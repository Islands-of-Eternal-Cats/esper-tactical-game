/**
 * Оружие: характеристики из `weapons.yaml`, проверенные при загрузке.
 *
 * YAML — чтобы числа правились без кода; проверка формы здесь — чтобы
 * опечатка в конфиге падала при старте, а не всплывала как NaN в шансе.
 */

import raw from './weapons.yaml'
import { SIGHT_RANGE } from './tuning'

export interface Weapon {
  readonly id: string
  readonly name: string
  readonly fireRange: number
  readonly aimMs: number
  readonly reloadMs: number
  readonly fireMs: number
  readonly hitBase: number
  readonly hitPerCell: number
  readonly coverMul: number
  readonly damage: number
}

const FIELDS = ['fireRange', 'aimMs', 'reloadMs', 'fireMs', 'hitBase', 'hitPerCell', 'coverMul', 'damage'] as const

function fail(id: string, what: string): never {
  throw new Error(`weapons.yaml, «${id}»: ${what}`)
}

function parse(id: string, entry: unknown): Weapon {
  if (typeof entry !== 'object' || entry === null) fail(id, 'не объект')
  const e = entry as Record<string, unknown>
  if (typeof e.name !== 'string' || e.name === '') fail(id, 'нет name')
  const w: Record<string, number> = {}
  for (const f of FIELDS) {
    const v = e[f]
    if (typeof v !== 'number' || !Number.isInteger(v)) fail(id, `${f} должно быть целым`)
    w[f] = v
  }
  const n = (f: (typeof FIELDS)[number]): number => w[f]!
  if (n('fireRange') < 1 || n('fireRange') > SIGHT_RANGE) fail(id, `fireRange вне 1..${SIGHT_RANGE}`)
  if (n('aimMs') < 0 || n('reloadMs') < 1) fail(id, 'aimMs ≥ 0, reloadMs ≥ 1')
  if (n('fireMs') < 0 || n('fireMs') > n('reloadMs')) fail(id, 'fireMs вне 0..reloadMs')
  if (n('hitBase') < 0 || n('hitBase') > 1000) fail(id, 'hitBase вне 0..1000')
  if (n('hitPerCell') > 0) fail(id, 'hitPerCell должно быть ≤ 0')
  if (n('coverMul') < 0 || n('coverMul') > 1000) fail(id, 'coverMul вне 0..1000')
  if (n('damage') < 1) fail(id, 'damage ≥ 1')
  return {
    id,
    name: e.name,
    fireRange: n('fireRange'),
    aimMs: n('aimMs'),
    reloadMs: n('reloadMs'),
    fireMs: n('fireMs'),
    hitBase: n('hitBase'),
    hitPerCell: n('hitPerCell'),
    coverMul: n('coverMul'),
    damage: n('damage'),
  }
}

function load(data: unknown): ReadonlyMap<string, Weapon> {
  if (typeof data !== 'object' || data === null) throw new Error('weapons.yaml: не объект')
  const out = new Map<string, Weapon>()
  for (const [id, entry] of Object.entries(data)) out.set(id, parse(id, entry))
  if (out.size === 0) throw new Error('weapons.yaml: пусто')
  return out
}

export const WEAPONS: ReadonlyMap<string, Weapon> = load(raw)

/** Незнакомый id — ошибка конфигурации, не тихий дефолт. */
export function weaponOf(id: string): Weapon {
  const w = WEAPONS.get(id)
  if (w === undefined) throw new Error(`неизвестное оружие «${id}»`)
  return w
}
