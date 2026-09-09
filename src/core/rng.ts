/**
 * Собственный ГПСЧ с явным сидом.
 *
 * Ни Math.random, ни Date.now, ни performance.now в ядре не появляются
 * никогда. Состояние сериализуемо и попадает в сохранение вместе с сидом:
 * загрузка не должна позволять перебросить зафиксированный исход.
 */

/** Разброс сида, чтобы соседние сиды давали непохожие последовательности. */
function splitmix32(seed: number): number {
  let z = (seed + 0x9e3779b9) >>> 0
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0
  return (z ^ (z >>> 15)) >>> 0
}

export class Rng {
  private s: number

  constructor(seed: number) {
    // Ноль — неподвижная точка xorshift: последовательность из него не выходит.
    this.s = splitmix32(seed >>> 0) || 0x9e3779b9
  }

  /** Следующее 32-битное беззнаковое. */
  next(): number {
    let x = this.s
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    this.s = x
    return x
  }

  /** Целое в [0, n). Смещение по модулю здесь не важно: раскладка, не баланс. */
  int(n: number): number {
    return this.next() % n
  }

  /** Целое в [min, max] включительно. */
  range(min: number, max: number): number {
    return min + this.int(max - min + 1)
  }

  get state(): number {
    return this.s
  }

  set state(s: number) {
    this.s = s >>> 0
  }
}
