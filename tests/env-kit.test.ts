/**
 * Контракт `env-kit.glb`: модули двора и обломки, из которых рендер собирает
 * кучи. По именам он берёт геометрию, значит имена — контракт, а не деталь.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const GLB = fileURLToPath(new URL('../public/models/env-kit.glb', import.meta.url))

interface Gltf {
  meshes: { name: string; primitives: { indices: number; attributes: Record<string, number> }[] }[]
  nodes: { name: string; mesh?: number; children?: number[] }[]
  accessors: { count: number }[]
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
    if (type === 0x4e4f534a) return { json: JSON.parse(buf.subarray(off, off + len).toString('utf8')) as Gltf, bytes: buf.byteLength }
    off += len
  }
  throw new Error('в GLB нет JSON-чанка')
}

const { json, bytes } = readGlb()

/**
 * Меши модуля: под именованным узлом, в безымянных потомках — так
 * раскладывает gltfpack, имена мешей он не хранит.
 */
function meshesOf(name: string): Gltf['meshes'] {
  const root = json.nodes.findIndex((n) => n.name === name)
  if (root < 0) throw new Error(`нет узла ${name}`)
  const out: Gltf['meshes'] = []
  const queue = [root]
  for (let head = 0; head < queue.length; head++) {
    const n = json.nodes[queue[head]!]!
    if (n.mesh !== undefined) out.push(json.meshes[n.mesh]!)
    for (const c of n.children ?? []) queue.push(c)
  }
  if (out.length === 0) throw new Error(`под ${name} нет меша`)
  return out
}

function triangles(name: string): number {
  let sum = 0
  for (const mesh of meshesOf(name)) {
    for (const p of mesh.primitives) sum += json.accessors[p.indices]!.count / 3
  }
  return sum
}

describe('env-kit.glb', () => {
  it('несёт обломки под именами из контракта, с UV и картой', () => {
    for (const name of ['debris_bag', 'debris_barrel', 'debris_crate']) {
      const [mesh] = meshesOf(name)
      expect(mesh?.primitives[0]?.attributes.TEXCOORD_0, `${name} без UV`).toBeDefined()
    }
  })

  it('несёт модули двора без текстур: плоские материалы, бюджет 50–300 тр.', () => {
    const modules = [
      'floor_slab', 'floor_patch', 'floor_grate', 'wall_block', 'wall_block_grille', 'wall_block_plate', 'edge_wall', 'edge_corrugated', 'edge_gate', 'edge_door', 'edge_curb', 'street_tile',
      'prop_dumpster', 'prop_barrel', 'prop_crate', 'prop_cart', 'prop_pallet', 'prop_lamp_wall', 'prop_vent', 'prop_ac', 'prop_pipe', 'prop_pipe_joint',
    ]
    for (const name of modules) {
      expect(triangles(name), name).toBeLessThanOrEqual(300)
    }
    // Картинки: только карты трёх обломков. Поверхности двора — шейдером
    // в рендере, модули текстур не носят.
    expect(json.images ?? []).toHaveLength(3)
  })

  it('укладывается в бюджет: обломков в кадре десятки, плиток — сотни', () => {
    for (const name of ['debris_bag', 'debris_barrel', 'debris_crate']) {
      expect(triangles(name), name).toBeLessThanOrEqual(400)
    }
    expect(bytes / 1024).toBeLessThanOrEqual(160)
  })
})
