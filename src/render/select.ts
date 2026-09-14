/**
 * Выделение и приказ: кольца под выделенными, маркер в клетке назначения,
 * рамка на экране. Всё живёт в главном потоке — воркер знает только
 * итоговый список id.
 */

import * as THREE from 'three'
import type { Cell, Snapshot, WorldView } from '../shared/protocol'
import { cellToWorld } from './kit'
import { PALETTE } from './palette'

/** Маркер гаснет по приходу, но не раньше, чем его успели увидеть. */
const MARKER_MIN_S = 0.5
const MARKER_FADE_S = 0.4

interface Marker {
  mesh: THREE.Mesh
  units: string[]
  age: number
  fading: number
}

export class Select {
  private readonly root = new THREE.Group()
  private readonly rings = new Map<string, THREE.Mesh>()
  private readonly ringGeo = new THREE.RingGeometry(0.34, 0.42, 28)
  private readonly ringMat = new THREE.MeshBasicMaterial({
    color: PALETTE.select,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  })
  private readonly markerGeo = new THREE.RingGeometry(0.12, 0.3, 4)
  private markers: Marker[] = []
  /** Рамка — DOM поверх холста: линии на экране, а не на земле. */
  private readonly box: HTMLDivElement

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: WorldView,
    host: HTMLElement,
  ) {
    scene.add(this.root)
    this.box = document.createElement('div')
    Object.assign(this.box.style, {
      position: 'fixed',
      border: '1px solid rgba(230, 236, 243, .8)',
      background: 'rgba(230, 236, 243, .08)',
      pointerEvents: 'none',
      display: 'none',
      zIndex: '1',
    } satisfies Partial<CSSStyleDeclaration>)
    host.appendChild(this.box)
  }

  dispose(): void {
    this.scene.remove(this.root)
    for (const m of this.markers) (m.mesh.material as THREE.Material).dispose()
    this.markers = []
    this.rings.clear()
    this.ringGeo.dispose()
    this.ringMat.dispose()
    this.markerGeo.dispose()
    this.box.remove()
  }

  /** Рамка на экране в координатах клиента; null — убрать. */
  setBox(rect: { x0: number; y0: number; x1: number; y1: number } | null): void {
    if (rect === null) {
      this.box.style.display = 'none'
      return
    }
    this.box.style.display = 'block'
    this.box.style.left = `${Math.min(rect.x0, rect.x1)}px`
    this.box.style.top = `${Math.min(rect.y0, rect.y1)}px`
    this.box.style.width = `${Math.abs(rect.x1 - rect.x0)}px`
    this.box.style.height = `${Math.abs(rect.y1 - rect.y0)}px`
  }

  /** Приказ отдан: маркер в клетке, гаснет, когда эти юниты пришли. */
  order(cell: Cell, units: string[]): void {
    // Один маркер на юнита: новый приказ тем же юнитам гасит прежний.
    for (const m of this.markers) m.units = m.units.filter((id) => !units.includes(id))
    const mesh = new THREE.Mesh(
      this.markerGeo,
      new THREE.MeshBasicMaterial({ color: PALETTE.select, transparent: true, opacity: 0.9, depthWrite: false }),
    )
    mesh.rotation.x = -Math.PI / 2
    mesh.rotation.z = Math.PI / 4
    cellToWorld(cell, this.world, mesh.position)
    mesh.position.y = 0.02
    this.root.add(mesh)
    this.markers.push({ mesh, units: [...units], age: 0, fading: 0 })
  }

  sync(snap: Snapshot, selected: ReadonlySet<string>, dt: number): void {
    // Кольца — под живыми выделенными; мёртвый из выделения выпадает сам.
    const seen = new Set<string>()
    for (const u of snap.units) {
      if (!selected.has(u.id) || u.action === 'dead') continue
      seen.add(u.id)
      let ring = this.rings.get(u.id)
      if (ring === undefined) {
        ring = new THREE.Mesh(this.ringGeo, this.ringMat)
        ring.rotation.x = -Math.PI / 2
        ring.position.y = 0.015
        this.rings.set(u.id, ring)
        this.root.add(ring)
      }
    }
    for (const [id, ring] of this.rings) {
      if (seen.has(id)) continue
      ring.removeFromParent()
      this.rings.delete(id)
    }

    for (let i = this.markers.length - 1; i >= 0; i--) {
      const m = this.markers[i]!
      m.age += dt
      const moving = snap.units.some((u) => m.units.includes(u.id) && u.action === 'move')
      if (m.fading === 0 && m.age >= MARKER_MIN_S && !moving) m.fading = 1e-6
      if (m.fading > 0) {
        m.fading += dt
        const mat = m.mesh.material as THREE.MeshBasicMaterial
        mat.opacity = Math.max(0, 0.9 * (1 - m.fading / MARKER_FADE_S))
        if (m.fading >= MARKER_FADE_S) {
          m.mesh.removeFromParent()
          mat.dispose()
          this.markers.splice(i, 1)
        }
      }
    }
  }

  /** Положение кольца — за фигурой, а не за клеткой: кольцо едет с ней. */
  placeRing(id: string, at: THREE.Vector3): void {
    const ring = this.rings.get(id)
    if (ring !== undefined) ring.position.set(at.x, 0.015, at.z)
  }
}
