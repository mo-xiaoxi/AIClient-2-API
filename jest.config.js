export default {
  testEnvironment: 'node',
  transform: {
    '^.+\\.(js|mjs)$': 'babel-jest',
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(uuid|@bufbuild)/)', // ESM modules that need to be transformed
    '/src/utils/tls-sidecar\\.js$', // keep native import.meta.url (babel import-meta plugin breaks under Jest ESM)
  ],
  globals: {
    'jest': {
      useESM: true
    }
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  testMatch: [
    '**/tests/**/*.test.js'
  ],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/**/*.test.js',
    '!**/node_modules/**',
    '!src/core/master.js',
    '!src/utils/tls-sidecar.js',
    '!src/scripts/**',
    '!src/convert/convert-old.js',
    '!src/providers/cursor/proto/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  testTimeout: 30000, // Add a global test timeout
  testPathIgnorePatterns: [
    '/node_modules/',
    '/tests/live/',
    '/\\.claude/worktrees/',
  ],
};