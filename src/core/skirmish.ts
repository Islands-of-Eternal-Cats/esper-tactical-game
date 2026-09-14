/**
 * Раскладка среза «Перестрелка».
 *
 * Тот же двор: стены и пропсы «Ржавого». Игрок слева, противник справа,
 * между ними — блок x=13..14 с проходами сверху и снизу. Противник получает
 * один приказ на старте: идти к игроку; дальше — тот же автомат.
 *
 * Оружие — из weapons.yaml: у каждой стороны винтовка и что-то короткое,
 * чтобы дальность решала, кого куда послать.
 */

import type { Cell, Side } from '../shared/protocol'
import type { State, Unit } from './state'
import { HP } from './tuning'
import { UNIT_STATUS, orderMove } from './units'
import { weaponOf } from './weapons'

interface Spawn {
  id: string
  side: Side
  cell: Cell
  weapon: string
}

/** id отсортированы: порядок обхода — порядок массива. */
const SPAWNS: readonly Spawn[] = [
  { id: 'a1', side: 'player', cell: { x: 3, y: 6 }, weapon: 'rifle' },
  { id: 'a2', side: 'player', cell: { x: 3, y: 9 }, weapon: 'smg' },
  { id: 'b1', side: 'enemy', cell: { x: 17, y: 6 }, weapon: 'rifle' },
  { id: 'b2', side: 'enemy', cell: { x: 17, y: 9 }, weapon: 'shotgun' },
]

/** Куда противник идёт со старта: к проходу и дальше, на сторону игрока. */
const ENEMY_ORDERS: ReadonlyArray<{ id: string; cell: Cell }> = [
  { id: 'b1', cell: { x: 8, y: 8 } },
  { id: 'b2', cell: { x: 8, y: 11 } },
]

export function spawnUnits(): Unit[] {
  return SPAWNS.map((s) => ({
    id: s.id,
    side: s.side,
    cell: { ...s.cell },
    prev: null,
    path: [],
    progress: 0,
    moveAcc: 0,
    facing: s.side === 'player' ? 'e' : 'w',
    mode: 'idle',
    // Проверка id при раскладке: незнакомое оружие падает на старте, не в бою.
    weapon: weaponOf(s.weapon).id,
    hp: HP,
    target: null,
    waitMs: 0,
    underFireMs: 0,
    threat: null,
    seekCooldownMs: 0,
    blockedMs: 0,
    shots: 0,
    status: s.side === 'player' ? UNIT_STATUS.await : UNIT_STATUS.search,
  }))
}

export function openingOrders(state: State): void {
  for (const o of ENEMY_ORDERS) orderMove(state, [o.id], o.cell)
}
