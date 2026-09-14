/**
 * Сетка двора: клетки, соседство, A*.
 *
 * Сетку игрок не видит. Она существует ради того, чтобы резервирование было
 * однозначным, столкновения решались занятостью клетки, а зона приоритета
 * была просто множеством клеток в радиусе.
 */

import type { Cell, Dir } from '../shared/protocol'

/** Целочисленные стоимости шага: диагональ ≈ 1,4 прямого. */
export const ORTHO = 10
export const DIAG = 14

interface Offset {
  dx: number
  dy: number
  cost: number
  dir: Dir
}

/**
 * Фиксированный порядок обхода соседей. Порядок здесь — часть детерминизма:
 * при равной стоимости путь должен выбираться один и тот же всегда.
 */
const OFFSETS: readonly Offset[] = [
  { dx: 0, dy: -1, cost: ORTHO, dir: 'n' },
  { dx: 1, dy: -1, cost: DIAG, dir: 'ne' },
  { dx: 1, dy: 0, cost: ORTHO, dir: 'e' },
  { dx: 1, dy: 1, cost: DIAG, dir: 'se' },
  { dx: 0, dy: 1, cost: ORTHO, dir: 's' },
  { dx: -1, dy: 1, cost: DIAG, dir: 'sw' },
  { dx: -1, dy: 0, cost: ORTHO, dir: 'w' },
  { dx: -1, dy: -1, cost: DIAG, dir: 'nw' },
]

export function sameCell(a: Cell, b: Cell): boolean {
  return a.x === b.x && a.y === b.y
}

/** Направление одного шага между соседними клетками. */
export function dirOf(from: Cell, to: Cell): Dir | null {
  const dx = Math.sign(to.x - from.x)
  const dy = Math.sign(to.y - from.y)
  for (const o of OFFSETS) if (o.dx === dx && o.dy === dy) return o.dir
  return null
}

/** Стоимость одного шага между соседними клетками, в единицах ORTHO/DIAG. */
export function stepCost(from: Cell, to: Cell): number {
  return from.x !== to.x && from.y !== to.y ? DIAG : ORTHO
}

/** Октильное расстояние — допустимая эвристика для восьми направлений. */
export function octile(a: Cell, b: Cell): number {
  const dx = Math.abs(a.x - b.x)
  const dy = Math.abs(a.y - b.y)
  return ORTHO * (dx + dy) + (DIAG - 2 * ORTHO) * Math.min(dx, dy)
}

export class Grid {
  readonly width: number
  readonly height: number
  private readonly blocked: Uint8Array

  // Буферы A* живут вместе с сеткой: поиск пути случается часто, а сетка одна.
  private readonly g: Int32Array
  private readonly f: Int32Array
  private readonly parent: Int32Array
  private readonly stamp: Int32Array
  private readonly closed: Uint8Array
  private generation = 0
  private heap: number[] = []

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    const n = width * height
    this.blocked = new Uint8Array(n)
    this.g = new Int32Array(n)
    this.f = new Int32Array(n)
    this.parent = new Int32Array(n)
    this.stamp = new Int32Array(n)
    this.closed = new Uint8Array(n)
  }

  idx(x: number, y: number): number {
    return y * this.width + x
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height
  }

  isBlocked(x: number, y: number): boolean {
    return !this.inBounds(x, y) || this.blocked[this.idx(x, y)] === 1
  }

  isWalkable(c: Cell): boolean {
    return !this.isBlocked(c.x, c.y)
  }

  setBlocked(x: number, y: number, value: boolean): void {
    if (this.inBounds(x, y)) this.blocked[this.idx(x, y)] = value ? 1 : 0
  }

  /**
   * Диагональ разрешена, только когда обе смежные прямые клетки свободны:
   * кот не проходит сквозь угол между двумя стенами.
   */
  private canStep(x: number, y: number, o: Offset): boolean {
    const nx = x + o.dx
    const ny = y + o.dy
    if (this.isBlocked(nx, ny)) return false
    if (o.dx !== 0 && o.dy !== 0) {
      if (this.isBlocked(x + o.dx, y)) return false
      if (this.isBlocked(x, y + o.dy)) return false
    }
    return true
  }

  /** Соседние проходимые клетки в фиксированном порядке обхода. */
  neighbours(cell: Cell): Cell[] {
    const out: Cell[] = []
    for (const o of OFFSETS) {
      if (this.canStep(cell.x, cell.y, o)) out.push({ x: cell.x + o.dx, y: cell.y + o.dy })
    }
    return out
  }

  /**
   * Достижима ли `b` из `a` одним шагом. Диагональ через угол между двумя
   * стенами не считается соседством: иначе кот дотянулся бы сквозь стену.
   */
  isNeighbour(a: Cell, b: Cell): boolean {
    const dx = b.x - a.x
    const dy = b.y - a.y
    for (const o of OFFSETS) {
      if (o.dx === dx && o.dy === dy) return this.canStep(a.x, a.y, o)
    }
    return false
  }

  /**
   * Путь от `from` до `to`, не включая `from` и включая `to`.
   * `[]` — уже на месте. `null` — пути нет.
   */
  findPath(from: Cell, to: Cell): Cell[] | null {
    if (!this.inBounds(from.x, from.y) || !this.inBounds(to.x, to.y)) return null
    if (this.isBlocked(to.x, to.y)) return null
    if (sameCell(from, to)) return []

    const gen = ++this.generation
    const start = this.idx(from.x, from.y)
    const goal = this.idx(to.x, to.y)

    this.heap.length = 0
    this.stamp[start] = gen
    this.closed[start] = 0
    this.g[start] = 0
    this.f[start] = octile(from, to)
    this.parent[start] = -1
    this.heapPush(start)

    while (this.heap.length > 0) {
      const cur = this.heapPop()
      if (cur === goal) return this.rebuild(start, goal)
      if (this.closed[cur] === 1) continue
      this.closed[cur] = 1

      const cx = cur % this.width
      const cy = (cur - cx) / this.width
      const cg = this.g[cur]!

      for (const o of OFFSETS) {
        if (!this.canStep(cx, cy, o)) continue
        const n = this.idx(cx + o.dx, cy + o.dy)
        if (this.stamp[n] === gen && this.closed[n] === 1) continue

        const ng = cg + o.cost
        if (this.stamp[n] === gen && ng >= this.g[n]!) continue

        this.stamp[n] = gen
        this.closed[n] = 0
        this.g[n] = ng
        this.f[n] = ng + octile({ x: cx + o.dx, y: cy + o.dy }, to)
        this.parent[n] = cur
        this.heapPush(n)
      }
    }
    return null
  }

  /**
   * Путь к клетке или, если она занята, к ближайшей свободной рядом с ней.
   *
   * Клик по стене или контейнеру — тоже намерение: идти туда настолько,
   * насколько можно, а не отказываться.
   */
  findPathNear(from: Cell, to: Cell): Cell[] | null {
    if (!this.isBlocked(to.x, to.y)) return this.findPath(from, to)
    let best: Cell[] | null = null
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        const path = this.findPath(from, { x: to.x + dx, y: to.y + dy })
        if (path !== null && (best === null || path.length < best.length)) best = path
      }
    }
    return best
  }

  private rebuild(start: number, goal: number): Cell[] {
    const out: Cell[] = []
    let n = goal
    while (n !== start) {
      const x = n % this.width
      out.push({ x, y: (n - x) / this.width })
      n = this.parent[n]!
    }
    out.reverse()
    return out
  }

  /**
   * Сравнение узлов кучи. При равном f порядок задаётся индексом клетки —
   * иначе порядок извлечения зависел бы от истории вставок, а он должен
   * зависеть только от состояния.
   */
  private less(a: number, b: number): boolean {
    const fa = this.f[a]!
    const fb = this.f[b]!
    return fa !== fb ? fa < fb : a < b
  }

  private heapPush(n: number): void {
    const h = this.heap
    h.push(n)
    let i = h.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (!this.less(h[i]!, h[p]!)) break
      const t = h[i]!
      h[i] = h[p]!
      h[p] = t
      i = p
    }
  }

  private heapPop(): number {
    const h = this.heap
    const top = h[0]!
    const last = h.pop()!
    if (h.length > 0) {
      h[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < h.length && this.less(h[l]!, h[m]!)) m = l
        if (r < h.length && this.less(h[r]!, h[m]!)) m = r
        if (m === i) break
        const t = h[i]!
        h[i] = h[m]!
        h[m] = t
        i = m
      }
    }
    return top
  }
}
