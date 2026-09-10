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
      else if (o instanceof THREE.Mesh) o.visible = wanted.has(o.name)
    })

    return { root, bones, clips: this.clips }
  }
}

/** Кость по имени из контракта. Отсутствие — поломка ассета, а не вариант. */
export function bone(rig: CatRig, name: string): THREE.Bone {
  const found = rig.bones.get(name) ?? rig.bones.get(sanitize(name))
  if (found === undefined) throw new Error(`в ките нет кости ${name}`)
  return found
}
