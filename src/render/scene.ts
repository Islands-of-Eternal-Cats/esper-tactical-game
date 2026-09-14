/**
 * Сцена: читает снапшот и рисует. Никогда не меняет состояние сама.
 *
 * Ввод отсюда уходит наружу командами и больше ничем: клик не двигает кота,
 * он сообщает воркеру намерение.
 */

import * as THREE from 'three'
import type { Cell, Snapshot, UnitView, WorldView } from '../shared/protocol'
import { IsoCamera } from './camera'
import { Cats } from './cats'
import { type CharacterKit, type EnvKit, type GunKit, type KitLoads, loadGunKit, loadUnitKit } from './model'
import { Kit, worldToCell } from './kit'
import { PALETTE } from './palette'
import { Select } from './select'
import { Units } from './units'
import { audio } from './audio'

export interface SceneHandlers {
  onIntent: (cell: Cell) => void
  onClearIntent: () => void
  /** Перестрелка: приказ выделенным идти в клетку. */
  onMove: (units: string[], cell: Cell) => void
  /** Выделение сменилось — интерфейсу показать, кого. */
  onSelect: (units: string[]) => void
}

/** Смещение курсора, после которого жест считается панорамой, а не кликом. */
const DRAG_SLOP = 4

/** Радиус попадания в фигуру на экране, px: капсула стоит выше своей клетки. */
const PICK_PX = 22

/**
 * Фон — вертикальный градиент: сверху холодное «небо», внизу графит тумана.
 * Плоская заливка одним цветом читалась как незакрашенный вьюпорт.
 */
function skyGradient(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, 0, canvas.height)
  g.addColorStop(0, `#${PALETTE.sky.toString(16).padStart(6, '0')}`)
  g.addColorStop(1, `#${PALETTE.background.toString(16).padStart(6, '0')}`)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

export class SceneView {
  private readonly renderer: THREE.WebGLRenderer
  /** Публично только ради отладки из консоли (см. main.ts). */
  readonly scene = new THREE.Scene()
  private readonly view = new IsoCamera()
  private world: WorldView
  private kit: Kit
  private cats: Cats
  private units: Units
  private select: Select
  /** Последний снапшот: по нему клик попадает в юнита. */
  private snap: Snapshot | null = null
  /** Выделение живёт здесь целиком: воркер знает только итоговый список id. */
  private selected = new Set<string>()
  private contextLost = false
  /** Кит переживает пересборку двора: грузить его на каждый сид незачем. */
  private catKit: CharacterKit | null = null
  private envKit: EnvKit | null = null
  private unitKit: CharacterKit | null = null
  private gunKit: GunKit | null = null

  private pointerId: number | null = null
  private button = 0
  private startX = 0
  private startY = 0
  private lastX = 0
  private lastY = 0
  private dragging = false
  /** Киты приехали или отказали — в любом случае показывать можно. */
  readonly ready: Promise<void>

  constructor(
    private readonly canvas: HTMLCanvasElement,
    world: WorldView,
    handlers: SceneHandlers,
    kits: KitLoads,
  ) {
    this.world = world
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    // Выше двух гнать нечего: плоская заливка от этого не выигрывает.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    // Контраст — из тонмаппинга, а не из яркости ламп: плоские заливки без
    // него сливаются в одно серое пятно, светлое и тёмное не расходятся.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.15
    // Тени от ключевого света — то, что ставит предмет на землю. Без них
    // стена и пол одного тона смыкаются в одну плоскость.
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.scene.background = skyGradient()
    // Туман съедает улицу за оградой в цвет фона: двор — освещённый
    // островок, за ним ничего разглядывать не надо. Дальность от камеры
    // (60) с запасом на весь двор: сам двор туман не трогает.
    this.scene.fog = new THREE.Fog(PALETTE.background, 64, 96)

    // Рассеянного света мало и он холодный: тень должна быть тёмной, иначе
    // она не тень. Ключевой — сильный, чуть тёплый, сверху и с ближней
    // стороны (камера смотрит от +X+Z): грань +Z освещена, грань +X в
    // полутени, и тень ложится на пол правее блока, где её видно, а не
    // за ним, где её загораживает сам блок.
    this.scene.add(new THREE.HemisphereLight(0x8fa4bf, 0x14171c, 0.55))
    const key = new THREE.DirectionalLight(0xfff0dd, 2.6)
    key.position.set(-5, 14, 9)
    key.castShadow = true
    // Двор 20×20 плюс ограда; тень ортографическая, без запаса по краям
    // она обрезается на дальней стене.
    const sc = key.shadow.camera
    sc.left = sc.bottom = -20
    sc.right = sc.top = 20
    sc.near = 1
    sc.far = 60
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.bias = -0.0005
    key.shadow.normalBias = 0.02
    this.scene.add(key)
    this.scene.add(key.target)
    const fill = new THREE.DirectionalLight(0x6d86a8, 0.35)
    fill.position.set(-8, 6, -6)
    this.scene.add(fill)

    this.kit = new Kit(this.scene, world)
    if (this.envKit !== null) this.kit.setEnv(this.envKit)
    this.cats = new Cats(this.scene, world)
    if (this.catKit !== null) this.cats.setKit(this.catKit)
    this.units = new Units(this.scene, world)
    this.select = new Select(this.scene, world, canvas.parentElement ?? document.body)
    this.wantUnitKit()
    this.view.lookAtCentre(0, 0)

    // Мобильные браузеры убивают контекст при сворачивании.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.contextLost = true
    })
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false
    })

    // Киты уже грузятся с самого старта; сцена до них работает на грейбоксе,
    // и падение загрузки не уносит с собой игру. Но показывать грейбокс не
    // надо — до `ready` главный поток держит занавес; капсула остаётся
    // запасным путём.
    this.ready = Promise.allSettled([
      kits.cat.then(
        (kit) => {
          this.catKit = kit
          this.cats.setKit(kit)
          // Свои в перестрелке — коты: если кит юнитов уже здесь, пересобрать.
          if (this.unitKit !== null && this.world.mode === 'skirmish') this.units.setKits(this.unitKit, kit, this.gunKit)
        },
        (err: unknown) => console.warn('кит персонажей не загрузился, остаёмся на капсуле', err),
      ),
      kits.env.then(
        (env) => {
          this.envKit = env
          this.kit.setEnv(env)
        },
        (err: unknown) => console.warn('кит окружения не загрузился, кучи остаются коробками', err),
      ),
    ]).then(() => undefined)

    this.bindPointer(handlers)
    this.resize()
  }

  /**
   * Ввод через Pointer Events. Клик и жест живут на одной кнопке, поэтому
   * жест решается порогом: сдвинул — жест, не сдвинул — клик.
   *
   * Двор: левая — намерение, тянуть — панорама.
   * Перестрелка: левая — выделить или послать, тянуть — рамка; правая —
   * снять выделение, тянуть правой — панорама.
   */
  private bindPointer(handlers: SceneHandlers): void {
    const c = this.canvas
    c.style.touchAction = 'none'

    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 2) return
      this.pointerId = e.pointerId
      this.button = e.button
      this.startX = this.lastX = e.clientX
      this.startY = this.lastY = e.clientY
      this.dragging = false
      c.setPointerCapture(e.pointerId)
    })

    c.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.pointerId) return
      if (!this.dragging) {
        const dx = e.clientX - this.startX
        const dy = e.clientY - this.startY
        if (dx * dx + dy * dy > DRAG_SLOP * DRAG_SLOP) this.dragging = true
      }
      if (!this.dragging) return
      if (this.boxing()) {
        this.select.setBox({ x0: this.startX, y0: this.startY, x1: e.clientX, y1: e.clientY })
        return
      }
      this.view.pan(e.clientX - this.lastX, e.clientY - this.lastY)
      this.lastX = e.clientX
      this.lastY = e.clientY
    })

    const finish = (e: PointerEvent): void => {
      if (e.pointerId !== this.pointerId) return
      this.pointerId = null
      if (this.dragging) {
        if (this.boxing()) {
          this.select.setBox(null)
          this.boxSelect(this.startX, this.startY, e.clientX, e.clientY, e.shiftKey, handlers)
        }
        return
      }
      if (this.button === 2) {
        // Правая без сдвига: снять выделение или приоритет — по режиму.
        if (this.world.mode === 'skirmish') this.setSelection([], handlers)
        else handlers.onClearIntent()
        return
      }
      const cell = this.cellAt(e.clientX, e.clientY)
      if (cell === null) return
      if (this.world.mode === 'yard') {
        handlers.onIntent(cell)
        return
      }
      this.clickSkirmish(cell, e.shiftKey, handlers, e.clientX, e.clientY)
    }
    c.addEventListener('pointerup', finish)
    c.addEventListener('pointercancel', () => {
      this.pointerId = null
      this.select.setBox(null)
    })

    // Меню браузера — никогда; сама правая кнопка обрабатывается через pointer.
    c.addEventListener('contextmenu', (e) => e.preventDefault())

    c.addEventListener('wheel', (e) => {
      e.preventDefault()
      this.view.zoomBy(e.deltaY)
    }, { passive: false })

    // Отладочный поворот камеры: Q/E — на 15°, R — назад в изометрию.
    window.addEventListener('keydown', (e) => {
      const target = e.target
      if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.isContentEditable)) return
      // `code` не зависит от раскладки; `key` выручает, когда события
      // синтетические и `code` пуст — как у цифр скорости в HUD.
      if (e.code === 'KeyQ' || e.key === 'q') this.view.rotate(-1)
      else if (e.code === 'KeyE' || e.key === 'e') this.view.rotate(1)
      else if (e.code === 'KeyR' || e.key === 'r') this.view.rotate(0)
      else if (e.code === 'KeyF' || e.key === 'f') this.follow = !this.follow
    })
  }

  /**
   * Кит юнитов — по требованию: во дворе не нужен, грузится при первом
   * входе в перестрелку; до него и без него бой идёт на капсулах.
   */
  private wantUnitKit(): void {
    if (this.world.mode !== 'skirmish') return
    if (this.unitKit !== null) {
      this.units.setKits(this.unitKit, this.catKit, this.gunKit)
      return
    }
    // Оружие — вместе с юнитами: без него кот держит брусок, и это не поломка.
    const guns = loadGunKit().catch((err: unknown) => {
      console.warn('кит оружия не загрузился, оружие бруском', err)
      return null
    })
    Promise.all([loadUnitKit(), guns]).then(
      ([kit, gunKit]) => {
        this.unitKit = kit
        this.gunKit = gunKit
        // Двор мог смениться, пока кит летел: ставить — текущему.
        if (this.world.mode === 'skirmish') this.units.setKits(kit, this.catKit, gunKit)
      },
      (err: unknown) => console.warn('кит юнитов не загрузился, бой на капсулах', err),
    )
  }

  /** Левая протяжка в перестрелке — рамка; всё остальное — панорама. */
  private boxing(): boolean {
    return this.button === 0 && this.world.mode === 'skirmish'
  }

  private setSelection(ids: string[], handlers: SceneHandlers): void {
    this.selected = new Set(ids)
    handlers.onSelect(ids)
  }

  /**
   * Клик по своему — выделить (Shift — добавить или убрать). Клик по земле
   * с выделением — приказ. Без выделения — ничего: клик, который делает
   * что-то невидимое, хуже клика, который не делает ничего.
   */
  private clickSkirmish(cell: Cell, shift: boolean, handlers: SceneHandlers, clientX: number, clientY: number): void {
    if (this.snap === null) return
    const own = Units.at(this.snap, cell, 'player') ?? this.pick(clientX, clientY)
    if (own !== null) {
      const next = shift ? new Set(this.selected) : new Set<string>()
      if (shift && next.has(own.id)) next.delete(own.id)
      else next.add(own.id)
      this.setSelection([...next], handlers)
      return
    }
    if (this.selected.size === 0) return
    const ids = [...this.selected]
    handlers.onMove(ids, cell)
    this.select.order(cell, ids)
  }

  /** Экранная точка фигуры — по груди, где на неё и кликают. */
  private screenOf(id: string, out: THREE.Vector3): { x: number; y: number } | null {
    const at = this.units.positionOf(id)
    if (at === null) return null
    const r = this.canvas.getBoundingClientRect()
    out.copy(at)
    out.y = 0.5
    out.project(this.view.camera)
    return { x: r.left + ((out.x + 1) / 2) * r.width, y: r.top + ((1 - out.y) / 2) * r.height }
  }

  /** Свой, чья фигура на экране ближе всего к клику, если он в радиусе. */
  private pick(clientX: number, clientY: number): UnitView | null {
    if (this.snap === null) return null
    let best: UnitView | null = null
    let bestD = PICK_PX * PICK_PX
    const p = new THREE.Vector3()
    for (const u of this.snap.units) {
      if (u.side !== 'player' || u.action === 'dead') continue
      const at = this.screenOf(u.id, p)
      if (at === null) continue
      const d = (at.x - clientX) ** 2 + (at.y - clientY) ** 2
      if (d < bestD) {
        best = u
        bestD = d
      }
    }
    return best
  }

  /** Рамка: свои, чья экранная точка попала внутрь. */
  private boxSelect(x0: number, y0: number, x1: number, y1: number, shift: boolean, handlers: SceneHandlers): void {
    if (this.snap === null) return
    const left = Math.min(x0, x1)
    const right = Math.max(x0, x1)
    const top = Math.min(y0, y1)
    const bottom = Math.max(y0, y1)
    const next = shift ? new Set(this.selected) : new Set<string>()
    const p = new THREE.Vector3()
    for (const u of this.snap.units) {
      if (u.side !== 'player' || u.action === 'dead') continue
      const at = this.screenOf(u.id, p)
      if (at === null) continue
      if (at.x >= left && at.x <= right && at.y >= top && at.y <= bottom) next.add(u.id)
    }
    this.setSelection([...next], handlers)
  }

  private cellAt(clientX: number, clientY: number): Cell | null {
    const r = this.canvas.getBoundingClientRect()
    const ndcX = ((clientX - r.left) / r.width) * 2 - 1
    const ndcY = -((clientY - r.top) / r.height) * 2 + 1
    const hit = this.view.groundAt(ndcX, ndcY)
    return hit === null ? null : worldToCell(hit, this.world)
  }

  /**
   * Новый двор на прежнем холсте.
   *
   * Пересоздавать SceneView нельзя: второй WebGLRenderer на том же холсте
   * получил бы тот же контекст, а обработчики ввода навесились бы повторно —
   * один клик слал бы столько команд, сколько было сбросов.
   */
  setWorld(world: WorldView): void {
    this.world = world
    this.kit.dispose()
    this.cats.dispose()
    this.units.dispose()
    this.select.dispose()
    this.kit = new Kit(this.scene, world)
    if (this.envKit !== null) this.kit.setEnv(this.envKit)
    this.cats = new Cats(this.scene, world)
    if (this.catKit !== null) this.cats.setKit(this.catKit)
    this.units = new Units(this.scene, world)
    this.select = new Select(this.scene, world, this.canvas.parentElement ?? document.body)
    this.snap = null
    this.selected = new Set()
    this.wantUnitKit()
  }

  resize(): void {
    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    if (w === 0 || h === 0) return
    this.renderer.setSize(w, h, false)
    this.view.resize(w, h)
  }

  /** Отладка: камера идёт за котом. Панорама при этом бесполезна. */
  private follow = false

  /** `dt` — реальное время кадра в секундах, умноженное на скорость. */
  render(snap: Snapshot | null, dt: number): void {
    if (this.contextLost) return
    audio.frame(this.view.camera)
    this.kit.flicker(dt)
    if (snap !== null) {
      this.snap = snap
      this.kit.sync(snap)
      this.cats.sync(snap, dt)
      this.units.sync(snap, dt, this.view.camera)
      this.select.sync(snap, this.selected, dt)
      for (const id of this.selected) {
        const at = this.units.positionOf(id)
        if (at !== null) this.select.placeRing(id, at)
      }
      if (this.follow) {
        const p = this.cats.positionOf(snap.cats[0]?.id ?? '')
        if (p !== null) this.view.lookAtCentre(p.x, p.z)
      }
    }
    this.renderer.render(this.scene, this.view.camera)
  }
}
