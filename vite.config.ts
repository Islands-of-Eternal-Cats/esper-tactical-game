import { writeFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { defineConfig, type Plugin } from 'vite'

/**
 * `import data from './x.yaml'` — объект в бандле. Десять строк вместо
 * плагина: типы @rollup/plugin-yaml не сходятся с vite при exactOptionalPropertyTypes.
 */
function yaml(): Plugin {
  return {
    name: 'yaml',
    transform(code, id) {
      if (!id.endsWith('.yaml')) return null
      return { code: `export default ${JSON.stringify(load(code))}`, map: null }
    },
  }
}

/**
 * Приёмник листа состояний (`SceneView.sheet()` в dev): страница шлёт JPEG
 * POST-ом на /__sheet, сервер кладёт его в assets/sheet.jpg. Только dev.
 */
function sheetSink(): Plugin {
  return {
    name: 'sheet-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__sheet', (req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          writeFileSync('assets/sheet.jpg', Buffer.concat(chunks))
          res.end('assets/sheet.jpg')
        })
      })
    },
  }
}

export default defineConfig({
  base: './',
  // Характеристики оружия лежат в YAML: правятся без кода, попадают в бандл как объект.
  plugins: [yaml(), sheetSink()],
  build: {
    target: 'es2022',
    // Отчёт по размеру нужен честный: бюджет загрузки проверяется скриптом после сборки.
    reportCompressedSize: true,
  },
  worker: {
    format: 'es',
    plugins: () => [yaml()],
  },
})
