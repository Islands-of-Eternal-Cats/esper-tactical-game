#!/usr/bin/env node
/**
 * Сжатие китов: meshopt поверх экспорта Blender.
 *
 * Blender умеет только Draco, а его декодер весит как половина экономии.
 * gltfpack кладёт EXT_meshopt_compression и квантование, декодер — 20 КБ и
 * уже в three. Геометрия и веса скиннинга ужимаются втрое; картинок не
 * трогает.
 *
 * `-kn` держит имена узлов: по ним рендер находит части кота, кости и модули
 * двора. Имена мешей gltfpack теряет — контракт живёт на узлах. Extras у
 * анимаций он теряет тоже, несмотря на `-ke`, а там `foot_speed`, без
 * которого ноги кота скользят: переносятся из исходника по имени клипа.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, statSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const gltfpack = require.resolve('gltfpack/cli.js')

const JSON_CHUNK = 0x4e4f534a

/** JSON-чанк GLB и всё, что после него. */
function split(buf) {
  const len = buf.readUInt32LE(12)
  const type = buf.readUInt32LE(16)
  if (type !== JSON_CHUNK) throw new Error('первый чанк GLB — не JSON')
  return { json: JSON.parse(buf.subarray(20, 20 + len).toString('utf8')), rest: buf.subarray(20 + len) }
}

/** GLB с новым JSON-чанком: длины и выравнивание по 4 пересчитываются. */
function join(json, rest) {
  let text = Buffer.from(JSON.stringify(json), 'utf8')
  const pad = (4 - (text.length % 4)) % 4
  if (pad > 0) text = Buffer.concat([text, Buffer.alloc(pad, 0x20)])
  const header = Buffer.alloc(20)
  header.write('glTF', 0, 'ascii')
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(20 + text.length + rest.length, 8)
  header.writeUInt32LE(text.length, 12)
  header.writeUInt32LE(JSON_CHUNK, 16)
  return Buffer.concat([header, text, rest])
}

// Кит юнитов собирается отдельно (`npm run assets:unit`) и пакуется, только
// если он есть: исходники Mixamo в репозитории не лежат.
const KITS = process.argv.length > 2 ? process.argv.slice(2) : ['character-kit', 'env-kit', 'unit-kit', 'gun-kit']

for (const name of KITS) {
  const src = `public/models/${name}.glb`
  if (!existsSync(src)) {
    console.log(`  ${name}: нет файла, пропуск`)
    continue
  }
  const tmp = `public/models/${name}.packed.glb`
  const before = statSync(src).size
  const raw = split(readFileSync(src)).json
  execFileSync(process.execPath, [gltfpack, '-i', src, '-o', tmp, '-cc', '-kn', '-km', '-ke'], { stdio: 'inherit' })
  const packed = split(readFileSync(tmp))
  unlinkSync(tmp)

  const extras = new Map((raw.animations ?? []).map((a) => [a.name, a.extras]))
  for (const anim of packed.json.animations ?? []) {
    const e = extras.get(anim.name)
    if (e !== undefined) anim.extras = e
  }

  writeFileSync(src, join(packed.json, packed.rest))
  const after = statSync(src).size
  console.log(`  ${name}: ${(before / 1024).toFixed(0)} → ${(after / 1024).toFixed(0)} КБ`)
}
