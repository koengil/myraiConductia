import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// The integration suite needs a real database — it runs via
// `npm run test:integration` (vitest.integration.config.ts), never here.
// The eval harness is its own package with its own runner
// (`npm --prefix evals/deal-discovery test`).
// Spread the defaults: a bare `exclude` REPLACES them (node_modules,
// dist, .git, ...), it does not extend them.
const exclude = [...configDefaults.exclude, 'tests/integration/**', 'evals/**'];

// A .test.ts runs without a DOM unless it is listed here; a .test.tsx always
// gets one.
const TS_TESTS_THAT_NEED_A_DOM = [
  'tests/deal-rail.test.ts',
  'tests/email-workbench.test.ts',
  'tests/inflight-read.test.ts',
  'tests/mail-format-sanitize.test.ts',
  'tests/onboarding-e2e.test.ts',
  'tests/skill-authoring-enhancement-basis.test.ts',
  'tests/skill-authoring-hook.test.ts',
];

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // The census renders (full rail, 65-skill library) take 3s+ on their own;
    // the 5s default cuts them off once the runner is under parallel load.
    testTimeout: 15000,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
          exclude: [...exclude, ...TS_TESTS_THAT_NEED_A_DOM],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
          include: ['tests/**/*.test.tsx', 'src/**/*.test.tsx', ...TS_TESTS_THAT_NEED_A_DOM],
          exclude,
        },
      },
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
