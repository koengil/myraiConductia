import { describe, expect, it } from 'vitest';

import { decide } from '../../scripts/ai-review/decide';
import type { Finding, Severity } from '../../scripts/ai-review/findings';

const finding = (severity: Severity, id = severity): Finding => ({
  id,
  lens: 'generalist',
  file: 'src/a.ts',
  line: 3,
  severity,
  claim: 'c',
  evidence: 'e',
});

describe('decide', () => {
  it('passes with no findings and no fence', () => {
    const d = decide({ route: { fenced: [] }, findings: [] });
    expect(d).toMatchObject({ conclusion: 'success', needsHuman: false, reasons: [] });
  });

  it('fails and asks for a human on a blocking finding', () => {
    const d = decide({ route: { fenced: [] }, findings: [finding('blocking'), finding('major')] });
    expect(d.conclusion).toBe('failure');
    expect(d.needsHuman).toBe(true);
    expect(d.reasons).toHaveLength(1);
    expect(d.summary).toContain('blocking: 1 | major: 1 | minor: 0 | nit: 0');
  });

  it('passes but asks for a human when a fenced file changed', () => {
    const d = decide({ route: { fenced: ['src/middleware.ts'] }, findings: [finding('major')] });
    expect(d.conclusion).toBe('success');
    expect(d.needsHuman).toBe(true);
    expect(d.summary).toContain('`src/middleware.ts`');
  });

  it('does not escalate on major findings alone', () => {
    const d = decide({ route: { fenced: [] }, findings: [finding('major'), finding('minor')] });
    expect(d.needsHuman).toBe(false);
  });

  it('writes no em-dashes', () => {
    const d = decide({ route: { fenced: ['a'] }, findings: [finding('blocking')] });
    expect(d.summary + d.reasons.join('')).not.toContain('—');
  });
});
