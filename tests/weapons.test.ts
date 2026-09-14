/**
 * weapons.yaml — конфиг, а конфиг ломают чаще кода. Загрузчик проверяет
 * форму; здесь — что каждое оружие в игре осмысленно и отличимо.
 */

import { describe, expect, it } from 'vitest'
import { hitChance } from '../src/core/combat'
import { ORTHO } from '../src/core/grid'
import { WEAPONS, weaponOf } from '../src/core/weapons'

describe('оружие', () => {
  it('раскладка среза ссылается только на известное', () => {
    for (const id of ['rifle', 'smg', 'shotgun', 'sniper']) expect(weaponOf(id).id).toBe(id)
    expect(() => weaponOf('bazooka')).toThrow()
  })

  it('на предельной дальности ещё есть шанс попасть', () => {
    for (const w of WEAPONS.values()) {
      expect(hitChance(w, w.fireRange * ORTHO, false), w.id).toBeGreaterThan(0)
    }
  })

  it('укрытие режет шанс у каждого', () => {
    for (const w of WEAPONS.values()) {
      expect(hitChance(w, ORTHO, true), w.id).toBeLessThan(hitChance(w, ORTHO, false))
    }
  })

  it('нет двух одинаковых', () => {
    const seen = new Set<string>()
    for (const w of WEAPONS.values()) {
      const key = [w.fireRange, w.reloadMs, w.hitBase, w.hitPerCell, w.damage].join('/')
      expect(seen.has(key), w.id).toBe(false)
      seen.add(key)
    }
  })
})
