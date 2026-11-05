import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

const RUN = process.env.RUN_DB_TESTS === '1';

describe.skipIf(!RUN)('project rail model', () => {
  it('holds the project-owned structure and its structural functions', () => {
    const db = process.env.DATABASE_URL;
    expect(db, 'DATABASE_URL must be set when RUN_DB_TESTS=1').toBeTruthy();
    expect(() =>
      execFileSync(
        'psql',
        [db!, '-v', 'ON_ERROR_STOP=1', '-f', 'supabase/tests/project_rail.sql'],
        { stdio: 'pipe' },
      ),
    ).not.toThrow();
  });
});
