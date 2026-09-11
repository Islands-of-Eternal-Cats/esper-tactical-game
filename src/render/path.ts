/**
 * Сглаживание маршрута по клеткам.
 *
 * A* по восьми направлениям даёт лесенку: прямая под 30° к цели — это
 * чередование диагональных и прямых шагов. Центры клеток лесенки лежат по
 * обе стороны от прямой, и скользящее среднее по окну в одну клетку ложится
 * на неё. Симуляция об этом не знает: она остаётся дискретной, а рендер
 * ведёт кота по среднему.
 */

import * as THREE from 'three'

const tmp = new THREE.Vector3()
const acc = new THREE.Vector3()

/**
 * Точка ломаной `pts[0..n)` в параметре `u` (в единицах сегментов). За
 * концами — продолжение крайнего сегмента по прямой: тогда среднее в
 * последней точке — ровно она сама, и кот приходит в центр клетки, а не
 * останавливается на восьмушку раньше.
 */
function at(pts: readonly THREE.Vector3[], n: number, u: number, out: THREE.Vector3): THREE.Vector3 {
  const last = n - 1
  if (last < 1) return out.copy(pts[0]!)
  const i = Math.max(0, Math.min(last - 1, Math.floor(u)))
  return out.copy(pts[i]!).lerp(pts[i + 1]!, u - i)
}

/**
 * Среднее ломаной по окну `[t − ½, t + ½]` — интеграл по кусочно-линейной
 * кривой считается точно, трапециями между изломами.
 */
export function smoothAlong(pts: readonly THREE.Vector3[], n: number, t: number, out: THREE.Vector3): THREE.Vector3 {
  const u0 = t - 0.5
  const u1 = t + 0.5
  out.set(0, 0, 0)
  let prevU = u0
  at(pts, n, prevU, acc)
  for (let k = Math.floor(u0) + 1; k <= u1; k++) {
    at(pts, n, k, tmp)
    out.addScaledVector(acc.add(tmp), (k - prevU) / 2)
    acc.copy(tmp)
    prevU = k
  }
  at(pts, n, u1, tmp)
  out.addScaledVector(acc.add(tmp), (u1 - prevU) / 2)
  return out
}
