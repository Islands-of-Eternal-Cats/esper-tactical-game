/**
 * Сглаживание маршрута: лесенка A* должна лечь на прямую, а концы — остаться
 * на месте. Иначе кот либо ковыляет зигзагом, либо не доходит до центра.
 */
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { smoothAlong } from '../src/render/path'

const V = (x: number, z: number): THREE.Vector3 => new THREE.Vector3(x, 0, z)

describe('smoothAlong', () => {
  it('лесенка из диагоналей и прямых ложится на прямую', () => {
    // Путь под ~27°: диаг, прямо, диаг, прямо… — центры по обе стороны от прямой.
    const pts = [V(0, 0), V(1, 1), V(2, 1), V(3, 2), V(4, 2), V(5, 3), V(6, 3)]
    const out = new THREE.Vector3()
    for (let t = 1; t <= 5; t += 0.25) {
      smoothAlong(pts, pts.length, t, out)
      // Прямая через середины пар: z = x / 2 + 0.25 (для x ≥ 1).
      expect(Math.abs(out.z - (out.x / 2 + 0.25))).toBeLessThan(0.13)
    }
  })

  it('на концах ломаной стоит ровно в её точках', () => {
    const pts = [V(0, 0), V(1, 1), V(2, 1)]
    const out = new THREE.Vector3()
    smoothAlong(pts, 3, 0, out)
    expect(out.x).toBeCloseTo(0, 6)
    expect(out.z).toBeCloseTo(0, 6)
    smoothAlong(pts, 3, 2, out)
    expect(out.x).toBeCloseTo(2, 6)
    expect(out.z).toBeCloseTo(1, 6)
  })

  it('стоящий кот — в центре клетки, откуда бы ни пришёл', () => {
    const out = new THREE.Vector3()
    smoothAlong([V(3, 3), V(4, 3)], 2, 1, out)
    expect(out.x).toBeCloseTo(4, 6)
    expect(out.z).toBeCloseTo(3, 6)
    smoothAlong([V(4, 3)], 1, 1, out)
    expect(out.x).toBeCloseTo(4, 6)
  })

  it('прямой путь остаётся прямым и без задержки', () => {
    const pts = [V(0, 0), V(1, 0), V(2, 0), V(3, 0)]
    const out = new THREE.Vector3()
    smoothAlong(pts, 4, 1.5, out)
    expect(out.x).toBeCloseTo(1.5, 6)
    expect(out.z).toBeCloseTo(0, 6)
  })
})
