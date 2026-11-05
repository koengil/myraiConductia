import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * Integration suite (#27) — real route handlers against a REAL Postgres
 * (local `supabase start` stack in CI, or the -dev project via .env.local).
 * Kept out of the default `npm test` run: it needs a database and network,
 * and the unit suite must stay fast and hermetic.
 *
 * Run: npm run test:integration  (requires NEXT_PUBLIC_SUPABASE_URL +
 * SUPABASE_SECRET_KEY in the environment).
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 90_000,
    // One file, sequential — the flow is a single story against one DB.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
