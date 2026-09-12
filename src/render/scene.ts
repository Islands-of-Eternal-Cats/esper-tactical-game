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
import { CatKit } from './model'
import { Kit, worldToCell } from './kit'
import { PALETTE } from './palette'

export interface SceneHandlers {
  onIntent: (cell: Cell) => void
  onClearIntent: () => void
}

/** Смещение курсора, после которого жест считается панорамой, а не кликом. */
const DRAG_SLOP = 4

export class SceneView {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly view = new IsoCamera()
  private world: WorldView
  private kit: Kit
  private cats: Cats
  private contextLost = false
  /** Кит переживает пересборку двора: грузить его на каждый сид незачем. */
  private catKit: CatKit | null = null

  private pointerId: number | null = null
  private startX = 0
  private startY = 0
  private lastX = 0
  private lastY = 0
  private dragging = false

  constructor(
    private readonly canvas: HTMLCanvasElement,
    world: WorldView,
    handlers: SceneHandlers,
  ) {
    this.world = world
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    // Выше двух гнать нечего: плоская заливка от этого не выигрывает.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.scene.background = new THREE.Color(PALETTE.background)

    // Теней нет: при плоской заливке форма читается затенением по нормали.
    this.scene.add(new THREE.HemisphereLight(0x9fb4cc, 0x20242c, 1.6))
    const key = new THREE.DirectionalLight(0xfff0dd, 1.5)
    key.position.set(6, 12, 4)
    this.scene.add(key)
    const fill = new THREE.DirectionalLight(0x6d86a8, 0.7)
    fill.position.set(-8, 6, -6)
    this.scene.add(fill)

    this.kit = new Kit(this.scene, world)
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

    // Кит грузится в фоне: до него сцена уже работает на капсуле, а падение
    // загрузки не должно уносить с собой всю игру.
    void CatKit.load().then(
      (kit) => {
        this.catKit = kit
        this.cats.setKit(kit)
      },
      (err: unknown) => console.warn('кит персонажей не загрузился, остаёмся на капсуле', err),
    )

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

  /** `dt` — реальное время кадра в секундах, умноженное на скорость. */
  render(snap: Snapshot | null, dt: number): void {
    if (this.contextLost) return
    if (snap !== null) {
      this.kit.sync(snap)
      this.cats.sync(snap, dt)
    }
    this.renderer.render(this.scene, this.view.camera)
  }
}
