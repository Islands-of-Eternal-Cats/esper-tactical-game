/**
 * Контракт `unit-kit.glb`: узел `unit_body`, кости Mixamo и хвост, пять
 * клипов, `foot_speed` у бега, бюджеты.
 *
 * Кит собирается из файлов Mixamo, которых в репозитории нет (лицензия
 * Adobe), поэтому без файла тест пропускается, а не падает: рендер без
 * кита честно деградирует до капсул. Но если файл есть — контракт строгий.
 */

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const GLB = fileURLToPath(new URL('../public/models/unit-kit.glb', import.meta.url))

interface Gltf {
  animations?: { name: string; extras?: { foot_speed?: number } }[]
  meshes: { primitives: { indices?: number }[] }[]
  nodes: { name: string; mesh?: number; skin?: number; children?: number[] }[]
  skins: { joints: number[] }[]
  accessors: { count: number }[]
  images?: unknown[]
}

function readJson(): { json: Gltf; bytes: number } {
  const buf = readFileSync(GLB)
  const len = buf.readUInt32LE(12)
  return { json: JSON.parse(buf.subarray(20, 20 + len).toString('utf8')) as Gltf, bytes: buf.byteLength }
}

/** Два скелета с клипами и кот с картой: сырой файл до упаковки gzip — щедрее. */
const MAX_BYTES = 400 * 1024
/** Родная сетка кота — 5,4k, Y Bot децимирован до 2,2k. */
const MAX_TRIS = 8000
const CLIPS = ['idle', 'run', 'aim', 'fire', 'die']
/** Те же пять — для кота, скачанные под его скелет. */
const CAT_CLIPS = CLIPS.map((c) => `cat_${c}`)

const present = existsSync(GLB)
if (!present) console.warn('unit-kit.glb нет — контракт кита юнитов не проверяется (npm run assets:unit)')

describe.skipIf(!present)('контракт unit-kit.glb', () => {
  // Тело describe выполняется и при пропуске: читать файл — только внутри тестов.
  const lazy = { value: null as { json: Gltf; bytes: number } | null }
  const data = (): { json: Gltf; bytes: number } => (lazy.value ??= readJson())

  it('меши — под узлами unit_body и cat_body, со скином', () => {
    const { json } = data()
    const names = new Map(json.nodes.map((n, i) => [n.name, i]))
    for (const body of ['unit_body', 'cat_body']) {
      const i = names.get(body)
      expect(i, `нет узла ${body}`).toBeDefined()
      const queue = [i!]
      let found: Gltf['nodes'][number] | null = null
      for (let h = 0; h < queue.length && found === null; h++) {
        const n = json.nodes[queue[h]!]!
        if (n.mesh !== undefined) found = n
        for (const c of n.children ?? []) queue.push(c)
      }
      expect(found, `под ${body} нет меша`).not.toBeNull()
      expect(found!.skin, `${body} без скина`).toBeDefined()
    }
  })

  it('два скелета Mixamo, у кота ещё хвост из эталона', () => {
    const { json } = data()
    // Два скелета с одинаковыми костями в одном файле: экспортёр даёт
    // вторым суффикс `_1`. Клипы привязаны к узлам, а не к именам; рендер
    // ищет суставы по имени с учётом суффикса, сняв чужой скелет.
    expect(json.skins).toHaveLength(2)
    const joints = new Set(json.skins.flatMap((s) => s.joints.map((j) => json.nodes[j]!.name)))
    for (const b of ['Hips', 'Spine', 'LeftFoot', 'RightFoot', 'Head', 'RightHand', 'LeftHand', 'LeftForeArm']) {
      expect([...joints].some((j) => new RegExp(`^mixamorig:${b}(_\\d+)?$`).test(j)), `нет кости ${b}`).toBe(true)
    }
    expect([...joints].some((j) => /^mixamorig\d/.test(j))).toBe(false)
    // Хвост авториггер не знает: без своих костей он махал бы вместе с ногой.
    for (const b of ['tail_1', 'tail_2', 'tail_3']) expect(joints.has(b), `нет кости ${b}`).toBe(true)
  })

  it('клипы по контракту, у бега — скорость ног', () => {
    const { json } = data()
    const anims = new Map((json.animations ?? []).map((a) => [a.name, a]))
    for (const c of [...CLIPS, ...CAT_CLIPS]) expect(anims.has(c), `нет клипа ${c}`).toBe(true)
    for (const run of ['run', 'cat_run']) expect(anims.get(run)!.extras?.foot_speed ?? 0, run).toBeGreaterThan(0)
  })

  it('карта одна и в бюджете', () => {
    const { json, bytes } = data()
    // Кот раскрашен своей картой; Y Bot плоский — сторону кладёт рендер.
    expect(json.images ?? []).toHaveLength(1)
    let tris = 0
    for (const m of json.meshes) {
      for (const p of m.primitives) if (p.indices !== undefined) tris += json.accessors[p.indices]!.count / 3
    }
    expect(tris).toBeLessThanOrEqual(MAX_TRIS)
    expect(bytes).toBeLessThanOrEqual(MAX_BYTES)
  })
})
