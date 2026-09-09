/**
 * Фиксированная точка.
 *
 * Накопление состояния — целые в тысячных долях, не float. Float,
 * проинтегрированный по дельте времени, — классический способ потерять
 * детерминизм между машинами и между скоростями, а он записан у нас как
 * обязательное свойство.
 */

import { TICK_MS } from './tuning'

/** Одна единица в тысячных. */
export const UNIT = 1000

export function toUnits(v: number): number {
  return v * UNIT
}

/**
 * Точная целочисленная скорость: `msPerUnit` миллисекунд на UNIT.
 *
 * Возвращает прирост за один тик и новый остаток. Остаток переносится между
 * тиками, поэтому средняя скорость точна даже когда UNIT*TICK_MS не делится
 * на msPerUnit нацело: 1500 мс на единицу при шаге 50 мс дают 33, 33, 34, …
 * — ровно 1000 за 30 тиков, без накопления ошибки.
 */
export function tickAmount(acc: number, msPerUnit: number): [amount: number, acc: number] {
  const total = acc + UNIT * TICK_MS
  const amount = Math.floor(total / msPerUnit)
  return [amount, total - amount * msPerUnit]
}
