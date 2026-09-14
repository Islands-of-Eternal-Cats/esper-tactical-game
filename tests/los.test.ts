/**
 * Видимость и укрытие — таблица случаев на маленькой сетке.
 *
 * Укрытие — невидимая механика, пока не проверено, что оно есть ровно там,
 * где игрок его ожидает: за стеной от стрелка, и нигде больше.
 */
import { describe, expect, it } from 'vitest'
import { Grid } from '../src/core/grid'
import { hitChance } from '../src/core/combat'
import { coverFrom, lineOfSight } from '../src/core/los'
import { weaponOf } from '../src/core/weapons'

/** Стена по x=5 на y=0..9 с проёмом в y=4. */
function wallWithGap(): Grid {
  const g = new Grid(12, 10)
  for (let y = 0; y < 10; y++) if (y !== 4) g.setBlocked(5, y, true)
  return g
}

describe('линия видимости', () => {
  it('в пустом дворе видно всё', () => {
    const g = new Grid(12, 10)
    expect(lineOfSight(g, { x: 0, y: 0 }, { x: 11, y: 9 })).toBe(true)
  })

  it('через проём видно, мимо проёма — нет', () => {
    const g = wallWithGap()
    expect(lineOfSight(g, { x: 1, y: 4 }, { x: 10, y: 4 })).toBe(true)
    expect(lineOfSight(g, { x: 1, y: 2 }, { x: 10, y: 2 })).toBe(false)
  })

  it('косая линия через проём проходит, если не задевает стену', () => {
    const g = wallWithGap()
    expect(lineOfSight(g, { x: 3, y: 4 }, { x: 7, y: 4 })).toBe(true)
    expect(lineOfSight(g, { x: 0, y: 4 }, { x: 10, y: 8 })).toBe(false)
  })

  it('симметрична', () => {
    const g = wallWithGap()
    for (const [a, b] of [
      [{ x: 1, y: 4 }, { x: 10, y: 5 }],
      [{ x: 2, y: 3 }, { x: 9, y: 6 }],
      [{ x: 4, y: 1 }, { x: 6, y: 7 }],
    ] as const) {
      expect(lineOfSight(g, a, b)).toBe(lineOfSight(g, b, a))
    }
  })

  it('симметрична на всём дворе, включая углы', () => {
    const g = wallWithGap()
    g.setBlocked(3, 7, true)
    g.setBlocked(8, 2, true)
    const cells: { x: number; y: number }[] = []
    for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) if (!g.isBlocked(x, y)) cells.push({ x, y })
    for (const a of cells) for (const b of cells) {
      if (lineOfSight(g, a, b) !== lineOfSight(g, b, a)) throw new Error(`несимметрично: ${a.x},${a.y} ↔ ${b.x},${b.y}`)
    }
  })

  it('соседей видно всегда', () => {
    const g = wallWithGap()
    expect(lineOfSight(g, { x: 4, y: 4 }, { x: 5, y: 4 })).toBe(true)
    expect(lineOfSight(g, { x: 4, y: 3 }, { x: 4, y: 4 })).toBe(true)
  })
})

describe('укрытие', () => {
  it('за стеной от стрелка — укрыт, с открытой стороны — нет', () => {
    const g = wallWithGap()
    const cell = { x: 4, y: 2 }
    expect(coverFrom(g, cell, { x: 9, y: 2 })).toBe(true)
    expect(coverFrom(g, cell, { x: 0, y: 2 })).toBe(false)
  })

  it('косой стрелок с той же стороны стены — тоже укрытие', () => {
    const g = wallWithGap()
    const cell = { x: 4, y: 2 }
    expect(coverFrom(g, cell, { x: 9, y: 6 })).toBe(true)
    expect(coverFrom(g, cell, { x: 8, y: 0 })).toBe(true)
  })

  it('стрелок вдоль стены — укрытия нет', () => {
    const g = wallWithGap()
    const cell = { x: 4, y: 2 }
    expect(coverFrom(g, cell, { x: 4, y: 8 })).toBe(false)
    expect(coverFrom(g, cell, { x: 4, y: 0 })).toBe(false)
  })

  it('на клетке без соседей-препятствий укрытия нет ни с одной стороны', () => {
    const g = wallWithGap()
    const cell = { x: 1, y: 7 }
    for (const from of [{ x: 10, y: 7 }, { x: 1, y: 0 }, { x: 3, y: 9 }, { x: 0, y: 5 }]) {
      expect(coverFrom(g, cell, from)).toBe(false)
    }
  })

  it('угол закрывает диагональ', () => {
    const g = new Grid(6, 6)
    g.setBlocked(3, 3, true)
    expect(coverFrom(g, { x: 2, y: 2 }, { x: 5, y: 5 })).toBe(true)
    expect(coverFrom(g, { x: 2, y: 2 }, { x: 0, y: 0 })).toBe(false)
  })
})

describe('шанс попадания', () => {
  const w = weaponOf('rifle')

  it('в упор без укрытия — базовый', () => {
    expect(hitChance(w, 0, false)).toBe(w.hitBase)
  })

  it('падает с дальностью и режется укрытием', () => {
    const at8 = hitChance(w, 80, false)
    expect(at8).toBe(w.hitBase + w.hitPerCell * 8)
    expect(hitChance(w, 80, true)).toBe(Math.trunc((at8 * w.coverMul) / 1000))
  })

  it('не выходит за 0..1000', () => {
    expect(hitChance(w, 10000, false)).toBe(0)
    expect(hitChance(w, 0, true)).toBeLessThanOrEqual(1000)
  })
})
