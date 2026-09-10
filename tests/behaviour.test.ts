/**
 * Правила, ради которых срез существует.
 *
 * Момент истины наступает там, где Ржавый не подчиняется мгновенно. Здесь
 * проверяется, что он не подчиняется по правилу, а не по случайности —
 * читается это как характер или как баг, решает уже живой человек.
 */
import { describe, expect, it } from 'vitest'
import { Sim } from '../src/core/sim'
import type { CatView, Snapshot } from '../src/shared/protocol'
import { NEARLY_DONE_UNITS, VACUUM_CAPACITY } from '../src/core/tuning'

function cat(snap: Snapshot): CatView {
  return snap.cats[0]!
}

/** Экранное положение кота: то, что видит игрок, а не клетка состояния. */
function place(view: CatView): { x: number; y: number } {
  if (view.next === null) return { x: view.cell.x, y: view.cell.y }
  return {
    x: view.cell.x + (view.next.x - view.cell.x) * view.progress,
    y: view.cell.y + (view.next.y - view.cell.y) * view.progress,
  }
}

function octile(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = Math.abs(a.x - b.x)
  const dy = Math.abs(a.y - b.y)
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)
}

/** Крутит симуляцию, пока не выполнится условие. Возвращает снапшот. */
function until(sim: Sim, pred: (s: Snapshot) => boolean, limit = 20000): Snapshot {
  for (let i = 0; i < limit; i++) {
    const snap = sim.snapshot()
    if (pred(snap)) return snap
    sim.tick()
  }
  throw new Error('условие не наступило за отведённые тики')
}

describe('автономный цикл', () => {
  it('двор убирается полностью и без тупика', () => {
    const sim = new Sim(3)
    const start = sim.snapshot().totals.remaining
    expect(start).toBeGreaterThan(0)

    const end = until(sim, (s) => s.totals.remaining === 0 && s.cats[0]!.load === 0, 200000)
    expect(end.piles).toHaveLength(0)
    expect(end.totals.collected).toBeCloseTo(start, 6)
  })

  it('кот резервирует кучу, за которую взялся', () => {
    const sim = new Sim(3)
    const snap = until(sim, (s) => s.cats[0]!.action === 'work')
    expect(snap.piles.filter((p) => p.reserved)).toHaveLength(1)
  })

  it('полный пылесос отправляет к контейнеру', () => {
    const sim = new Sim(3)
    const snap = until(sim, (s) => s.cats[0]!.action === 'haul')
    expect(cat(snap).load).toBeGreaterThanOrEqual(VACUUM_CAPACITY)
    expect(cat(snap).status).toBe('пылесос полон, иду к контейнеру')
  })

  it('опустошение возвращает пылесос в ноль', () => {
    const sim = new Sim(3)
    until(sim, (s) => s.cats[0]!.action === 'dump')
    const after = until(sim, (s) => s.cats[0]!.load === 0)
    expect(cat(after).load).toBe(0)
    expect(after.totals.collected).toBeGreaterThan(0)
  })
})

describe('клик — намерение, а не маршрут', () => {
  it('кот не бросает почти доубранную кучу', () => {
    const sim = new Sim(3)
    // Ждём момент, когда он работает и кучи осталось меньше порога.
    // Кот работает, стоя рядом с кучей, поэтому кучу опознаём по вниманию.
    const snap = until(sim, (s) => {
      const c = s.cats[0]!
      if (c.action !== 'work' || c.lookAt === null) return false
      const pile = s.piles.find((p) => p.cell.x === c.lookAt!.x && p.cell.y === c.lookAt!.y)
      return pile !== undefined && pile.volume <= NEARLY_DONE_UNITS && pile.volume > 0.2
    })
    const at = cat(snap).lookAt!
    const held = snap.piles.find((p) => p.cell.x === at.x && p.cell.y === at.y)!

    // Приоритет в дальний угол, заведомо вне этой кучи.
    const far = held.cell.x < 10 ? { x: 18, y: 18 } : { x: 1, y: 1 }
    sim.setZone(far, 3)

    // Он доканчивает начатое, а не срывается по клику.
    const next = sim.snapshot()
    expect(next.cats[0]!.action).toBe('work')

    const done = until(sim, (s) => !s.piles.some((p) => p.id === held.id))
    expect(done.cats[0]!.action).not.toBe('work')
  })

  it('полный пылесос опустошается раньше, чем выполняется новый приоритет', () => {
    const sim = new Sim(3)
    until(sim, (s) => s.cats[0]!.action === 'haul')
    sim.setZone({ x: 2, y: 2 }, 4)
    // Приказ принят, но ходка к контейнеру не отменена.
    expect(cat(sim.snapshot()).action).toBe('haul')
    const atDump = until(sim, (s) => s.cats[0]!.action === 'dump')
    expect(atDump.zone).not.toBeNull()
  })

  it('на ходу к дальней куче приоритет перехватывается сразу', () => {
    const sim = new Sim(3)
    const walking = until(sim, (s) => s.cats[0]!.action === 'walk')
    const wasTarget = walking.cats[0]!.lookAt!

    const near = sim.snapshot().piles
      .slice()
      .sort((a, b) => {
        const c = walking.cats[0]!.cell
        const da = Math.abs(a.cell.x - c.x) + Math.abs(a.cell.y - c.y)
        const db = Math.abs(b.cell.x - c.x) + Math.abs(b.cell.y - c.y)
        return db - da
      })[0]!

    sim.setZone(near.cell, 2)
    const after = sim.snapshot()
    // Цель сменилась в том же тике, ничего доканчивать не нужно.
    expect(after.cats[0]!.lookAt).not.toEqual(wasTarget)
  })

  it('приказ посреди шага не дёргает кота назад', () => {
    const sim = new Sim(3)
    // Именно посреди шага: приказ в момент, когда кот стоит в центре клетки,
    // ничего сдвинуть и не мог бы.
    const walking = until(
      sim,
      (s) => s.cats[0]!.action === 'walk' && s.cats[0]!.progress > 0.3 && s.cats[0]!.next !== null,
    )
    const before = place(cat(walking))

    const far = sim.snapshot().piles
      .slice()
      .sort((a, b) => octile(b.cell, cat(walking).cell) - octile(a.cell, cat(walking).cell))[0]!
    sim.setZone(far.cell, 2)

    const moved = place(cat(sim.snapshot()))
    expect(Math.hypot(moved.x - before.x, moved.y - before.y)).toBeCloseTo(0, 6)
    // Начатый шаг не отменён: кот доходит до клетки, в которую уже ступил.
    expect(cat(sim.snapshot()).next).toEqual(walking.cats[0]!.next)
  })

  it('в пустой зоне кот доходит, осматривается и возвращается к своему порядку', () => {
    const sim = new Sim(3)
    // Угол двора, где мусора заведомо нет: рядом с контейнером чисто.
    sim.setZone({ x: 17, y: 17 }, 1)
    const surveying = until(sim, (s) => s.cats[0]!.status === 'осматривается')
    expect(surveying.zone).not.toBeNull()

    const back = until(sim, (s) => s.zone === null)
    expect(back.zone).toBeNull()
  })

  it('пока зона задана, кот не берёт кучи за её пределами', () => {
    const sim = new Sim(3)
    const first = until(sim, (s) => s.cats[0]!.action === 'work')
    const inZone = first.piles.filter(
      (p) => (p.cell.x - 4) ** 2 + (p.cell.y - 4) ** 2 <= 25,
    )
    if (inZone.length === 0) return // раскладка этого сида не подходит — не над чем проверять

    sim.setZone({ x: 4, y: 4 }, 5)
    const working = until(sim, (s) => {
      const c = s.cats[0]!
      return c.action === 'work' && c.status === 'убирает мусор'
    })
    // Проверяем кучу, а не кота: сам он стоит на соседней клетке и вполне
    // может оказаться на шаг за границей зоны.
    const at = working.cats[0]!.lookAt!
    expect((at.x - 4) ** 2 + (at.y - 4) ** 2).toBeLessThanOrEqual(25)
  })
})

describe('объяснимость', () => {
  it('строка состояния всегда непуста', () => {
    const sim = new Sim(9)
    for (let i = 0; i < 5000; i++) {
      expect(cat(sim.snapshot()).status.length).toBeGreaterThan(0)
      sim.tick()
    }
  })

  it('внимание направлено на то, чем кот занят', () => {
    const sim = new Sim(9)
    const working = until(sim, (s) => s.cats[0]!.action === 'work')
    const c = cat(working)
    const at = c.lookAt!
    expect(working.piles.some((p) => p.cell.x === at.x && p.cell.y === at.y)).toBe(true)
    // Рядом, а не поверх: иначе кот закрывает собой то, что убирает.
    expect(at).not.toEqual(c.cell)
    expect(Math.max(Math.abs(at.x - c.cell.x), Math.abs(at.y - c.cell.y))).toBe(1)
  })

  it('кот никогда не работает, стоя на куче', () => {
    const sim = new Sim(4)
    for (let i = 0; i < 30000; i++) {
      const c = sim.snapshot().cats[0]!
      if (c.action === 'work') {
        expect(c.lookAt).not.toEqual(c.cell)
      }
      sim.tick()
    }
  })
})
