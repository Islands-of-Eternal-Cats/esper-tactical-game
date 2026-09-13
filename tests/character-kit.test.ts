/**
 * Контракт `character-kit.glb`.
 *
 * По именам узлов код гасит видимость, по именам костей адресуются сокеты —
 * значит это контракт, а не деталь ассета. Переименование в Blender иначе
 * ломает рантайм молча, и обнаруживается это на сцене, а не при сборке.
 *
 * Кит сжат gltfpack (meshopt): имена мешей он не хранит, меш лежит под
 * именованным узлом в безымянном дочернем, атрибуты квантованы.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

const GLB = fileURLToPath(new URL('../public/models/character-kit.glb', import.meta.url))

interface Gltf {
  animations?: {
    name: string
    extras?: { foot_speed?: number }
    channels: { sampler: number; target: { node: number; path: string } }[]
    samplers: { input: number }[]
  }[]
  meshes: { name: string; primitives: { indices: number; attributes: Record<string, number> }[] }[]
  nodes: { name: string; mesh?: number; skin?: number; children?: number[] }[]
  skins: { name: string; joints: number[] }[]
  accessors: {
    count: number
    type: string
    componentType: number
    bufferView?: number
    byteOffset?: number
    min?: number[]
    max?: number[]
  }[]
  bufferViews: {
    byteOffset?: number
    byteLength: number
    byteStride?: number
    extensions?: {
      EXT_meshopt_compression?: { byteOffset?: number; byteLength: number; byteStride: number; count: number; mode: string; filter?: string }
    }
  }[]
  images?: { mimeType?: string }[]
}

function readGlb(): { json: Gltf; bytes: number; bin: Buffer } {
  const buf = readFileSync(GLB)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let off = 12
  let json: Gltf | null = null
  let bin: Buffer | null = null
  while (off < buf.byteLength) {
    const len = view.getUint32(off, true)
    const type = view.getUint32(off + 4, true)
    off += 8
    if (type === 0x4e4f534a) json = JSON.parse(buf.subarray(off, off + len).toString('utf8')) as Gltf
    else if (type === 0x004e4942) bin = buf.subarray(off, off + len)
    off += len
  }
  if (json === null || bin === null) throw new Error('в GLB нет JSON- или BIN-чанка')
  return { json, bytes: buf.byteLength, bin }
}

const { json, bytes, bin } = readGlb()

await MeshoptDecoder.ready

/** Байты bufferView: сжатый meshopt распаковывается тем же декодером, что в рендере. */
function bytesOf(index: number): Uint8Array {
  const bv = json.bufferViews[index]
  if (bv === undefined) throw new Error(`нет bufferView ${index}`)
  const mo = bv.extensions?.EXT_meshopt_compression
  if (mo === undefined) {
    return new Uint8Array(bin.buffer, bin.byteOffset + (bv.byteOffset ?? 0), bv.byteLength)
  }
  const source = new Uint8Array(bin.buffer, bin.byteOffset + (mo.byteOffset ?? 0), mo.byteLength)
  const out = new Uint8Array(mo.count * mo.byteStride)
  MeshoptDecoder.decodeGltfBuffer(out, mo.count, mo.byteStride, source, mo.mode, mo.filter)
  return out
}

/** Данные аксессора числами: нормированные целые — в 0…1, float — как есть. */
function numbers(accessor: number): number[] {
  const acc = json.accessors[accessor]
  if (acc === undefined) throw new Error(`нет аксессора ${accessor}`)
  if (acc.bufferView === undefined) throw new Error(`аксессор ${accessor}: нет bufferView`)
  const bv = json.bufferViews[acc.bufferView]!
  const data = bytesOf(acc.bufferView)
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type] ?? 0
  const size = { 5126: 4, 5123: 2, 5121: 1 }[acc.componentType] ?? 0
  const stride = bv.byteStride ?? bv.extensions?.EXT_meshopt_compression?.byteStride ?? n * size
  const out: number[] = []
  for (let i = 0; i < acc.count; i++) {
    for (let k = 0; k < n; k++) {
      const at = (acc.byteOffset ?? 0) + i * stride + k * size
      if (acc.componentType === 5126) out.push(view.getFloat32(at, true))
      else if (acc.componentType === 5123) out.push(view.getUint16(at, true) / 65535)
      else out.push(view.getUint8(at) / 255)
    }
  }
  return out
}
const index = new Map(json.nodes.map((n, i) => [n.name, i]))

/** Узел с мешем под именем: сам именованный узел или его безымянный потомок. */
function meshNode(name: string): Gltf['nodes'][number] {
  const queue = [nodeIndex(name)]
  for (let head = 0; head < queue.length; head++) {
    const n = json.nodes[queue[head]!]!
    if (n.mesh !== undefined) return n
    for (const c of n.children ?? []) queue.push(c)
  }
  throw new Error(`под ${name} нет меша`)
}

function mesh(name: string): Gltf['meshes'][number] {
  return json.meshes[meshNode(name).mesh!]!
}

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
  return mesh(name).primitives.reduce((sum, p) => {
    const acc = json.accessors[p.indices]
    if (acc === undefined) throw new Error(`у ${name} нет индексов`)
    return sum + acc.count / 3
  }, 0)
}

describe('character-kit.glb', () => {
  it('несёт части под именами из контракта', () => {
    for (const name of ['head_rusty', 'body_stocky', 'gear_vacuum', 'held_vacuum']) {
      expect(index.has(name), `нет узла ${name}`).toBe(true)
      expect(mesh(name)).toBeDefined()
    }
  })

  it('скиннингует голову и корпус одним скелетом', () => {
    expect(json.skins).toHaveLength(1)
    for (const name of ['head_rusty', 'body_stocky']) {
      expect(meshNode(name).skin, `${name} должен быть скиннингован`).toBe(0)
    }
  })

  it('держит пропсы на сокетах, а не на весах', () => {
    for (const [prop, socket] of [
      ['held_vacuum', 'socket_hand_r'],
      ['gear_vacuum', 'socket_back'],
    ] as const) {
      expect(meshNode(prop).skin, `${prop} — пропс, скиннинг ему не нужен`).toBeUndefined()
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

  it('у походок записана скорость ног — по ней рендер гасит скольжение', () => {
    // Скорость земли задаёт симуляция, скорость ног — клип. Рендер делит
    // одно на другое и получает темп; без числа в extras он крутил бы клип
    // вслепую, и ноги скользили бы при любом изменении темпа игры.
    for (const name of ['walk', 'haul']) {
      const anim = (json.animations ?? []).find((a) => a.name === name)
      const v = anim?.extras?.foot_speed
      expect(v, `${name} без foot_speed`).toBeGreaterThan(0.3)
      expect(v).toBeLessThan(3)
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

  it('каждая вершина кота кому-то принадлежит', () => {
    // Вершина без весов остаётся в bind-позе и висит в воздухе, когда кот
    // двигается. В Blender это не видно, в игре — сразу. Так летали кусок
    // хвоста и бирка на ремне; страховка в скрипте, проверка — здесь.
    for (const name of ['head_rusty', 'body_stocky']) {
      const weights = mesh(name).primitives[0]?.attributes.WEIGHTS_0
      expect(weights, `${name} без весов`).toBeDefined()
      const w = numbers(weights!)
      let orphans = 0
      for (let i = 0; i < w.length; i += 4) {
        if (w[i]! + w[i + 1]! + w[i + 2]! + w[i + 3]! < 0.01) orphans++
      }
      expect(orphans, `${name}: вершин без весов`).toBe(0)
    }
  })

  it('красит кота картой, без цвета вершин', () => {
    // Карта Tripo 512² с UV генератора. Цвета вершин в GLB нет: карта в том
    // же файле, запасной путь не сработал бы никогда, а весил бы 30 КБ.
    for (const name of ['head_rusty', 'body_stocky']) {
      expect(mesh(name).primitives[0]?.attributes.COLOR_0, `${name} с лишним цветом вершин`).toBeUndefined()
      expect(mesh(name).primitives[0]?.attributes.TEXCOORD_0, `${name} без UV`).toBeDefined()
    }
    // Одна карта на кота, по одной на сгенерированный пропс — не больше:
    // каждая лишняя картинка — это и вес, и отдельный вызов рисования.
    expect((json.images ?? []).length).toBeLessThanOrEqual(3)
  })

  it('укладывается в бюджеты техплана', () => {
    // Кот из генерации, ~10k треугольников: децимация под этот бюджет в
    // build-character-kit.py. Меньше — теряются уши и ремни.
    const cat = triangles('head_rusty') + triangles('body_stocky')
    expect(cat).toBeLessThanOrEqual(12000)
    // Пропсы в лапе и на спине — «геройские», в кадре всегда: под них
    // генерация оправдана, и бюджет выше болваночных 200.
    expect(triangles('held_vacuum')).toBeLessThanOrEqual(900)
    expect(triangles('gear_vacuum')).toBeLessThanOrEqual(1600)
    // После meshopt: геометрия и веса втрое меньше, карты — как были.
    expect(bytes / 1024).toBeLessThanOrEqual(400)
  })
})
