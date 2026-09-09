import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    // Отчёт по размеру нужен честный: бюджет загрузки проверяется скриптом после сборки.
    reportCompressedSize: true,
  },
  worker: {
    format: 'es',
  },
})
