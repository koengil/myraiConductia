// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A big table (supabase/lint/big-tables.txt) is never left without an index it relies on, and never waits on an
// ACCESS EXCLUSIVE lock for one: an index on it is dropped only concurrently, alone in its file, and a replaced
// index only after its replacement is built and checked valid (#173 G-07 audit S1).

const DIR = join(process.cwd(), 'supabase/migrations');
const files = readdirSync(DIR)
  .filter((n) => n.endsWith('.sql'))
  .sort();
const sqlOf = (name: string) =>
  readFileSync(join(DIR, name), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
const bigTables = new Set(
  readFileSync(join(process.cwd(), 'supabase/lint/big-tables.txt'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#')),
);

/** Each index name created on a big table, from every migration. */
const bigIndexes = new Set<string>();
for (const name of files) {
  const re = /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(\w+)\s+on\s+(?:only\s+)?(?:public\.)?(\w+)/gi;
  for (const m of sqlOf(name).matchAll(re)) if (bigTables.has(m[2])) bigIndexes.add(m[1]);
}

const statements = (sql: string) =>
  sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

describe('an index on a big table is dropped safely', () => {
  it('knows the latest-row indexes of stage_assessments', () => {
    expect(bigIndexes.has('stage_assessments_latest_idx')).toBe(true);
    expect(bigIndexes.has('stage_assessments_audience_latest_idx')).toBe(true);
  });

  it('drops one only concurrently, and alone in its file', () => {
    const problems: string[] = [];
    for (const name of files) {
      const stmts = statements(sqlOf(name));
      for (const st of stmts) {
        const m = /^drop\s+index\s+(concurrently\s+)?(?:if\s+exists\s+)?(?:public\.)?(\w+)/i.exec(st);
        if (!m || !bigIndexes.has(m[2])) continue;
        if (!m[1]) problems.push(`${name}: drops ${m[2]} without concurrently`);
        else if (stmts.length > 1) problems.push(`${name}: drops ${m[2]} concurrently beside other statements`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('drops the old stage_assessments latest-row index only after its per-audience replacement is built and checked valid', () => {
    const indexOf = (test: (sql: string) => boolean) => files.findIndex((n) => test(sqlOf(n)));
    const built = indexOf((s) => /create\s+index\s+concurrently\s+if\s+not\s+exists\s+stage_assessments_audience_latest_idx\b/i.test(s));
    const checked = indexOf((s) => /stage_assessments_audience_latest_idx'::regclass\s+and\s+indisvalid/i.test(s));
    const dropped = indexOf((s) => /drop\s+index\s+concurrently\s+if\s+exists\s+stage_assessments_latest_idx\b/i.test(s));
    expect(built).toBeGreaterThanOrEqual(0);
    expect(checked).toBeGreaterThan(built);
    expect(dropped).toBeGreaterThan(checked);
  });
});
