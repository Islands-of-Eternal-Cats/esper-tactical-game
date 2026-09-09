/**
 * Двор: пол, стены, контейнер, кучи, метка зоны.
 *
 * Всё повторяющееся — через InstancedMesh. Это решается здесь и сейчас:
 * задним числом переделывать больно.
 */

import * as THREE from 'three'
import type { Cell, CatView, PileView, Snapshot, WorldView } from '../shared/protocol'
import { PALETTE } from './palette'

/** Обломков на кучу. Куча тает, теряя их по одному. */
const CHUNKS = 8
const MAX_PILES = 64

/** Высота стены. Из неё же считается, что она успевает загородить. */
const WALL_H = 1.3

/**
 * Клетки, стена в которых загораживает точку интереса.
 *
 * Камера смотрит вдоль диагонали (+1,+1) под 35,3°, поэтому луч от точки на
 * высоте y входит в клетку со смещением d на высоте y + d − 0,5. При стене
 * 1,3 загораживает только d = 1: на d = 2 луч уже на 1,5 и проходит над.
 * Соседи по стороне цепляют край кота, поэтому тоже гаснут.
 */
const OCCLUDERS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [1, 0],
  [0, 1],
]

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
  private readonly wallMatrices: THREE.Matrix4[] = []
  private readonly wallIndexByCell = new Map<number, number>()
  /** Номер сплошного блока для каждой стенной клетки. Гаснет блок целиком. */
  private readonly wallBlockOf: number[] = []
  private readonly wallsSolid: THREE.InstancedMesh
  private readonly wallsGhost: THREE.InstancedMesh
  private ghostSignature = -1

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

    // Стены живут двумя наборами на одной геометрии: сплошной и гаснущий.
    // Инстанс переезжает между ними, когда закрывает собой кота.
    const wallGeo = new THREE.BoxGeometry(1, WALL_H, 1)
    const v = new THREE.Vector3()
    world.walls.forEach((cell, i) => {
      cellToWorld(cell, world, v)
      this.wallMatrices.push(new THREE.Matrix4().makeTranslation(v.x, WALL_H / 2, v.z))
      this.wallIndexByCell.set(cell.y * width + cell.x, i)
    })

    this.groupWallsIntoBlocks(world)

    const count = Math.max(1, world.walls.length)
    this.wallsSolid = new THREE.InstancedMesh(
      wallGeo,
      new THREE.MeshLambertMaterial({ color: PALETTE.wall }),
      count,
    )
    this.wallsGhost = new THREE.InstancedMesh(
      wallGeo,
      new THREE.MeshLambertMaterial({
        color: PALETTE.wall,
        transparent: true,
        opacity: 0.3,
        // Не пишет глубину: иначе загородила бы сама себя и кота за собой.
        depthWrite: false,
      }),
      count,
    )
    this.wallsGhost.renderOrder = 2
    scene.add(this.wallsSolid)
    scene.add(this.wallsGhost)

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
    this.syncWalls(snap.cats)
    this.syncPiles(snap.piles)
    this.syncZone(snap.zone)
  }

  /**
   * Сплошные стены собираются в блоки по общей стороне.
   *
   * Гасить одну клетку — значит проделать в стене дыру: глаз читает это как
   * пропавшую геометрию, а не как «сквозь неё видно». Блок целиком читается
   * с первого взгляда.
   */
  private groupWallsIntoBlocks(world: WorldView): void {
    const n = world.walls.length
    for (let i = 0; i < n; i++) this.wallBlockOf.push(-1)

    let block = 0
    for (let start = 0; start < n; start++) {
      if (this.wallBlockOf[start] !== -1) continue
      const queue = [start]
      this.wallBlockOf[start] = block
      for (let head = 0; head < queue.length; head++) {
        const cell = world.walls[queue[head]!]!
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const j = this.wallIndexByCell.get((cell.y + dy) * world.width + (cell.x + dx))
          if (j === undefined || this.wallBlockOf[j] !== -1) continue
          this.wallBlockOf[j] = block
          queue.push(j)
        }
      }
      block++
    }
  }

  private markOccluders(cell: Cell, into: Set<number>): void {
    for (const [dx, dy] of OCCLUDERS) {
      const x = cell.x + dx
      const y = cell.y + dy
      if (x < 0 || y < 0 || x >= this.world.width || y >= this.world.height) continue
      const i = this.wallIndexByCell.get(y * this.world.width + x)
      if (i !== undefined) into.add(this.wallBlockOf[i]!)
    }
  }

  /**
   * Стена, закрывающая кота или кучу, над которой он работает, гаснет.
   *
   * Иначе от кота видна одна голова, а куча не видна вовсе — и работа
   * читается как дёрганье на пустом месте.
   */
  private syncWalls(cats: readonly CatView[]): void {
    const ghost = new Set<number>()
    for (const cat of cats) {
      this.markOccluders(cat.cell, ghost)
      if (cat.next !== null) this.markOccluders(cat.next, ghost)
      if (cat.lookAt !== null) this.markOccluders(cat.lookAt, ghost)
    }

    // Набор меняется редко, а матриц немного: перестраиваем только на смену.
    // Подпись не зависит от порядка обхода множества.
    let signature = ghost.size
    for (const i of ghost) signature ^= Math.imul(i + 1, 0x9e3779b1)
    if (signature === this.ghostSignature) return
    this.ghostSignature = signature

    let solid = 0
    let faded = 0
    for (let i = 0; i < this.wallMatrices.length; i++) {
      const m = this.wallMatrices[i]!
      if (ghost.has(this.wallBlockOf[i]!)) this.wallsGhost.setMatrixAt(faded++, m)
      else this.wallsSolid.setMatrixAt(solid++, m)
    }
    this.wallsSolid.count = solid
    this.wallsGhost.count = faded
    this.wallsSolid.instanceMatrix.needsUpdate = true
    this.wallsGhost.instanceMatrix.needsUpdate = true
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
