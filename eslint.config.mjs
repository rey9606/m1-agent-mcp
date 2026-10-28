import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const tsFiles = ['**/*.{ts,mts,cts}'];

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.tmp/**', 'fixtures/**'],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...js.configs.recommended,
    languageOptions: {
      ...js.configs.recommended.languageOptions,
      globals: globals.node,
    },
  },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: tsFiles })),
  {
    files: tsFiles,
    rules: {
      // Parámetros intencionalmente ignorados (p. ej. firmas de interfaces).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'smart'],
      'no-eval': 'error',
      '@typescript-eslint/no-implied-eval': 'error',
      'no-new-func': 'error',
      'prefer-const': 'error',
    },
  },
  {
    // Arquitectura: el core no puede depender de la capa CLI.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/cli/**', '../cli/*', '../../cli/*'],
              message: 'src/core no puede importar desde la capa CLI (invertí la dependencia).',
            },
          ],
        },
      ],
    },
  },
);
