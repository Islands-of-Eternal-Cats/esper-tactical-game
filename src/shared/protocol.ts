/**
 * Единственный общий словарь главного потока и воркера.
 *
 * Всё, что пересекает границу, описано здесь. Всё остальное — внутренние
 * детали своей стороны: ядро не знает про Three.js, рендер не знает про
 * устройство симуляции.
 */

export interface Cell {
  x: number
  y: number
}

export type Dir = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

/** Скорость: 0 — пауза. Умножает число тиков, а не величину шага. */
/** Дробные — отладочные: разглядеть стык клипов и старт шага. */
export type Speed = 0 | 0.1 | 0.5 | 1 | 3

/**
 * Радиус зоны приоритета в клетках. Решение дизайнерское, но живёт здесь:
 * радиус выбирает главный поток и кладёт в команду, а ядро он не импортирует.
 * Мал — игрок кликает без остановки; велик — приоритет ничего не значит.
 */
export const DEFAULT_ZONE_RADIUS = 4

// ─── главный поток → воркер ──────────────────────────────────────────────

export type Command =
  | { t: 'setSpeed'; speed: Speed }
  | { t: 'setZone'; cell: Cell; radius: number }
  | { t: 'clearZone' }
  | { t: 'reset'; seed: number }
  /** Отладка: весь мусор исчезает — посмотреть, что кот делает без работы. */
  | { t: 'debugClearPiles' }

// ─── воркер → главный поток ──────────────────────────────────────────────

/**
 * Статика мира: приходит один раз после reset, до первого снапшота.
 *
 * Расширение контракта относительно техплана. Причина: рендеру нужны размеры
 * двора, стены и контейнер, а они не меняются, и слать их в каждом снапшоте —
 * это платить за неизменное 20 раз в секунду.
 */
/** Крупный реквизит на полу: занимает клетку, как стена, но выглядит собой. */
export type PropKind = 'barrels' | 'crates' | 'cart' | 'pallet'

export interface PropView {
  cell: Cell
  kind: PropKind
  /** Поворот в четвертях оборота: раскладка задаёт, рендер поворачивает. */
  turn: 0 | 1 | 2 | 3
}

export interface WorldView {
  seed: number
  width: number
  height: number
  walls: Cell[]
  props: PropView[]
  container: Cell
}

export interface PileView {
  id: string
  cell: Cell
  /** Текущий объём в единицах. Float появляется только здесь, на границе. */
  volume: number
  /** Начальный объём — рендер знает, сколько обломков рассыпать. */
  initial: number
  reserved: boolean
}

export interface CatView {
  id: string
  cell: Cell
  /** Откуда пришёл в `cell`; null в начале и после загрузки. Для сглаживания. */
  prev: Cell | null
  /** Следующая клетка; рендер интерполирует между ними. */
  next: Cell | null
  /**
   * Ближайшие клетки маршрута, начиная с `next`. Рендер ведёт кота по
   * плавной кривой через их центры, а не по лесенке A*; симуляция при этом
   * остаётся дискретной.
   */
  route: Cell[]
  /** 0..1, приводится к float только здесь. */
  progress: number
  /**
   * Сколько модельных мс длится шаг cell → next (0, если шага нет). Рендер
   * ведёт по нему позицию между снапшотами: закон стоимости шага — дело
   * ядра, рендер знает только длительность.
   */
  stepMs: number
  facing: Dir
  /** Единственный источник выбора анимации. Ввод игрока на него не влияет. */
  action: 'idle' | 'walk' | 'work' | 'haul' | 'dump'
  /** Цель внимания — для поворота головы. */
  lookAt: Cell | null
  /** Одна строка, всегда актуальная. Почему кот делает то, что делает. */
  status: string
  load: number
  capacity: number
}

export interface Snapshot {
  tick: number
  cats: CatView[]
  piles: PileView[]
  zone: { cell: Cell; radius: number } | null
  totals: { remaining: number; collected: number }
}

export type WorkerMessage =
  | { t: 'world'; world: WorldView }
  | { t: 'snapshot'; snap: Snapshot }
