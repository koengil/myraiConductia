import { describe, expect, it } from 'vitest';
import { LIFECYCLE_CATEGORIES } from '@/lib/constants/deals';
import { confidentialSubject, requiresConfidential, threadSubject } from '@/lib/mail/confidential';
describe('Confidential subject', () => {
  it.each(LIFECYCLE_CATEGORIES)('uses authoritative category %s', (category) => {
    expect(requiresConfidential(category)).toBe(['live', 'pitch'].includes(category));
  });
  it('marks once and preserves manual labels', () => {
    expect(confidentialSubject('Process update', true)).toBe('[Confidential] Process update');
    expect(confidentialSubject('[Confidential] Process update', true)).toBe('[Confidential] Process update');
    expect(confidentialSubject('[confidential] Process update', false)).toBe('[confidential] Process update');
    expect(confidentialSubject('Re: Process update', true)).toBe('[Confidential] Re: Process update');
  });
  it('keeps one leading label across a reply thread, however it comes back', () => {
    expect(confidentialSubject('Re: [Confidential] Process update', true)).toBe('[Confidential] Re: Process update');
    expect(confidentialSubject('[Confidential] Re: [Confidential] Process update', true)).toBe('[Confidential] Re: Process update');
    expect(confidentialSubject('Fwd: RE: [CONFIDENTIAL] Process update', true)).toBe('[Confidential] Fwd: RE: Process update');
    expect(confidentialSubject('[Confidential]Process update', true)).toBe('[Confidential]Process update');
    expect(confidentialSubject('[Confidentiality] notice', true)).toBe('[Confidential] [Confidentiality] notice');
  });
  it('is idempotent, so the first and the token-carrying call bind the same subject', () => {
    for (const subject of ['Process update', 'Re: [Confidential] x', '[CONFIDENTIAL] x', '[Confidential] [Confidential] x', 'Fw: Re: x', '']) {
      const once = confidentialSubject(subject, true);
      expect(confidentialSubject(once, true)).toBe(once);
    }
  });
  it('threads a reply or forward without doubling the prefix behind a label', () => {
    expect(threadSubject('Process update', 'Re')).toBe('Re: Process update');
    expect(threadSubject('Re: Process update', 'Re')).toBe('Re: Process update');
    expect(threadSubject('[Confidential] Process update', 'Re')).toBe('[Confidential] Re: Process update');
    expect(threadSubject('[Confidential] Re: Process update', 'Re')).toBe('[Confidential] Re: Process update');
    expect(threadSubject('[Confidential] Re: Process update', 'Fw')).toBe('[Confidential] Fw: Re: Process update');
  });
});
