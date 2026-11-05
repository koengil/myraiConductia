// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { migrationIsCurrent, pgbossMigrationSql, stripTransactionWrapper } from '../scripts/pgboss-migration';

// The pgboss schema migration is generated from the pinned pg-boss's
// construction plan (design Q2). Bumping pg-boss without regenerating (or,
// for an upgrade, adding a migration from getMigrationPlans) turns this red,
// because the worker runs with migrate: false and would refuse the schema.
describe('the pg-boss schema migration', () => {
  it('matches the construction plan of the installed pg-boss', async () => {
    expect(await migrationIsCurrent()).toBe(true);
  });

  it('drops only the plan\'s own transaction wrapper, and guards a replay', () => {
    const plan = 'BEGIN;\n    SET LOCAL lock_timeout = 30000;\nCREATE SCHEMA IF NOT EXISTS pgboss;\nCOMMIT;';
    expect(stripTransactionWrapper(plan)).toBe('CREATE SCHEMA IF NOT EXISTS pgboss;');
    const sql = pgbossMigrationSql(plan, '0.0.0');
    expect(sql).toContain("if to_regclass('pgboss.version') is not null then");
    expect(sql).toContain('revoke all on schema pgboss from public, anon, authenticated;');
    expect(sql).not.toMatch(/^\s*COMMIT;/m);
  });
});
