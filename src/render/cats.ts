/**
 * Ржавый на примитивах.
 *
 * Шаги 4–5 отвечают на дизайнерский вопрос, и капсулы для этого достаточно.
 * Модель, скелет и настоящий look-at на кость головы — шаг 6; до тех пор
 * поворот головы изображает отдельная деталь, потому что видимое внимание
 * нужно проверять раньше, чем появится художник.
 */

import * as THREE from 'three'
import type { CatView, Dir, Snapshot, WorldView } from '../shared/protocol'
import { cellToWorld, disposeTree } from './kit'
import { PALETTE } from './palette'

/** Направление взгляда в плоскости земли. y растёт на юг. */
const HEADING: Record<Dir, [number, number]> = {
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
  nw: [-1, -1],
}

const TURN_RATE = 12
const HEAD_RATE = 9
/** Дальше кот не выворачивает голову — иначе внимание читается как поломка. */
const HEAD_LIMIT = (110 * Math.PI) / 180

function approachAngle(current: number, target: number, rate: number, dt: number): number {
  let d = target - current
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return current + d * (1 - Math.exp(-rate * dt))
}

interface CatObject {
  root: THREE.Group
  body: THREE.Group
  /** Наклон к работе. Отдельным узлом, чтобы не спорить с рысканьем корпуса. */
  lean: THREE.Group
  head: THREE.Group
  vacuum: THREE.Mesh
  yaw: number
  headYaw: number
  phase: number
}

function build(): CatObject {
  const root = new THREE.Group()
  const body = new THREE.Group()
  root.add(body)
  const lean = new THREE.Group()
  body.add(lean)

  const torso = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.26, 0.42, 6, 12),
    new THREE.MeshLambertMaterial({ color: PALETTE.rusty }),
  )
  torso.position.y = 0.47
  lean.add(torso)

  const head = new THREE.Group()
  head.position.y = 0.92
  lean.add(head)

  const skull = new THREE.Mesh(
    new THREE.SphereGeometry(0.19, 14, 10),
    new THREE.MeshLambertMaterial({ color: PALETTE.rustyHead }),
  )
  head.add(skull)

  // Морда: без неё поворот головы на сфере не виден вообще.
  const muzzle = new THREE.Mesh(
    new THREE.BoxGeometry(0.14, 0.1, 0.14),
    new THREE.MeshLambertMaterial({ color: PALETTE.rustyHead }),
  )
  muzzle.position.set(0, -0.02, 0.17)
  head.add(muzzle)

  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(
      new THREE.ConeGeometry(0.07, 0.14, 4),
      new THREE.MeshLambertMaterial({ color: PALETTE.rustyHead }),
    )
    ear.position.set(side * 0.11, 0.17, -0.02)
    head.add(ear)
  }

  // Пылесос — пропс в лапе. На шаге 6 он уедет в сокет ладони как есть.
  const vacuum = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 0.2, 0.42),
    new THREE.MeshLambertMaterial({ color: PALETTE.container }),
  )
  vacuum.position.set(0.2, 0.4, 0.3)
  lean.add(vacuum)

  return { root, body, lean, head, vacuum, yaw: 0, headYaw: 0, phase: 0 }
}

export class Cats {
  private readonly root = new THREE.Group()
  private readonly objects = new Map<string, CatObject>()
  private readonly a = new THREE.Vector3()
  private readonly b = new THREE.Vector3()

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: WorldView,
  ) {
    scene.add(this.root)
  }

  dispose(): void {
    this.scene.remove(this.root)
    disposeTree(this.root)
    this.objects.clear()
  }

  /** `dt` — реальное время кадра, умноженное на множитель скорости. */
  sync(snap: Snapshot, dt: number): void {
    for (const view of snap.cats) {
      let obj = this.objects.get(view.id)
      if (obj === undefined) {
        obj = build()
        this.objects.set(view.id, obj)
        this.root.add(obj.root)
      }
      this.place(obj, view, dt)
    }
  }

  private place(obj: CatObject, view: CatView, dt: number): void {
    // Позиция — линейная интерполяция cell → next по progress. Симуляция
    // дискретная, картинка непрерывная.
    cellToWorld(view.cell, this.world, this.a)
    if (view.next !== null) {
      cellToWorld(view.next, this.world, this.b)
      this.a.lerp(this.b, view.progress)
    }
    obj.root.position.set(this.a.x, 0, this.a.z)

    const [hx, hz] = HEADING[view.facing]
    obj.yaw = approachAngle(obj.yaw, Math.atan2(hx, hz), TURN_RATE, dt)
    obj.body.rotation.y = obj.yaw

    // Взгляд: кот смотрит на то, чем занят, за секунду до того, как что-то
    // сделает. Это и есть видимое внимание.
    let headTarget = obj.yaw
    if (view.lookAt !== null) {
      const t = cellToWorld(view.lookAt, this.world, this.b)
      const dx = t.x - obj.root.position.x
      const dz = t.z - obj.root.position.z
      if (dx * dx + dz * dz > 0.04) headTarget = Math.atan2(dx, dz)
    }
    let offset = headTarget - obj.yaw
    while (offset > Math.PI) offset -= 2 * Math.PI
    while (offset < -Math.PI) offset += 2 * Math.PI
    offset = Math.max(-HEAD_LIMIT, Math.min(HEAD_LIMIT, offset))
    obj.headYaw = approachAngle(obj.headYaw, offset, HEAD_RATE, dt)
    obj.head.rotation.y = obj.headYaw

    obj.phase += dt
    this.animate(obj, view)
  }

  /**
   * Заглушка микшера. Клипы приедут на шаге 6, но правило уже действует:
   * время берётся из кадра, а не из аккумулятора симуляции.
   */
  private animate(obj: CatObject, view: CatView): void {
    switch (view.action) {
      case 'work': {
        // Движение строится от предмета: ведётся путь пылесоса, корпус идёт
        // за ним. Медленный широкий взмах — работа; мелкая частая дрожь
        // читается как тик, а не как дело.
        const t = obj.phase * 3.2
        const sweep = Math.sin(t)
        obj.body.position.y = -0.02 + Math.abs(Math.cos(t)) * 0.025
        obj.lean.rotation.x = 0.17
        obj.vacuum.position.set(0.06 + sweep * 0.24, 0.16, 0.54)
        obj.vacuum.rotation.set(-0.5, sweep * 0.45, 0)
        break
      }
      case 'dump':
        obj.body.position.y = 0
        obj.lean.rotation.x = -0.12
        obj.vacuum.position.set(0.05, 0.62, 0.34)
        obj.vacuum.rotation.set(-1.1, 0, 0)
        break
      case 'walk':
      case 'haul':
        obj.body.position.y = Math.abs(Math.sin(obj.phase * 7)) * 0.045
        obj.lean.rotation.x = 0.06
        obj.vacuum.position.set(0.2, 0.4, 0.3)
        obj.vacuum.rotation.set(0, 0, 0)
        break
      case 'idle':
        obj.body.position.y = Math.sin(obj.phase * 1.6) * 0.012
        obj.lean.rotation.x = 0
        obj.vacuum.position.set(0.2, 0.4, 0.3)
        obj.vacuum.rotation.set(0, 0, 0)
        break
    }
  }
}
