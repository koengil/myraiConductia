import { describe, expect, it } from 'vitest';

import { parseReviewerOutput, parseVerdicts } from '../../scripts/ai-review/findings';

const good = {
  id: 'f1',
  lens: 'governance',
  file: 'src/lib/api/v1/access.ts',
  line: 12,
  severity: 'major',
  claim: 'Route skips the deal predicate.',
  evidence: 'access.ts:12 returns before canAccessDeal.',
};

describe('parseReviewerOutput', () => {
  it('accepts a valid output and an empty one', () => {
    expect(parseReviewerOutput({ lens: 'governance', findings: [good] }).findings[0].id).toBe('f1');
    expect(parseReviewerOutput({ lens: 'generalist', findings: [] }).findings).toEqual([]);
  });

  it('keeps the optional check', () => {
    const out = parseReviewerOutput({ lens: 'governance', findings: [{ ...good, check: 'rg canAccessDeal' }] });
    expect(out.findings[0].check).toBe('rg canAccessDeal');
  });

  it.each([
    ['non-object', 'text'],
    ['unknown lens', { lens: 'style', findings: [] }],
    ['findings missing', { lens: 'generalist' }],
    ['bad severity', { lens: 'generalist', findings: [{ ...good, severity: 'critical' }] }],
    ['fractional line', { lens: 'generalist', findings: [{ ...good, line: 1.5 }] }],
    ['empty claim', { lens: 'generalist', findings: [{ ...good, claim: ' ' }] }],
    ['non-string check', { lens: 'generalist', findings: [{ ...good, check: 4 }] }],
    ['duplicate ids', { lens: 'generalist', findings: [good, good] }],
  ])('throws on %s', (_name, input) => {
    expect(() => parseReviewerOutput(input)).toThrow(/ai-review: invalid/);
  });
});

describe('parseVerdicts', () => {
  it('accepts an array or a wrapped array', () => {
    const v = { id: 'f1', verdict: 'confirmed', evidence: 'access.ts:12' };
    expect(parseVerdicts([v])).toEqual([v]);
    expect(parseVerdicts({ verdicts: [v] })).toEqual([v]);
  });

  it('throws on an unknown verdict or missing evidence', () => {
    expect(() => parseVerdicts([{ id: 'f1', verdict: 'maybe', evidence: 'x' }])).toThrow(/verdict/);
    expect(() => parseVerdicts([{ id: 'f1', verdict: 'rejected' }])).toThrow(/evidence/);
    expect(() => parseVerdicts('nope')).toThrow(/verdicts/);
  });
});
