/**
 * Сущности симуляции.
 *
 * Всё, что накапливается, лежит в тысячных долях целыми числами. Float
 * появляется только на границе, в снапшоте.
 */

import type { Cell, Event, Mode, PropView, Side } from '../shared/protocol'
import type { Grid } from './grid'
import type { Mover } from './mover'
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

/** Движение — общее с юнитом (`mover.ts`); всё остальное — только кота. */
export interface Cat extends Mover {
  id: string
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

/**
 * `seek` — идёт к укрытию; `fire` — поза выстрела на FIRE_MS после него.
 * Наружу оба выходят как `move` и `fire`; всё остальное совпадает с видом.
 */
export type UnitMode = 'idle' | 'move' | 'aim' | 'fire' | 'seek' | 'dead'

/**
 * Юнит — не кот. Общее у них только движение; попытка натянуть тактику на
 * `CatMode` — самый быстрый способ сломать «Ржавого».
 */
export interface Unit extends Mover {
  id: string
  side: Side
  mode: UnitMode
  /** id из weapons.yaml: дальность, темп, шанс и урон — там. */
  weapon: string
  hp: number
  /** id цели, в которую целится. Приказ игрока её сбрасывает. */
  target: string | null
  /** Остаток до следующего действия: прицеливание, поза выстрела, перезарядка. */
  waitMs: number
  /** Сколько ещё он «под огнём», и кто стрелял последним. */
  underFireMs: number
  threat: string | null
  /** Укрытия рядом не нашлось: не искать снова, пока не истечёт. */
  seekCooldownMs: number
  /** Сколько уже ждёт перед занятой клеткой. */
  blockedMs: number
  /** Выстрелов по текущей цели: «целится» до первого, «перезарядка» после. */
  shots: number
  status: string
}

export interface Zone {
  cell: Cell
  radius: number
}

export interface State {
  seed: number
  mode: Mode
  tick: number
  grid: Grid
  rng: Rng
  walls: Cell[]
  props: PropView[]
  container: Cell
  /** Отсортированы по id и никогда не переупорядочиваются. */
  piles: Pile[]
  cats: Cat[]
  /** Отсортированы по id: порядок обхода и разрешения одновременных выстрелов. */
  units: Unit[]
  zone: Zone | null
  collected: number
  /**
   * Буфер вывода, не состояние: копится между снапшотами, снапшот его
   * забирает. В хеш не входит и на ход симуляции не влияет.
   */
  events: Event[]
}
