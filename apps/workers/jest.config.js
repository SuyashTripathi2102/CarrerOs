/** Minimal ts-jest setup for pure adapter/mapping unit tests. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { isolatedModules: true }],
  },
  moduleNameMapper: {
    '^@careeros/shared$': '<rootDir>/../../packages/shared/src',
  },
};
