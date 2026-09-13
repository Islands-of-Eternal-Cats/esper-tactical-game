/**
 * Раскладка двора.
 *
 * Стены заданы руками и одинаковы всегда: они существуют, чтобы проверить
 * перекрытия, обход препятствий и сортировку по глубине, а не чтобы удивлять.
 * Сид разбрасывает мусор — это единственное, что меняется от прохода к проходу.
 */

import type { Cell, PropView } from '../shared/protocol'
import { UNIT } from './fixed'
import { Grid } from './grid'
import { Rng } from './rng'
import type { Pile } from './state'
import { GRID_H, GRID_W, PILES_MAX, PILES_MIN, PILE_VOL_MAX, PILE_VOL_MIN } from './tuning'

interface Block {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Три-четыре блока: коридоры между ними и заставляют кота обходить. */
const BLOCKS: readonly Block[] = [
  { x0: 4, y0: 5, x1: 8, y1: 6 },
  { x0: 13, y0: 3, x1: 14, y1: 9 },
  { x0: 5, y0: 12, x1: 6, y1: 16 },
  { x0: 10, y0: 14, x1: 16, y1: 15 },
]

/**
 * Реквизит на полу: бочки, ящики, тележка, поддон. Тоже заданы руками и
 * тоже препятствия — кот их обходит, а мусор у них скапливается, как у
 * стен. Стоят у ограды и у торцов блоков, где такому и место; вокруг
 * контейнера и в углах, куда тесты и отладка шлют кота, — пусто.
 */
const PROPS: readonly PropView[] = [
  { cell: { x: 0, y: 3 }, kind: 'barrels', turn: 0 },
  { cell: { x: 0, y: 4 }, kind: 'barrels', turn: 1 },
  { cell: { x: 0, y: 10 }, kind: 'crates', turn: 0 },
  { cell: { x: 9, y: 0 }, kind: 'cart', turn: 1 },
  { cell: { x: 15, y: 0 }, kind: 'pallet', turn: 0 },
  { cell: { x: 9, y: 6 }, kind: 'crates', turn: 2 },
  { cell: { x: 13, y: 10 }, kind: 'barrels', turn: 2 },
  { cell: { x: 19, y: 8 }, kind: 'cart', turn: 3 },
  { cell: { x: 3, y: 18 }, kind: 'pallet', turn: 1 },
]

export const CONTAINER: Cell = { x: 17, y: 17 }

export function buildGrid(): { grid: Grid; walls: Cell[]; props: PropView[] } {
  const grid = new Grid(GRID_W, GRID_H)
  const walls: Cell[] = []
  for (const b of BLOCKS) {
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = b.x0; x <= b.x1; x++) {
        grid.setBlocked(x, y, true)
        walls.push({ x, y })
      }
    }
  }
  const props = PROPS.map((p) => ({ ...p, cell: { ...p.cell } }))
  for (const p of props) grid.setBlocked(p.cell.x, p.cell.y, true)
  return { grid, walls, props }
}

/** Клетки, куда кот вообще может дойти от контейнера. */
function reachableFrom(grid: Grid, from: Cell): Uint8Array {
  const seen = new Uint8Array(grid.width * grid.height)
  const queue: Cell[] = [from]
  seen[grid.idx(from.x, from.y)] = 1
  for (let head = 0; head < queue.length; head++) {
    const c = queue[head]!
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        const nx = c.x + dx
        const ny = c.y + dy
        if (grid.isBlocked(nx, ny)) continue
        // Тот же запрет на срезание углов, что и в поиске пути: иначе флуд
        // объявит достижимым то, куда A* не проведёт.
        if (dx !== 0 && dy !== 0 && (grid.isBlocked(c.x + dx, c.y) || grid.isBlocked(c.x, c.y + dy))) continue
        const i = grid.idx(nx, ny)
        if (seen[i] === 1) continue
        seen[i] = 1
        queue.push({ x: nx, y: ny })
      }
    }
  }
  return seen
}

function blockedNeighbours(grid: Grid, x: number, y: number): number {
  let n = 0
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue
      if (grid.isBlocked(x + dx, y + dy)) n++
    }
  }
  return n
}

function shuffle<T>(items: T[], rng: Rng): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.int(i + 1)
    const t = items[i]!
    items[i] = items[j]!
    items[j] = t
  }
}

/**
 * Мусор скапливается у стен и в углах, а не лежит ровным полем.
 * Так двор читается, а кот вынужден обходить препятствия — заодно бесплатно
 * проверяются поиск пути и сортировка по глубине.
 */
export function placePiles(grid: Grid, rng: Rng, container: Cell): Pile[] {
  const reachable = reachableFrom(grid, container)
  const corners: Cell[] = []
  const edges: Cell[] = []

  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (grid.isBlocked(x, y)) continue
      if (reachable[grid.idx(x, y)] !== 1) continue
      // Вокруг контейнера чисто: иначе первая же куча обесценивает ходку.
      if (Math.abs(x - container.x) <= 1 && Math.abs(y - container.y) <= 1) continue
      const n = blockedNeighbours(grid, x, y)
      if (n >= 3) corners.push({ x, y })
      else if (n >= 1) edges.push({ x, y })
    }
  }

  shuffle(corners, rng)
  shuffle(edges, rng)

  const total = rng.range(PILES_MIN, PILES_MAX)
  const wantCorners = Math.min(corners.length, Math.round(total * 0.4))
  const chosen = [...corners.slice(0, wantCorners), ...edges.slice(0, total - wantCorners)]

  // Порядок в массиве куч не должен зависеть от того, из какого пула они
  // пришли: id назначаются после сортировки по позиции.
  chosen.sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x))

  return chosen.map((cell, i) => {
    const volume = rng.range(PILE_VOL_MIN, PILE_VOL_MAX) * UNIT
    return {
      id: `p${String(i).padStart(2, '0')}`,
      cell,
      volume,
      initial: volume,
      reservedBy: null,
    }
  })
}
