/**
 * Линия видимости и укрытие — две функции над сеткой.
 *
 * Всё дискретное: линия между центрами клеток по Брезенхему, укрытие —
 * свойство клетки относительно направления. Предвычислять нечего: четыре
 * юнита на четыре цели двадцать раз в секунду — копейки.
 */

import type { Cell } from '../shared/protocol'
import type { Grid } from './grid'

/**
 * Видна ли `b` из `a`: стена или пропс на отрезке между центрами закрывают.
 * Сами концы не проверяются — стрелок и цель стоят на проходимых клетках.
 */
export function lineOfSight(grid: Grid, a: Cell, b: Cell): boolean {
  let x = a.x
  let y = a.y
  const dx = Math.abs(b.x - a.x)
  const dy = -Math.abs(b.y - a.y)
  const sx = a.x < b.x ? 1 : -1
  const sy = a.y < b.y ? 1 : -1
  let err = dx + dy
  for (;;) {
    if (x === b.x && y === b.y) return true
    const e2 = 2 * err
    if (e2 >= dy) {
      err += dy
      x += sx
    }
    if (e2 <= dx) {
      err += dx
      y += sy
    }
    if (x === b.x && y === b.y) return true
    if (grid.isBlocked(x, y)) return false
  }
}

/**
 * Укрыта ли `cell` от стрелка в `from`.
 *
 * Укрытие — препятствие в соседней клетке со стороны стрелка. Для косого
 * направления считается и диагональный сосед, и сосед по главной оси: за
 * стеной, стоящей вдоль, юнит укрыт от всех, кто стреляет с той стороны,
 * а не только от тех, кто стоит строго напротив.
 */
export function coverFrom(grid: Grid, cell: Cell, from: Cell): boolean {
  const dx = from.x - cell.x
  const dy = from.y - cell.y
  if (dx === 0 && dy === 0) return false
  const sx = Math.sign(dx)
  const sy = Math.sign(dy)
  if (grid.isBlocked(cell.x + sx, cell.y + sy)) return true
  if (Math.abs(dx) > Math.abs(dy) && sy !== 0 && grid.isBlocked(cell.x + sx, cell.y)) return true
  if (Math.abs(dy) > Math.abs(dx) && sx !== 0 && grid.isBlocked(cell.x, cell.y + sy)) return true
  return false
}
