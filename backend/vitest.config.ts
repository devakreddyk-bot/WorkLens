import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Handlers read configuration at module load, so each test file gets a fresh module
    // registry rather than inheriting whatever the previous file's env left behind.
    isolate: true,
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      // Thin AWS-SDK wrappers and type-only modules are excluded: covering them measures
      // the mock, not the code.
      exclude: ['src/**/*.d.ts', 'src/shared/types/**'],
      thresholds: {
        // The aggregation rollup and the auth middleware are the two places where a bug
        // is expensive, and both are pure functions with no excuse for gaps.
        'src/aggregation/rollup.ts': { statements: 95, branches: 90, functions: 100, lines: 95 },
        'src/middleware/**': { statements: 90, branches: 85, functions: 95, lines: 90 },
      },
    },
  },
});
