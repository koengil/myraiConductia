import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

// Issue #50: proves the legal hold guarantees by running the canonical SQL probe
// (supabase/tests/legal_hold.sql) against a real Postgres.
//
// OPT-IN ONLY: skipped unless RUN_DB_TESTS=1, so CI (mocked, no DB) and normal local
// `npm test` runs are unaffected — and it can never fire against the live DB by accident.
// To run it (after the migration is applied to the target DB):
//   RUN_DB_TESTS=1 DATABASE_URL=postgres://... npm test
//
// Future: flip this into a permanent DB-test lane (pgTAP / Postgres-in-CI) so it always
// runs — tracked by the DB-test-capability follow-up.
const RUN = process.env.RUN_DB_TESTS === '1';

describe.skipIf(!RUN)('legal hold (#50)', () => {
  it('blocks deal/document delete under hold and audits place/lift (verify.sql exits 0)', () => {
    const db = process.env.DATABASE_URL;
    expect(db, 'DATABASE_URL must be set when RUN_DB_TESTS=1').toBeTruthy();
    expect(() =>
      execFileSync(
        'psql',
        [db!, '-v', 'ON_ERROR_STOP=1', '-f', 'supabase/tests/legal_hold.sql'],
        { stdio: 'pipe' },
      ),
    ).not.toThrow();
  });
});
