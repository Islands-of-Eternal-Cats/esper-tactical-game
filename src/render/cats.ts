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
import { smoothAlong } from './path'
import { Hose } from './hose'

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

// Резче, чем у головы: доворот на 45° при выходе на диагональ идёт вместе
// со стартом шага, и пока корпус вертится, кот читается не идущим, а
// плывущим. Постоянная времени — 55 мс.
const TURN_RATE = 18
const HEAD_RATE = 9
/**
 * Дальше кот не выворачивает голову — иначе внимание читается как поломка.
 * На капсуле сходили с рук 110°, у настоящей шеи в капюшоне — нет.
 */
const HEAD_LIMIT = (60 * Math.PI) / 180
/**
 * Доля рысканья на шее — ноль: воротник капюшона весит на шее, и любой
 * её поворот скручивает его вслед за головой. Наклон шеи из клипов при
 * этом остаётся — капюшон наклоняется вместе с ней.
 */
const NECK_SHARE = 0

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
  /**
   * Продвинуть движение на кадр. `dt` — то же время, что у поворотов;
   * `speed` — скорость земли под котом, ед/с (0, когда стоит).
   */
  animate(action: CatView['action'], dt: number, speed: number): void
}

// --------------------------------------------------------------------------
// Модель
// --------------------------------------------------------------------------

/**
 * Смена клипа — кроссфейд, а не подмена кадром: на стыке занятий кот не
 * должен дёргаться. Но в шаг он входит быстрее, чем в работу: клетка
 * проходится за 0.4 с, и фейд в четверть секунды — это половина пути, на
 * которой кот уже едет, а ноги ещё в позе покоя. Со стороны это «летит».
 */
const FADE: Record<CatView['action'], number> = {
  walk: 0.06,
  haul: 0.06,
  idle: 0.22,
  work: 0.22,
  dump: 0.22,
}

/**
 * С какой фазы цикла стартует клип. Шаг — с проноса, а не с контакта:
 * контактная поза почти неотличима от покоя, и до первого видимого движения
 * ног проходит четверть цикла, за которую кот уже уехал на полклетки.
 * Пронос — нога в воздухе — читается как ходьба с первого кадра.
 */
/** Скорость ног в клипе, ед/с — из extras glTF; у неходячих клипов её нет. */
function footSpeedOf(clip: THREE.AnimationClip): number | null {
  const v: unknown = (clip.userData as Record<string, unknown>)['foot_speed']
  return typeof v === 'number' && v > 0 ? v : null
}

const START_PHASE: Partial<Record<CatView['action'], number>> = {
  walk: 0.25,
  haul: 0.25,
}

class ModelFigure implements Figure {
  readonly root = new THREE.Group()
  private readonly body = new THREE.Group()
  private readonly mixer: THREE.AnimationMixer
  private readonly clips = new Map<CatView['action'], THREE.AnimationAction>()
  private readonly head: THREE.Bone
  /** Bind-поза головы: рысканье задаётся смещением от неё, а не поверх кадра. */
  private readonly headBase: THREE.Quaternion
  private readonly neck: THREE.Bone
  /** Обратный к доле шеи прошлого кадра: снять её, прежде чем класть новую. */
  private readonly neckUndo = new THREE.Quaternion()
  private readonly q = new THREE.Quaternion()
  private readonly e = new THREE.Euler()
  private playing: CatView['action'] | null = null
  /** Шланг от ранца к раструбу: оба пропса на сокетах, шланг — между ними. */
  private readonly hose: Hose | null
  private readonly gear: THREE.Object3D | null
  private readonly held: THREE.Object3D | null
  private readonly hoseFrom = new THREE.Vector3()
  private readonly hoseTo = new THREE.Vector3()
  private readonly hoseSide = new THREE.Vector3()

  constructor(rig: CatRig) {
    this.root.add(this.body)
    this.body.add(rig.root)

    this.gear = rig.root.getObjectByName('gear_vacuum') ?? null
    this.held = rig.root.getObjectByName('held_vacuum') ?? null
    if (this.gear !== null && this.held !== null) {
      this.hose = new Hose(new THREE.MeshLambertMaterial({ color: PALETTE.hose }))
      this.body.add(this.hose.mesh)
    } else {
      this.hose = null
    }

    this.mixer = new THREE.AnimationMixer(rig.root)
    for (const name of ACTIONS) {
      const action = this.mixer.clipAction(clip(rig, name))
      action.setLoop(THREE.LoopRepeat, Infinity)
      this.clips.set(name, action)
    }

    this.head = bone(rig, 'mixamorig:Head')
    this.headBase = this.head.quaternion.clone()
    this.neck = bone(rig, 'mixamorig:Neck')
  }

  /**
   * Геометрия и материалы приехали из кита и общие на всех котов: освободить
   * их здесь — значит стереть модель у остальных и у будущих. Клипы тоже
   * общие, но привязки микшера — свои, и их надо снять.
   */
  dispose(): void {
    this.mixer.stopAllAction()
    this.mixer.uncacheRoot(this.mixer.getRoot())
    this.hose?.dispose()
    this.root.removeFromParent()
  }

  setYaw(yaw: number): void {
    this.body.rotation.y = yaw
  }

  setHeadYaw(offset: number): void {
    // Клипы кость головы не трогают именно затем, чтобы взгляд остался за
    // рантаймом: иначе трек затирал бы внимание кота каждый кадр.
    this.head.quaternion.copy(this.headBase).multiply(
      this.q.setFromEuler(this.e.set(0, offset * (1 - NECK_SHARE), 0)),
    )
    // Шею клипы анимируют (наклон корпуса), поэтому её доля — поверх того,
    // что поставил микшер, а не от bind-позы. Но пишет её микшер не в
    // каждом клипе: постоянные каналы из экспорта выброшены, и в work трека
    // шеи нет. Поэтому прошлый поворот снимается в animate() до микшера —
    // иначе он копился бы кадр за кадром, пока голова не уедет на спину.
    this.q.setFromEuler(this.e.set(0, offset * NECK_SHARE, 0))
    this.neck.quaternion.multiply(this.q)
    this.neckUndo.copy(this.q).invert()
  }

  animate(action: CatView['action'], dt: number, speed: number): void {
    this.neck.quaternion.multiply(this.neckUndo)
    this.neckUndo.identity()
    if (action !== this.playing) {
      const next = this.clips.get(action)
      if (next !== undefined) {
        const prev = this.playing === null ? undefined : this.clips.get(this.playing)
        next.reset().play()
        next.time = (START_PHASE[action] ?? 0) * next.getClip().duration
        // Без warp: он подгоняет скорость нового клипа под длину старого,
        // и шаг после покоя (0.8 с против 3.2 с) стартовал бы вчетверо
        // медленнее — ноги трогаются позже кота. Warp для walk↔run, не сюда.
        if (prev !== undefined) next.crossFadeFrom(prev, FADE[action], false)
        this.playing = action
      }
    }
    // Ноги не скользят: темп шага — отношение скорости земли к скорости
    // ног в клипе (foot_speed запечён в extras при сборке кита). Темп игры
    // и шаг клипа сведены близко, чтобы тут крутилось на проценты, а не в
    // разы: при большом множителе кот семенит.
    const current = this.playing === null ? undefined : this.clips.get(this.playing)
    if (current !== undefined) {
      const footSpeed = footSpeedOf(current.getClip())
      current.timeScale = footSpeed !== null && speed > 0 ? speed / footSpeed : 1
    }
    this.mixer.update(dt)
    this.syncHose(dt)
  }

  /**
   * Концы шланга — обрубок на крышке ранца и верх рукояти раструба, в
   * локальных координатах пропсов (glTF: +Y вверх). Считается в системе
   * `body`, куда шланг и положен: там же, где повёрнут корпус, и без
   * позиции кота в мире.
   */
  private syncHose(dt: number): void {
    if (this.hose === null || this.gear === null || this.held === null) return
    this.body.updateWorldMatrix(true, true)
    // Выход из бака — на правой стенке у самого низа (glTF пропса: +Y
    // вверх, правая сторона кота — −X, наружная стенка бака — −Z);
    // рукоять — верх раструба.
    this.gear.localToWorld(this.hoseFrom.set(-0.12, 0.06, -0.06))
    this.held.localToWorld(this.hoseTo.set(0, 0.03, 0))
    this.body.worldToLocal(this.hoseFrom)
    this.body.worldToLocal(this.hoseTo)
    // Наружу — вправо от кота (в системе body право — −X).
    this.hoseSide.set(-1, 0, 0)
    this.hose.update(this.hoseFrom, this.hoseTo, this.hoseSide, dt)
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
    // Скорость земли капсуле не нужна: у неё нет ног, чтобы скользить.
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
  private readonly c = new THREE.Vector3()
  /** Ломаная маршрута: prev, cell, next, дальше — без аллокаций на кадр. */
  private readonly route: THREE.Vector3[] = Array.from({ length: 8 }, () => new THREE.Vector3())
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

  /** Экранная позиция кота — для отладочной камеры-преследователя. */
  positionOf(id: string): THREE.Vector3 | null {
    const obj = this.objects.get(id)
    return obj === undefined ? null : obj.figure.root.position
  }

  private build(): Figure {
    return this.kit === null ? new StandInFigure() : new ModelFigure(this.kit.spawn(RUSTY_PARTS))
  }

  /** Тик последнего снапшота и модельное время, прошедшее с него. */
  private seenTick = -1
  private sinceTick = 0

  /** `dt` — реальное время кадра, умноженное на множитель скорости. */
  sync(snap: Snapshot, dt: number): void {
    // Снапшот приходит раз в тик, а тик — 50 мс модельного времени: на ×0.1
    // это два раза в секунду. Между снапшотами позиция ведётся вперёд по
    // тому же закону, по которому её посчитает симуляция, — поэтому в
    // момент прихода снапшота она уже там, и стыка не видно.
    if (snap.tick !== this.seenTick) {
      this.seenTick = snap.tick
      this.sinceTick = 0
    } else {
      this.sinceTick += dt * 1000
    }
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

  /** Ломаная prev → cell → next → route… в `this.route`; вернёт число точек. */
  private routePoints(view: CatView): number {
    let n = 0
    const push = (cell: { x: number; y: number }): void => {
      if (n < this.route.length) cellToWorld(cell, this.world, this.route[n++]!)
    }
    push(view.prev ?? view.cell)
    push(view.cell)
    for (const cell of view.route) push(cell)
    return n
  }

  private place(obj: CatObject, view: CatView, dt: number): void {
    // Позиция — вдоль маршрута по прогрессу. Симуляция дискретная, картинка
    // непрерывная. Прогресс экстраполируется на время с последнего тика той
    // же скоростью, что и в симуляции, и упирается в следующую клетку.
    let speed = 0
    let s = 0
    if (view.next !== null) {
      cellToWorld(view.cell, this.world, this.a)
      cellToWorld(view.next, this.world, this.b)
      const moving = view.action === 'walk' || view.action === 'haul'
      const ahead = moving && view.stepMs > 0 ? this.sinceTick / view.stepMs : 0
      if (moving && view.stepMs > 0) speed = this.a.distanceTo(this.b) / (view.stepMs / 1000)
      s = Math.min(1, view.progress + ahead)
    }

    // Лесенка A* сглаживается скользящим средним по маршруту: центры
    // клеток зигзага лежат по обе стороны прямой, и среднее по окну в
    // клетку ложится на неё. Симуляция об этом не знает и знать не должна.
    const n = this.routePoints(view)
    smoothAlong(this.route, n, 1 + s, this.a)
    obj.figure.root.position.set(this.a.x, 0, this.a.z)

    // Корпус — по касательной к сглаженной кривой, пока кот идёт; иначе на
    // повороте лесенки он бы дёргался между восемью направлениями.
    let yawTarget: number
    if (speed > 0 && n >= 3) {
      smoothAlong(this.route, n, 1 + s + 0.25, this.b)
      smoothAlong(this.route, n, 1 + s - 0.25, this.c)
      yawTarget = Math.atan2(this.b.x - this.c.x, this.b.z - this.c.z)
    } else {
      const [hx, hz] = HEADING[view.facing]
      yawTarget = Math.atan2(hx, hz)
    }
    obj.yaw = approachAngle(obj.yaw, yawTarget, TURN_RATE, dt)
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

    obj.figure.animate(view.action, dt, speed)
    // После анимации: микшер трогает те же кости и иначе затрёт поворот головы.
    obj.figure.setHeadYaw(obj.headYaw)
  }
}
