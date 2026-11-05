import { describe, expect, it } from 'vitest';

import { applyKeyed } from '@/lib/conductia/intel';
import { canonicalizeText, contentHashOf } from '@/lib/conductia/documents';

describe('applyKeyed', () => {
  it('upserts by key and removes named keys', () => {
    const next = applyKeyed(
      [{ key: 'p:dylan', text: 'old' }, { key: 'p:gone', text: 'drop' }],
      {
        upsert: [{ key: 'p:dylan', text: 'new', decisionRole: 'decision_maker' }],
        remove: [{ key: 'p:gone' }],
      },
    );
    expect(next).toEqual([
      { key: 'p:dylan', text: 'new', decisionRole: 'decision_maker' },
    ]);
  });
});

describe('document canonicalization', () => {
  it('normalizes line endings and hashes sha256', () => {
    const text = canonicalizeText('Hello\r\nDylan Field\r');
    expect(text).toBe('Hello\nDylan Field\n');
    expect(contentHashOf(text)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
