import globals from 'globals'
import pluginJs from '@eslint/js'
import tseslint from 'typescript-eslint'
import noCatchAll from 'eslint-plugin-no-catch-all'

const ROOT_WRAPPER_MODULES = [
  'config',
  'db',
  'env',
  'group-folder',
  'logger',
  'mount-security',
  'router',
  'sender-allowlist',
  'timezone',
  'types',
]

const wrapperMessage =
  'Import from the split domain modules (core/storage/platform/messaging), not root wrappers.'

export default [
  { ignores: ['node_modules/', 'dist/', 'apps/core/agents/'] },
  {
    files: [
      'apps/core/src/**/*.{js,ts}',
      'apps/core/test/**/*.{js,ts}',
      'packages/contracts/src/**/*.{js,ts}',
      'packages/contracts/test/**/*.{js,ts}',
    ],
  },
  { languageOptions: { globals: globals.node } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/core/src/**/*.{js,ts}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [`../{${ROOT_WRAPPER_MODULES.join(',')}}.js`],
              message: wrapperMessage,
            },
            {
              group: [`../apps/core/src/{${ROOT_WRAPPER_MODULES.join(',')}}.js`],
              message: wrapperMessage,
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/core/src/index.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [`./{${ROOT_WRAPPER_MODULES.join(',')}}.js`],
              message: wrapperMessage,
            },
          ],
        },
      ],
    },
  },
  {
    plugins: { 'no-catch-all': noCatchAll },
    rules: {
      'preserve-caught-error': ['error', { requireCatchParameter: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'no-catch-all/no-catch-all': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
]
