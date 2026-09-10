/**
 * Ржавый: модель на скелете, а до её загрузки — капсула.
 *
 * Капсула остаётся не как временный код, а как честная деградация: сцена
 * должна работать, пока кит летит по сети, и если он не долетел вовсе.
 *
 * Клипов в ките пока нет, движение процедурное — но правило микшера уже
 * действует: `dt` здесь всегда реальное время кадра, умноженное на множитель
 * скорости, и никогда не дельта из аккумулятора симуляции.
 */

import * as THREE from 'three'
import type { CatView, Dir, Snapshot, WorldView } from '../shared/protocol'
import { bone, type CatKit, type CatRig } from './model'
import { cellToWorld, disposeTree } from './kit'
import { PALETTE } from './palette'

/** Части, которые показывает Ржавый. Кит несёт и чужие — они гасятся. */
const RUSTY_PARTS = ['head_rusty', 'body_stocky', 'gear_vacuum', 'held_vacuum'] as const

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

/**
 * Фигура кота. Модель и капсула отвечают на одни и те же три вопроса, и
 * больше рендер про них ничего не знает.
 */
interface Figure {
  readonly root: THREE.Object3D
  /** Освободить своё. Общее добро кита фигуре не принадлежит. */
  dispose(): void
  /** Рысканье корпуса: куда кот повёрнут. */
  setYaw(yaw: number): void
  /** Поворот головы относительно корпуса: на что он смотрит. */
  setHeadYaw(offset: number): void
  pose(action: CatView['action'], phase: number): void
}

// --------------------------------------------------------------------------
// Модель
// --------------------------------------------------------------------------

const BONES = [
  'mixamorig:Hips', 'mixamorig:Spine1', 'mixamorig:Head',
  'mixamorig:LeftArm', 'mixamorig:RightArm',
  'mixamorig:LeftForeArm', 'mixamorig:RightForeArm',
  'mixamorig:LeftUpLeg', 'mixamorig:RightUpLeg',
  'mixamorig:LeftLeg', 'mixamorig:RightLeg',
  'tail_1', 'tail_2', 'tail_3',
] as const

type BoneName = (typeof BONES)[number]

class ModelFigure implements Figure {
  readonly root = new THREE.Group()
  private readonly body = new THREE.Group()
  private readonly bones = new Map<BoneName, THREE.Bone>()
  /** Bind-поза: любое движение задаётся смещением от неё, а не поверх кадра. */
  private readonly base = new Map<BoneName, THREE.Quaternion>()
  private readonly q = new THREE.Quaternion()
  private readonly e = new THREE.Euler()

  constructor(rig: CatRig) {
    this.root.add(this.body)
    this.body.add(rig.root)
    for (const name of BONES) {
      const b = bone(rig, name)
      this.bones.set(name, b)
      this.base.set(name, b.quaternion.clone())
    }
  }

  /**
   * Геометрия и материалы приехали из кита и общие на всех котов: освободить
   * их здесь — значит стереть модель у остальных и у будущих.
   */
  dispose(): void {
    this.root.removeFromParent()
  }

  setYaw(yaw: number): void {
    this.body.rotation.y = yaw
  }

  setHeadYaw(offset: number): void {
    // Кость головы смотрит вдоль своей оси Y, поэтому рысканье — поворот
    // вокруг неё же.
    this.turn('mixamorig:Head', 0, offset, 0)
  }

  /** Поворот кости от bind-позы. Углы — в её собственных осях. */
  private turn(name: BoneName, x: number, y: number, z: number): void {
    const b = this.bones.get(name)
    const base = this.base.get(name)
    if (b === undefined || base === undefined) return
    b.quaternion.copy(base).multiply(this.q.setFromEuler(this.e.set(x, y, z)))
  }

  pose(action: CatView['action'], phase: number): void {
    // Хвост живёт всегда: синус с отставанием по звеньям. В humanoid-ригах
    // хвоста нет, и это единственное, что делает кота котом в покое.
    const sway = action === 'idle' ? 0.9 : 2.6
    for (const [i, name] of (['tail_1', 'tail_2', 'tail_3'] as const).entries()) {
      const t = phase * sway - i * 0.7
      this.turn(name, Math.sin(t) * 0.10, 0, Math.cos(t * 0.7) * 0.14)
    }

    switch (action) {
      case 'walk':
      case 'haul': {
        const t = phase * 7
        this.body.position.y = Math.abs(Math.sin(t)) * 0.04
        this.turn('mixamorig:Spine1', 0.06, 0, 0)
        this.stride(t, 0.5, 0.35)
        break
      }
      case 'work': {
        // Движение строится от предмета: ведётся путь пылесоса, а раструб
        // сидит в сокете ладони — значит достаточно вести руку. Взмах
        // медленный и широкий: мелкая частая дрожь читается как тик.
        const t = phase * 3.2
        const sweep = Math.sin(t)
        this.body.position.y = 0
        this.turn('mixamorig:Spine1', 0.24, sweep * 0.16, 0)
        this.turn('mixamorig:RightArm', -0.55, 0, sweep * 0.5)
        this.turn('mixamorig:RightForeArm', -0.45, 0, 0)
        this.turn('mixamorig:LeftArm', -0.2, 0, 0)
        this.turn('mixamorig:LeftForeArm', -0.3, 0, 0)
        this.stride(0, 0, 0)
        break
      }
      case 'dump': {
        this.body.position.y = 0
        this.turn('mixamorig:Spine1', -0.16, 0, 0)
        this.turn('mixamorig:RightArm', 1.2, 0, 0)
        this.turn('mixamorig:RightForeArm', 0.5, 0, 0)
        this.turn('mixamorig:LeftArm', 0.3, 0, 0)
        this.turn('mixamorig:LeftForeArm', 0, 0, 0)
        this.stride(0, 0, 0)
        break
      }
      case 'idle': {
        const t = phase * 1.6
        this.body.position.y = Math.sin(t) * 0.012
        this.turn('mixamorig:Spine1', Math.sin(t) * 0.03, 0, 0)
        this.turn('mixamorig:RightArm', 0, 0, 0)
        this.turn('mixamorig:RightForeArm', -0.1, 0, 0)
        this.turn('mixamorig:LeftArm', 0, 0, 0)
        this.turn('mixamorig:LeftForeArm', -0.1, 0, 0)
        this.stride(0, 0, 0)
        break
      }
    }
  }

  /** Шаг: ноги в противофазе, руки — навстречу своим ногам. */
  private stride(t: number, legs: number, arms: number): void {
    const swing = Math.sin(t)
    this.turn('mixamorig:LeftUpLeg', swing * legs, 0, 0)
    this.turn('mixamorig:RightUpLeg', -swing * legs, 0, 0)
    this.turn('mixamorig:LeftLeg', Math.max(0, -swing) * legs * 0.9, 0, 0)
    this.turn('mixamorig:RightLeg', Math.max(0, swing) * legs * 0.9, 0, 0)
    if (arms > 0) {
      this.turn('mixamorig:LeftArm', -swing * arms, 0, 0)
      this.turn('mixamorig:RightArm', swing * arms, 0, 0)
      this.turn('mixamorig:LeftForeArm', -0.2, 0, 0)
      this.turn('mixamorig:RightForeArm', -0.2, 0, 0)
    }
  }
}

// --------------------------------------------------------------------------
// Капсула: то, что видно, пока кит не приехал
// --------------------------------------------------------------------------

class StandInFigure implements Figure {
  readonly root = new THREE.Group()
  private readonly body = new THREE.Group()
  private readonly lean = new THREE.Group()
  private readonly head = new THREE.Group()
  private readonly vacuum: THREE.Mesh

  constructor() {
    this.root.add(this.body)
    this.body.add(this.lean)

    const torso = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.26, 0.42, 6, 12),
      new THREE.MeshLambertMaterial({ color: PALETTE.rusty }),
    )
    torso.position.y = 0.47
    this.lean.add(torso)

    this.head.position.y = 0.92
    this.lean.add(this.head)
    const skull = new THREE.Mesh(
      new THREE.SphereGeometry(0.19, 14, 10),
      new THREE.MeshLambertMaterial({ color: PALETTE.rustyHead }),
    )
    this.head.add(skull)

    // Морда: без неё поворот головы на сфере не виден вообще.
    const muzzle = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.1, 0.14),
      new THREE.MeshLambertMaterial({ color: PALETTE.rustyHead }),
    )
    muzzle.position.set(0, -0.02, 0.17)
    this.head.add(muzzle)

    this.vacuum = new THREE.Mesh(
      new THREE.BoxGeometry(0.2, 0.2, 0.42),
      new THREE.MeshLambertMaterial({ color: PALETTE.container }),
    )
    this.vacuum.position.set(0.2, 0.4, 0.3)
    this.lean.add(this.vacuum)
  }

  dispose(): void {
    this.root.removeFromParent()
    disposeTree(this.root)
  }

  setYaw(yaw: number): void {
    this.body.rotation.y = yaw
  }

  setHeadYaw(offset: number): void {
    this.head.rotation.y = offset
  }

  pose(action: CatView['action'], phase: number): void {
    switch (action) {
      case 'work': {
        const t = phase * 3.2
        const sweep = Math.sin(t)
        this.body.position.y = -0.02 + Math.abs(Math.cos(t)) * 0.025
        this.lean.rotation.x = 0.17
        this.vacuum.position.set(0.06 + sweep * 0.24, 0.16, 0.54)
        this.vacuum.rotation.set(-0.5, sweep * 0.45, 0)
        break
      }
      case 'dump':
        this.body.position.y = 0
        this.lean.rotation.x = -0.12
        this.vacuum.position.set(0.05, 0.62, 0.34)
        this.vacuum.rotation.set(-1.1, 0, 0)
        break
      case 'walk':
      case 'haul':
        this.body.position.y = Math.abs(Math.sin(phase * 7)) * 0.045
        this.lean.rotation.x = 0.06
        this.vacuum.position.set(0.2, 0.4, 0.3)
        this.vacuum.rotation.set(0, 0, 0)
        break
      case 'idle':
        this.body.position.y = Math.sin(phase * 1.6) * 0.012
        this.lean.rotation.x = 0
        this.vacuum.position.set(0.2, 0.4, 0.3)
        this.vacuum.rotation.set(0, 0, 0)
        break
    }
  }
}

interface CatObject {
  figure: Figure
  yaw: number
  headYaw: number
  phase: number
}

export class Cats {
  private readonly root = new THREE.Group()
  private readonly objects = new Map<string, CatObject>()
  private readonly a = new THREE.Vector3()
  private readonly b = new THREE.Vector3()
  private kit: CatKit | null = null

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: WorldView,
  ) {
    scene.add(this.root)
  }

  /**
   * Кит приехал. Фигуры пересобираются на месте: углы и фаза переносятся,
   * поэтому подмена не выглядит рывком, а кот не телепортируется.
   */
  setKit(kit: CatKit): void {
    this.kit = kit
    for (const obj of this.objects.values()) {
      obj.figure.dispose()
      obj.figure = this.build()
      this.root.add(obj.figure.root)
    }
  }

  dispose(): void {
    this.scene.remove(this.root)
    for (const obj of this.objects.values()) obj.figure.dispose()
    this.objects.clear()
  }

  private build(): Figure {
    return this.kit === null ? new StandInFigure() : new ModelFigure(this.kit.spawn(RUSTY_PARTS))
  }

  /** `dt` — реальное время кадра, умноженное на множитель скорости. */
  sync(snap: Snapshot, dt: number): void {
    for (const view of snap.cats) {
      let obj = this.objects.get(view.id)
      if (obj === undefined) {
        obj = { figure: this.build(), yaw: 0, headYaw: 0, phase: 0 }
        this.objects.set(view.id, obj)
        this.root.add(obj.figure.root)
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
    obj.figure.root.position.set(this.a.x, 0, this.a.z)

    const [hx, hz] = HEADING[view.facing]
    obj.yaw = approachAngle(obj.yaw, Math.atan2(hx, hz), TURN_RATE, dt)
    obj.figure.setYaw(obj.yaw)

    // Взгляд: кот смотрит на то, чем занят, за секунду до того, как что-то
    // сделает. Это и есть видимое внимание.
    let headTarget = obj.yaw
    if (view.lookAt !== null) {
      const t = cellToWorld(view.lookAt, this.world, this.b)
      const dx = t.x - obj.figure.root.position.x
      const dz = t.z - obj.figure.root.position.z
      if (dx * dx + dz * dz > 0.04) headTarget = Math.atan2(dx, dz)
    }
    let offset = headTarget - obj.yaw
    while (offset > Math.PI) offset -= 2 * Math.PI
    while (offset < -Math.PI) offset += 2 * Math.PI
    offset = Math.max(-HEAD_LIMIT, Math.min(HEAD_LIMIT, offset))
    obj.headYaw = approachAngle(obj.headYaw, offset, HEAD_RATE, dt)

    obj.phase += dt
    obj.figure.pose(view.action, obj.phase)
    // После позы: она трогает те же кости и иначе затрёт поворот головы.
    obj.figure.setHeadYaw(obj.headYaw)
  }
}
