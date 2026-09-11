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

/**
 * Оболочка блока стен: геометрия, в которой есть только внешние грани.
 *
 * Грань выпускается, только если соседней клетки-стены с этой стороны нет.
 * Прозрачный материал не пишет глубину и потому рисует всё, что ему дали, —
 * гасящиеся кубы показали бы и замурованные внутри блока грани, и блок вышел
 * бы ребристым, с внутренними стенками. У оболочки внутренних граней нет
 * вовсе, а отсечение задних даёт ровно один слой поверхности.
 *
 * Сплошные стены остаются InstancedMesh: там всё это невидимо, и решение об
 * инстансинге повторяющейся геометрии остаётся в силе.
 */
function buildShell(cells: readonly Cell[], world: WorldView): THREE.BufferGeometry {
  const present = new Set(cells.map((c) => c.y * world.width + c.x))
  const position: number[] = []
  const normal: number[] = []
  const index: number[] = []

  /** Четырёхугольник обходом против часовой стрелки, если смотреть снаружи. */
  const quad = (v: readonly number[], n: readonly number[]): void => {
    const base = position.length / 3
    position.push(...v)
    for (let i = 0; i < 4; i++) normal.push(...n)
    index.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }

  const p = new THREE.Vector3()
  const h = WALL_H

  for (const cell of cells) {
    cellToWorld(cell, world, p)
    const x = p.x
    const z = p.z
    const solid = (dx: number, dy: number): boolean =>
      present.has((cell.y + dy) * world.width + (cell.x + dx))

    if (!solid(1, 0)) {
      quad([x + 0.5, 0, z + 0.5, x + 0.5, 0, z - 0.5, x + 0.5, h, z - 0.5, x + 0.5, h, z + 0.5], [1, 0, 0])
    }
    if (!solid(-1, 0)) {
      quad([x - 0.5, 0, z - 0.5, x - 0.5, 0, z + 0.5, x - 0.5, h, z + 0.5, x - 0.5, h, z - 0.5], [-1, 0, 0])
    }
    if (!solid(0, 1)) {
      quad([x - 0.5, 0, z + 0.5, x + 0.5, 0, z + 0.5, x + 0.5, h, z + 0.5, x - 0.5, h, z + 0.5], [0, 0, 1])
    }
    if (!solid(0, -1)) {
      quad([x + 0.5, 0, z - 0.5, x - 0.5, 0, z - 0.5, x - 0.5, h, z - 0.5, x + 0.5, h, z - 0.5], [0, 0, -1])
    }
    // Верх открыт всегда, низ не виден никогда: стены не ставятся друг на друга.
    quad([x - 0.5, h, z + 0.5, x + 0.5, h, z + 0.5, x + 0.5, h, z - 0.5, x - 0.5, h, z - 0.5], [0, 1, 0])
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3))
  geometry.setIndex(index)
  return geometry
}

/**
 * Освобождает поддерево. Материалы собираются в множество: они общие между
 * объектами, и освобождать их в обходе как попало значит освободить дважды.
 */
export function disposeTree(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>()
  root.traverse((object) => {
    const node = object as THREE.Object3D & {
      geometry?: THREE.BufferGeometry
      material?: THREE.Material | THREE.Material[]
    }
    node.geometry?.dispose()
    const material = node.material
    if (Array.isArray(material)) for (const m of material) materials.add(m)
    else if (material !== undefined) materials.add(material)
  })
  for (const material of materials) material.dispose()
}

export class Kit {
  /** Всё своё — в одной группе: двор пересоздаётся на каждый новый сид. */
  private readonly root = new THREE.Group()
  private readonly wallMatrices: THREE.Matrix4[] = []
  private readonly wallIndexByCell = new Map<number, number>()
  /** Номер сплошного блока для каждой стенной клетки. Гаснет блок целиком. */
  private readonly wallBlockOf: number[] = []
  private readonly wallsSolid: THREE.InstancedMesh
  /** Оболочка на блок: показывается вместо его кубов, когда блок гаснет. */
  private readonly ghostShells: THREE.Mesh[] = []
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
    this.root.add(slab)

    const skirt = new THREE.Mesh(
      new THREE.BoxGeometry(width + 0.6, 0.24, height + 0.6),
      new THREE.MeshLambertMaterial({ color: PALETTE.floorEdge }),
    )
    skirt.position.y = -0.42
    this.root.add(skirt)

    // Разметка клеток: сетка симуляции видна как есть — шаг, зона, кучи
    // ложатся ровно на неё, и по ней же читается реальный масштаб кота.
    const pts: number[] = []
    for (let x = 0; x <= width; x++) {
      pts.push(x - width / 2, 0, -height / 2, x - width / 2, 0, height / 2)
    }
    for (let y = 0; y <= height; y++) {
      pts.push(-width / 2, 0, y - height / 2, width / 2, 0, y - height / 2)
    }
    const gridGeo = new THREE.BufferGeometry()
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    const grid = new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: PALETTE.grid }))
    // Чуть над плитой: на одной высоте линии мерцают в z-буфере.
    grid.position.y = 0.004
    this.root.add(grid)

    // Стены живут двумя наборами на одной геометрии: сплошной и гаснущий.
    // Инстанс переезжает между ними, когда закрывает собой кота.
    const wallGeo = new THREE.BoxGeometry(1, WALL_H, 1)
    const v = new THREE.Vector3()
    world.walls.forEach((cell, i) => {
      cellToWorld(cell, world, v)
      this.wallMatrices.push(new THREE.Matrix4().makeTranslation(v.x, WALL_H / 2, v.z))
      this.wallIndexByCell.set(cell.y * width + cell.x, i)
    })

    const blocks = this.groupWallsIntoBlocks(world)

    this.wallsSolid = new THREE.InstancedMesh(
      wallGeo,
      new THREE.MeshLambertMaterial({ color: PALETTE.wall }),
      Math.max(1, world.walls.length),
    )
    this.root.add(this.wallsSolid)

    const ghostMaterial = new THREE.MeshLambertMaterial({
      color: PALETTE.wall,
      transparent: true,
      opacity: 0.36,
      // Не пишет глубину: иначе загородила бы кота, стоящего за ней.
      depthWrite: false,
    })
    const edgeMaterial = new THREE.LineBasicMaterial({
      color: PALETTE.wallGhostEdge,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    })
    for (const cells of blocks) {
      const geometry = buildShell(cells, world)
      const shell = new THREE.Mesh(geometry, ghostMaterial)
      shell.renderOrder = 2
      shell.visible = false

      // Контур — не украшение, а единственный признак объёма у погасшей
      // стены. Заливка одна показывает крышу плоским пятном, и куча за
      // стеной читается лежащей на этой крыше. EdgesGeometry отбрасывает
      // рёбра между гранями в одной плоскости, поэтому клетки внутри блока
      // следов не оставляют, а нижние рёбра остаются: это след стены на
      // земле, то самое, за что цепляется глаз.
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), edgeMaterial)
      edges.renderOrder = 3
      shell.add(edges)

      this.ghostShells.push(shell)
      this.root.add(shell)
    }

    const container = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 1.05, 1.5),
      new THREE.MeshLambertMaterial({ color: PALETTE.container }),
    )
    cellToWorld(world.container, world, v)
    container.position.set(v.x, 0.52, v.z)
    this.root.add(container)

    this.piles = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.3, 0.24, 0.3),
      new THREE.MeshLambertMaterial({ color: PALETTE.pile }),
      MAX_PILES * CHUNKS,
    )
    this.piles.count = 0
    this.root.add(this.piles)

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
      this.root.add(mesh)
    }

    scene.add(this.root)
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
  private groupWallsIntoBlocks(world: WorldView): Cell[][] {
    const n = world.walls.length
    for (let i = 0; i < n; i++) this.wallBlockOf.push(-1)

    const blocks: Cell[][] = []
    for (let start = 0; start < n; start++) {
      if (this.wallBlockOf[start] !== -1) continue
      const block = blocks.length
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
      blocks.push(queue.map((i) => world.walls[i]!))
    }
    return blocks
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
    for (let i = 0; i < this.wallMatrices.length; i++) {
      if (ghost.has(this.wallBlockOf[i]!)) continue
      this.wallsSolid.setMatrixAt(solid++, this.wallMatrices[i]!)
    }
    this.wallsSolid.count = solid
    this.wallsSolid.instanceMatrix.needsUpdate = true

    this.ghostShells.forEach((shell, block) => {
      shell.visible = ghost.has(block)
    })
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
    this.scene.remove(this.root)
    disposeTree(this.root)
  }
}
