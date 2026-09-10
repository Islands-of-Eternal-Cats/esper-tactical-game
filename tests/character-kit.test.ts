/**
 * Контракт `character-kit.glb`.
 *
 * По именам мешей код гасит видимость, по именам костей адресуются сокеты —
 * значит это контракт, а не деталь ассета. Переименование в Blender иначе
 * ломает рантайм молча, и обнаруживается это на сцене, а не при сборке.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const GLB = fileURLToPath(new URL('../public/models/character-kit.glb', import.meta.url))

interface Gltf {
  animations?: {
    name: string
    channels: { sampler: number; target: { node: number; path: string } }[]
    samplers: { input: number }[]
  }[]
  meshes: { name: string; primitives: { indices: number }[] }[]
  nodes: { name: string; mesh?: number; skin?: number; children?: number[] }[]
  skins: { name: string; joints: number[] }[]
  accessors: { count: number; min?: number[]; max?: number[] }[]
  images?: unknown[]
}

function readGlb(): { json: Gltf; bytes: number } {
  const buf = readFileSync(GLB)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let off = 12
  while (off < buf.byteLength) {
    const len = view.getUint32(off, true)
    const type = view.getUint32(off + 4, true)
    off += 8
    if (type === 0x4e4f534a) {
      return { json: JSON.parse(buf.subarray(off, off + len).toString('utf8')) as Gltf, bytes: buf.byteLength }
    }
    off += len
  }
  throw new Error('в GLB нет JSON-чанка')
}

const { json, bytes } = readGlb()
const index = new Map(json.nodes.map((n, i) => [n.name, i]))

/** Индекс узла по имени. Отсутствие — это провал контракта, а не undefined. */
function nodeIndex(name: string): number {
  const i = index.get(name)
  if (i === undefined) throw new Error(`нет узла ${name}`)
  return i
}

function node(name: string): Gltf['nodes'][number] {
  const n = json.nodes[nodeIndex(name)]
  if (n === undefined) throw new Error(`нет узла ${name}`)
  return n
}

function triangles(name: string): number {
  const mesh = json.meshes.find((m) => m.name === name)
  if (mesh === undefined) throw new Error(`нет меша ${name}`)
  return mesh.primitives.reduce((sum, p) => {
    const acc = json.accessors[p.indices]
    if (acc === undefined) throw new Error(`у ${name} нет индексов`)
    return sum + acc.count / 3
  }, 0)
}

describe('character-kit.glb', () => {
  it('несёт части под именами из контракта', () => {
    for (const name of ['head_rusty', 'body_stocky', 'gear_vacuum', 'held_vacuum']) {
      expect(json.meshes.map((m) => m.name)).toContain(name)
    }
  })

  it('скиннингует голову и корпус одним скелетом', () => {
    expect(json.skins).toHaveLength(1)
    for (const name of ['head_rusty', 'body_stocky']) {
      expect(node(name).skin, `${name} должен быть скиннингован`).toBe(0)
    }
  })

  it('держит пропсы на сокетах, а не на весах', () => {
    for (const [prop, socket] of [
      ['held_vacuum', 'socket_hand_r'],
      ['gear_vacuum', 'socket_back'],
    ] as const) {
      expect(node(prop).skin, `${prop} — пропс, скиннинг ему не нужен`).toBeUndefined()
      expect(node(socket).children).toContain(nodeIndex(prop))
    }
  })

  it('даёт кости, которых нет в humanoid: хвост и уши', () => {
    for (const bone of ['tail_1', 'tail_2', 'tail_3', 'ear_l', 'ear_r']) {
      expect(index.has(bone), `нет кости ${bone}`).toBe(true)
    }
  })

  it('сохраняет имена Mixamo, иначе клипы не ретаргетятся', () => {
    for (const bone of ['Hips', 'Spine1', 'Head', 'RightHand', 'LeftFoot']) {
      expect(index.has(`mixamorig:${bone}`), `нет кости ${bone}`).toBe(true)
    }
  })

  it('несёт клип на каждое занятие кота', () => {
    const clips = new Map((json.animations ?? []).map((a) => [a.name, a]))
    for (const name of ['idle', 'walk', 'haul', 'work', 'dump']) {
      const anim = clips.get(name)
      expect(anim, `нет клипа ${name}`).toBeDefined()
      if (anim === undefined) continue
      // Клип начинается с нуля и длится хоть сколько-то: полусекундный
      // огрызок в начале при зацикливании читается запинкой.
      const t = json.accessors[anim.samplers[0]!.input]
      expect(t?.min?.[0]).toBe(0)
      expect(t?.max?.[0] ?? 0).toBeGreaterThan(0.5)
    }
  })

  it('оставляет голову рантайму: взгляд не запечён в клипы', () => {
    // Рысканье головы — внимание кота, им управляет рендер. Трек на этой
    // кости затирал бы взгляд каждый кадр, и починка была бы неочевидной.
    const head = nodeIndex('mixamorig:Head')
    for (const anim of json.animations ?? []) {
      const targets = anim.channels.map((c) => c.target.node)
      expect(targets, `клип ${anim.name} трогает голову`).not.toContain(head)
    }
  })

  it('укладывается в бюджеты техплана', () => {
    const cat = triangles('head_rusty') + triangles('body_stocky')
    expect(cat).toBeLessThanOrEqual(1200)
    expect(triangles('held_vacuum')).toBeLessThanOrEqual(200)
    expect(triangles('gear_vacuum')).toBeLessThanOrEqual(200)
    // Текстур нет ни одной; только плоские материалы.
    expect(json.images ?? []).toHaveLength(0)
    expect(bytes / 1024).toBeLessThanOrEqual(120)
  })
})
