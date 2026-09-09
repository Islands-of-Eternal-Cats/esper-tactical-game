/**
 * Двор: пол, стены, контейнер, кучи, метка зоны.
 *
 * Всё повторяющееся — через InstancedMesh. Это решается здесь и сейчас:
 * задним числом переделывать больно.
 */

import * as THREE from 'three'
import type { Cell, PileView, Snapshot, WorldView } from '../shared/protocol'
import { PALETTE } from './palette'

/** Обломков на кучу. Куча тает, теряя их по одному. */
const CHUNKS = 8
const MAX_PILES = 64

const AXIS_Y = new THREE.Vector3(0, 1, 0)

export function cellToWorld(cell: Cell, world: WorldView, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(cell.x - world.width / 2 + 0.5, 0, cell.y - world.height / 2 + 0.5)
}

export function worldToCell(p: THREE.Vector3, world: WorldView): Cell | null {
  const x = Math.floor(p.x + world.width / 2)
  const y = Math.floor(p.z + world.height / 2)
  if (x < 0 || y < 0 || x >= world.width || y >= world.height) return null
  return { x, y }
}

/** Стабильный разброс от id кучи: обломки не пляшут между кадрами. */
function hash01(id: string, salt: number): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0
  h = Math.imul(h ^ salt, 16777619) >>> 0
  return (h >>> 8) / 0x1000000
}

export class Kit {
  private readonly piles: THREE.InstancedMesh
  private readonly zoneRing: THREE.Mesh
  private readonly zoneDisc: THREE.Mesh
  private readonly m = new THREE.Matrix4()
  private readonly q = new THREE.Quaternion()
  private readonly pos = new THREE.Vector3()
  private readonly scl = new THREE.Vector3()

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: WorldView,
  ) {
    const { width, height } = world

    // Пол — плита, а не плоскость: у двора должен быть видимый край.
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.4, height),
      new THREE.MeshLambertMaterial({ color: PALETTE.floor }),
    )
    slab.position.y = -0.2
    scene.add(slab)

    const skirt = new THREE.Mesh(
      new THREE.BoxGeometry(width + 0.6, 0.24, height + 0.6),
      new THREE.MeshLambertMaterial({ color: PALETTE.floorEdge }),
    )
    skirt.position.y = -0.42
    scene.add(skirt)

    // Стены: одна геометрия, один материал, один вызов отрисовки.
    const wallGeo = new THREE.BoxGeometry(1, 1.3, 1)
    const walls = new THREE.InstancedMesh(
      wallGeo,
      new THREE.MeshLambertMaterial({ color: PALETTE.wall }),
      Math.max(1, world.walls.length),
    )
    const v = new THREE.Vector3()
    world.walls.forEach((cell, i) => {
      cellToWorld(cell, world, v)
      walls.setMatrixAt(i, new THREE.Matrix4().makeTranslation(v.x, 0.65, v.z))
    })
    walls.instanceMatrix.needsUpdate = true
    walls.count = world.walls.length
    scene.add(walls)

    const container = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 1.05, 1.5),
      new THREE.MeshLambertMaterial({ color: PALETTE.container }),
    )
    cellToWorld(world.container, world, v)
    container.position.set(v.x, 0.52, v.z)
    scene.add(container)

    this.piles = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.3, 0.24, 0.3),
      new THREE.MeshLambertMaterial({ color: PALETTE.pile }),
      MAX_PILES * CHUNKS,
    )
    this.piles.count = 0
    scene.add(this.piles)

    // Зона приоритета: намерение игрока, а не маршрут. Тёплый янтарь —
    // красный зарезервирован под угрозу.
    this.zoneDisc = new THREE.Mesh(
      new THREE.CircleGeometry(1, 48),
      new THREE.MeshBasicMaterial({ color: PALETTE.zone, transparent: true, opacity: 0.09, depthWrite: false }),
    )
    this.zoneRing = new THREE.Mesh(
      new THREE.RingGeometry(0.94, 1, 64),
      new THREE.MeshBasicMaterial({ color: PALETTE.zone, transparent: true, opacity: 0.55, depthWrite: false }),
    )
    for (const mesh of [this.zoneDisc, this.zoneRing]) {
      mesh.rotation.x = -Math.PI / 2
      mesh.position.y = 0.02
      mesh.visible = false
      mesh.renderOrder = 1
      scene.add(mesh)
    }
  }

  sync(snap: Snapshot): void {
    this.syncPiles(snap.piles)
    this.syncZone(snap.zone)
  }

  private syncPiles(piles: readonly PileView[]): void {
    let n = 0
    const centre = new THREE.Vector3()

    for (const pile of piles.slice(0, MAX_PILES)) {
      cellToWorld(pile.cell, this.world, centre)
      const fraction = pile.initial > 0 ? pile.volume / pile.initial : 0
      // Обломки убираются по мере убывания объёма: куча тает на глазах, и у
      // прерывания появляется видимая цена.
      const shown = Math.min(CHUNKS, Math.ceil(fraction * CHUNKS))

      for (let i = 0; i < shown; i++) {
        // Обломки лежат ярусами: верхние уходят первыми, и куча оседает,
        // а не выцветает равномерно.
        const level = Math.floor(i / 3)
        const angle = hash01(pile.id, i * 3 + 1) * Math.PI * 2
        const radius = (0.32 - level * 0.09) * (0.55 + hash01(pile.id, i * 3) * 0.45)
        const size = 0.85 + hash01(pile.id, i * 7) * 0.5
        // Последний обломок доживает свой объём, уменьшаясь.
        const tail = i === shown - 1 ? Math.max(0.35, fraction * CHUNKS - (shown - 1)) : 1

        this.pos.set(
          centre.x + Math.cos(angle) * radius,
          0.1 + level * 0.15,
          centre.z + Math.sin(angle) * radius,
        )
        this.q.setFromAxisAngle(AXIS_Y, hash01(pile.id, i * 11) * Math.PI)
        this.scl.setScalar(size * tail)
        this.piles.setMatrixAt(n++, this.m.compose(this.pos, this.q, this.scl))
      }
    }

    this.piles.count = n
    this.piles.instanceMatrix.needsUpdate = true
  }

  private syncZone(zone: Snapshot['zone']): void {
    const on = zone !== null
    this.zoneDisc.visible = on
    this.zoneRing.visible = on
    if (zone === null) return
    const c = cellToWorld(zone.cell, this.world)
    for (const mesh of [this.zoneDisc, this.zoneRing]) {
      mesh.position.set(c.x, mesh.position.y, c.z)
      mesh.scale.setScalar(zone.radius + 0.5)
    }
  }

  dispose(): void {
    this.scene.clear()
  }
}
