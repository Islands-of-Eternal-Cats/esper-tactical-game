/**
 * Контракт `gun-kit.glb`: каждая часть из weapons.yaml есть в ките, у
 * каждого корпуса — гнёзда под всё, что в него ставится, и бюджет.
 *
 * Кит собирается из набора Quaternius, которого в репозитории нет (62 МБ),
 * поэтому без файла тест пропускается: рендер без кита держит брусок.
 */

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WEAPONS } from '../src/core/weapons'

const GLB = fileURLToPath(new URL('../public/models/gun-kit.glb', import.meta.url))

interface Gltf {
  nodes: { name?: string; mesh?: number; extras?: { sockets?: Record<string, number[]> } }[]
  meshes: { primitives: { indices?: number }[] }[]
  accessors: { count: number }[]
  images?: unknown[]
}

function readJson(): { json: Gltf; bytes: number } {
  const buf = readFileSync(GLB)
  const len = buf.readUInt32LE(12)
  return { json: JSON.parse(buf.subarray(20, 20 + len).toString('utf8')) as Gltf, bytes: buf.byteLength }
}

/** ~24 части по 400–1500 тр.: сырой файл до gzip. */
const MAX_BYTES = 200 * 1024
const MAX_TRIS = 20_000

const present = existsSync(GLB)
if (!present) console.warn('gun-kit.glb нет — контракт кита оружия не проверяется (npm run assets:guns)')

describe.skipIf(!present)('gun-kit.glb', () => {
  const { json, bytes } = readJson()
  const nodes = new Map(json.nodes.filter((n) => n.name !== undefined).map((n) => [n.name!, n]))

  it('каждая часть из weapons.yaml — узел кита', () => {
    for (const w of WEAPONS.values()) {
      for (const part of Object.values(w.look)) expect(nodes.has(`gun_${part.toLowerCase()}`), `${w.id}: ${part}`).toBe(true)
    }
  })

  it('у корпуса есть гнездо под каждую часть', () => {
    for (const w of WEAPONS.values()) {
      const body = nodes.get(`gun_${w.look.body.toLowerCase()}`)!
      const sockets = body.extras?.sockets
      expect(sockets, `${w.id}: у ${w.look.body} нет гнёзд`).toBeDefined()
      for (const slot of Object.keys(w.look)) {
        if (slot === 'body') continue
        expect(sockets![slot], `${w.id}: гнездо ${slot}`).toHaveLength(3)
      }
    }
  })

  it('без текстур и в бюджете', () => {
    expect(json.images ?? []).toHaveLength(0)
    expect(bytes).toBeLessThan(MAX_BYTES)
    let tris = 0
    for (const m of json.meshes) for (const p of m.primitives) if (p.indices !== undefined) tris += json.accessors[p.indices]!.count / 3
    expect(tris).toBeLessThan(MAX_TRIS)
  })
})
