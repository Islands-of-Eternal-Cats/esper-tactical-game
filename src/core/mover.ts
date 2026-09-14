/**
 * Движение по сетке — общее для кота и юнита.
 *
 * Вынесено из `sim.ts` ровно в том виде, в каком там жило: те же поля, тот
 * же закон шага, та же дисциплина «начатый шаг переживает новый приказ».
 * Всё, что здесь, — про клетки и тики; кто и зачем идёт, движение не знает.
 */

import type { Cell, Dir } from '../shared/protocol'
import { UNIT, tickAmount } from './fixed'
import { ORTHO, dirOf, stepCost } from './grid'

export interface Mover {
  cell: Cell
  /**
   * Клетка, из которой пришёл в `cell`. Только для рендера: сглаживание
   * траектории смотрит на полклетки назад. В сохранение не входит — после
   * загрузки первые полклетки просто не сглаживаются.
   */
  prev: Cell | null
  /** Оставшиеся клетки пути; `path[0]` — следующая. */
  path: Cell[]
  /** 0..UNIT внутри текущего шага. */
  progress: number
  moveAcc: number
  facing: Dir
}

/** Длительность шага в модельных мс: диагональ дороже прямого. */
export function stepMs(from: Cell, to: Cell, msPerCell: number): number {
  return (msPerCell * stepCost(from, to)) / ORTHO
}

/**
 * Клетка, из которой строится новый маршрут.
 *
 * Застигнутый приказом посреди шага доходит до клетки, в которую уже
 * ступил. Иначе маршрут считается от покинутой клетки, а фигура на экране
 * прыгает в её центр — рывок назад на каждый клик игрока.
 */
export function origin(m: Mover): Cell {
  const step = m.path[0]
  return m.progress > 0 && step !== undefined ? step : m.cell
}

/** Начатый шаг: то единственное из маршрута, что переживает новый приказ. */
export function stepInFlight(m: Mover): Cell[] {
  const step = m.path[0]
  return m.progress > 0 && step !== undefined ? [step] : []
}

/** Назначить маршрут, не отменяя начатый шаг. */
export function setPath(m: Mover, path: Cell[]): void {
  const step = m.path[0]
  if (m.progress > 0 && step !== undefined) {
    // Прогресс и накопитель шага остаются: шаг продолжается, а не начинается.
    m.path = [step, ...path]
    return
  }
  m.path = path
  m.progress = 0
  m.moveAcc = 0
}

/**
 * Продвижение по пути. `true` — путь пройден.
 *
 * `blocked` — клетка, в которую нельзя ступить прямо сейчас (кто-то стоит).
 * Проверяется только на старте шага: тот, кто уже между клетками, доходит.
 */
export function advance(m: Mover, msPerCell: number, blocked?: (cell: Cell) => boolean): boolean {
  if (m.path.length === 0) return true

  const next = m.path[0]!
  if (m.progress === 0 && blocked !== undefined && blocked(next)) return false

  // Направление — туда, куда идёт, а не откуда пришёл. Если ставить его по
  // факту прихода в клетку, фигура целую клетку едет к цели боком и только
  // потом доворачивается: на капсуле это незаметно, на модели — сразу видно.
  m.facing = dirOf(m.cell, next) ?? m.facing
  const [amount, acc] = tickAmount(m.moveAcc, stepMs(m.cell, next, msPerCell))
  m.moveAcc = acc
  m.progress += amount

  while (m.progress >= UNIT && m.path.length > 0) {
    m.progress -= UNIT
    m.prev = m.cell
    m.cell = m.path.shift()!
    const ahead = m.path[0]
    if (ahead !== undefined) m.facing = dirOf(m.cell, ahead) ?? m.facing
  }

  if (m.path.length === 0) {
    m.progress = 0
    m.moveAcc = 0
    return true
  }
  return false
}
