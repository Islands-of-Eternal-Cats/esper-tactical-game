/**
 * Состояние и тик.
 *
 * tick() не принимает время. Ускорение ×3 означает втрое больше тиков, а не
 * втрое больший шаг — именно поэтому результат на всех скоростях одинаковый.
 * Если хоть где-то в логику попадёт дельта, это свойство исчезнет.
 */

import type { Cell, Snapshot, WorldView } from '../shared/protocol'
import { UNIT, tickAmount } from './fixed'
import { ORTHO, dirOf, octile, stepCost } from './grid'
import { inZone, pileById, rankPiles, release } from './jobs'
import { Rng } from './rng'
import type { Cat, CatMode, Pile, State, Zone } from './state'
import {
  DUMP_MS,
  NEARLY_DONE_UNITS,
  SUCK_MS_PER_UNIT,
  SURVEY_MS,
  TICK_MS,
  VACUUM_CAPACITY,
  WALK_MS_PER_CELL,
} from './tuning'
import { CONTAINER, buildGrid, placePiles } from './world'

/**
 * Строка состояния — не украшение. Без неё неподчинение читается как баг,
 * и срез не проверяет ничего.
 */
const STATUS = {
  empty: 'мусор закончился',
  walk: 'иду к куче',
  walkZone: 'иду в указанную зону',
  work: 'убирает мусор',
  finishing: 'доканчивает кучу',
  haulFull: 'пылесос полон, иду к контейнеру',
  haulRest: 'несу остаток к контейнеру',
  dump: 'опустошает пылесос',
  survey: 'осматривается',
  stuck: 'не могу подойти',
} as const

const NEARLY_DONE = Math.round(NEARLY_DONE_UNITS * UNIT)

export interface SaveState {
  v: 1
  seed: number
  tick: number
  rng: number
  collected: number
  zone: Zone | null
  piles: Array<{ id: string; x: number; y: number; volume: number; initial: number; reservedBy: string | null }>
  cats: Array<{
    id: string
    x: number
    y: number
    path: Cell[]
    progress: number
    moveAcc: number
    facing: Cat['facing']
    mode: CatMode
    target: string | null
    load: number
    capacity: number
    suckAcc: number
    unitAcc: number
    reconsider: boolean
    waitMs: number
    status: string
  }>
}

/** Сколько клеток маршрута видит рендер вперёд: на сглаживание хватает трёх. */
const ROUTE_AHEAD = 4

/** Длительность шага в модельных мс: диагональ дороже прямого. */
function stepMs(from: Cell, to: Cell): number {
  return (WALK_MS_PER_CELL * stepCost(from, to)) / ORTHO
}

export class Sim {
  private state: State

  constructor(seed: number) {
    this.state = Sim.create(seed)
  }

  private static create(seed: number): State {
    const { grid, walls, props } = buildGrid()
    const rng = new Rng(seed)
    const piles = placePiles(grid, rng, CONTAINER)
    const cat: Cat = {
      id: 'rusty',
      cell: { x: CONTAINER.x - 2, y: CONTAINER.y },
      prev: null,
      path: [],
      progress: 0,
      moveAcc: 0,
      facing: 'n',
      mode: 'idle',
      target: null,
      load: 0,
      capacity: VACUUM_CAPACITY * UNIT,
      suckAcc: 0,
      unitAcc: 0,
      reconsider: false,
      waitMs: 0,
      status: STATUS.empty,
    }
    return {
      seed,
      tick: 0,
      grid,
      rng,
      walls,
      props,
      container: { ...CONTAINER },
      piles,
      cats: [cat],
      zone: null,
      collected: 0,
    }
  }

  reset(seed: number): void {
    this.state = Sim.create(seed)
  }

  // ─── команды ───────────────────────────────────────────────────────────

  /**
   * Клик — намерение, а не маршрут. Игрок сообщает, что важно, а не куда
   * ставить ноги, и поэтому приказ не отменяет то, что уже начато.
   */
  setZone(cell: Cell, radius: number): void {
    this.state.zone = { cell: { ...cell }, radius }
    for (const cat of this.state.cats) {
      switch (cat.mode) {
        case 'work': {
          // Перехват откладывается до конца цикла всасывания. Но строка
          // состояния меняется сразу: игрок должен узнать, что приказ принят
          // и почему он ещё не выполняется, в тот же кадр, а не через тик.
          cat.reconsider = true
          const pile = pileById(this.state, cat.target)
          if (pile !== null && !this.wanted(pile)) cat.status = STATUS.finishing
          break
        }
        case 'walk':
        case 'survey':
          // Ничего не вложено — переприцеливается сразу.
          // Маршрут отменяется весь, кроме начатого шага: цель должна
          // смениться в тот же тик, но возвращать кота в центр покинутой
          // клетки нельзя — на экране это рывок назад.
          release(this.state, cat)
          cat.mode = 'idle'
          cat.path = this.stepInFlight(cat)
          cat.status = STATUS.walkZone
          break
        case 'haul':
        case 'dump':
        case 'idle':
          // Полный пылесос опустошается раньше, чем выполняется приоритет.
          break
      }
    }
  }

  clearZone(): void {
    this.state.zone = null
  }

  /**
   * Отладка: весь мусор исчезает. Кучи не удаляются, а обнуляются — снапшот
   * их и так не показывает, а кот увидит пустую кучу на следующем тике и
   * переприцелится сам, по своим же правилам. Собранное не растёт: это не
   * уборка.
   */
  debugClearPiles(): void {
    for (const pile of this.state.piles) {
      pile.volume = 0
      pile.reservedBy = null
    }
  }

  // ─── тик ───────────────────────────────────────────────────────────────

  tick(): void {
    this.state.tick++
    // Порядок обхода — порядок массива, а он задан при создании и не меняется.
    for (const cat of this.state.cats) this.stepCat(cat)
  }

  private stepCat(cat: Cat): void {
    switch (cat.mode) {
      case 'idle':
        this.assign(cat)
        return
      case 'walk':
        if (this.advance(cat)) this.arriveAtPile(cat)
        return
      case 'work':
        this.work(cat)
        return
      case 'haul':
        if (this.advance(cat)) {
          cat.mode = 'dump'
          cat.waitMs = DUMP_MS
          cat.status = STATUS.dump
        }
        return
      case 'dump':
        cat.waitMs -= TICK_MS
        if (cat.waitMs <= 0) {
          this.state.collected += cat.load
          cat.load = 0
          cat.mode = 'idle'
        }
        return
      case 'survey':
        this.survey(cat)
        return
    }
  }

  /**
   * Клетка, из которой строится новый маршрут.
   *
   * Кот, застигнутый приказом посреди шага, доходит до клетки, в которую уже
   * ступил. Иначе маршрут считается от покинутой клетки, а кот на экране
   * прыгает в её центр — рывок назад на каждый клик игрока.
   */
  private origin(cat: Cat): Cell {
    const step = cat.path[0]
    return cat.progress > 0 && step !== undefined ? step : cat.cell
  }

  /** Начатый шаг: то единственное из маршрута, что переживает новый приказ. */
  private stepInFlight(cat: Cat): Cell[] {
    const step = cat.path[0]
    return cat.progress > 0 && step !== undefined ? [step] : []
  }

  /** Назначить маршрут, не отменяя начатый шаг. */
  private setPath(cat: Cat, path: Cell[]): void {
    const step = cat.path[0]
    if (cat.progress > 0 && step !== undefined) {
      // Прогресс и накопитель шага остаются: шаг продолжается, а не начинается.
      cat.path = [step, ...path]
      return
    }
    cat.path = path
    cat.progress = 0
    cat.moveAcc = 0
  }

  /** Продвижение по пути. `true` — путь пройден. */
  private advance(cat: Cat): boolean {
    if (cat.path.length === 0) return true

    const next = cat.path[0]!
    // Направление — туда, куда кот идёт, а не откуда пришёл. Если ставить его
    // по факту прихода в клетку, кот целую клетку едет к цели боком и только
    // потом доворачивается: на капсуле это незаметно, на модели — сразу видно.
    cat.facing = dirOf(cat.cell, next) ?? cat.facing
    const [amount, acc] = tickAmount(cat.moveAcc, stepMs(cat.cell, next))
    cat.moveAcc = acc
    cat.progress += amount

    while (cat.progress >= UNIT && cat.path.length > 0) {
      cat.progress -= UNIT
      cat.prev = cat.cell
      cat.cell = cat.path.shift()!
      const ahead = cat.path[0]
      if (ahead !== undefined) cat.facing = dirOf(cat.cell, ahead) ?? cat.facing
    }

    if (cat.path.length === 0) {
      cat.progress = 0
      cat.moveAcc = 0
      return true
    }
    return false
  }

  /**
   * Путь к клетке, с которой кот работает с кучей.
   *
   * Он встаёт рядом, а не поверх: стоя на куче, он её собой и закрывает, и
   * игрок не видит ни что убирается, ни сколько осталось. Заодно у пылесоса
   * появляется направление — то самое, от которого на шаге 6 строится
   * анимация работы.
   */
  private approach(cat: Cat, pile: Pile): Cell[] | null {
    const grid = this.state.grid
    const from = this.origin(cat)
    if (grid.isNeighbour(from, pile.cell)) return []

    const spots = grid.neighbours(pile.cell)
    spots.sort((a, b) => {
      const da = octile(from, a)
      const db = octile(from, b)
      if (da !== db) return da - db
      return a.y !== b.y ? a.y - b.y : a.x - b.x
    })
    for (const spot of spots) {
      const path = grid.findPath(from, spot)
      if (path !== null) return path
    }
    return null
  }

  private beginWork(cat: Cat, pile: Pile): void {
    cat.mode = 'work'
    cat.suckAcc = 0
    cat.unitAcc = 0
    cat.status = STATUS.work
    // Развернуться к куче: иначе пылесос будет работать в пустоту.
    cat.facing = dirOf(cat.cell, pile.cell) ?? cat.facing
  }

  private arriveAtPile(cat: Cat): void {
    const pile = pileById(this.state, cat.target)
    if (pile === null || pile.volume <= 0 || !this.state.grid.isNeighbour(cat.cell, pile.cell)) {
      release(this.state, cat)
      cat.mode = 'idle'
      return
    }
    this.beginWork(cat, pile)
  }

  private nearlyDone(pile: Pile): boolean {
    return pile.volume <= NEARLY_DONE
  }

  private wanted(pile: Pile): boolean {
    return this.state.zone === null || inZone(this.state.zone, pile.cell)
  }

  private work(cat: Cat): void {
    const pile = pileById(this.state, cat.target)
    if (pile === null || pile.volume <= 0 || !this.state.grid.isNeighbour(cat.cell, pile.cell)) {
      release(this.state, cat)
      cat.mode = 'idle'
      return
    }

    const [amount, acc] = tickAmount(cat.suckAcc, SUCK_MS_PER_UNIT)
    cat.suckAcc = acc
    const take = Math.min(amount, pile.volume, cat.capacity - cat.load)
    pile.volume -= take
    cat.load += take
    cat.unitAcc += take

    cat.status = cat.reconsider && !this.wanted(pile) ? STATUS.finishing : STATUS.work

    if (pile.volume <= 0) {
      pile.volume = 0
      pile.reservedBy = null
      cat.target = null
      cat.reconsider = false
      cat.mode = 'idle'
      return
    }

    // Полный пылесос — не помеха, а главный источник интересных ситуаций:
    // законная причина не выполнить приказ немедленно, и причина видимая.
    if (cat.load >= cat.capacity) {
      this.beginHaul(cat, STATUS.haulFull)
      return
    }

    // Единственный момент, когда приказ перехватывает работу.
    if (cat.unitAcc >= UNIT) {
      cat.unitAcc -= UNIT
      if (cat.reconsider) {
        if (this.wanted(pile) || this.nearlyDone(pile)) {
          // Кот, которому осталось одно действие, не бросает кучу по клику.
          // Это характер, выраженный правилом, а не текстом.
          if (this.wanted(pile)) cat.reconsider = false
        } else {
          cat.reconsider = false
          release(this.state, cat)
          cat.mode = 'idle'
        }
      }
    }
  }

  private survey(cat: Cat): void {
    if (!this.advance(cat)) {
      cat.status = STATUS.walkZone
      return
    }
    cat.status = STATUS.survey
    cat.waitMs -= TICK_MS
    if (cat.waitMs <= 0) {
      // Зона исчерпана: игрок видит конец приоритета, а не гадает, действует
      // он ещё или нет.
      this.state.zone = null
      cat.mode = 'idle'
    }
  }

  private beginHaul(cat: Cat, status: string): void {
    release(this.state, cat)
    const path = this.state.grid.findPath(this.origin(cat), this.state.container)
    if (path === null) {
      cat.mode = 'idle'
      cat.status = STATUS.stuck
      return
    }
    this.setPath(cat, path)
    const arrived = cat.path.length === 0
    cat.mode = arrived ? 'dump' : 'haul'
    cat.waitMs = DUMP_MS
    cat.status = arrived ? STATUS.dump : status
  }

  private beginSurvey(cat: Cat): void {
    const zone = this.state.zone
    if (zone === null) {
      cat.mode = 'idle'
      return
    }
    const path = this.state.grid.findPath(this.origin(cat), zone.cell)
    if (path === null) {
      // До центра зоны не дойти — приоритет молча снимается, иначе кот
      // застрянет в намерении, которое нельзя исполнить.
      this.state.zone = null
      cat.mode = 'idle'
      return
    }
    this.setPath(cat, path)
    cat.mode = 'survey'
    cat.waitMs = SURVEY_MS
    cat.status = cat.path.length === 0 ? STATUS.survey : STATUS.walkZone
  }

  private assign(cat: Cat): void {
    cat.reconsider = false

    if (cat.load >= cat.capacity) {
      this.beginHaul(cat, STATUS.haulFull)
      return
    }

    const ranked = rankPiles(this.state, cat)

    if (ranked.length === 0) {
      // Зона задана, но мусора в ней нет — это не «работы нет».
      if (this.state.zone !== null) {
        this.beginSurvey(cat)
        return
      }
      if (cat.load > 0) {
        this.beginHaul(cat, STATUS.haulRest)
        return
      }
      cat.status = STATUS.empty
      this.setPath(cat, [])
      return
    }

    for (const pile of ranked) {
      const path = this.approach(cat, pile)
      if (path === null) continue
      pile.reservedBy = cat.id
      cat.target = pile.id
      this.setPath(cat, path)
      cat.suckAcc = 0
      cat.unitAcc = 0
      if (cat.path.length === 0) {
        this.beginWork(cat, pile)
      } else {
        cat.mode = 'walk'
        cat.status = this.wanted(pile) && this.state.zone !== null ? STATUS.walkZone : STATUS.walk
      }
      return
    }

    cat.status = STATUS.stuck
  }

  // ─── чтение ────────────────────────────────────────────────────────────

  world(): WorldView {
    const s = this.state
    return {
      seed: s.seed,
      width: s.grid.width,
      height: s.grid.height,
      walls: s.walls.map((c) => ({ ...c })),
      props: s.props.map((p) => ({ ...p, cell: { ...p.cell } })),
      container: { ...s.container },
    }
  }

  private lookAt(cat: Cat): Cell | null {
    if (cat.mode === 'work') {
      const pile = pileById(this.state, cat.target)
      return pile === null ? null : { ...pile.cell }
    }
    if (cat.path.length > 0) return { ...cat.path[cat.path.length - 1]! }
    if (cat.mode === 'dump') return { ...this.state.container }
    return null
  }

  snapshot(): Snapshot {
    const s = this.state
    let remaining = 0
    for (const p of s.piles) remaining += p.volume

    return {
      tick: s.tick,
      cats: s.cats.map((c) => ({
        id: c.id,
        cell: { ...c.cell },
        prev: c.prev === null ? null : { ...c.prev },
        next: c.path.length > 0 ? { ...c.path[0]! } : null,
        route: c.path.slice(0, ROUTE_AHEAD).map((p) => ({ ...p })),
        // Единственное место, где фиксированная точка становится float.
        progress: c.progress / UNIT,
        stepMs: c.path.length > 0 ? stepMs(c.cell, c.path[0]!) : 0,
        facing: c.facing,
        // Осмотр — это два разных дела под одним режимом: сначала дойти до
        // зоны, потом стоять и осматриваться. Пока путь не пройден, кот
        // идёт — иначе он летит к зоне неподвижно, в позе покоя.
        action: c.mode === 'survey' ? (c.path.length > 0 ? 'walk' : 'idle') : c.mode,
        lookAt: this.lookAt(c),
        status: c.status,
        load: c.load / UNIT,
        capacity: c.capacity / UNIT,
      })),
      piles: s.piles
        .filter((p) => p.volume > 0)
        .map((p) => ({
          id: p.id,
          cell: { ...p.cell },
          volume: p.volume / UNIT,
          initial: p.initial / UNIT,
          reserved: p.reservedBy !== null,
        })),
      zone: s.zone === null ? null : { cell: { ...s.zone.cell }, radius: s.zone.radius },
      totals: { remaining: remaining / UNIT, collected: s.collected / UNIT },
    }
  }

  // ─── проверки и сохранение ─────────────────────────────────────────────

  private static readonly MODES: readonly CatMode[] = ['idle', 'walk', 'work', 'haul', 'dump', 'survey']

  /** FNV-1a по всему, что может разойтись. Основа теста детерминизма. */
  hash(): number {
    const s = this.state
    let h = 0x811c9dc5

    const num = (v: number): void => {
      h = Math.imul(h ^ (v | 0), 0x01000193) >>> 0
    }
    const str = (v: string): void => {
      for (let i = 0; i < v.length; i++) num(v.charCodeAt(i))
    }

    num(s.tick)
    num(s.rng.state)
    num(s.collected)
    num(s.zone === null ? -1 : s.zone.cell.x)
    num(s.zone === null ? -1 : s.zone.cell.y)
    num(s.zone === null ? -1 : s.zone.radius)

    for (const p of s.piles) {
      str(p.id)
      num(p.cell.x)
      num(p.cell.y)
      num(p.volume)
      str(p.reservedBy ?? '-')
    }
    for (const c of s.cats) {
      str(c.id)
      num(c.cell.x)
      num(c.cell.y)
      num(c.progress)
      num(c.moveAcc)
      num(c.suckAcc)
      num(c.unitAcc)
      num(c.load)
      num(c.waitMs)
      num(Sim.MODES.indexOf(c.mode))
      num(c.reconsider ? 1 : 0)
      num(c.path.length)
      for (const step of c.path) {
        num(step.x)
        num(step.y)
      }
      str(c.status)
    }
    return h
  }

  /**
   * Сид и состояние ГПСЧ уходят в сохранение вместе с состоянием: загрузка не
   * должна позволять перебросить зафиксированный исход.
   */
  serialize(): SaveState {
    const s = this.state
    return {
      v: 1,
      seed: s.seed,
      tick: s.tick,
      rng: s.rng.state,
      collected: s.collected,
      zone: s.zone === null ? null : { cell: { ...s.zone.cell }, radius: s.zone.radius },
      piles: s.piles.map((p) => ({
        id: p.id,
        x: p.cell.x,
        y: p.cell.y,
        volume: p.volume,
        initial: p.initial,
        reservedBy: p.reservedBy,
      })),
      cats: s.cats.map((c) => ({
        id: c.id,
        x: c.cell.x,
        y: c.cell.y,
        path: c.path.map((p) => ({ ...p })),
        progress: c.progress,
        moveAcc: c.moveAcc,
        facing: c.facing,
        mode: c.mode,
        target: c.target,
        load: c.load,
        capacity: c.capacity,
        suckAcc: c.suckAcc,
        unitAcc: c.unitAcc,
        reconsider: c.reconsider,
        waitMs: c.waitMs,
        status: c.status,
      })),
    }
  }

  static load(save: SaveState): Sim {
    const sim = new Sim(save.seed)
    const s = sim.state
    s.tick = save.tick
    s.rng.state = save.rng
    s.collected = save.collected
    s.zone = save.zone === null ? null : { cell: { ...save.zone.cell }, radius: save.zone.radius }
    s.piles = save.piles.map((p) => ({
      id: p.id,
      cell: { x: p.x, y: p.y },
      volume: p.volume,
      initial: p.initial,
      reservedBy: p.reservedBy,
    }))
    s.cats = save.cats.map((c) => ({
      id: c.id,
      cell: { x: c.x, y: c.y },
      prev: null,
      path: c.path.map((p) => ({ ...p })),
      progress: c.progress,
      moveAcc: c.moveAcc,
      facing: c.facing,
      mode: c.mode,
      target: c.target,
      load: c.load,
      capacity: c.capacity,
      suckAcc: c.suckAcc,
      unitAcc: c.unitAcc,
      reconsider: c.reconsider,
      waitMs: c.waitMs,
      status: c.status,
    }))
    return sim
  }
}
