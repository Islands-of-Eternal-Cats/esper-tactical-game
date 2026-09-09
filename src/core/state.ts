/**
 * Сущности симуляции.
 *
 * Всё, что накапливается, лежит в тысячных долях целыми числами. Float
 * появляется только на границе, в снапшоте.
 */

import type { Cell, Dir } from '../shared/protocol'
import type { Grid } from './grid'
import type { Rng } from './rng'

/**
 * `survey` — «дошёл до пустой зоны и осматривается». Наружу не выходит:
 * в снапшоте становится `idle`, потому что отдельной анимации у него нет.
 */
export type CatMode = 'idle' | 'walk' | 'work' | 'haul' | 'dump' | 'survey'

/**
 * Куча — единица симуляции. Не счётчик и не отдельные мусоринки.
 *
 * Счётчик не годится: клик означает «здесь важнее», а у счётчика нет «здесь».
 * Атомарная куча тоже не годится: если её нельзя бросить наполовину, у
 * прерывания нет читаемой цены, и срез не проверяет то, ради чего делается.
 */
export interface Pile {
  id: string
  cell: Cell
  volume: number
  initial: number
  /** Резервирование обязательно с первого дня, даже когда кот один. */
  reservedBy: string | null
}

export interface Cat {
  id: string
  cell: Cell
  /** Оставшиеся клетки пути; `path[0]` — следующая. */
  path: Cell[]
  /** 0..UNIT внутри текущего шага. */
  progress: number
  moveAcc: number
  facing: Dir
  mode: CatMode
  /** id кучи, за которой закреплён. */
  target: string | null
  load: number
  capacity: number
  suckAcc: number
  /** Набранное внутри текущего цикла всасывания. Цикл — точка решения. */
  unitAcc: number
  /** Зона сменилась, пока он работал: перехватить на границе цикла. */
  reconsider: boolean
  /** Остаток ожидания (опустошение, осмотр) в миллисекундах. */
  waitMs: number
  status: string
}

export interface Zone {
  cell: Cell
  radius: number
}

export interface State {
  seed: number
  tick: number
  grid: Grid
  rng: Rng
  walls: Cell[]
  container: Cell
  /** Отсортированы по id и никогда не переупорядочиваются. */
  piles: Pile[]
  cats: Cat[]
  zone: Zone | null
  collected: number
}
