#!/usr/bin/env node
/**
 * Бюджет начальной загрузки.
 *
 * Порог проверяется автоматически при сборке, иначе он уползает незаметно.
 */
import { gzipSync } from 'node:zlib'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Килобайт по сети на весь начальный чанк. Техплан: 0,5–0,8 МБ на всю игру.
 * 400 было для «Ржавого»; срез «Перестрелка» добавил ~6 КБ ядра боя и
 * рендера юнитов, и порог поднят до 420 — пока всё ещё в нижней половине
 * бюджета игры.
 */
const LIMIT_KB = 420

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

/**
 * Кит юнитов грузится только в перестрелке, после старта — у него свой
 * порог, в начальную загрузку он не входит. Техплан: скелет и анимации —
 * 50–150 КБ.
 */
const LIMIT_UNIT_KB = 160
const LATE = /unit-kit\.glb$/

// Модели входят в начальную загрузку наравне с кодом: их вес уползает так же
// незаметно, а в бюджете техплана они отдельная строка.
const files = walk('dist').filter((f) => /\.(js|css|html|glb)$/.test(f))
let total = 0
let late = 0
const rows = []
for (const f of files) {
  const kb = gzipSync(readFileSync(f)).length / 1024
  if (LATE.test(f)) late += kb
  else total += kb
  rows.push([f, kb])
}

rows.sort((a, b) => b[1] - a[1])
for (const [f, kb] of rows) console.log(`  ${kb.toFixed(1).padStart(7)} КБ  ${f}${LATE.test(f) ? '  (позже, в перестрелке)' : ''}`)
console.log(`  ${total.toFixed(1).padStart(7)} КБ  начальная загрузка (gzip), порог ${LIMIT_KB} КБ`)
if (late > 0) console.log(`  ${late.toFixed(1).padStart(7)} КБ  кит юнитов, порог ${LIMIT_UNIT_KB} КБ`)

if (late > LIMIT_UNIT_KB) {
  console.error(`\nКит юнитов тяжелее порога: ${late.toFixed(1)} КБ > ${LIMIT_UNIT_KB} КБ`)
  process.exit(1)
}
if (total > LIMIT_KB) {
  console.error(`\nБюджет загрузки превышен: ${total.toFixed(1)} КБ > ${LIMIT_KB} КБ`)
  process.exit(1)
}
