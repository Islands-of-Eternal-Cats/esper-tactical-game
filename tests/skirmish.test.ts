/**
 * Бой на том же ядре: детерминизм, завершаемость, различие от сида.
 *
 * Тест детерминизма здесь должен упасть первым, если в бой попадёт float
 * или Math.random. Завершаемость ловит юнита, застрявшего в поиске укрытия
 * навсегда.
 */
import { describe, expect, it } from 'vitest'
import { Sim } from '../src/core/sim'
import type { Snapshot } from '../src/shared/protocol'

/** 150 с модельного времени: бой обязан кончиться раньше в разы. */
const LIMIT = 3000

function alive(snap: Snapshot): Set<string> {
  return new Set(snap.units.filter((u) => u.action !== 'dead').map((u) => u.side))
}

/** Тики до конца боя; бросает, если он не кончился. */
function fight(sim: Sim, limit = LIMIT): number {
  for (let t = 0; t < limit; t++) {
    sim.tick()
    if (alive(sim.snapshot()).size < 2) return t
  }
  throw new Error('бой не кончился')
}

function runInBatches(seed: number, ticks: number, batch: number): number {
  const sim = new Sim(seed, 'skirmish')
  let done = 0
  while (done < ticks) {
    const n = Math.min(batch, ticks - done)
    for (let i = 0; i < n; i++) sim.tick()
    done += n
    sim.snapshot()
  }
  return sim.hash()
}

describe('детерминизм боя', () => {
  it('×1 и ×3 дают одинаковое состояние', () => {
    expect(runInBatches(7, 2000, 1)).toBe(runInBatches(7, 2000, 3))
  })

  it('приказы в одном и том же тике не ломают воспроизводимость', () => {
    const run = (batch: number): number => {
      const sim = new Sim(11, 'skirmish')
      for (let t = 0; t < 2400; t += batch) {
        for (let i = 0; i < batch; i++) {
          if (t + i === 40) sim.move(['a1', 'a2'], { x: 10, y: 11 })
          if (t + i === 300) sim.halt(['a1'])
          if (t + i === 600) sim.move(['a2'], { x: 2, y: 2 })
          sim.tick()
        }
      }
      return sim.hash()
    }
    expect(run(1)).toBe(run(3))
  })

  it('сохранение посреди боя восстанавливает исход', () => {
    const sim = new Sim(5, 'skirmish')
    for (let i = 0; i < 300; i++) sim.tick()
    const save = JSON.parse(JSON.stringify(sim.serialize())) as ReturnType<Sim['serialize']>
    for (let i = 0; i < 400; i++) sim.tick()
    const restored = Sim.load(save)
    expect(restored.mode).toBe('skirmish')
    for (let i = 0; i < 400; i++) restored.tick()
    expect(restored.hash()).toBe(sim.hash())
  })
})

describe('завершаемость и разнообразие', () => {
  it('от десяти сидов бой заканчивается, и по-разному', () => {
    const outcomes = new Set<number>()
    for (let seed = 1; seed <= 10; seed++) {
      const sim = new Sim(seed, 'skirmish')
      const ticks = fight(sim)
      // Не мгновенно и не вечно: от 15 секунд до предела.
      expect(ticks).toBeGreaterThan(300)
      outcomes.add(sim.hash())
    }
    expect(outcomes.size).toBeGreaterThan(5)
  })

  it('от одного сида — одинаково', () => {
    const a = new Sim(3, 'skirmish')
    const b = new Sim(3, 'skirmish')
    expect(fight(a)).toBe(fight(b))
    expect(a.hash()).toBe(b.hash())
  })

  it('без единого приказа бой тоже кончается: противник наступает сам', () => {
    const sim = new Sim(21, 'skirmish')
    fight(sim)
    const snap = sim.snapshot()
    expect(snap.units.some((u) => u.action === 'dead')).toBe(true)
  })

  it('решение игрока «куда послать» видно на исходе', () => {
    const idle = new Sim(4, 'skirmish')
    fight(idle)
    const ordered = new Sim(4, 'skirmish')
    // Отряд встречает противника у прохода, а не ждёт на месте.
    ordered.move(['a1', 'a2'], { x: 11, y: 12 })
    fight(ordered)
    expect(ordered.hash()).not.toBe(idle.hash())
  })
})

describe('юнит объясняет себя', () => {
  it('строка состояния всегда непуста, и укрытие отмечено', () => {
    const sim = new Sim(9, 'skirmish')
    let covered = 0
    for (let i = 0; i < 1500; i++) {
      sim.tick()
      const snap = sim.snapshot()
      for (const u of snap.units) {
        expect(u.status.length).toBeGreaterThan(0)
        if (u.cover) covered++
      }
    }
    expect(covered).toBeGreaterThan(0)
  })

  it('приказ идти ставит move и очищает цель; halt — останавливает', () => {
    const sim = new Sim(2, 'skirmish')
    for (let i = 0; i < 200; i++) sim.tick()
    sim.move(['a1'], { x: 8, y: 2 })
    const going = sim.snapshot().units.find((u) => u.id === 'a1')!
    expect(going.action).toBe('move')
    expect(going.target).toBeNull()
    expect(going.status).toBe('выдвигается')
    sim.tick()
    sim.halt(['a1'])
    sim.tick()
    const halted = sim.snapshot().units.find((u) => u.id === 'a1')!
    expect(halted.route.length).toBeLessThanOrEqual(1)
  })

  it('события — выстрелы и смерти — приходят и не повторяются', () => {
    const sim = new Sim(6, 'skirmish')
    let shots = 0
    let deaths = 0
    for (let i = 0; i < LIMIT; i++) {
      sim.tick()
      const snap = sim.snapshot()
      for (const e of snap.events) {
        if (e.t === 'shot') shots++
        else deaths++
      }
      if (alive(snap).size < 2) break
    }
    expect(shots).toBeGreaterThan(0)
    expect(deaths).toBeGreaterThanOrEqual(2)
    expect(sim.snapshot().events).toHaveLength(0)
  })
})

describe('двор без боя', () => {
  it('в режиме yard юнитов нет, а в skirmish нет кота и куч', () => {
    expect(new Sim(1).snapshot().units).toHaveLength(0)
    const s = new Sim(1, 'skirmish').snapshot()
    expect(s.cats).toHaveLength(0)
    expect(s.piles).toHaveLength(0)
    expect(s.units).toHaveLength(4)
  })
})

describe('занятость клеток', () => {
  it('двое живых никогда не стоят в одной клетке', () => {
    for (const seed of [1, 4, 8]) {
      const sim = new Sim(seed, 'skirmish')
      // Обоих в одну клетку — самый верный способ столкнуть.
      sim.move(['a1', 'a2'], { x: 10, y: 11 })
      for (let t = 0; t < LIMIT; t++) {
        sim.tick()
        const live = sim.snapshot().units.filter((u) => u.action !== 'dead')
        const cells = new Set(live.map((u) => `${u.cell.x},${u.cell.y}`))
        expect(cells.size).toBe(live.length)
        if (alive(sim.snapshot()).size < 2) break
      }
    }
  })
})
