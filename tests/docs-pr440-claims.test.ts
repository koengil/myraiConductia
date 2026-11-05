// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('#440 documentation claims', () => {
  const log = read('docs/07-decisions/decision-log.md');
  const adr = read('docs/07-decisions/ADR-0017-hybrid-data-residency.md');

  it('holds the extraction decision as D94 and keeps every D-number unique', () => {
    const ids = [...log.matchAll(/^\| (D\d+) \|/gm)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    const row = log.split('\n').find((l) => l.startsWith('| D94 |')) ?? '';
    expect(row).toContain('bounded by its own estimate');
    expect(log.split('\n').find((l) => l.startsWith('| D85 |')) ?? '').toContain('Recipient colours');
    expect(row).not.toMatch(/arrives with #432/);
  });

  it('grants the budget reservation RPCs, not direct update, and carries no stale #432 wording', () => {
    expect(adr).toContain('`discovery_extract_reserve`');
    expect(adr).toContain('`discovery_extract_settle`');
    expect(adr).not.toContain('inflight_since)');
    expect(adr).not.toMatch(/arrives with #432/);
  });
});
