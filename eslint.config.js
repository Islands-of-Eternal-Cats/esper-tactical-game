import tseslint from 'typescript-eslint'

/**
 * Границы модулей — правило линтера, а не договорённость.
 * Нарушение появляется тихо и всплывает через полгода как рассинхрон.
 */
export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['**/render/*', '**/ui/*', '**/worker/*', 'three', 'three/*'],
            message: 'core не знает про DOM, three и рендер: только shared.' },
        ],
      }],
    },
  },
  {
    files: ['src/render/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['**/ui/*', '**/core/*'],
            message: 'render читает снапшот и ничего не меняет; ядро — только через воркер.' },
        ],
      }],
    },
  },
  {
    files: ['src/ui/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['**/render/*', '**/core/*', 'three', 'three/*'],
            message: 'ui не знает про render и ядро.' },
        ],
      }],
    },
  },
  {
    files: ['src/main.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['**/core/*'],
            message: 'главный поток не импортирует core напрямую — только через воркер.' },
        ],
      }],
    },
  },
)
