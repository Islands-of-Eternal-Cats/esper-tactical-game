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

export default defineConfig({
  base: './',
  // Характеристики оружия лежат в YAML: правятся без кода, попадают в бандл как объект.
  plugins: [yaml()],
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
