/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.(test|spec).ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/index.ts'],
  coverageThreshold: {
    // Raised aggressively as the engine is implemented (Phases 3-4).
    global: { branches: 60, functions: 60, lines: 60, statements: 60 },
  },
  clearMocks: true,
};
