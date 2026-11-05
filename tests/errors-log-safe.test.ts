// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { safeLogId } from '@/lib/errors/logSafe';

describe('safeLogId', () => {
  it.each(['md-briefing', 'run_1', 'FALCO-2026-100', '3f2c9a1e-0b7d-4c1a-9e55-2a6f0c1d7b10', 'a.b:c-d_e'])(
    'keeps the identifier-shaped value %s',
    (value) => {
      expect(safeLogId(value)).toBe(value);
    },
  );

  it.each([
    'CANARY-331 mailbox text',
    'Dylan Field',
    'a/b',
    'x'.repeat(65),
    '',
    '<script>',
    'line\nbreak',
  ])('replaces %j with invalid', (value) => {
    expect(safeLogId(value)).toBe('invalid');
  });

  it('keeps a 64-character identifier and replaces a missing value', () => {
    expect(safeLogId('x'.repeat(64))).toBe('x'.repeat(64));
    expect(safeLogId(null)).toBe('invalid');
    expect(safeLogId(undefined)).toBe('invalid');
  });
});
