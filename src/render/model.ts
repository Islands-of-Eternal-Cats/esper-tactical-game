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
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { proceduralAsphalt, proceduralConcrete, proceduralWall } from './surface'

const URL_KIT = `${import.meta.env.BASE_URL}models/character-kit.glb`

/**
 * three выкидывает из имён зарезервированные символы, среди них двоеточие:
 * `mixamorig:Head` в сцене зовётся `mixamorigHead`. Скелет назван по Mixamo
 * ради ретаргета клипов, поэтому искать надо по обоим написаниям — иначе
 * поиск кости молча вернёт undefined.
 */
function sanitize(name: string): string {
  return name.replace(/[[\].:/]/g, '')
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

  static async load(): Promise<CatKit> {
    const gltf = await new GLTFLoader().loadAsync(URL_KIT)
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
      // Кит несёт все головы и корпуса сразу; кот показывает свои.
      else if (o instanceof THREE.Mesh) {
        o.visible = wanted.has(o.name)
        // Цвет вершин в меше — запасной, на случай, если атлас не доехал.
        // Загрузчик включает его всегда, когда есть COLOR_0, и тогда он
        // перемножается с текстурой — кот темнеет вдвое.
        const mat = o.material
        if (mat instanceof THREE.MeshStandardMaterial && mat.map !== null) {
          mat.vertexColors = false
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

  static async load(): Promise<EnvKit> {
    const gltf = await new GLTFLoader().loadAsync(URL_ENV)
    const meshes = new Map<string, THREE.Mesh[]>()
    gltf.scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return
      const base = o.name.replace(/_\d+$/, '')
      const list = meshes.get(base) ?? []
      list.push(o)
      meshes.set(base, list)
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
