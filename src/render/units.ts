/**
 * Юниты: капсулы цвета стороны, до кита. Трассеры и вспышки — по событиям.
 *
 * Движение — тот же `Glide`, что у кота: ни строчки новой интерполяции.
 * `action` — единственный источник позы, `events` проигрываются и
 * забываются: ничего из них не живёт в рендере дольше одного проигрывания.
 */

import * as THREE from 'three'
import type { Dir, Event, Snapshot, UnitSign, UnitView, WorldView } from '../shared/protocol'
import { Glide } from './glide'
import { disposeTree } from './kit'
import { assembleGun, holdOf } from './guns'
import { reach } from './ik'
import { type CharacterKit, type CharacterRig, type GunKit, clip, joint } from './model'
import { PALETTE } from './palette'
import { Signs } from './signs'
import { audio } from './audio'

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
/**
 * Куда ложится тело в клипе смерти, в системе фигуры (x вправо, z вперёд):
 * голова и дальняя нога. Измерено по клипу `die`.
 * По этим точкам при смерти выбирается поворот, чтобы труп не лёг в стену.
 */
const FALL_HEAD: [number, number] = [-0.5, 0.45]
const FALL_FEET: [number, number] = [-0.35, -0.41]
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
/** Длина шага капсулы, м: у неё нет клипа, из которого её взять. */
const STANDIN_STRIDE = 0.6
/** Кот в перестрелке бежит на лапах — шаг тише, чем у Y Bot в ботинках. */
const CAT_WEIGHT = 0.5

function approachAngle(current: number, target: number, rate: number, dt: number): number {
  let d = target - current
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return current + d * (1 - Math.exp(-rate * dt))
}

/**
 * Фигура юнита. Модель и капсула отвечают на одни и те же вопросы, и
 * больше рендер про них ничего не знает.
 */
interface Figure {
  readonly root: THREE.Object3D
  readonly overlay: Overlay
  dispose(): void
  setYaw(yaw: number): void
  /** `speed` — скорость земли под ногами, ед/с (0, когда стоит). */
  animate(action: UnitView['action'], dt: number, speed: number): void
  /** Сколько земли проходится за один шаг, м: по нему звучат шаги. */
  stride(): number
}

/**
 * То, что над фигурой и у её ног: деления здоровья, знак, щиток укрытия.
 * Общее для капсулы и модели — у них разный рост, но одинаковые вопросы.
 */
class Overlay {
  readonly bar = new THREE.Group()
  readonly shield: THREE.Mesh
  private readonly pips: THREE.Mesh[] = []
  private readonly sign: THREE.Mesh
  private shown: UnitSign | null = null

  constructor(private readonly signs: Signs, height: number) {
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
    this.bar.position.y = height + 0.35

    this.sign = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.44))
    this.sign.position.y = 0.34
    this.sign.renderOrder = 11
    this.sign.visible = false
    this.bar.add(this.sign)

    // Щиток — в сторону угрозы, у ног, без освещения: он знак, а не предмет.
    this.shield = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.26, 0.05),
      new THREE.MeshBasicMaterial({ color: PALETTE.shield, transparent: true, opacity: 0.85 }),
    )
    this.shield.position.set(0, 0.16, 0.36)
    this.shield.visible = false
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

  setSign(sign: UnitSign | null): void {
    if (sign === this.shown) return
    this.shown = sign
    this.sign.visible = sign !== null
    if (sign !== null) this.sign.material = this.signs.material(sign)
  }

  faceCamera(q: THREE.Quaternion): void {
    this.bar.quaternion.copy(q)
  }

  /** Мёртвому ни здоровья, ни знаков. */
  hide(): void {
    this.bar.visible = false
    this.shield.visible = false
  }
}

// --------------------------------------------------------------------------
// Капсула: то, что видно, пока кит не приехал
// --------------------------------------------------------------------------

class StandInFigure implements Figure {
  readonly root = new THREE.Group()
  readonly overlay: Overlay
  private readonly body = new THREE.Group()
  private readonly lean = new THREE.Group()
  private readonly gun: THREE.Mesh
  private phase = 0
  /** 0 — стоит, 1 — лежит. */
  private fallen = 0

  constructor(color: number, signs: Signs) {
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

    this.overlay = new Overlay(signs, 0.95)
    this.root.add(this.overlay.bar)
    this.body.add(this.overlay.shield)
  }

  dispose(): void {
    this.root.removeFromParent()
    disposeTree(this.root)
  }

  setYaw(yaw: number): void {
    this.body.rotation.y = yaw
  }

  stride(): number {
    return STANDIN_STRIDE
  }

  animate(action: UnitView['action'], dt: number): void {
    this.phase += dt
    const phase = this.phase
    if (action === 'dead') {
      this.fallen = Math.min(1, this.fallen + dt / FALL_S)
      this.overlay.hide()
    }
    // Труп — капсула лежит. Достаточно. Лёжа корпус лежит на боку радиусом
    // на полу, а не по оси.
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

// --------------------------------------------------------------------------
// Модель из кита
// --------------------------------------------------------------------------

/** Клипы по действию. Имена — контракт с ассетом, `tests/unit-kit.test.ts`. */
const CLIP_OF: Record<UnitView['action'], string> = {
  idle: 'idle',
  move: 'run',
  aim: 'aim',
  fire: 'fire',
  dead: 'die',
}

/**
 * Свои — кот, противник — Y Bot; оба из кита юнитов, у каждого свой скелет и
 * свои клипы, скачанные для него: переноса нет. Клипы кота — `cat_*`.
 */
const CAT_HEIGHT = 1.2

/** Однократные клипы: выстрел отыгрывается и держит последний кадр, смерть — тоже. */
const ONCE = new Set<UnitView['action']>(['fire', 'dead'])

/**
 * Кроссфейд между занятиями. В бег — быстро, как у кота: клетка проходится
 * за 0.9 с, и полсекунды фейда — это полпути в позе покоя.
 */
const FADE: Record<UnitView['action'], number> = {
  move: 0.08,
  idle: 0.2,
  aim: 0.15,
  fire: 0.04,
  dead: 0.1,
}

/** Рост Y Bot — из скрипта сборки (CHARACTERS). Полоска и знак — над ним. */
const MODEL_HEIGHT = 1.35

function footSpeedOf(clip: THREE.AnimationClip): number | null {
  const v: unknown = (clip.userData as Record<string, unknown>)['foot_speed']
  return typeof v === 'number' && v > 0 ? v : null
}

/**
 * Винтовка кота. Не на кости ладони: после ретаргета запястье крутится
 * непредсказуемо, и ствол, повторяющий его, смотрит куда угодно. Вместо
 * этого ствол каждый кадр строится по положениям костей: в прицеле — от
 * правой ладони к левой (обе лежат на винтовке), иначе — вдоль предплечья.
 */
const GUN_LENGTH = 0.6
/** Приклад — за хватом, у плеча; всё остальное — вперёд, за левую ладонь. */
const GUN_STOCK = 0.15
const GUN_AHEAD = GUN_LENGTH / 2 - GUN_STOCK

class ModelFigure implements Figure {
  readonly root = new THREE.Group()
  readonly overlay: Overlay
  private readonly body = new THREE.Group()
  private readonly mixer: THREE.AnimationMixer
  private readonly clips = new Map<UnitView['action'], THREE.AnimationAction>()
  private readonly material: THREE.MeshLambertMaterial | null
  private playing: UnitView['action'] | null = null
  private readonly gun: THREE.Object3D | null
  /** Насколько начало координат модели оружия впереди ладони: у бруска — его центр. */
  private readonly gunAhead: number
  private readonly handR: THREE.Object3D | null
  private readonly handL: THREE.Object3D | null
  private readonly armL: THREE.Object3D | null
  private readonly foreArmL: THREE.Object3D | null
  /** Где на оружии лежит левая ладонь: вперёд от рукояти, м. */
  private readonly hold: number
  private readonly v1 = new THREE.Vector3()
  private readonly v2 = new THREE.Vector3()
  private readonly v3 = new THREE.Vector3()

  /**
   * `clipsOf(action)` — откуда брать клип: у Y Bot всё из одного кита, у
   * кота свои `cat_*`. `color` — плоский цвет стороны; null — оставить
   * материалы кита (кот раскрашен своей картой).
   * `gun` — модель из кита оружия с рукоятью в начале координат; `'stub'` —
   * брусок до кита; null — безоружный.
   */
  constructor(
    rig: CharacterRig,
    clipOf: (action: UnitView['action']) => THREE.AnimationClip,
    color: number | null,
    height: number,
    signs: Signs,
    gun: THREE.Object3D | 'stub' | null,
  ) {
    this.root.add(this.body)
    this.body.add(rig.root)
    this.material = color === null ? null : new THREE.MeshLambertMaterial({ color })
    rig.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        if (this.material !== null) o.material = this.material
        o.castShadow = true
      }
    })

    if (gun !== null) {
      if (gun === 'stub') {
        const stub = new THREE.Mesh(
          new THREE.BoxGeometry(0.035, 0.05, GUN_LENGTH),
          new THREE.MeshLambertMaterial({ color: PALETTE.hose }),
        )
        stub.castShadow = true
        this.gun = stub
        this.gunAhead = GUN_AHEAD
        this.hold = GUN_AHEAD + GUN_LENGTH * 0.2
      } else {
        this.gun = gun
        this.gunAhead = 0
        this.hold = holdOf(gun)
      }
      this.body.add(this.gun)
      // Не `bone()`: у Y Bot кисти и пальцы без весов, и загрузчик делает
      // их не костями, а простыми узлами — ищутся по имени в иерархии.
      this.handR = joint(rig, 'mixamorig:RightHand')
      this.handL = joint(rig, 'mixamorig:LeftHand')
      this.armL = joint(rig, 'mixamorig:LeftArm')
      this.foreArmL = joint(rig, 'mixamorig:LeftForeArm')
    } else {
      this.gun = null
      this.gunAhead = 0
      this.hold = 0
      this.handR = this.handL = this.armL = this.foreArmL = null
    }

    this.mixer = new THREE.AnimationMixer(rig.root)
    for (const action of Object.keys(CLIP_OF) as UnitView['action'][]) {
      const a = this.mixer.clipAction(clipOf(action))
      if (ONCE.has(action)) {
        a.setLoop(THREE.LoopOnce, 1)
        a.clampWhenFinished = true
      } else {
        a.setLoop(THREE.LoopRepeat, Infinity)
      }
      this.clips.set(action, a)
    }

    this.overlay = new Overlay(signs, height)
    this.root.add(this.overlay.bar)
    this.body.add(this.overlay.shield)
  }

  /** Геометрия и клипы — общие с китом; своё здесь — микшер и материал. */
  dispose(): void {
    this.mixer.stopAllAction()
    this.mixer.uncacheRoot(this.mixer.getRoot())
    this.material?.dispose()
    this.root.removeFromParent()
  }

  setYaw(yaw: number): void {
    this.body.rotation.y = yaw
  }

  animate(action: UnitView['action'], dt: number, speed: number): void {
    if (action !== this.playing && this.playing !== 'dead') {
      const next = this.clips.get(action)
      if (next !== undefined) {
        const prev = this.playing === null ? undefined : this.clips.get(this.playing)
        next.reset().play()
        if (prev !== undefined) next.crossFadeFrom(prev, FADE[action], false)
        this.playing = action
        if (action === 'dead') this.overlay.hide()
      }
    }
    // Ноги не скользят: темп бега — скорость земли к скорости ног в клипе.
    const current = this.playing === null ? undefined : this.clips.get(this.playing)
    if (current !== undefined) {
      const footSpeed = footSpeedOf(current.getClip())
      current.timeScale = footSpeed !== null && speed > 0 ? speed / footSpeed : 1
    }
    this.mixer.update(dt)
    this.placeGun()
  }

  /** Цикл бега — два шага: путь за клип пополам. */
  stride(): number {
    const current = this.playing === null ? undefined : this.clips.get(this.playing)
    if (current === undefined) return STANDIN_STRIDE
    const footSpeed = footSpeedOf(current.getClip())
    return footSpeed === null ? STANDIN_STRIDE : (footSpeed * current.getClip().duration) / 2
  }

  private placeGun(): void {
    if (this.gun === null || this.handR === null || this.handL === null) return
    this.body.updateWorldMatrix(true, true)
    const grip = this.body.worldToLocal(this.handR.getWorldPosition(this.v1))
    // Все клипы кита — «с винтовкой»: и в покое, и на бегу обе ладони на
    // оружии, ствол — от правой к левой. Раньше покой шёл по фиксированному
    // направлению «на ремне»: у перенесённых клипов рука висела где попало.
    const dir = this.body.worldToLocal(this.handL.getWorldPosition(this.v2)).sub(grip)
    const span = dir.length()
    if (span < 1e-3) return
    dir.divideScalar(span)
    this.gun.position.copy(grip).addScaledVector(dir, this.gunAhead)
    this.gun.quaternion.setFromUnitVectors(FORWARD, dir)
    if (this.armL === null || this.foreArmL === null) return
    // Левая ладонь — на цевьё: IK кладёт кисть на линию ствола. Но не дальше,
    // чем её держит клип: в покое ладони близко, и тянуть кисть к цевью
    // короткого автомата значило бы вытянуть руку в струну.
    // `dir` живёт в v2 — цель считается в своём векторе, иначе она затрёт направление.
    const target = this.body.localToWorld(this.v3.copy(grip).addScaledVector(dir, Math.min(this.hold, span)))
    reach(this.armL, this.foreArmL, this.handL, target, DOWN)
  }
}

const DOWN = new THREE.Vector3(0, -1, 0)

const FORWARD = new THREE.Vector3(0, 0, 1)

interface UnitObject {
  figure: Figure
  side: UnitView['side']
  weapon: string
  yaw: number
  /** Умер капсулой — и остаётся ею, даже когда кит приехал. */
  dead: boolean
  /** Пройдено с прошлого шага, м: шаг звучит, когда набирается stride. */
  walked: number
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
  private readonly signs = new Signs()
  private kit: CharacterKit | null = null
  private gunKit: GunKit | null = null

  /** Занятые клетки двора — стены, пропсы, контейнер: куда трупу не лечь. */
  private readonly solid = new Set<number>()

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: WorldView,
  ) {
    this.glide = new Glide(world)
    for (const c of world.walls) this.solid.add(c.y * world.width + c.x)
    for (const p of world.props) this.solid.add(p.cell.y * world.width + p.cell.x)
    this.solid.add(world.container.y * world.width + world.container.x)
    scene.add(this.root)
  }

  private free(x: number, z: number): boolean {
    const cx = Math.floor(x + this.world.width / 2)
    const cy = Math.floor(z + this.world.height / 2)
    if (cx < 0 || cy < 0 || cx >= this.world.width || cy >= this.world.height) return false
    return !this.solid.has(cy * this.world.width + cx)
  }

  /**
   * Поворот для падения: ближайший к текущему из восьми, при котором голова
   * и ноги ложатся на свободные клетки. Не нашлось — текущий, как есть.
   */
  private fallYaw(at: THREE.Vector3, yaw: number): number {
    const fits = (a: number): boolean => {
      for (const [ox, oz] of [FALL_HEAD, FALL_FEET]) {
        const wx = at.x + ox * Math.cos(a) + oz * Math.sin(a)
        const wz = at.z - ox * Math.sin(a) + oz * Math.cos(a)
        if (!this.free(wx, wz)) return false
      }
      return true
    }
    let best = yaw
    let bestD = Infinity
    for (let k = 0; k < 8; k++) {
      const a = yaw + (k * Math.PI) / 4
      if (!fits(a)) continue
      const d = Math.abs(((k * Math.PI) / 4 + Math.PI) % (2 * Math.PI) - Math.PI)
      if (d < bestD) {
        bestD = d
        best = a
      }
    }
    return best
  }

  /**
   * Кит приехал: фигуры пересобираются на месте, углы переносятся —
   * подмена не выглядит рывком. Мёртвые остаются капсулами: клип смерти
   * с середины боя проигрывать нечему.
   */
  setKits(kit: CharacterKit, guns: GunKit | null): void {
    this.kit = kit
    this.gunKit = guns
    for (const obj of this.objects.values()) {
      if (obj.dead) continue
      obj.figure.dispose()
      obj.figure = this.build(obj.side, obj.weapon)
      obj.figure.setYaw(obj.yaw)
      this.root.add(obj.figure.root)
    }
  }

  /** Оружие по id из двора: модель из кита, пока кита нет — брусок. */
  private gun(weapon: string): THREE.Object3D | 'stub' {
    const w = this.world.weapons[weapon]
    if (this.gunKit === null || w === undefined) return 'stub'
    return assembleGun(this.gunKit, w.look)
  }

  private build(side: UnitView['side'], weapon: string): Figure {
    const color = side === 'player' ? PALETTE.ally : PALETTE.foe
    if (this.kit === null) return new StandInFigure(color, this.signs)
    // Кит несёт оба скелета с костями Mixamo под одними именами: чужой —
    // вон, иначе поиск сустава для оружия найдёт не тот.
    if (side === 'player') {
      const rig = this.kit.spawn(['cat_body'])
      rig.root.getObjectByName('unit_rig')?.removeFromParent()
      return new ModelFigure(rig, (action) => clip(rig, `cat_${CLIP_OF[action]}`), null, CAT_HEIGHT, this.signs, this.gun(weapon))
    }
    const rig = this.kit.spawn(['unit_body'])
    rig.root.getObjectByName('cat_rig')?.removeFromParent()
    return new ModelFigure(rig, (action) => clip(rig, CLIP_OF[action]), color, MODEL_HEIGHT, this.signs, this.gun(weapon))
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
    this.signs.dispose()
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
        obj = {
          figure: this.build(view.side, view.weapon),
          side: view.side,
          weapon: view.weapon,
          yaw: Math.atan2(hx, hz),
          dead: false,
          walked: 0,
        }
        this.objects.set(view.id, obj)
        this.root.add(obj.figure.root)
      }
      this.place(obj, view, dt)
      obj.figure.overlay.faceCamera(camera.quaternion)
    }
    for (const e of snap.events) this.play(e)
    this.age(dt)
  }

  private place(obj: UnitObject, view: UnitView, dt: number): void {
    const { speed, tangentYaw } = this.glide.place(view, view.action === 'move', this.a)
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
    else if (!obj.dead) obj.yaw = this.fallYaw(this.a, obj.yaw)
    obj.figure.setYaw(obj.yaw)
    obj.figure.overlay.setHp(view.hp)
    obj.figure.overlay.setCover(view.cover)
    obj.figure.overlay.setSign(view.sign)
    if (view.action === 'dead') obj.dead = true
    obj.figure.animate(view.action, dt, speed)
    this.footsteps(obj, speed, dt)
  }

  /** Шаги по пройденному пути — как у кота во дворе; см. Cats.footsteps. */
  private footsteps(obj: UnitObject, speed: number, dt: number): void {
    if (speed <= 0) {
      obj.walked = obj.figure.stride() / 2
      return
    }
    obj.walked += speed * dt
    const stride = obj.figure.stride()
    if (obj.walked < stride) return
    obj.walked %= stride
    const isCat = obj.side === 'player' && this.kit !== null
    audio.step(obj.figure.root.position.x, obj.figure.root.position.z, isCat ? CAT_WEIGHT : 1)
  }

  private play(e: Event): void {
    if (e.t !== 'shot') return
    const from = this.positionOf(e.from)
    const to = this.positionOf(e.to)
    if (from === null || to === null) return

    audio.shot(from.x, from.z)
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
