/**
 * Single source of ESLint truth for the monorepo. Each package's `lint` script
 * runs `eslint` from its own directory; ESLint walks up to this file. Plugins
 * resolve against the repo-root node_modules where they are installed.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  env: { node: true, es2022: true, jest: true },
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'build/',
    '.next/',
    'coverage/',
    '.turbo/',
    '.expo/',
    '**/*.js',
    '**/*.cjs',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
  },
  overrides: [
    {
      files: ['**/*.test.ts', '**/*.spec.ts', '**/*.e2e-spec.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
      },
    },
    {
      files: ['apps/api/**/*.ts'],
      rules: {
        // NestJS DI relies on classes that may look "extraneous" to the linter.
        '@typescript-eslint/no-extraneous-class': 'off',
      },
    },
    {
      // The poker engine must stay pure: no framework, DB, transport, or UI.
      files: ['packages/poker-engine/src/**/*.ts'],
      excludedFiles: ['**/*.test.ts', '**/*.spec.ts', '**/testkit/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              '@nestjs/*',
              '@prisma/*',
              'prisma',
              '@river/*',
              'react',
              'react-native',
              'react-dom',
              'socket.io',
              'socket.io-client',
              'express',
              'ioredis',
              'zod',
              '@tanstack/*',
              'zustand',
            ],
          },
        ],
      },
    },
    {
      files: ['apps/mobile/**/*.{ts,tsx}'],
      env: { browser: true, node: true },
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  ],
};
