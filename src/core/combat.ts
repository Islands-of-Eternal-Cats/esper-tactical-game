/**
 * Выстрел: шанс, бросок, урон.
 *
 * Шанс — целое в тысячных, дальность — октиль в единицах ORTHO. Всё
 * целочисленное, и бросок ГПСЧ — единственное место, где бой случаен.
 * Числа — у оружия (`weapons.yaml`), формула — здесь.
 */

import { ORTHO } from './grid'
import type { Rng } from './rng'
import type { Weapon } from './weapons'

/** Шанс попадания в тысячных: базовый × дальность × укрытие. */
export function hitChance(w: Weapon, octileDistance: number, cover: boolean): number {
  // hitPerCell — на клетку; октиль — в десятых клетки. Делится нацело,
  // пока hitPerCell кратен ORTHO; иначе усечение, и это тоже детерминизм.
  let chance = w.hitBase + Math.trunc((w.hitPerCell * octileDistance) / ORTHO)
  if (cover) chance = Math.trunc((chance * w.coverMul) / 1000)
  return Math.max(0, Math.min(1000, chance))
}

/** Бросок против шанса. Ровно одно обращение к ГПСЧ на выстрел. */
export function rollHit(rng: Rng, chance: number): boolean {
  return rng.int(1000) < chance
}
