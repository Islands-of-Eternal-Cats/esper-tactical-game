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

function triangles(name: string): number {
  const mesh = json.meshes.find((m) => m.name === name)
  if (mesh === undefined) throw new Error(`нет меша ${name}`)
  return mesh.primitives.reduce((sum, p) => sum + json.accessors[p.indices]!.count / 3, 0)
}

describe('env-kit.glb', () => {
  it('несёт обломки под именами из контракта, с UV и картой', () => {
    for (const name of ['debris_bag', 'debris_barrel', 'debris_crate']) {
      const mesh = json.meshes.find((m) => m.name === name)
      expect(mesh, `нет ${name}`).toBeDefined()
      expect(mesh?.primitives[0]?.attributes.TEXCOORD_0, `${name} без UV`).toBeDefined()
    }
    expect(json.images ?? []).toHaveLength(3)
  })

  it('несёт модули двора без текстур: плоские материалы, бюджет 50–300 тр.', () => {
    const modules = [
      'floor_slab', 'floor_patch', 'floor_grate', 'wall_block',
      'prop_dumpster', 'prop_lamp_wall', 'prop_vent', 'prop_ac', 'prop_pipe', 'prop_pipe_joint',
    ]
    for (const name of modules) {
      const mesh = json.meshes.find((m) => m.name === name)
      expect(mesh, `нет ${name}`).toBeDefined()
      expect(triangles(name), name).toBeLessThanOrEqual(300)
    }
    // Картинок ровно столько, сколько обломков: модули текстур не носят.
    expect(json.images ?? []).toHaveLength(3)
  })

  it('укладывается в бюджет: обломков в кадре десятки, плиток — сотни', () => {
    for (const name of ['debris_bag', 'debris_barrel', 'debris_crate']) {
      expect(triangles(name), name).toBeLessThanOrEqual(400)
    }
    expect(bytes / 1024).toBeLessThanOrEqual(200)
  })
})
