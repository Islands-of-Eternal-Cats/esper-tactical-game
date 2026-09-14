/**
 * Модель оружия из кита: корпус в начале координат, остальные части — по
 * гнёздам корпуса. Что в какое гнездо — `look` из weapons.yaml, приходит с
 * двором; обвес — те же гнёзда (`top`), пустое гнездо — пустое.
 *
 * Результат ориентирован как брусок-заглушка в units.ts: рукоять в начале
 * координат, ствол вдоль +Z. Кит — в метрах «под человека», масштаб под
 * кота — здесь.
 */

import * as THREE from 'three'
import type { WeaponLook } from '../shared/protocol'
import type { GunKit } from './model'

/**
 * Автомат из набора — 1,9 м под человека 1,8; кот — 1,2, и по росту вышло бы
 * 0,21. Берётся чуть больше, чтобы оружие читалось сверху, но не настолько,
 * чтобы приклад уходил за плечо при вытянутых руках.
 */
const GUN_SCALE = 0.26
/** Рукоять в ките — низ пистолетной рукояти; ладонь — выше, на её середине. */
const GRIP_RISE = 0.1

const AXIS_Y = new THREE.Vector3(0, 1, 0)

/** Левая ладонь снизу обхватывает цевьё: на столько ниже оси ствола, в единицах кита. */
const HAND_UNDER = 0.1

/** Где на оружии лежит левая ладонь, в осях оружия (+Z вперёд, +Y вверх), м. */
export function holdOf(gun: THREE.Object3D): THREE.Vector3 {
  const v: unknown = gun.userData['hold']
  return v instanceof THREE.Vector3 ? v : new THREE.Vector3(0, -0.02, 0.15)
}

export function assembleGun(kit: GunKit, look: WeaponLook): THREE.Group {
  const sockets = kit.socketsOf(look.body)
  const grip = sockets['grip'] ?? [0, 0, 0]
  const assembly = new THREE.Group()
  for (const [slot, name] of Object.entries(look)) {
    const part = kit.part(name)
    const mesh = new THREE.Mesh(part.geometry, part.material)
    mesh.castShadow = true
    if (slot !== 'body') {
      const at = sockets[slot]
      if (at === undefined) throw new Error(`у ${look.body} нет гнезда ${slot}`)
      mesh.position.set(at[0], at[1], at[2])
    }
    assembly.add(mesh)
  }
  // Начало координат — в ладонь: части сдвигаются на минус рукоять.
  assembly.position.set(-grip[0], -grip[1] - GRIP_RISE, -grip[2])

  // Ствол в ките растёт вдоль +X; заглушка и placeGun считают вперёд +Z.
  // Поворот — на своём узле: внешний placeGun крутит каждый кадр.
  const turn = new THREE.Group()
  turn.quaternion.setFromAxisAngle(AXIS_Y, -Math.PI / 2)
  turn.add(assembly)
  const gun = new THREE.Group()
  gun.scale.setScalar(GUN_SCALE)
  gun.add(turn)
  // Цевьё — на 60 % длины переда от рукояти: и у короткого автомата, и у
  // снайперской ладонь ложится где ей место. По высоте — под осью ствола:
  // ладонь обхватывает цевьё снизу, а не лежит на линии ствола.
  // Бокс — в осях `turn`: части уже сдвинуты на минус рукоять, и max.x — перед.
  const box = new THREE.Box3().setFromObject(assembly)
  const barrel = sockets['barrel'] ?? [0, 0, 0]
  const axisY = barrel[1] - grip[1] - GRIP_RISE
  gun.userData['hold'] = new THREE.Vector3(0, (axisY - HAND_UNDER) * GUN_SCALE, Math.max(0.05, box.max.x * 0.6 * GUN_SCALE))
  return gun
}
