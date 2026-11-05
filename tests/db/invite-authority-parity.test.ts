import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * create_invite re-derives invitation authority and seat shape inside the write
 * transaction, which makes it a second implementation of rules that also live
 * in src/lib/api/v1/proposalFeasibility.ts. Two implementations of one rule
 * drift, and the drift is silent: the route would keep answering correctly
 * while the write did something else.
 *
 * So the SQL side is pinned to the same case table the TypeScript side is
 * pinned to in tests/invite-authority-parity.test.ts. Both assert the RESOLVED
 * outcome (which company role was actually stored, which phase was granted),
 * not merely that a call was refused, so a build that refuses for the wrong
 * reason cannot pass either half.
 *
 * The probes report PASS with `raise notice`, which psql writes to STDERR, while
 * the ROLLBACK command tag goes to stdout. Each probe is therefore run through
 * `runProbe`, which requires a zero exit status and reads both streams.
 *
 * Requires a database, like the other tests/db probes:
 *   RUN_DB_TESTS=1 DATABASE_URL=... npx vitest run tests/db/invite-authority-parity.test.ts
 */
const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const DATABASE_URL = process.env.DATABASE_URL;

/** Runs one psql probe; returns stdout and stderr joined, after asserting a clean exit. */
function runProbe(file: string): string {
  expect(DATABASE_URL, 'DATABASE_URL is required when RUN_DB_TESTS=1').toBeTruthy();
  const result = spawnSync(
    'psql',
    [DATABASE_URL!, '-v', 'ON_ERROR_STOP=1', '-f', resolve(file)],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  expect(result.error, `psql failed to start: ${result.error?.message}`).toBeUndefined();
  const output = `${result.stdout}\n${result.stderr}`;
  expect(result.status, `psql exited ${result.status}:\n${output}`).toBe(0);
  return output;
}

describe.skipIf(!RUN_DB_TESTS)('invite authority parity (SQL side)', () => {
  it('resolves every authority case the way proposalFeasibility does', () => {
    const output = runProbe('supabase/tests/invite_authority_parity.sql');

    expect(output).toContain('PASS: invite authority parity');
    expect(output).toContain('ROLLBACK');
  });
});

describe.skipIf(!RUN_DB_TESTS)('acceptance grants the confirmed phase', () => {
  it('keeps the verification gate and grants the phase that was confirmed', () => {
    const output = runProbe('supabase/tests/invite_phase_accept.sql');

    expect(output).toContain('PASS: acceptance grants the confirmed phase');
    expect(output).toContain('ROLLBACK');
  });
});

describe.skipIf(!RUN_DB_TESTS)('rollback containment', () => {
  it('expires only nonzero pending invitations, audits them, and blocks acceptance', () => {
    const output = runProbe('supabase/tests/invite_phase_rollback.sql');

    expect(output).toContain('PASS: rollback containment');
    expect(output).toContain('ROLLBACK');
  });
});
