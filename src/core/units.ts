/**
 * Автомат юнита поверх `mover`: ищет цель, целится, стреляет, прячется.
 *
 * Всё в клетках и тиках; единственная случайность — бросок при выстреле.
 * Юниты обходятся по порядку массива (он отсортирован по id), и два юнита,
 * стреляющие друг в друга в один тик, разрешаются этим порядком: результат
 * воспроизводим, а игроку такая асимметрия не видна.
 */

import type { Cell, UnitSign } from '../shared/protocol'
import { hitChance, rollHit } from './combat'
import { ORTHO, dirOf, octile, sameCell } from './grid'
import { coverFrom, lineOfSight } from './los'
import { advance, origin, setPath, stepInFlight } from './mover'
import type { State, Unit } from './state'
import {
  AIM_MS,
  BLOCKED_MS,
  COVER_RADIUS,
  FIRE_MS,
  FIRE_RANGE,
  RELOAD_MS,
  SIGHT_RANGE,
  TICK_MS,
  UNDER_FIRE_MS,
  UNIT_MS_PER_CELL,
} from './tuning'

/** Юнит, который «просто стоит», раздражает; «прижат огнём» — объясняет. */
export const UNIT_STATUS = {
  await: 'ждёт приказа',
  search: 'ищет цель',
  move: 'выдвигается',
  aim: 'целится',
  reload: 'перезарядка',
  fire: 'стреляет',
  close: 'сближается',
  seek: 'ищет укрытие',
  pinned: 'прижат огнём',
  yield: 'пропускает',
  stuck: 'не могу подойти',
  halt: 'стоит',
  far: 'цель вне дальности',
  dead: 'убит',
} as const

/** Знак по строке: строка — источник, знак — её сокращение, и расходиться им нельзя. */
const SIGN_OF: ReadonlyMap<string, UnitSign> = new Map([
  [UNIT_STATUS.pinned, 'pinned'],
  [UNIT_STATUS.seek, 'seek'],
  [UNIT_STATUS.reload, 'reload'],
  [UNIT_STATUS.far, 'far'],
  [UNIT_STATUS.stuck, 'stuck'],
  [UNIT_STATUS.yield, 'yield'],
])

export function signOf(status: string): UnitSign | null {
  return SIGN_OF.get(status) ?? null
}

export function unitById(state: State, id: string | null): Unit | null {
  if (id === null) return null
  for (const u of state.units) if (u.id === id) return u
  return null
}

export function alive(u: Unit): boolean {
  return u.mode !== 'dead'
}

/** Клетка занята живым юнитом — стоящим в ней или уже шагнувшим в неё. */
function occupied(state: State, cell: Cell, self: Unit): boolean {
  for (const v of state.units) {
    if (v === self || !alive(v)) continue
    if (sameCell(v.cell, cell)) return true
    const step = v.path[0]
    if (v.progress > 0 && step !== undefined && sameCell(step, cell)) return true
  }
  return false
}

function visible(state: State, u: Unit, other: Unit): boolean {
  return octile(u.cell, other.cell) <= SIGHT_RANGE * ORTHO && lineOfSight(state.grid, u.cell, other.cell)
}

function inFireRange(u: Unit, other: Unit): boolean {
  return octile(u.cell, other.cell) <= FIRE_RANGE * ORTHO
}

/**
 * Цель. Сначала те, кого можно достать: видимая цель вне дальности огня
 * не стоит того, чтобы под неё подставлять спину. Среди достижимых — тот,
 * кто стреляет в тебя, потом прежняя цель (прицел не должен прыгать между
 * двумя равными), потом ближайший; ничья — по id. Если достать некого,
 * прежняя цель остаётся, пока видна, иначе — ближайшая видимая.
 */
function acquire(state: State, u: Unit): Unit | null {
  let best: Unit | null = null
  let bestKey = 0
  for (const v of state.units) {
    if (v.side === u.side || !alive(v) || !visible(state, u, v)) continue
    const d = octile(u.cell, v.cell)
    // Меньше — лучше: разряды старше расстояния.
    let key = d
    if (v.id === u.target) key -= 1_000
    if (u.underFireMs > 0 && v.id === u.threat) key -= 10_000
    if (inFireRange(u, v)) key -= 100_000
    if (best === null || key < bestKey || (key === bestKey && v.id < best.id)) {
      best = v
      bestKey = key
    }
  }
  return best
}

/** Ближайший живой противник, видимый или нет. Для наступления. */
function nearestEnemy(state: State, u: Unit): Unit | null {
  let best: Unit | null = null
  let bestD = 0
  for (const v of state.units) {
    if (v.side === u.side || !alive(v)) continue
    const d = octile(u.cell, v.cell)
    if (best === null || d < bestD || (d === bestD && v.id < best.id)) {
      best = v
      bestD = d
    }
  }
  return best
}

// ─── переходы ────────────────────────────────────────────────────────────

function beginAim(u: Unit, t: Unit): void {
  u.mode = 'aim'
  u.target = t.id
  u.waitMs = AIM_MS
  u.status = UNIT_STATUS.aim
  u.facing = dirOf(u.cell, t.cell) ?? u.facing
}

/** Путь к клетке; `true` — маршрут назначен (возможно, пустой). */
function beginMove(state: State, u: Unit, cell: Cell, status: string): boolean {
  const path = state.grid.findPathNear(origin(u), cell)
  if (path === null) {
    u.status = UNIT_STATUS.stuck
    return false
  }
  setPath(u, path)
  u.mode = 'move'
  u.target = null
  u.blockedMs = 0
  u.status = status
  return true
}

function die(state: State, u: Unit): void {
  u.mode = 'dead'
  u.hp = 0
  u.path = []
  u.progress = 0
  u.moveAcc = 0
  u.target = null
  u.status = UNIT_STATUS.dead
  state.events.push({ t: 'died', unit: u.id })
}

function shoot(state: State, u: Unit, t: Unit): void {
  const cover = coverFrom(state.grid, t.cell, u.cell)
  const chance = hitChance(octile(u.cell, t.cell), cover)
  const hit = rollHit(state.rng, chance)
  state.events.push({ t: 'shot', from: u.id, to: t.id, hit, chance, cover })
  // Промах — тоже огонь: юнит, мимо которого свистит, ищет укрытие.
  t.underFireMs = UNDER_FIRE_MS
  t.threat = u.id
  if (hit) {
    t.hp -= 1
    if (t.hp <= 0) die(state, t)
  }
  u.shots += 1
  u.mode = 'fire'
  u.waitMs = FIRE_MS
  u.status = UNIT_STATUS.fire
}

/**
 * Ближайшая клетка в радиусе, укрытая от стрелка, с доступным путём.
 * Порядок кандидатов — по расстоянию, затем по клетке: детерминизм.
 */
function findCover(state: State, u: Unit, from: Cell): Cell[] | null {
  const grid = state.grid
  const o = origin(u)
  const spots: Cell[] = []
  for (let dy = -COVER_RADIUS; dy <= COVER_RADIUS; dy++) {
    for (let dx = -COVER_RADIUS; dx <= COVER_RADIUS; dx++) {
      const c = { x: o.x + dx, y: o.y + dy }
      if (grid.isBlocked(c.x, c.y) || occupied(state, c, u)) continue
      if (!coverFrom(grid, c, from)) continue
      spots.push(c)
    }
  }
  spots.sort((a, b) => {
    const da = octile(o, a)
    const db = octile(o, b)
    if (da !== db) return da - db
    return a.y !== b.y ? a.y - b.y : a.x - b.x
  })
  for (const spot of spots) {
    const path = grid.findPath(o, spot)
    if (path !== null) return path
  }
  return null
}

/** Под огнём и не укрыт — бежать к укрытию. `true` — побежал. */
function trySeekCover(state: State, u: Unit): boolean {
  if (u.underFireMs <= 0 || u.seekCooldownMs > 0) return false
  const threat = unitById(state, u.threat)
  if (threat === null || !alive(threat)) return false
  if (coverFrom(state.grid, origin(u), threat.cell)) return false
  const path = findCover(state, u, threat.cell)
  if (path === null) {
    // Прятаться некуда — стоит и стреляет, и не перебирает клетки каждый тик.
    u.seekCooldownMs = UNDER_FIRE_MS
    return false
  }
  setPath(u, path)
  u.mode = 'seek'
  u.target = null
  u.blockedMs = 0
  u.status = UNIT_STATUS.seek
  return true
}

/**
 * Обход: тот же маршрут к той же цели, но клетки под другими юнитами —
 * временно стены. Занятая цель — как стена: встать рядом. Сетка общая,
 * поэтому стены ставятся и снимаются в одном вызове. `true` — путь найден.
 */
function detour(state: State, u: Unit): boolean {
  const goal = u.path[u.path.length - 1]
  if (goal === undefined) return false
  const grid = state.grid
  const walls: Cell[] = []
  for (const v of state.units) {
    if (v === u || !alive(v)) continue
    const cells = [v.cell]
    const step = v.path[0]
    if (v.progress > 0 && step !== undefined) cells.push(step)
    for (const c of cells) {
      if (grid.isBlocked(c.x, c.y)) continue
      grid.setBlocked(c.x, c.y, true)
      walls.push(c)
    }
  }
  const path = grid.findPathNear(origin(u), goal)
  for (const c of walls) grid.setBlocked(c.x, c.y, false)
  if (path === null || path.length === 0) return false
  setPath(u, path)
  return true
}

/**
 * Шаг по маршруту с учётом занятости: перед занятой клеткой юнит сначала
 * ищет обход, не найдя — ждёт, а прождав BLOCKED_MS — бросает маршрут,
 * чтобы двое не стояли друг перед другом вечно. `true` — маршрут кончился.
 */
function step(state: State, u: Unit, walking: string): boolean {
  const next = u.path[0]
  if (next !== undefined && u.progress === 0 && occupied(state, next, u)) {
    if (u.blockedMs === 0 && detour(state, u)) {
      u.status = walking
      return advance(u, UNIT_MS_PER_CELL, (cell) => occupied(state, cell, u))
    }
    u.blockedMs += TICK_MS
    if (u.blockedMs < BLOCKED_MS) {
      u.status = UNIT_STATUS.yield
      return false
    }
    u.path = []
    u.blockedMs = 0
    return true
  }
  u.blockedMs = 0
  // Клетка освободилась — строка снова про ходьбу, а не про ожидание.
  u.status = walking
  return advance(u, UNIT_MS_PER_CELL, (cell) => occupied(state, cell, u))
}

/** Чем занят идущий: свои выполняют приказ, противник ищет цель. */
function walking(u: Unit): string {
  return u.side === 'player' ? UNIT_STATUS.move : UNIT_STATUS.search
}

// ─── автомат ─────────────────────────────────────────────────────────────

function stepIdle(state: State, u: Unit): void {
  if (trySeekCover(state, u)) return
  const t = acquire(state, u)
  if (t !== null) {
    beginAim(u, t)
    return
  }
  if (u.side === 'enemy') {
    // Под огнём и в укрытии — сидит, пока не стихнет: выскочить сразу по
    // приходу значило бы бегать туда-сюда между укрытием и пулей.
    if (u.underFireMs > 0) {
      u.status = UNIT_STATUS.pinned
      return
    }
    // Противник без цели наступает на ближайшего: иначе две стороны,
    // спрятавшиеся за стенами, простоят до конца времён.
    const enemy = nearestEnemy(state, u)
    if (enemy !== null) beginMove(state, u, enemy.cell, walking(u))
    return
  }
  u.status = UNIT_STATUS.await
}

function stepMove(state: State, u: Unit): void {
  // Идёт, видит врага в дальности огня — останавливается и стреляет.
  // Начатый шаг доходит: возвращать в центр клетки — рывок назад.
  const t = acquire(state, u)
  if (t !== null && inFireRange(u, t)) {
    u.path = stepInFlight(u)
    beginAim(u, t)
    return
  }
  if (step(state, u, walking(u))) u.mode = 'idle'
}

function stepSeek(state: State, u: Unit): void {
  if (step(state, u, UNIT_STATUS.seek)) u.mode = 'idle'
}

function stepAim(state: State, u: Unit): void {
  const t = unitById(state, u.target)
  if (t === null || !alive(t) || !visible(state, u, t)) {
    u.target = null
    u.mode = 'idle'
    u.path = stepInFlight(u)
    return
  }
  if (trySeekCover(state, u)) return
  u.facing = dirOf(u.cell, t.cell) ?? u.facing

  if (!inFireRange(u, t)) {
    u.waitMs = AIM_MS
    // Свои не сближаются сами: куда идти — решение игрока, и строка
    // состояния говорит ему, что решение требуется.
    if (u.side === 'player') {
      u.status = UNIT_STATUS.far
      if (u.path.length > 0) step(state, u, UNIT_STATUS.far)
      return
    }
    // Противник видит, но не достаёт — сближается, пока не достанет.
    if (u.path.length === 0) {
      const path = state.grid.findPath(origin(u), t.cell)
      if (path === null) {
        u.status = UNIT_STATUS.stuck
        return
      }
      setPath(u, path)
    }
    step(state, u, UNIT_STATUS.close)
    return
  }

  // Достаёт: остаток маршрута отменяется, начатый шаг доходит.
  if (u.path.length > 0) {
    u.path = stepInFlight(u)
    if (u.path.length > 0) {
      step(state, u, UNIT_STATUS.aim)
      return
    }
  }

  const pinned = u.underFireMs > 0 && coverFrom(state.grid, u.cell, t.cell)
  u.status = pinned ? UNIT_STATUS.pinned : u.shots === 0 ? UNIT_STATUS.aim : UNIT_STATUS.reload
  u.waitMs -= TICK_MS
  if (u.waitMs <= 0) shoot(state, u, t)
}

function stepFire(u: Unit): void {
  u.waitMs -= TICK_MS
  if (u.waitMs <= 0) {
    u.mode = 'aim'
    u.waitMs = RELOAD_MS - FIRE_MS
    u.status = UNIT_STATUS.reload
  }
}

export function tickUnits(state: State): void {
  for (const u of state.units) {
    if (!alive(u)) continue
    if (u.underFireMs > 0) u.underFireMs -= TICK_MS
    if (u.seekCooldownMs > 0) u.seekCooldownMs -= TICK_MS
    switch (u.mode) {
      case 'idle':
        stepIdle(state, u)
        break
      case 'move':
        stepMove(state, u)
        break
      case 'seek':
        stepSeek(state, u)
        break
      case 'aim':
        stepAim(state, u)
        break
      case 'fire':
        stepFire(u)
        break
      case 'dead':
        break
    }
  }
}

// ─── приказы ─────────────────────────────────────────────────────────────

/** Приказ идти: ставит `move` и очищает цель. Дошедший снова ищет цели сам. */
export function orderMove(state: State, ids: readonly string[], cell: Cell): void {
  for (const id of ids) {
    const u = unitById(state, id)
    if (u === null || !alive(u)) continue
    if (!beginMove(state, u, cell, walking(u))) continue
    if (u.path.length === 0) u.mode = 'idle'
  }
}

export function orderHalt(state: State, ids: readonly string[]): void {
  for (const id of ids) {
    const u = unitById(state, id)
    if (u === null || !alive(u)) continue
    u.path = stepInFlight(u)
    u.mode = 'idle'
    u.target = null
    u.status = UNIT_STATUS.halt
  }
}

// ─── чтение ──────────────────────────────────────────────────────────────

/** Текущая угроза: кто стрелял последним, пока это свежо, иначе цель. */
export function threatOf(state: State, u: Unit): Unit | null {
  if (u.underFireMs > 0) {
    const threat = unitById(state, u.threat)
    if (threat !== null && alive(threat)) return threat
  }
  const target = unitById(state, u.target)
  return target !== null && alive(target) ? target : null
}
