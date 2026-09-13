/**
 * Двор: пол, стены, контейнер, кучи, метка зоны.
 *
 * Всё повторяющееся — через InstancedMesh. Это решается здесь и сейчас:
 * задним числом переделывать больно.
 */

import * as THREE from 'three'
import type { Cell, CatView, PileView, PropKind, Snapshot, WorldView } from '../shared/protocol'
import { PALETTE } from './palette'
import { DEBRIS, FLOORS, type EnvKit } from './model'

/** Обломков на кучу. Куча тает, теряя их по одному. */
const CHUNKS = 8
const MAX_PILES = 64

/** Высота стены. Из неё же считается, что она успевает загородить. */
const WALL_H = 1.3
/** Толщина плитки пола: с китом верх плитки — уровень земли симуляции. */
const FLOOR_H = 0.05
/** Улица под плитой: ниже дна юбки. */
const STREET_Y = -0.56
/** Улица — до тумана и дальше, метров. */
const STREET_SIZE = 160
/** Толщина панели ограды и парапета. */
const EDGE_T = 0.3

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
/** Матрица нулевого масштаба: инстанс на месте, но его не видно. */
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0)
const AXIS_Z = new THREE.Vector3(0, 0, 1)

/** Ламп во дворе: тёплых пятен должно быть мало, иначе нуар кончается. */
const LAMPS = 2
/** Высота кронштейна лампы на стене: под самым верхом панели. */
const LAMP_H = 1.15

/**
 * Поворот модуля, чтобы его «вперёд» (−Z, как у кота) смотрело вдоль нормали
 * стены. Настенные пропсы ставятся на грани, обращённые к камере (+X и +Z):
 * на остальных их не видно.
 */
function yawFacing(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz)
}

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

/** Копия геометрии, сдвинутая по нормалям на `d`: для линий поверх граней. */
function inflate(geometry: THREE.BufferGeometry, d: number): THREE.BufferGeometry {
  const out = geometry.clone()
  const p = out.getAttribute('position') as THREE.BufferAttribute
  const n = out.getAttribute('normal') as THREE.BufferAttribute
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i, p.getX(i) + n.getX(i) * d, p.getY(i) + n.getY(i) * d, p.getZ(i) + n.getZ(i) * d)
  }
  return out
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
  /** Грейбокс, который кит вытесняет: плита, разметка, куб контейнера. */
  private readonly slab: THREE.Mesh
  private readonly grid: THREE.LineSegments
  private readonly container: THREE.Mesh
  /** Плитки пола по варианту — только с китом. */
  private floors: THREE.InstancedMesh[] = []
  /** Пропсы двора по модулю — только с китом. */
  private props: THREE.InstancedMesh[] = []
  /** Грейбокс реквизита на полу: коробки на занятых клетках до кита. */
  private readonly propBoxes: THREE.InstancedMesh
  private readonly lamps: THREE.PointLight[] = []
  private time = 0
  private readonly blocks: Cell[][]
  /** Оболочка на блок: показывается вместо его кубов, когда блок гаснет. */
  private readonly ghostShells: THREE.Mesh[] = []
  /** Обводка сплошного блока — с китом; гаснет вместе с ним. */
  private readonly outlines: THREE.LineSegments[] = []
  /** Пропсы на крыше по блокам: гаснут вместе с ним, иначе висят над контуром. */
  private readonly blockProps: { mesh: THREE.InstancedMesh; index: number; matrix: THREE.Matrix4 }[][] = []
  private ghostSignature = -1

  /**
   * Кучи — обломки. Пока кит окружения не приехал, обломки — коробки одним
   * инстансером; с китом — по инстансеру на вид обломка, вид выбирается
   * хешем от id кучи и номера обломка, как и всё остальное в раскладке.
   */
  private piles: THREE.InstancedMesh[]
  private lastPiles: readonly PileView[] = []
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
    slab.receiveShadow = true
    this.root.add(slab)
    this.slab = slab

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
    this.grid = grid

    // Стены живут двумя наборами на одной геометрии: сплошной и гаснущий.
    // Инстанс переезжает между ними, когда закрывает собой кота.
    // Начало координат модуля — на земле, как у модулей кита; коробка
    // грейбокса приподнята сама, чтобы матрицы инстансов были общими.
    const wallGeo = new THREE.BoxGeometry(1, WALL_H, 1).translate(0, WALL_H / 2, 0)
    const v = new THREE.Vector3()
    world.walls.forEach((cell, i) => {
      cellToWorld(cell, world, v)
      this.wallMatrices.push(new THREE.Matrix4().makeTranslation(v.x, 0, v.z))
      this.wallIndexByCell.set(cell.y * width + cell.x, i)
    })

    const blocks = this.groupWallsIntoBlocks(world)
    this.blocks = blocks

    this.wallsSolid = new THREE.InstancedMesh(
      wallGeo,
      new THREE.MeshLambertMaterial({ color: PALETTE.wall }),
      Math.max(1, world.walls.length),
    )
    this.wallsSolid.castShadow = true
    this.wallsSolid.receiveShadow = true
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
    const outlineMaterial = new THREE.LineBasicMaterial({
      color: PALETTE.outline,
      transparent: true,
      opacity: 0.75,
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

      // Тёмная обводка сплошного блока: на плоской заливке ребро между
      // гранью в свету и гранью в тени и так видно, а между двумя гранями
      // в тени — нет, и блок сливается с полом. Линии лежат на поверхности,
      // поэтому геометрия сдвинута по нормалям — иначе мерцание в z-буфере.
      const outline = new THREE.LineSegments(new THREE.EdgesGeometry(inflate(geometry, 0.012)), outlineMaterial)
      outline.visible = false
      this.outlines.push(outline)
      this.root.add(outline)

      this.ghostShells.push(shell)
      this.root.add(shell)
    }

    const container = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 1.05, 1.5).translate(0, 0.52, 0),
      new THREE.MeshLambertMaterial({ color: PALETTE.container }),
    )
    cellToWorld(world.container, world, v)
    container.position.set(v.x, 0, v.z)
    container.castShadow = true
    this.root.add(container)
    this.container = container

    // Реквизит на полу — препятствия симуляции; в грейбоксе это коробки
    // пониже стен, чтобы читались занятыми клетками, а не стенами.
    this.propBoxes = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.8, 0.7, 0.8).translate(0, 0.35, 0),
      new THREE.MeshLambertMaterial({ color: PALETTE.container }),
      Math.max(1, world.props.length),
    )
    world.props.forEach((prop, i) => {
      cellToWorld(prop.cell, world, v)
      this.propBoxes.setMatrixAt(i, new THREE.Matrix4().makeTranslation(v.x, 0, v.z))
    })
    this.propBoxes.count = world.props.length
    this.propBoxes.castShadow = true
    this.root.add(this.propBoxes)

    this.piles = [
      new THREE.InstancedMesh(
        new THREE.BoxGeometry(0.3, 0.24, 0.3),
        new THREE.MeshLambertMaterial({ color: PALETTE.pile }),
        MAX_PILES * CHUNKS,
      ),
    ]
    for (const mesh of this.piles) {
      mesh.count = 0
      this.root.add(mesh)
    }

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

  /**
   * Лампы чуть дышат: сумма двух медленных синусов и редкий провал. Не
   * мигание — старая лампа под нестабильной сетью. Время своё, от кадра:
   * это картинка, симуляция о лампах не знает.
   */
  flicker(dt: number): void {
    this.time += dt
    this.lamps.forEach((lamp, i) => {
      const t = this.time + i * 1.7
      let k = 1 + 0.05 * Math.sin(t * 7.3) + 0.04 * Math.sin(t * 2.1 + 1)
      // Провал раз в несколько секунд, на долю секунды.
      if (Math.sin(t * 0.61 + i) > 0.985) k *= 0.55
      lamp.intensity = (lamp.userData.base as number) * k
    })
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
      if (this.floors.length > 0) this.outlines[block]!.visible = !ghost.has(block)
      this.showBlockProps(block, !ghost.has(block))
    })
  }

  /** Кит окружения приехал: грейбокс уступает модулям, кучи — обломкам. */
  setEnv(env: EnvKit): void {
    this.dress(env)
    for (const mesh of this.piles) {
      this.root.remove(mesh)
      // Геометрия коробки — своя, материал кита — общий, его не трогаем.
      if (this.piles.length === 1) {
        mesh.geometry.dispose()
        ;(mesh.material as THREE.Material).dispose()
      }
    }
    this.piles = DEBRIS.map((name) => {
      const { geometry, material } = env.part(name)
      const mesh = new THREE.InstancedMesh(geometry, material, MAX_PILES * CHUNKS)
      mesh.count = 0
      mesh.castShadow = true
      this.root.add(mesh)
      return mesh
    })
    this.syncPiles(this.lastPiles)
  }

  /**
   * Двор из модулей кита поверх раскладки грейбокса.
   *
   * Плитки — по клетке, вариант и поворот от хеша клетки: пол не ровный,
   * но и не пляшет между сидами. Разметка гаснет: швы плиток — та же сетка.
   * Стены и контейнер меняют геометрию, оставаясь на своих местах.
   */
  private dress(env: EnvKit): void {
    const { width, height } = this.world
    this.floors = FLOORS.map((name) => {
      const { geometry, material } = env.part(name)
      const mesh = new THREE.InstancedMesh(geometry, material, width * height)
      mesh.count = 0
      mesh.receiveShadow = true
      this.root.add(mesh)
      return mesh
    })
    const counts = this.floors.map(() => 0)
    const cell: Cell = { x: 0, y: 0 }
    for (cell.y = 0; cell.y < height; cell.y++) {
      for (cell.x = 0; cell.x < width; cell.x++) {
        const id = `${cell.x}:${cell.y}`
        const r = hash01(id, 1)
        // Латок немного, стоков ещё меньше: двор чинили, но не украшали.
        const kind = r < 0.86 ? 0 : r < 0.95 ? 1 : 2
        cellToWorld(cell, this.world, this.pos)
        this.pos.y = -FLOOR_H
        this.q.setFromAxisAngle(AXIS_Y, Math.floor(hash01(id, 2) * 4) * (Math.PI / 2))
        this.scl.setScalar(1)
        this.floors[kind]!.setMatrixAt(counts[kind]!++, this.m.compose(this.pos, this.q, this.scl))
      }
    }
    this.floors.forEach((mesh, k) => {
      mesh.count = counts[k]!
      mesh.instanceMatrix.needsUpdate = true
    })
    this.grid.visible = false
    this.slab.position.y -= FLOOR_H
    // Обводка — часть художественного прохода, грейбокс живёт без неё.
    this.ghostShells.forEach((shell, block) => {
      this.outlines[block]!.visible = !shell.visible
    })

    this.dressEdge(env)

    const wall = env.part('wall_block')
    this.wallsSolid.geometry.dispose()
    ;(this.wallsSolid.material as THREE.Material).dispose()
    this.wallsSolid.geometry = wall.geometry
    this.wallsSolid.material = wall.material

    const dumpster = env.part('prop_dumpster')
    this.container.geometry.dispose()
    ;(this.container.material as THREE.Material).dispose()
    this.container.geometry = dumpster.geometry
    this.container.material = dumpster.material

    this.dressBlocks(env)
    this.dressProps(env)
  }

  /**
   * Реквизит на полу из модулей кита: в клетке — не один предмет, а
   * небольшая группа, как её оставили бы люди. Раскладка группы — своя на
   * вид, поворот — из мира, разброс — от хеша клетки.
   */
  private dressProps(env: EnvKit): void {
    this.propBoxes.visible = false
    const kinds = ['prop_barrel', 'prop_crate', 'prop_cart', 'prop_pallet'] as const
    type Kind = (typeof kinds)[number]
    const matrices = new Map<Kind, THREE.Matrix4[]>()
    for (const kind of kinds) matrices.set(kind, [])
    const centre = new THREE.Vector3()
    const put = (kind: Kind, dx: number, dz: number, y: number, yaw: number, scale = 1): void => {
      this.pos.set(centre.x + dx, y, centre.z + dz)
      this.q.setFromAxisAngle(AXIS_Y, yaw)
      this.scl.setScalar(scale)
      matrices.get(kind)!.push(this.m.compose(this.pos, this.q, this.scl).clone())
    }

    for (const prop of this.world.props) {
      cellToWorld(prop.cell, this.world, centre)
      const id = `prop${prop.cell.x}:${prop.cell.y}`
      const base = prop.turn * (Math.PI / 2)
      const cos = Math.cos(base)
      const sin = Math.sin(base)
      // Смещения в группе — в осях группы, поворачиваются вместе с ней.
      const local = (kind: Kind, u: number, v: number, y: number, yaw: number, scale = 1): void =>
        put(kind, u * cos - v * sin, u * sin + v * cos, y, base + yaw, scale)

      const layouts: Record<PropKind, () => void> = {
        barrels: () => {
          local('prop_barrel', -0.2, -0.18, 0, hash01(id, 1) * Math.PI)
          local('prop_barrel', 0.24, -0.1, 0, hash01(id, 2) * Math.PI, 0.96)
          if (hash01(id, 3) < 0.7) local('prop_barrel', 0.02, 0.28, 0, hash01(id, 4) * Math.PI, 0.9)
        },
        crates: () => {
          local('prop_crate', -0.12, 0.05, 0, 0)
          local('prop_crate', -0.1, 0.02, 0.7, (hash01(id, 1) - 0.5) * 0.4, 0.86)
          local('prop_crate', 0.4, -0.3, 0, 0.3, 0.6)
        },
        cart: () => local('prop_cart', 0, 0, 0, (hash01(id, 1) - 0.5) * 0.3),
        pallet: () => {
          local('prop_pallet', 0, 0, 0, (hash01(id, 1) - 0.5) * 0.2)
          if (hash01(id, 2) < 0.6) local('prop_barrel', 0.1, 0.05, 0.12, hash01(id, 3) * Math.PI, 0.9)
        },
      }
      layouts[prop.kind]()
    }

    this.props.push(...kinds.map((kind) => {
      const list = matrices.get(kind)!
      const { geometry, material } = env.part(kind)
      const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, list.length))
      list.forEach((m, i) => mesh.setMatrixAt(i, m))
      mesh.count = list.length
      mesh.instanceMatrix.needsUpdate = true
      mesh.castShadow = true
      mesh.receiveShadow = true
      this.root.add(mesh)
      return mesh
    }))
  }

  /**
   * Улица и ограда вокруг плиты.
   *
   * Улица — плоскость под плитой до тумана: двор стоит на земле, а не висит
   * в пустоте. По дальним сторонам (−X, −Z) — ограда в рост, бетон и
   * гофролист, с воротами и дверью: камера смотрит от +X+Z, и там она
   * ничего не загораживает, только замыкает двор. По ближним — низкий
   * парапет, с разрывом у угла контейнера: туда выезжают.
   */
  private dressEdge(env: EnvKit): void {
    const { width, height } = this.world
    // Материал улицы — из кита: тайл асфальта повторяется по метру.
    const asphalt = env.part('street_tile').material as THREE.MeshStandardMaterial
    if (asphalt.map !== null) {
      asphalt.map.wrapS = asphalt.map.wrapT = THREE.RepeatWrapping
      asphalt.map.repeat.set(STREET_SIZE, STREET_SIZE)
    }
    const street = new THREE.Mesh(new THREE.PlaneGeometry(STREET_SIZE, STREET_SIZE), asphalt)
    street.rotation.x = -Math.PI / 2
    street.receiveShadow = true
    street.position.y = STREET_Y
    this.root.add(street)

    const kinds = ['edge_wall', 'edge_corrugated', 'edge_gate', 'edge_door', 'edge_curb'] as const
    type Kind = (typeof kinds)[number]
    const matrices = new Map<Kind, THREE.Matrix4[]>()
    for (const kind of kinds) matrices.set(kind, [])
    const put = (kind: Kind, x: number, z: number, yaw: number): void => {
      this.pos.set(x, STREET_Y, z)
      this.q.setFromAxisAngle(AXIS_Y, yaw)
      this.scl.setScalar(1)
      matrices.get(kind)!.push(this.m.compose(this.pos, this.q, this.scl).clone())
    }
    // Ограда стоит вплотную за юбкой плиты, по её внешнему краю.
    const off = 0.3 + EDGE_T / 2
    const xL = -width / 2 - off
    const xR = width / 2 + off
    const zN = -height / 2 - off
    const zF = height / 2 + off

    // Ограда — не одна стена, а панели разных хозяев: бетон и гофролист
    // участками по 2–4 панели, от хеша участка. Ворота на дальней стене
    // (две панели), дверь на левой; лампа над воротами — третье тёплое
    // пятно двора, у входа ему и место.
    const GATE_AT = 8
    const DOOR_AT = 14
    const run = (side: string, i: number): Kind => {
      const seg = Math.floor(i / 3)
      return hash01(`${side}${seg}`, 1) < 0.45 ? 'edge_corrugated' : 'edge_wall'
    }
    // Панели от угла до угла, угловая — с дальней стороны, чтобы стык закрыть.
    for (let i = -1; i <= width; i++) {
      const x = -width / 2 + 0.5 + i
      if (i === GATE_AT) {
        put('edge_gate', x + 0.5, zN, 0)
        continue
      }
      if (i === GATE_AT + 1) continue
      put(run('n', i), x, zN, 0)
    }
    for (let i = 0; i < height; i++) {
      const z = -height / 2 + 0.5 + i
      put(i === DOOR_AT ? 'edge_door' : run('w', i), xL, z, Math.PI / 2)
    }
    // Парапет по ближним сторонам, разрыв в две клетки у угла контейнера.
    for (let i = 0; i < width - 2; i++) put('edge_curb', -width / 2 + 0.5 + i, zF, 0)
    for (let i = 0; i < height - 2; i++) put('edge_curb', xR, -height / 2 + 0.5 + i, Math.PI / 2)
    put('edge_curb', xR, zF, 0)

    const gateLight = new THREE.PointLight(PALETTE.lamp, 7, 8, 2)
    gateLight.userData.base = gateLight.intensity
    gateLight.position.set(-width / 2 + 0.5 + GATE_AT + 0.5, STREET_Y + 1.95, zN + 0.35)
    this.lamps.push(gateLight)
    this.root.add(gateLight)

    for (const kind of kinds) {
      const list = matrices.get(kind)!
      const { geometry, material } = env.part(kind)
      const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, list.length))
      list.forEach((m, i) => mesh.setMatrixAt(i, m))
      mesh.count = list.length
      mesh.instanceMatrix.needsUpdate = true
      mesh.castShadow = true
      mesh.receiveShadow = true
      this.root.add(mesh)
      this.props.push(mesh)
    }
  }

  /**
   * Пропсы на блоках стен: вентиляция и кондиционеры на крышах, труба вдоль
   * длинной стороны с водостоком по стене, лампы на гранях к камере.
   *
   * Всё от хеша номера блока — двор одинаков от сида к сиду, как и сами
   * стены: они существуют, чтобы читаться, а не чтобы удивлять. Пропсы
   * живут только в рендере: на крышах и на стенах кот не ходит, а на пол
   * ничего не ставится, чтобы не спорить с кучами и симуляцией.
   */
  private dressBlocks(env: EnvKit): void {
    const kinds = ['prop_vent', 'prop_ac', 'prop_pipe', 'prop_pipe_joint', 'prop_lamp_wall'] as const
    type Kind = (typeof kinds)[number]
    const matrices = new Map<Kind, THREE.Matrix4[]>()
    for (const kind of kinds) matrices.set(kind, [])
    // Кому принадлежит инстанс: номер блока на каждую матрицу, по видам.
    const owners = new Map<Kind, number[]>()
    for (const kind of kinds) owners.set(kind, [])
    let block = 0
    const add = (kind: Kind): void => {
      matrices.get(kind)!.push(this.m.compose(this.pos, this.q, this.scl).clone())
      owners.get(kind)!.push(block)
    }
    const put = (kind: Kind, x: number, y: number, z: number, yaw = 0, scale = 1): void => {
      this.pos.set(x, y, z)
      this.q.setFromAxisAngle(AXIS_Y, yaw)
      this.scl.setScalar(scale)
      add(kind)
    }
    /** Труба длиной `length` из точки вдоль +X, повёрнутая кватернионом. */
    const pipe = (x: number, y: number, z: number, length: number): void => {
      this.pos.set(x, y, z)
      this.scl.set(length, 1, 1)
      add('prop_pipe')
    }

    // Лампы достаются блокам с наибольшим хешем: двум, не всем.
    const lampOrder = this.blocks
      .map((_, b) => b)
      .sort((a, b) => hash01('lamp', b) - hash01('lamp', a))
      .slice(0, LAMPS)

    const min = new THREE.Vector3()
    const max = new THREE.Vector3()
    this.blocks.forEach((cells, b) => {
      block = b
      this.blockProps.push([])
      const id = `block${b}`
      cellToWorld(cells[0]!, this.world, min)
      max.copy(min)
      for (const cell of cells) {
        cellToWorld(cell, this.world, this.pos)
        min.min(this.pos)
        max.max(this.pos)
      }
      // Блоки — прямоугольники клеток; «вдоль» — по длинной стороне.
      // Точка на доле t длины и на поперечном сдвиге s от оси блока.
      const alongX = max.x - min.x >= max.z - min.z
      const length = (alongX ? max.x - min.x : max.z - min.z) + 1
      const at = (t: number, s: number): [number, number] => {
        const u = (alongX ? min.x : min.z) - 0.5 + t * length
        const v = (alongX ? min.z + max.z : min.x + max.x) / 2 + s
        return alongX ? [u, v] : [v, u]
      }
      const roof = WALL_H

      // Вентиляция: одна-две трубы, ближе к краям крыши.
      const vents = 1 + Math.floor(hash01(id, 1) * 2)
      for (let i = 0; i < vents; i++) {
        const [x, z] = at((i === 0 ? 0.25 : 0.75) + (hash01(id, 2 + i) - 0.5) * 0.2, (hash01(id, 5 + i) - 0.5) * 0.4)
        put('prop_vent', x, roof, z, 0, 0.9 + hash01(id, 9 + i) * 0.3)
      }

      // Кондиционер — на блоках подлиннее, решёткой к камере.
      if (length >= 4) {
        const [x, z] = at(0.5 + (hash01(id, 20) - 0.5) * 0.3, -0.15)
        put('prop_ac', x, roof, z, alongX ? 0 : -Math.PI / 2)
      }

      // Труба вдоль края крыши на грани к камере, с коленами и водостоком
      // вниз по стене на дальнем конце.
      if (length >= 3) {
        const inset = 0.12
        const y = roof + 0.09
        const [x0, z0] = at(inset / length, 0)
        const [x1, z1] = at(1 - inset / length, 0)
        const side = (alongX ? max.z : max.x) + 0.5 - inset
        const [ax, az] = alongX ? [x0, side] : [side, z0]
        const [bx, bz] = alongX ? [x1, side] : [side, z1]
        this.q.setFromAxisAngle(AXIS_Y, alongX ? 0 : -Math.PI / 2)
        pipe(ax, y, az, length - 2 * inset)
        put('prop_pipe_joint', ax, y, az)
        put('prop_pipe_joint', bx, y, bz)
        this.q.setFromAxisAngle(AXIS_Z, -Math.PI / 2)
        pipe(bx, y, bz, y)
      }

      // Лампа на грани к камере: +Z у блока вдоль X, +X у блока вдоль Z.
      if (lampOrder.includes(b)) {
        const [x, z] = at(0.35 + hash01(id, 40) * 0.3, 0.5)
        const [dx, dz] = alongX ? [0, 1] : [1, 0]
        put('prop_lamp_wall', x, LAMP_H, z, yawFacing(dx, dz))
        // Свет — из-под плафона, на длину вылета кронштейна.
        const light = new THREE.PointLight(PALETTE.lamp, 9, 8, 2)
        light.userData.base = light.intensity
        light.position.set(x + dx * 0.42, LAMP_H - 0.15, z + dz * 0.42)
        this.lamps.push(light)
        this.root.add(light)
      }
    })

    this.props.push(...kinds.map((kind) => {
      const list = matrices.get(kind)!
      const { geometry, material } = env.part(kind)
      const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, list.length))
      list.forEach((m, i) => {
        mesh.setMatrixAt(i, m)
        this.blockProps[owners.get(kind)![i]!]!.push({ mesh, index: i, matrix: m })
      })
      mesh.count = list.length
      mesh.instanceMatrix.needsUpdate = true
      mesh.castShadow = true
      this.root.add(mesh)
      return mesh
    }))
    this.ghostShells.forEach((shell, b) => this.showBlockProps(b, !shell.visible))
  }

  /** Пропсы блока: показать или сжать в точку — инстанс не спрятать иначе. */
  private showBlockProps(block: number, shown: boolean): void {
    for (const { mesh, index, matrix } of this.blockProps[block] ?? []) {
      mesh.setMatrixAt(index, shown ? matrix : HIDDEN)
      mesh.instanceMatrix.needsUpdate = true
    }
  }

  private syncPiles(piles: readonly PileView[]): void {
    this.lastPiles = piles
    const counts = this.piles.map(() => 0)
    const centre = new THREE.Vector3()

    for (const pile of piles.slice(0, MAX_PILES)) {
      cellToWorld(pile.cell, this.world, centre)
      const fraction = pile.initial > 0 ? pile.volume / pile.initial : 0
      // Обломки убираются по мере убывания объёма: куча тает на глазах, и у
      // прерывания появляется видимая цена.
      const shown = Math.min(CHUNKS, Math.ceil(fraction * CHUNKS))

      for (let i = 0; i < shown; i++) {
        // Обломки лежат ярусами: верхние уходят первыми, и куча оседает,
        // а не выцветает равномерно. Нижний ярус — пять штук россыпью по
        // клетке, второй — ещё два сверху, последний — один на макушке:
        // так куча читается кучей, а не столбиком.
        const level = i < 5 ? 0 : i < 7 ? 1 : 2
        const angle = hash01(pile.id, i * 3 + 1) * Math.PI * 2
        const radius = level === 0
          ? 0.22 + hash01(pile.id, i * 3) * 0.2
          : level === 1 ? 0.08 + hash01(pile.id, i * 3) * 0.1 : 0.03
        const size = 0.8 + hash01(pile.id, i * 7) * 0.4
        // Последний обломок доживает свой объём, уменьшаясь.
        const tail = i === shown - 1 ? Math.max(0.35, fraction * CHUNKS - (shown - 1)) : 1

        this.pos.set(
          centre.x + Math.cos(angle) * radius,
          level * 0.2,
          centre.z + Math.sin(angle) * radius,
        )
        this.q.setFromAxisAngle(AXIS_Y, hash01(pile.id, i * 11) * Math.PI * 2)
        this.scl.setScalar(size * tail)
        const kind = Math.floor(hash01(pile.id, i * 13 + 5) * this.piles.length) % this.piles.length
        const mesh = this.piles[kind]!
        mesh.setMatrixAt(counts[kind]!++, this.m.compose(this.pos, this.q, this.scl))
      }
    }

    this.piles.forEach((mesh, k) => {
      mesh.count = counts[k]!
      mesh.instanceMatrix.needsUpdate = true
    })
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
    // Геометрия и материалы кита окружения — общее добро: снять их из
    // дерева до общей уборки, иначе следующий двор получит пустые кучи.
    if (this.piles.length > 1) for (const mesh of this.piles) this.root.remove(mesh)
    for (const mesh of [...this.floors, ...this.props]) this.root.remove(mesh)
    if (this.floors.length > 0) {
      this.root.remove(this.wallsSolid)
      this.root.remove(this.container)
    }
    disposeTree(this.root)
  }
}
