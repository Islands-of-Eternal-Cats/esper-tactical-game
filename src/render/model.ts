/**
 * Загрузка кита персонажей.
 *
 * Файл один на всех котов: скелет, головы, корпуса, снаряжение одной
 * иерархией, лишнее гасится видимостью. Отдельные файлы на каждую часть со
 * сшивкой на рантайме не делаются — расходящиеся bind-позы самый неприятный
 * класс ошибок здесь, а при наших размерах грузить всё одним файлом дешевле,
 * чем их ловить.
 *
 * Имена мешей и костей — контракт с ассетом, он проверяется автотестом
 * `tests/character-kit.test.ts`.
 */

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { proceduralAsphalt, proceduralConcrete, proceduralWall } from './surface'

const URL_KIT = `${import.meta.env.BASE_URL}models/character-kit.glb`

/** Ход загрузки: байт получено и байт всего (0, пока сервер не сказал). */
export type Progress = (loaded: number, total: number) => void

export interface KitLoads {
  cat: Promise<CatKit>
  env: Promise<EnvKit>
}

/**
 * Оба кита разом, одной шкалой прогресса. Запускается при старте главного
 * потока, до того как воркер объявит двор: киты — самое тяжёлое в загрузке,
 * и ждать сцены, чтобы их запросить, значит терять секунду на медленной сети.
 *
 * Пока сервер не назвал размер, знаменатель — ожидаемый: иначе полоска
 * прыгает назад, когда второй файл отзывается.
 */
export function loadKits(onProgress: (fraction: number) => void): KitLoads {
  const expected = [620_000, 290_000]
  const loaded = [0, 0]
  const total = [...expected]
  const report = (i: number): Progress => (got, all) => {
    loaded[i] = got
    if (all > 0) total[i] = all
    const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)
    onProgress(Math.min(1, sum(loaded) / sum(total)))
  }
  return { cat: CatKit.load(report(0)), env: EnvKit.load(report(1)) }
}

function progress(on?: Progress): ((e: ProgressEvent) => void) | undefined {
  return on === undefined ? undefined : (e) => on(e.loaded, e.lengthComputable ? e.total : 0)
}

/**
 * three выкидывает из имён зарезервированные символы, среди них двоеточие:
 * `mixamorig:Head` в сцене зовётся `mixamorigHead`. Скелет назван по Mixamo
 * ради ретаргета клипов, поэтому искать надо по обоим написаниям — иначе
 * поиск кости молча вернёт undefined.
 */
function sanitize(name: string): string {
  return name.replace(/[[\].:/]/g, '')
}

/**
 * Безымянный узел: gltfpack хранит имена только у узлов (`-kn`), а мешам
 * под ними загрузчик даёт служебные `mesh_N`, а общим для нескольких узлов —
 * ещё и `_instance_N`. Имя из контракта — на ближайшем предке со своим.
 */
function unnamed(o: THREE.Object3D): boolean {
  return o.name === '' || /^(mesh_\d+|_instance_\d+)/.test(o.name)
}

/**
 * Киты сжаты meshopt (`scripts/pack-kits.mjs`): геометрия и веса втрое
 * меньше, декодер — 20 КБ в three. Квантование позиций gltfpack выносит в
 * трансформацию узла, поэтому геометрию модулей нельзя брать «как есть» —
 * она запекается при загрузке кита окружения.
 */
function loader(): GLTFLoader {
  const l = new GLTFLoader()
  l.setMeshoptDecoder(MeshoptDecoder)
  return l
}


export interface CatRig {
  root: THREE.Object3D
  bones: Map<string, THREE.Bone>
  clips: THREE.AnimationClip[]
}

export class CatKit {
  private constructor(
    private readonly scene: THREE.Object3D,
    private readonly clips: THREE.AnimationClip[],
  ) {}

  static async load(onProgress?: Progress): Promise<CatKit> {
    const gltf = await loader().loadAsync(URL_KIT, progress(onProgress))
    return new CatKit(gltf.scene, gltf.animations)
  }

  /**
   * Экземпляр кота. Клонировать обычным `clone()` нельзя: у скиннингованного
   * меша он оставит ссылку на чужой скелет, и все коты будут повторять
   * движения первого.
   */
  spawn(parts: readonly string[]): CatRig {
    const root = cloneSkinned(this.scene)
    const wanted = new Set(parts)
    const bones = new Map<string, THREE.Bone>()

    root.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones.set(o.name, o as THREE.Bone)
      // Кит несёт все головы и корпуса сразу; кот показывает свои. Имя
      // части — на узле, меш под ним безымянный (так раскладывает gltfpack).
      else if (o instanceof THREE.Mesh) {
        let node: THREE.Object3D = o
        while (unnamed(node) && node.parent !== null) node = node.parent
        o.visible = wanted.has(node.name)
        const mat = o.material
        if (mat instanceof THREE.MeshStandardMaterial && mat.map !== null) {
          // Одежда — оболочка без толщины: воротник капюшона, рукава, полы
          // с некоторых ракурсов видны изнутри, и изнанка без этого чёрная.
          mat.side = THREE.DoubleSide
        }
      }
    })

    return { root, bones, clips: this.clips }
  }
}

/** Клип по имени из контракта. Отсутствие — поломка ассета, а не вариант. */
export function clip(rig: CatRig, name: string): THREE.AnimationClip {
  const found = rig.clips.find((c) => c.name === name)
  if (found === undefined) throw new Error(`в ките нет клипа ${name}`)
  return found
}

/** Кость по имени из контракта. Отсутствие — поломка ассета, а не вариант. */
export function bone(rig: CatRig, name: string): THREE.Bone {
  const found = rig.bones.get(name) ?? rig.bones.get(sanitize(name))
  if (found === undefined) throw new Error(`в ките нет кости ${name}`)
  return found
}

const URL_ENV = `${import.meta.env.BASE_URL}models/env-kit.glb`

/** Обломки мусора, из которых рендер собирает кучи. Имена — контракт. */
export const DEBRIS = ['debris_bag', 'debris_barrel', 'debris_crate'] as const

/** Плитки пола: по клетке на каждую, вариант выбирается хешем клетки. */
export const FLOORS = ['floor_slab', 'floor_patch', 'floor_grate'] as const

/** Панели стен: гладкая и две с деталью. По хешу клетки; тон — шейдером. */
export const WALL_BLOCKS = ['wall_block', 'wall_block_grille', 'wall_block_plate'] as const

/** Модули двора, которые рендер ставит по раскладке. Имена — контракт. */
export const MODULES = [
  ...FLOORS,
  ...WALL_BLOCKS,
  'edge_wall',
  'edge_corrugated',
  'edge_gate',
  'edge_door',
  'edge_curb',
  'street_tile',
  'prop_dumpster',
  'prop_barrel',
  'prop_crate',
  'prop_cart',
  'prop_pallet',
  'prop_lamp_wall',
  'prop_vent',
  'prop_ac',
  'prop_pipe',
  'prop_pipe_joint',
] as const

export interface EnvPart {
  geometry: THREE.BufferGeometry
  material: THREE.Material | THREE.Material[]
}

/**
 * Кит окружения: геометрия и материалы модулей двора по именам. Меши не
 * ставятся в сцену сами — рендер инстансирует их сколько нужно.
 *
 * Модуль из нескольких материалов загрузчик приносит группой мешей по
 * примитиву на материал, с именами `имя`, `имя_1`, … Инстансировать группу
 * нельзя, поэтому примитивы сшиваются обратно в одну геометрию с группами
 * граней и массивом материалов — это InstancedMesh умеет.
 */
export class EnvKit {
  private constructor(private readonly parts: Map<string, EnvPart>) {}

  static async load(onProgress?: Progress): Promise<EnvKit> {
    const gltf = await loader().loadAsync(URL_ENV, progress(onProgress))
    // Имя модуля — имя ближайшего именованного предка: gltfpack держит
    // имена узлов, а меши раскладывает под ними безымянными узлами —
    // по одному на материал, с квантованием в трансформации. Геометрия
    // запекается относительно именованного узла: рендер инстансирует её
    // своими матрицами и этих узлов не видит.
    const meshes = new Map<string, THREE.Mesh[]>()
    const local = new THREE.Matrix4()
    // Одинаковые меши gltfpack сводит в один, и загрузчик делит геометрию
    // между узлами: запечь её дважды — значит умножить квантование дважды.
    // Первому достаётся оригинал, остальным — копии нетронутого.
    const pristine = new Map<THREE.BufferGeometry, THREE.BufferGeometry>()
    gltf.scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return
      const shared = pristine.get(o.geometry)
      if (shared !== undefined) o.geometry = shared.clone()
      else pristine.set(o.geometry, o.geometry.clone())
      // Квантованные позиции — целые int16; умножить их на матрицу
      // на месте нельзя, результат не влезет обратно. Переводим в float.
      const pos = o.geometry.getAttribute('position') as THREE.BufferAttribute
      if (!(pos.array instanceof Float32Array)) {
        const f = new Float32Array(pos.count * 3)
        for (let i = 0; i < pos.count; i++) {
          f[i * 3] = pos.getX(i)
          f[i * 3 + 1] = pos.getY(i)
          f[i * 3 + 2] = pos.getZ(i)
        }
        o.geometry.setAttribute('position', new THREE.BufferAttribute(f, 3))
      }
      local.identity()
      let node: THREE.Object3D = o
      while (node.parent !== null && node.parent !== gltf.scene && unnamed(node)) {
        node.updateMatrix()
        local.premultiply(node.matrix)
        node = node.parent
      }
      if (node === o) {
        o.updateMatrix()
        local.copy(o.matrix)
      }
      o.geometry.applyMatrix4(local)
      const list = meshes.get(node.name) ?? []
      list.push(o)
      meshes.set(node.name, list)
    })
    // Бетон, асфальт и стены — шейдером по мировой координате, не картинкой.
    // Материалы в ките общие, править каждый достаточно один раз.
    const patched = new Set<THREE.Material>()
    for (const list of meshes.values()) {
      for (const mesh of list) {
        const mat = mesh.material
        if (!(mat instanceof THREE.MeshStandardMaterial) || patched.has(mat)) continue
        patched.add(mat)
        if (mat.name === 'concrete') proceduralConcrete(mat)
        else if (mat.name === 'asphalt') proceduralAsphalt(mat)
        else if (mat.name === 'wall') proceduralWall(mat)
      }
    }
    const parts = new Map<string, EnvPart>()
    for (const [name, list] of meshes) {
      if (list.length === 1) {
        parts.set(name, { geometry: list[0]!.geometry, material: list[0]!.material as THREE.Material })
        continue
      }
      const geometry = mergeGeometries(list.map((m) => m.geometry), true)
      if (geometry === null) throw new Error(`не сшиваются примитивы ${name}`)
      parts.set(name, { geometry, material: list.map((m) => m.material as THREE.Material) })
    }
    for (const name of [...DEBRIS, ...MODULES]) {
      if (!parts.has(name)) throw new Error(`в ките окружения нет ${name}`)
    }
    return new EnvKit(parts)
  }

  /** Геометрия и материал по имени — общие, инстансы их не копируют. */
  part(name: string): EnvPart {
    const part = this.parts.get(name)
    if (part === undefined) throw new Error(`в ките окружения нет ${name}`)
    return part
  }
}
