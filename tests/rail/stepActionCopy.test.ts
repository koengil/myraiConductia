import { describe, expect, it } from 'vitest';

import {
  draftActionLabel,
  draftPlainLine,
  openDraftLabel,
} from '@/components/rail/stepActionCopy';
import { MD_BRIEFING_STEP_ID, TEASER_STEP_ID } from '@/lib/rail/dealRail';

describe('step draft copy', () => {
  it('names the output where the step has a known one', () => {
    expect(draftActionLabel(TEASER_STEP_ID, 'Teaser')).toBe('Draft the teaser');
    expect(draftActionLabel(MD_BRIEFING_STEP_ID, 'MD Briefing + Company Backgrounding')).toBe(
      'Draft the MD brief',
    );
  });

  it("names the step's skill everywhere else, never 'Draft this step'", () => {
    expect(draftActionLabel('p3-s45', 'Buyer NDA')).toBe('Draft with the Buyer NDA skill');
    expect(openDraftLabel('p3-s45', 'Buyer NDA')).toBe('Draft with the Buyer NDA skill…');
  });

  it('says what Conductia does and what the banker does, in plain words', () => {
    expect(draftPlainLine(TEASER_STEP_ID, 'Teaser')).toBe(
      'Conductia drafts the teaser. You review and sign off.',
    );
    for (const line of [
      draftPlainLine(TEASER_STEP_ID, 'Teaser'),
      draftPlainLine(MD_BRIEFING_STEP_ID, 'MD Briefing'),
      draftPlainLine('p3-s45', 'Buyer NDA'),
    ]) {
      expect(line).not.toMatch(/orchestration|spine|agent|Ignatious|—/i);
    }
  });
});
