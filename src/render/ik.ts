/**
 * Двухзвенная IK руки: плечо и локоть доворачиваются так, чтобы кисть легла
 * в точку. Аналитически, без итераций: сначала локоть сгибается до нужной
 * длины «плечо — кисть», потом плечо поворачивается, чтобы кисть смотрела
 * на цель. Порядок важен: поворот плеча не меняет угол в локте.
 *
 * Нужна поверх клипа, а не вместо: перенос боевых клипов Mixamo на скелет
 * кота даёт руки примерно, и левая ладонь не дотягивается до цевья. С
 * бруском это не бросалось в глаза, с настоящей винтовкой — сразу.
 */

import * as THREE from 'three'

const a = new THREE.Vector3()
const b = new THREE.Vector3()
const c = new THREE.Vector3()
const ab = new THREE.Vector3()
const bc = new THREE.Vector3()
const ac = new THREE.Vector3()
const at = new THREE.Vector3()
const axis = new THREE.Vector3()
const q = new THREE.Quaternion()
const world = new THREE.Quaternion()
const parent = new THREE.Quaternion()

/** Поворот узла в мировых осях: локальный = обратный родительский × мировой. */
function rotateWorld(node: THREE.Object3D, delta: THREE.Quaternion): void {
  node.getWorldQuaternion(world)
  world.premultiply(delta)
  if (node.parent !== null) node.parent.getWorldQuaternion(parent)
  else parent.identity()
  node.quaternion.copy(parent.invert().multiply(world))
  node.updateWorldMatrix(true, true)
}

/**
 * `upper` — плечевая кость, `lower` — предплечье, `end` — кисть; `target` —
 * куда кисть, в мировых координатах. Цель дальше вытянутой руки — рука
 * тянется, не достаёт; ближе минимума — сгибается до упора. `bend` —
 * куда выгибать локоть, если рука была прямой и своей плоскости сгиба нет.
 */
export function reach(
  upper: THREE.Object3D,
  lower: THREE.Object3D,
  end: THREE.Object3D,
  target: THREE.Vector3,
  bend: THREE.Vector3,
): void {
  upper.getWorldPosition(a)
  lower.getWorldPosition(b)
  end.getWorldPosition(c)
  ab.subVectors(b, a)
  bc.subVectors(c, b)
  const l1 = ab.length()
  const l2 = bc.length()
  if (l1 < 1e-6 || l2 < 1e-6) return
  at.subVectors(target, a)
  // Достижимая длина: не дальше вытянутой и не ближе, чем позволяет сгиб.
  const d = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, at.length()))

  // Локоть: угол между плечом и предплечьем по теореме косинусов.
  const cosNow = ab.dot(bc) / (l1 * l2)
  const cosWant = (l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2)
  const now = Math.acos(Math.max(-1, Math.min(1, cosNow)))
  const want = Math.acos(Math.max(-1, Math.min(1, -cosWant)))
  axis.crossVectors(ab, bc)
  if (axis.lengthSq() < 1e-8) axis.crossVectors(ab, bend)
  if (axis.lengthSq() < 1e-8) return
  axis.normalize()
  q.setFromAxisAngle(axis, want - now)
  rotateWorld(lower, q)

  // Плечо: направление «плечо — кисть» на цель.
  end.getWorldPosition(c)
  ac.subVectors(c, a)
  if (ac.lengthSq() < 1e-8 || at.lengthSq() < 1e-8) return
  q.setFromUnitVectors(ac.normalize(), at.normalize())
  rotateWorld(upper, q)
}
