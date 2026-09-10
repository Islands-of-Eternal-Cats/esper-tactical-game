#!/usr/bin/env node
/**
 * Бюджет начальной загрузки.
 *
 * Порог проверяется автоматически при сборке, иначе он уползает незаметно.
 */
import { gzipSync } from 'node:zlib'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Килобайт по сети на весь начальный чанк. Техплан: 0,5–0,8 МБ на всю игру. */
const LIMIT_KB = 400

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

// Модели входят в начальную загрузку наравне с кодом: их вес уползает так же
// незаметно, а в бюджете техплана они отдельная строка.
const files = walk('dist').filter((f) => /\.(js|css|html|glb)$/.test(f))
let total = 0
const rows = []
for (const f of files) {
  const kb = gzipSync(readFileSync(f)).length / 1024
  total += kb
  rows.push([f, kb])
}

rows.sort((a, b) => b[1] - a[1])
for (const [f, kb] of rows) console.log(`  ${kb.toFixed(1).padStart(7)} КБ  ${f}`)
console.log(`  ${total.toFixed(1).padStart(7)} КБ  всего (gzip), порог ${LIMIT_KB} КБ`)

if (total > LIMIT_KB) {
  console.error(`\nБюджет загрузки превышен: ${total.toFixed(1)} КБ > ${LIMIT_KB} КБ`)
  process.exit(1)
}
