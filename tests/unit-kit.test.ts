/**
 * Контракт `unit-kit.glb`: узел `unit_body`, кости Mixamo, пять клипов,
 * `foot_speed` у бега, бюджеты.
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

/** Скелет, анимации: 50–150 КБ по техплану; сырой файл до упаковки gzip — щедрее. */
const MAX_BYTES = 300 * 1024
const MAX_TRIS = 2600
const CLIPS = ['idle', 'run', 'aim', 'fire', 'die']
/** Те же бои, перенесённые на скелет кота: свои в перестрелке — Ржавый. */
const CAT_CLIPS = ['cat_run', 'cat_aim', 'cat_fire', 'cat_die']

const present = existsSync(GLB)
if (!present) console.warn('unit-kit.glb нет — контракт кита юнитов не проверяется (npm run assets:unit)')

describe.skipIf(!present)('контракт unit-kit.glb', () => {
  // Тело describe выполняется и при пропуске: читать файл — только внутри тестов.
  const lazy = { value: null as { json: Gltf; bytes: number } | null }
  const data = (): { json: Gltf; bytes: number } => (lazy.value ??= readJson())

  it('меш юнита — под узлом unit_body, со скином', () => {
    const { json } = data()
    const names = new Map(json.nodes.map((n, i) => [n.name, i]))
    const i = names.get('unit_body')
    expect(i, 'нет узла unit_body').toBeDefined()
    const queue = [i!]
    let found: Gltf['nodes'][number] | null = null
    for (let h = 0; h < queue.length && found === null; h++) {
      const n = json.nodes[queue[h]!]!
      if (n.mesh !== undefined) found = n
      for (const c of n.children ?? []) queue.push(c)
    }
    expect(found, 'под unit_body нет меша').not.toBeNull()
    expect(found!.skin, 'меш без скина').toBeDefined()
  })

  it('кости — Mixamo, без номера в префиксе', () => {
    const { json } = data()
    const joints = new Set(json.skins.flatMap((s) => s.joints.map((j) => json.nodes[j]!.name)))
    for (const b of ['mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:LeftFoot', 'mixamorig:RightFoot', 'mixamorig:Head']) {
      expect(joints.has(b), `нет кости ${b}`).toBe(true)
    }
    expect([...joints].some((j) => /^mixamorig\d/.test(j))).toBe(false)
  })

  it('клипы по контракту, у бега — скорость ног', () => {
    const { json } = data()
    const anims = new Map((json.animations ?? []).map((a) => [a.name, a]))
    for (const c of CLIPS) expect(anims.has(c), `нет клипа ${c}`).toBe(true)
    const run = anims.get('run')!
    expect(run.extras?.foot_speed ?? 0).toBeGreaterThan(0)
  })

  it('боевые клипы кота — на скелете cat_rig, у cat_run скорость ног', () => {
    const { json } = data()
    const anims = new Map((json.animations ?? []).map((a) => [a.name, a]))
    for (const c of CAT_CLIPS) expect(anims.has(c), `нет клипа ${c}`).toBe(true)
    expect(anims.get('cat_run')!.extras?.foot_speed ?? 0).toBeGreaterThan(0)
    expect(json.nodes.some((n) => n.name === 'cat_rig'), 'нет узла cat_rig').toBe(true)
  })

  it('без текстур и в бюджете', () => {
    const { json, bytes } = data()
    expect(json.images ?? []).toHaveLength(0)
    let tris = 0
    for (const m of json.meshes) {
      for (const p of m.primitives) if (p.indices !== undefined) tris += json.accessors[p.indices]!.count / 3
    }
    expect(tris).toBeLessThanOrEqual(MAX_TRIS)
    expect(bytes).toBeLessThanOrEqual(MAX_BYTES)
  })
})
