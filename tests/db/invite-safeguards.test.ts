import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === '1';
const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!RUN_DB_TESTS)('invite safeguard database invariants', () => {
  it('passes the transactional SQL probe', () => {
    expect(DATABASE_URL, 'DATABASE_URL is required when RUN_DB_TESTS=1').toBeTruthy();

    const output = execFileSync(
      'psql',
      [DATABASE_URL!, '-v', 'ON_ERROR_STOP=1', '-f', resolve('supabase/tests/invite_safeguards.sql')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );

    expect(output).toContain('ROLLBACK');
  });
});
