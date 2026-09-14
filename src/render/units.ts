/**
 * Юниты: капсулы цвета стороны, до кита. Трассеры и вспышки — по событиям.
 *
 * Движение — тот же `Glide`, что у кота: ни строчки новой интерполяции.
 * `action` — единственный источник позы, `events` проигрываются и
 * забываются: ничего из них не живёт в рендере дольше одного проигрывания.
 */

import * as THREE from 'three'
import type { Dir, Event, Snapshot, UnitView, WorldView } from '../shared/protocol'
import { Glide } from './glide'
import { disposeTree } from './kit'
import { PALETTE } from './palette'

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

const TURN_RATE = 18
/** Трассер живёт 3–4 кадра; вспышка чуть дольше, чтобы её успели увидеть. */
const TRACER_S = 0.07
const FLASH_S = 0.16
/** Как далеко за целью ложится промах, м. */
const MISS_BEYOND = 1.1
/** Высота груди: откуда летит и куда попадает. */
const CHEST = 0.62
/** Труп ложится за столько секунд. */
const FALL_S = 0.35
const HP_MAX = 3

function approachAngle(current: number, target: number, rate: number, dt: number): number {
  let d = target - current
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return current + d * (1 - Math.exp(-rate * dt))
}

/** Капсула: корпус, голова, ствол, полоска здоровья, щиток укрытия. */
class Figure {
  readonly root = new THREE.Group()
  private readonly body = new THREE.Group()
  private readonly lean = new THREE.Group()
  private readonly gun: THREE.Mesh
  private readonly bar = new THREE.Group()
  private readonly pips: THREE.Mesh[] = []
  private readonly shield: THREE.Mesh
  private phase = 0
  /** 0 — стоит, 1 — лежит. */
  private fallen = 0

  constructor(color: number) {
    this.root.add(this.body)
    this.body.add(this.lean)

    const mat = new THREE.MeshLambertMaterial({ color })
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.44, 6, 12), mat)
    torso.position.y = 0.5
    torso.castShadow = true
    this.lean.add(torso)

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), mat)
    head.position.y = 0.95
    this.lean.add(head)

    this.gun = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.07, 0.5),
      new THREE.MeshLambertMaterial({ color: PALETTE.outline }),
    )
    this.gun.position.set(0.16, 0.6, 0.22)
    this.lean.add(this.gun)

    // Полоска здоровья — три деления над головой, повёрнутые к камере.
    for (let i = 0; i < HP_MAX; i++) {
      const pip = new THREE.Mesh(
        new THREE.PlaneGeometry(0.16, 0.05),
        new THREE.MeshBasicMaterial({ color: PALETTE.hpOn, depthTest: false, transparent: true }),
      )
      pip.position.x = (i - (HP_MAX - 1) / 2) * 0.2
      pip.renderOrder = 10
      this.pips.push(pip)
      this.bar.add(pip)
    }
    this.bar.position.y = 1.3
    this.root.add(this.bar)

    // Щиток — в сторону угрозы, у ног, без освещения: он знак, а не предмет.
    this.shield = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.26, 0.05),
      new THREE.MeshBasicMaterial({ color: PALETTE.shield, transparent: true, opacity: 0.85 }),
    )
    this.shield.position.set(0, 0.16, 0.36)
    this.shield.visible = false
    this.body.add(this.shield)
  }

  dispose(): void {
    this.root.removeFromParent()
    disposeTree(this.root)
  }

  setYaw(yaw: number): void {
    this.body.rotation.y = yaw
  }

  setHp(hp: number): void {
    for (let i = 0; i < this.pips.length; i++) {
      const m = this.pips[i]!.material as THREE.MeshBasicMaterial
      m.color.setHex(i < hp ? PALETTE.hpOn : PALETTE.hpOff)
    }
  }

  setCover(on: boolean): void {
    this.shield.visible = on
  }

  faceCamera(q: THREE.Quaternion): void {
    this.bar.quaternion.copy(q)
  }

  animate(action: UnitView['action'], dt: number): void {
    this.phase += dt
    const phase = this.phase
    if (action === 'dead') {
      this.fallen = Math.min(1, this.fallen + dt / FALL_S)
      this.bar.visible = false
      this.shield.visible = false
    }
    // Труп — капсула лежит. Достаточно.
    // Лёжа корпус лежит на боку радиусом на полу, а не по оси.
    this.lean.rotation.x = -this.fallen * (Math.PI / 2)
    this.lean.position.y = this.fallen * 0.2
    if (this.fallen > 0) return

    switch (action) {
      case 'move':
        this.body.position.y = Math.abs(Math.sin(phase * 8)) * 0.04
        this.lean.rotation.x = 0.08
        this.gun.position.set(0.16, 0.6, 0.22)
        this.gun.rotation.x = 0.35
        break
      case 'aim':
        this.body.position.y = 0
        this.lean.rotation.x = 0.04
        this.gun.position.set(0.12, 0.72, 0.3)
        this.gun.rotation.x = 0
        break
      case 'fire':
        this.body.position.y = 0
        this.lean.rotation.x = -0.05
        this.gun.position.set(0.12, 0.72, 0.22)
        this.gun.rotation.x = -0.08
        break
      case 'idle':
        this.body.position.y = Math.sin(phase * 1.6) * 0.012
        this.lean.rotation.x = 0
        this.gun.position.set(0.16, 0.6, 0.22)
        this.gun.rotation.x = 0.35
        break
      case 'dead':
        break
    }
  }
}

interface UnitObject {
  figure: Figure
  yaw: number
}

interface Tracer {
  mesh: THREE.Mesh
  ttl: number
}

interface Flash {
  mesh: THREE.Mesh
  ttl: number
}

export class Units {
  private readonly root = new THREE.Group()
  private readonly objects = new Map<string, UnitObject>()
  private readonly glide: Glide
  private readonly a = new THREE.Vector3()
  private readonly b = new THREE.Vector3()
  private readonly tracers: Tracer[] = []
  private readonly flashes: Flash[] = []
  /** Трассер — тонкий бокс, а не Line: толще, заметнее, и класс уже в бандле. */
  private readonly tracerGeo = new THREE.BoxGeometry(0.03, 0.03, 1)
  private readonly tracerMat = new THREE.MeshBasicMaterial({ color: PALETTE.tracer, transparent: true, opacity: 0.9 })
  private readonly flashMat = new THREE.MeshBasicMaterial({ color: PALETTE.flash })
  private readonly flashGeo = new THREE.SphereGeometry(0.13, 8, 6)
  private readonly missMat = new THREE.MeshBasicMaterial({ color: PALETTE.tracer, transparent: true, opacity: 0.5 })

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: WorldView,
  ) {
    this.glide = new Glide(world)
    scene.add(this.root)
  }

  dispose(): void {
    this.scene.remove(this.root)
    for (const obj of this.objects.values()) obj.figure.dispose()
    this.objects.clear()
    for (const t of this.tracers) t.mesh.removeFromParent()
    for (const f of this.flashes) f.mesh.removeFromParent()
    this.tracers.length = 0
    this.flashes.length = 0
    this.tracerGeo.dispose()
    this.tracerMat.dispose()
    this.flashMat.dispose()
    this.missMat.dispose()
    this.flashGeo.dispose()
  }

  /** Экранная позиция юнита: для рамки выделения и трассеров. */
  positionOf(id: string): THREE.Vector3 | null {
    const obj = this.objects.get(id)
    return obj === undefined ? null : obj.figure.root.position
  }

  /** `dt` — реальное время кадра, умноженное на множитель скорости. */
  sync(snap: Snapshot, dt: number, camera: THREE.Camera): void {
    this.glide.frame(snap.tick, dt)
    for (const view of snap.units) {
      let obj = this.objects.get(view.id)
      if (obj === undefined) {
        const [hx, hz] = HEADING[view.facing]
        obj = { figure: new Figure(view.side === 'player' ? PALETTE.ally : PALETTE.foe), yaw: Math.atan2(hx, hz) }
        this.objects.set(view.id, obj)
        this.root.add(obj.figure.root)
      }
      this.place(obj, view, dt)
      obj.figure.faceCamera(camera.quaternion)
    }
    for (const e of snap.events) this.play(e)
    this.age(dt)
  }

  private place(obj: UnitObject, view: UnitView, dt: number): void {
    const { tangentYaw } = this.glide.place(view, view.action === 'move', this.a)
    obj.figure.root.position.set(this.a.x, 0, this.a.z)

    // Прицел — на цель точно, а не на одно из восьми направлений: стрелок,
    // глядящий на 20° мимо того, в кого стреляет, читается как поломка.
    let yawTarget: number
    const target = view.target === null ? null : this.positionOf(view.target)
    if (target !== null && view.action !== 'move') {
      yawTarget = Math.atan2(target.x - this.a.x, target.z - this.a.z)
    } else if (tangentYaw !== null) {
      yawTarget = tangentYaw
    } else {
      const [hx, hz] = HEADING[view.facing]
      yawTarget = Math.atan2(hx, hz)
    }
    if (view.action !== 'dead') obj.yaw = approachAngle(obj.yaw, yawTarget, TURN_RATE, dt)
    obj.figure.setYaw(obj.yaw)
    obj.figure.setHp(view.hp)
    obj.figure.setCover(view.cover)
    obj.figure.animate(view.action, dt)
  }

  private play(e: Event): void {
    if (e.t !== 'shot') return
    const from = this.positionOf(e.from)
    const to = this.positionOf(e.to)
    if (from === null || to === null) return

    this.a.set(from.x, CHEST, from.z)
    this.b.set(to.x, CHEST, to.z)
    const tracer = new THREE.Mesh(this.tracerGeo, this.tracerMat)
    tracer.position.copy(this.a).lerp(this.b, 0.5)
    tracer.scale.z = this.a.distanceTo(this.b)
    tracer.lookAt(this.b)
    this.root.add(tracer)
    this.tracers.push({ mesh: tracer, ttl: TRACER_S })

    // Попадание — вспышка на цели, промах — на клетке за ней.
    const flash = new THREE.Mesh(this.flashGeo, e.hit ? this.flashMat : this.missMat)
    if (e.hit) {
      flash.position.copy(this.b)
    } else {
      const dx = this.b.x - this.a.x
      const dz = this.b.z - this.a.z
      const d = Math.hypot(dx, dz) || 1
      flash.position.set(this.b.x + (dx / d) * MISS_BEYOND, 0.2, this.b.z + (dz / d) * MISS_BEYOND)
      flash.scale.setScalar(0.6)
    }
    this.root.add(flash)
    this.flashes.push({ mesh: flash, ttl: FLASH_S })
  }

  private age(dt: number): void {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i]!
      t.ttl -= dt
      if (t.ttl > 0) continue
      t.mesh.removeFromParent()
      this.tracers.splice(i, 1)
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i]!
      f.ttl -= dt
      if (f.ttl > 0) continue
      f.mesh.removeFromParent()
      this.flashes.splice(i, 1)
    }
  }

  /** Клетка юнита под точкой на земле — по последнему снапшоту. */
  static at(snap: Snapshot, cell: { x: number; y: number }, side: UnitView['side']): UnitView | null {
    for (const u of snap.units) {
      if (u.side !== side || u.action === 'dead') continue
      if (u.cell.x === cell.x && u.cell.y === cell.y) return u
      if (u.next !== null && u.progress > 0.5 && u.next.x === cell.x && u.next.y === cell.y) return u
    }
    return null
  }
}
