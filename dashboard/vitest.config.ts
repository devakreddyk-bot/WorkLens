import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The dashboard's test setup.
 *
 * # Why the tests are node-environment and there is no jsdom
 *
 * What is tested here is the logic the pages depend on, not the pages: calendar arithmetic, the
 * band's geometry, session decoding, and the Server Actions' error mapping. Every one of those is a
 * pure function or a function whose only impurity is `fetch`, and none of them needs a DOM.
 *
 * Rendering tests would need jsdom, `@testing-library/react`, and — for Server Components, which is
 * what most of these pages are — a React canary the testing library does not properly support yet.
 * The result would be a large dependency surface testing mostly React rather than WorkLens. The
 * things that would actually break a timesheet are arithmetic, and arithmetic is tested directly.
 *
 * `next build` is the check that the components compile and render; it runs in CI on every push.
 */
export default defineConfig({
  resolve: {
    // The `@/` alias mirrors tsconfig.json's paths. Vitest does not read tsconfig for this.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    isolate: true,
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      // Only the modules these tests are actually about. Including src/app and src/components
      // would report a coverage figure for React code no test here exercises, which is a number
      // that misleads rather than informs.
      include: [
        'src/lib/action-support.ts',
        'src/lib/band.ts',
        'src/lib/dates.ts',
        'src/lib/format.ts',
        'src/lib/session.ts',
      ],
      thresholds: {
        // The band's geometry and the calendar arithmetic are where a bug produces a wrong
        // timesheet that looks right, so they are held to a high bar deliberately.
        'src/lib/band.ts': { statements: 95, branches: 90, functions: 100, lines: 95 },
        'src/lib/dates.ts': { statements: 95, branches: 90, functions: 100, lines: 95 },
      },
    },
  },
});
