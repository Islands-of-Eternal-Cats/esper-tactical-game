/**
 * Сцена: читает снапшот и рисует. Никогда не меняет состояние сама.
 *
 * Ввод отсюда уходит наружу командами и больше ничем: клик не двигает кота,
 * он сообщает воркеру намерение.
 */

import * as THREE from 'three'
import type { Cell, Snapshot, WorldView } from '../shared/protocol'
import { IsoCamera } from './camera'
import { Cats } from './cats'
import { CatKit, EnvKit } from './model'
import { Kit, worldToCell } from './kit'
import { PALETTE } from './palette'

export interface SceneHandlers {
  onIntent: (cell: Cell) => void
  onClearIntent: () => void
}

/** Смещение курсора, после которого жест считается панорамой, а не кликом. */
const DRAG_SLOP = 4

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
  private contextLost = false
  /** Кит переживает пересборку двора: грузить его на каждый сид незачем. */
  private catKit: CatKit | null = null
  private envKit: EnvKit | null = null

  private pointerId: number | null = null
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
    this.view.lookAtCentre(0, 0)

    // Мобильные браузеры убивают контекст при сворачивании.
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.contextLost = true
    })
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false
    })

    // Киты грузятся в фоне: сцена уже работает на грейбоксе, и падение
    // загрузки не уносит с собой игру. Но показывать грейбокс не надо — до
    // `ready` главный поток держит занавес; капсула остаётся запасным путём.
    this.ready = Promise.allSettled([
      CatKit.load().then(
        (kit) => {
          this.catKit = kit
          this.cats.setKit(kit)
        },
        (err: unknown) => console.warn('кит персонажей не загрузился, остаёмся на капсуле', err),
      ),
      EnvKit.load().then(
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
   * Ввод через Pointer Events. Клик и панорама живут на одной кнопке, поэтому
   * жест решается порогом: сдвинул — панорама, не сдвинул — намерение.
   */
  private bindPointer(handlers: SceneHandlers): void {
    const c = this.canvas
    c.style.touchAction = 'none'

    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      this.pointerId = e.pointerId
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
      if (this.dragging) {
        this.view.pan(e.clientX - this.lastX, e.clientY - this.lastY)
        this.lastX = e.clientX
        this.lastY = e.clientY
      }
    })

    const finish = (e: PointerEvent): void => {
      if (e.pointerId !== this.pointerId) return
      this.pointerId = null
      if (this.dragging) return
      const cell = this.cellAt(e.clientX, e.clientY)
      if (cell !== null) handlers.onIntent(cell)
    }
    c.addEventListener('pointerup', finish)
    c.addEventListener('pointercancel', () => {
      this.pointerId = null
    })

    c.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      handlers.onClearIntent()
    })

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
    this.kit = new Kit(this.scene, world)
    if (this.envKit !== null) this.kit.setEnv(this.envKit)
    this.cats = new Cats(this.scene, world)
    if (this.catKit !== null) this.cats.setKit(this.catKit)
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
    this.kit.flicker(dt)
    if (snap !== null) {
      this.kit.sync(snap)
      this.cats.sync(snap, dt)
      if (this.follow) {
        const p = this.cats.positionOf(snap.cats[0]?.id ?? '')
        if (p !== null) this.view.lookAtCentre(p.x, p.z)
      }
    }
    this.renderer.render(this.scene, this.view.camera)
  }
}
