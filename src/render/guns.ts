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

/** Автомат из набора — 1,9 м; у кота винтовка-брусок была 0,6. */
const GUN_SCALE = 0.32
/** Рукоять в ките — низ пистолетной рукояти; ладонь — выше, на её середине. */
const GRIP_RISE = 0.1

const AXIS_Y = new THREE.Vector3(0, 1, 0)

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
  return gun
}
