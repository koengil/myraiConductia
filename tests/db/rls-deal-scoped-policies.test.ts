import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

// #78 / #79 (D63): runs the parity probe (supabase/tests/rls_deal_scoped_policies.sql)
// against a real Postgres. The probe reads the deal tables as `authenticated` for
// two tenants and asserts that a direct /rest/v1/* read returns what the app would
// show, or less, and never another tenant's rows. It also asserts the privilege end
// state (feature_flags and the four lead/CRM tables closed to `authenticated`, the
// two skill tables service-role only, AQ-12) and lints pg_policies for tenant-blind overseer checks, after a self-test proving the
// lint can fire.
//
// OPT-IN ONLY: skipped unless RUN_DB_TESTS=1, so the mocked `verify` job and normal
// local `npm test` runs are unaffected, and it can never fire against the live DB by
// accident. CI's `integration` job runs it on a freshly started local stack:
//   RUN_DB_TESTS=1 DATABASE_URL=postgres://... npx vitest run tests/db
const RUN = process.env.RUN_DB_TESTS === '1';

const EXPECTED_PASSES = [
  'PASS: rls fixture seeded',
  "PASS: app_is_deal_overseer fences overseers by the deal's tenant",
  'PASS: deal_parties and deal_memberships',
  'PASS: app_user_is_external fails closed on an unknown caller',
  'PASS: documents: MD and same-tenant admin see 4',
  'PASS: deal_steps: internal members and same-tenant admin see 1',
  'PASS: app_actor_in_user_tenant matches same-tenant actors only',
  'PASS: audit_log: members see own rows',
  'PASS: privileges: authenticated keeps SELECT on the five deal tables',
  'PASS: skill tables: deal_step_skill_runs and deal_step_skill_bindings are service-role only',
  'PASS: overseer lint self-test',
  'PASS: overseer lint: no policy outside the allowlist',
];

describe.skipIf(!RUN)('deal-scoped RLS parity probe (#78, #79)', () => {
  it('fences overseers by tenant on the deal tables (probe exits 0 and rolls back)', () => {
    const db = process.env.DATABASE_URL;
    expect(db, 'DATABASE_URL must be set when RUN_DB_TESTS=1').toBeTruthy();

    const result = spawnSync(
      'psql',
      [db!, '-v', 'ON_ERROR_STOP=1', '-f', resolve('supabase/tests/rls_deal_scoped_policies.sql')],
      { encoding: 'utf8' },
    );
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

    // Surface the probe's verdicts in the CI log, pass or fail.
    for (const line of output.split('\n')) {
      if (/(PASS|FAIL):/.test(line)) console.log(line.trim());
    }

    expect(result.error, 'psql could not be started').toBeUndefined();
    expect(result.status, output).toBe(0);
    for (const pass of EXPECTED_PASSES) expect(output).toContain(pass);
    expect(output).toContain('ROLLBACK');
  });
});
