/**
 * Ржавый: модель на скелете, а до её загрузки — капсула.
 *
 * Капсула остаётся не как временный код, а как честная деградация: сцена
 * должна работать, пока кит летит по сети, и если он не долетел вовсе.
 *
 * Движение модели — клипы из кита через `AnimationMixer`; капсула остаётся
 * процедурной, ей клипы неоткуда взять. Правило микшера: `dt` здесь всегда
 * реальное время кадра, умноженное на множитель скорости, и никогда не дельта
 * из аккумулятора симуляции — иначе анимация живёт в другом времени, чем
 * картинка, и на паузе или ускорении это сразу видно.
 */

import * as THREE from 'three'
import type { CatView, Dir, Snapshot, WorldView } from '../shared/protocol'
import { bone, clip, type CatKit, type CatRig } from './model'
import { cellToWorld, disposeTree } from './kit'
import { PALETTE } from './palette'

/** Части, которые показывает Ржавый. Кит несёт и чужие — они гасятся. */
const RUSTY_PARTS = ['head_rusty', 'body_stocky', 'gear_vacuum', 'held_vacuum'] as const

/**
 * Клипы кита, по одному на занятие. Имена — контракт с ассетом, он проверяется
 * автотестом `tests/character-kit.test.ts`; отсутствие клипа — поломка кита.
 */
const ACTIONS: readonly CatView['action'][] = ['idle', 'walk', 'haul', 'work', 'dump']

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
  /** Продвинуть движение на кадр. `dt` — то же время, что у поворотов. */
  animate(action: CatView['action'], dt: number): void
}

// --------------------------------------------------------------------------
// Модель
// --------------------------------------------------------------------------

/**
 * Смена клипа — кроссфейд, а не подмена кадром: кот меняет занятие за четверть
 * секунды, и на этом стыке он не должен дёргаться. Длиннее — и он выглядит
 * вялым, короче — щёлкает.
 */
const FADE = 0.22

class ModelFigure implements Figure {
  readonly root = new THREE.Group()
  private readonly body = new THREE.Group()
  private readonly mixer: THREE.AnimationMixer
  private readonly clips = new Map<CatView['action'], THREE.AnimationAction>()
  private readonly head: THREE.Bone
  /** Bind-поза головы: рысканье задаётся смещением от неё, а не поверх кадра. */
  private readonly headBase: THREE.Quaternion
  private readonly q = new THREE.Quaternion()
  private readonly e = new THREE.Euler()
  private playing: CatView['action'] | null = null

  constructor(rig: CatRig) {
    this.root.add(this.body)
    this.body.add(rig.root)

    this.mixer = new THREE.AnimationMixer(rig.root)
    for (const name of ACTIONS) {
      const action = this.mixer.clipAction(clip(rig, name))
      action.setLoop(THREE.LoopRepeat, Infinity)
      this.clips.set(name, action)
    }

    this.head = bone(rig, 'mixamorig:Head')
    this.headBase = this.head.quaternion.clone()
  }

  /**
   * Геометрия и материалы приехали из кита и общие на всех котов: освободить
   * их здесь — значит стереть модель у остальных и у будущих. Клипы тоже
   * общие, но привязки микшера — свои, и их надо снять.
   */
  dispose(): void {
    this.mixer.stopAllAction()
    this.mixer.uncacheRoot(this.mixer.getRoot())
    this.root.removeFromParent()
  }

  setYaw(yaw: number): void {
    this.body.rotation.y = yaw
  }

  setHeadYaw(offset: number): void {
    // Клипы кость головы не трогают именно затем, чтобы взгляд остался за
    // рантаймом: иначе трек затирал бы внимание кота каждый кадр.
    this.head.quaternion.copy(this.headBase).multiply(
      this.q.setFromEuler(this.e.set(0, offset, 0)),
    )
  }

  animate(action: CatView['action'], dt: number): void {
    if (action !== this.playing) {
      const next = this.clips.get(action)
      if (next !== undefined) {
        const prev = this.playing === null ? undefined : this.clips.get(this.playing)
        next.reset().play()
        if (prev !== undefined) next.crossFadeFrom(prev, FADE, true)
        this.playing = action
      }
    }
    this.mixer.update(dt)
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
  /** Своё время: у капсулы нет микшера, её движение считается от фазы. */
  private phase = 0

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

  animate(action: CatView['action'], dt: number): void {
    this.phase += dt
    const phase = this.phase
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
   * Кит приехал. Фигуры пересобираются на месте: углы переносятся, поэтому
   * подмена не выглядит рывком, а кот не телепортируется. Фаза капсулы
   * теряется вместе с капсулой — клип всё равно начинается со своего начала.
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
        obj = { figure: this.build(), yaw: 0, headYaw: 0 }
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

    obj.figure.animate(view.action, dt)
    // После анимации: микшер трогает те же кости и иначе затрёт поворот головы.
    obj.figure.setHeadYaw(obj.headYaw)
  }
}
