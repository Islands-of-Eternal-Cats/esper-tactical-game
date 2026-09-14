/**
 * Выстрел: шанс, бросок, урон.
 *
 * Шанс — целое в тысячных, дальность — октиль в единицах ORTHO. Всё
 * целочисленное, и бросок ГПСЧ — единственное место, где бой случаен.
 */

import { ORTHO } from './grid'
import type { Rng } from './rng'
import { COVER_MUL, HIT_BASE, HIT_PER_CELL } from './tuning'

/** Шанс попадания в тысячных: базовый × дальность × укрытие. */
export function hitChance(octileDistance: number, cover: boolean): number {
  // HIT_PER_CELL — на клетку; октиль — в десятых клетки. Делится нацело,
  // пока HIT_PER_CELL кратен ORTHO; иначе усечение, и это тоже детерминизм.
  let chance = HIT_BASE + Math.trunc((HIT_PER_CELL * octileDistance) / ORTHO)
  if (cover) chance = Math.trunc((chance * COVER_MUL) / 1000)
  return Math.max(0, Math.min(1000, chance))
}

/** Бросок против шанса. Ровно одно обращение к ГПСЧ на выстрел. */
export function rollHit(rng: Rng, chance: number): boolean {
  return rng.int(1000) < chance
}
