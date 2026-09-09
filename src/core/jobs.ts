/**
 * Выбор задачи и резервирование.
 *
 * Резервирование стоит здесь с первого дня, хотя кот пока один: без него
 * второй кот, когда появится, побежит к той же куче. Это самая частая ошибка
 * в таких системах, и чинить её задним числом дорого.
 */

import type { Cell } from '../shared/protocol'
import { octile } from './grid'
import type { Cat, Pile, State, Zone } from './state'

export function inZone(zone: Zone, cell: Cell): boolean {
  const dx = cell.x - zone.cell.x
  const dy = cell.y - zone.cell.y
  return dx * dx + dy * dy <= zone.radius * zone.radius
}

/**
 * Кучи, за которые кот может взяться, в порядке предпочтения.
 *
 * Зона задана — за её пределы список не выходит вовсе. Пустой список при
 * заданной зоне означает не «работы нет», а «в зоне мусора не осталось», и
 * решает это вызывающий: сюда логика характера не протекает.
 */
export function rankPiles(state: State, cat: Cat): Pile[] {
  const pool: Pile[] = []
  for (const pile of state.piles) {
    if (pile.volume <= 0) continue
    if (pile.reservedBy !== null && pile.reservedBy !== cat.id) continue
    if (state.zone !== null && !inZone(state.zone, pile.cell)) continue
    pool.push(pile)
  }
  // Октиль вместо длины пути: на 20×20 разница незаметна, а поиск пути для
  // каждой кучи — работа впустую. Ничья разрешается по id, не по порядку в
  // массиве, чтобы порядок не зависел от истории вставок.
  pool.sort((a, b) => {
    const da = octile(cat.cell, a.cell)
    const db = octile(cat.cell, b.cell)
    return da !== db ? da - db : a.id < b.id ? -1 : 1
  })
  return pool
}

export function release(state: State, cat: Cat): void {
  if (cat.target === null) return
  for (const pile of state.piles) {
    if (pile.id === cat.target && pile.reservedBy === cat.id) pile.reservedBy = null
  }
  cat.target = null
}

export function pileById(state: State, id: string | null): Pile | null {
  if (id === null) return null
  for (const pile of state.piles) if (pile.id === id) return pile
  return null
}
