// Web app tests: Next's own Jest preset (SWC transform, CSS stubs) plus a
// browser-like DOM. Tests live in __tests__/ so the production build never
// type-checks or bundles them.
import nextJest from 'next/jest.js';

const createJestConfig = nextJest({ dir: './' });

/** @type {import('jest').Config} */
const config = {
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.tsx'],
  testMatch: ['<rootDir>/__tests__/**/*.test.tsx'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
};

export default createJestConfig(config);
