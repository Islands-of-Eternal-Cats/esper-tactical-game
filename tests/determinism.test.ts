/**
 * Одинаковый сид на разных скоростях даёт одинаковый хеш состояния.
 *
 * Это автотест, а не ручная проверка, и он написан раньше, чем появилась
 * сцена: если детерминизм не держится, строить дальше нечего.
 *
 * Скорость в ядро не попадает вообще — она живёт в цикле воркера и означает
 * ровно «сколько тиков за кадр». Поэтому проверяется именно то, чем ×1
 * отличается от ×3: размер пачки тиков.
 */
import { describe, expect, it } from 'vitest'
import { Sim } from '../src/core/sim'

const TICKS = 4000

function runInBatches(seed: number, ticks: number, batch: number): number {
  const sim = new Sim(seed)
  let done = 0
  while (done < ticks) {
    const n = Math.min(batch, ticks - done)
    for (let i = 0; i < n; i++) sim.tick()
    done += n
    sim.snapshot() // снапшот не должен менять состояние
  }
  return sim.hash()
}

describe('детерминизм', () => {
  it('×1 и ×3 дают одинаковое состояние', () => {
    expect(runInBatches(7, TICKS, 1)).toBe(runInBatches(7, TICKS, 3))
  })

  it('пачка любого размера, вплоть до MAX_STEPS, ничего не меняет', () => {
    const base = runInBatches(7, TICKS, 1)
    for (const batch of [2, 3, 5, 8]) {
      expect(runInBatches(7, TICKS, batch)).toBe(base)
    }
  })

  it('один сид — один результат, разные сиды — разные', () => {
    expect(runInBatches(42, 1500, 1)).toBe(runInBatches(42, 1500, 1))
    expect(runInBatches(42, 1500, 1)).not.toBe(runInBatches(43, 1500, 1))
  })

  it('команды в одном и том же тике не ломают воспроизводимость', () => {
    const run = (batch: number): number => {
      const sim = new Sim(11)
      for (let t = 0; t < 3000; t += batch) {
        for (let i = 0; i < batch; i++) {
          if ((t + i) === 300) sim.setZone({ x: 4, y: 16 }, 4)
          if ((t + i) === 900) sim.setZone({ x: 16, y: 4 }, 4)
          if ((t + i) === 1800) sim.clearZone()
          sim.tick()
        }
      }
      return sim.hash()
    }
    expect(run(1)).toBe(run(3))
  })
})

describe('сохранение', () => {
  it('загрузка не позволяет перебросить зафиксированный исход', () => {
    const sim = new Sim(5)
    for (let i = 0; i < 1200; i++) sim.tick()
    const save = JSON.parse(JSON.stringify(sim.serialize())) as ReturnType<Sim['serialize']>

    for (let i = 0; i < 800; i++) sim.tick()
    const expected = sim.hash()

    const restored = Sim.load(save)
    for (let i = 0; i < 800; i++) restored.tick()
    expect(restored.hash()).toBe(expected)
  })

  it('состояние ГПСЧ восстанавливается вместе с состоянием', () => {
    const sim = new Sim(5)
    for (let i = 0; i < 700; i++) sim.tick()
    const restored = Sim.load(sim.serialize())
    expect(restored.hash()).toBe(sim.hash())
  })
})
