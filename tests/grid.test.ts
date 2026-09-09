import { describe, expect, it } from 'vitest'
import { Grid, octile, stepCost } from '../src/core/grid'

describe('сетка и поиск пути', () => {
  it('находит прямой путь в пустом дворе', () => {
    const g = new Grid(10, 10)
    const path = g.findPath({ x: 0, y: 0 }, { x: 3, y: 0 })
    expect(path).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ])
  })

  it('на месте — пустой путь, не null', () => {
    const g = new Grid(10, 10)
    expect(g.findPath({ x: 4, y: 4 }, { x: 4, y: 4 })).toEqual([])
  })

  it('обходит стену', () => {
    const g = new Grid(10, 10)
    for (let y = 0; y <= 7; y++) g.setBlocked(5, y, true)
    const path = g.findPath({ x: 1, y: 1 }, { x: 9, y: 1 })
    expect(path).not.toBeNull()
    expect(path!.some((c) => c.x === 5 && c.y >= 8)).toBe(true)
    expect(path!.every((c) => !g.isBlocked(c.x, c.y))).toBe(true)
  })

  it('в замурованную клетку пути нет', () => {
    const g = new Grid(10, 10)
    for (const [x, y] of [[8, 8], [9, 8], [8, 9]] as const) g.setBlocked(x, y, true)
    expect(g.findPath({ x: 0, y: 0 }, { x: 9, y: 9 })).toBeNull()
  })

  it('не срезает угол между двумя стенами', () => {
    const g = new Grid(5, 5)
    g.setBlocked(2, 1, true)
    g.setBlocked(1, 2, true)
    const path = g.findPath({ x: 1, y: 1 }, { x: 2, y: 2 })
    expect(path).not.toBeNull()
    // Диагональ 1,1 → 2,2 запрещена: путь обязан быть длиннее одного шага.
    expect(path!.length).toBeGreaterThan(1)
  })

  it('один и тот же путь при повторном поиске', () => {
    const g = new Grid(20, 20)
    for (let y = 3; y <= 12; y++) g.setBlocked(9, y, true)
    const a = g.findPath({ x: 0, y: 0 }, { x: 19, y: 19 })
    const b = g.findPath({ x: 0, y: 0 }, { x: 19, y: 19 })
    expect(a).toEqual(b)
  })

  it('октиль не переоценивает реальную стоимость', () => {
    const g = new Grid(12, 12)
    const from = { x: 0, y: 0 }
    const to = { x: 7, y: 4 }
    const path = g.findPath(from, to)!
    let cost = 0
    let cur = from
    for (const step of path) {
      cost += stepCost(cur, step)
      cur = step
    }
    expect(octile(from, to)).toBeLessThanOrEqual(cost)
  })
})
