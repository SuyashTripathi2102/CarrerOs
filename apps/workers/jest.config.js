/** Workers had specs (jooble.spec.ts) but no runner, so they never executed.
 *  Adapter logic is pure and worth guarding — this wires them into `npm test`. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    // 151002: tsconfig uses nodenext module resolution (pinned deliberately —
    // see PROJECT_LOG); harmless under ts-jest, so don't shout about it.
    '^.+\\.ts$': [
      'ts-jest',
      { tsconfig: '<rootDir>/../tsconfig.json', diagnostics: { ignoreCodes: [151002] } },
    ],
  },
  moduleFileExtensions: ['js', 'json', 'ts'],
};
