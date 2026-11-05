import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('client company default roles', () => {
  it('does not seed roles on lead insert; seeds them on first invite or member', () => {
    const result = spawnSync(
      'psql',
      [
        DATABASE_URL!,
        '-v',
        'ON_ERROR_STOP=1',
        '-f',
        resolve('supabase/tests/client_company_default_roles.sql'),
      ],
      { encoding: 'utf8' },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout + result.stderr).toContain('PASS client company default roles');
  });
});
