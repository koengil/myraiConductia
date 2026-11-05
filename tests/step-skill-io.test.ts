import { afterEach, describe, expect, it, vi } from 'vitest';

import { MANUAL_STEP_DEFS } from '@/lib/rail/manualStepDefs';
import {
  applySkillReply,
  buildStepSkillPrompt,
  filledFieldsFromWork,
  loadLeadMapsForDeal,
  PATHING_BRIEF_FIELD,
  stepSkillCopy,
} from '@/lib/ignatious/stepSkillIo';

const CHECKBOX_ONLY_STEPS = Object.values(MANUAL_STEP_DEFS)
  .filter((def) => def.fields.length > 0 && def.fields.every((field) => field.type === 'checkbox'))
  .map((def) => def.stepId);

describe('stepSkillCopy', () => {
  it('describes MD Briefing without referring to form boxes', () => {
    const copy = stepSkillCopy('p1-s9', 'MD Briefing');
    expect(copy.uses).toMatch(/MD brief and company background/i);
    expect(copy.uses).not.toMatch(/boxes above/i);
    expect(copy.uses).toMatch(/not a filed deal artifact/i);
  });
});

describe('stepSkillCopy names the draft button the way the step shows it', () => {
  it('uses the glossary labels and never "Draft this step"', () => {
    expect(stepSkillCopy('p1-s9', 'MD Briefing').idle).toBe('Choose the meeting type, then select Draft the MD brief.');
    expect(stepSkillCopy('p1-s10', 'Meeting Intelligence').idle).toContain(
      'select Draft with the Meeting Intelligence skill.',
    );
    const lead = buildStepSkillPrompt('p1-s8', 'Relationship Pathing', {});
    expect(lead.ok).toBe(false);
    if (!lead.ok) expect(lead.error).toBe(
      'This deal has no linked target company. Add the lead first, then select Draft with the Relationship Pathing skill.',
    );
  });
});

describe('stepSkillCopy on a step with nowhere to file the reply', () => {
  it('does not promise the Initial Diligence Request List a written-back reply', () => {
    const copy = stepSkillCopy('p1-s13', 'Initial Diligence Request List');
    expect(copy.uses).toMatch(/no box to file the reply into/i);
    expect(copy.applied).not.toMatch(/written onto the step/i);
  });

  it('keeps the written-back promise where a field does receive the reply', () => {
    expect(stepSkillCopy('p1-s10', 'Meeting Intelligence').applied).toMatch(/written onto the step/i);
  });
});

describe('buildStepSkillPrompt', () => {
  it('refuses Meeting Intelligence with no transcript', () => {
    const prompt = buildStepSkillPrompt('p1-s10', 'Meeting Intelligence', {});
    expect(prompt.ok).toBe(false);
    if (!prompt.ok) expect(prompt.error).toMatch(/Meeting notes/i);
  });

  it('sends the saved notes as the skill input', () => {
    const prompt = buildStepSkillPrompt('p1-s10', 'Meeting Intelligence', {
      meeting_notes: 'Buyer asked for a Q3 cohort cut.',
    });
    expect(prompt.ok).toBe(true);
    if (prompt.ok) {
      expect(prompt.message).toContain('Buyer asked for a Q3 cohort cut.');
      expect(prompt.message).toContain('Meeting notes');
    }
  });

  it('does not ask Relationship Pathing for form boxes', () => {
    const prompt = buildStepSkillPrompt('p1-s8', 'Relationship Pathing', {});
    expect(prompt.ok).toBe(false);
    if (!prompt.ok) {
      expect(prompt.error).not.toMatch(/boxes above/i);
      expect(prompt.error).toMatch(/target company/i);
    }
  });

  it('sends the target and lead maps as Relationship Pathing input', () => {
    const prompt = buildStepSkillPrompt(
      'p1-s8',
      'Relationship Pathing',
      {},
      {
        companyId: 'c1',
        companyName: 'Villa Holdings',
        stakeholders: [
          {
            name: 'Ada Lovelace',
            role_in_decision: 'decision-maker',
            stance: 'Supporter',
            investor: true,
          },
        ],
        relationships: [
          { person_name: 'Rob', relationship_type: 'prior client', strength: 'High' },
        ],
      },
    );
    expect(prompt.ok).toBe(true);
    if (prompt.ok) {
      expect(prompt.message).toContain('Villa Holdings');
      expect(prompt.message).toContain('Ada Lovelace');
      expect(prompt.message).toContain('decision-maker');
      expect(prompt.message).toContain('Rob');
      expect(prompt.message).toContain('prior client');
      expect(prompt.message).toMatch(/live deal record/i);
      expect(prompt.message).toMatch(/Do not call Conductia/i);
    }
  });
});

describe('buildStepSkillPrompt on checkbox-only steps', () => {
  it('finds the checkbox-only steps the rail actually ships', () => {
    expect(CHECKBOX_ONLY_STEPS).toEqual([
      'p1-s12',
      'p1-s13',
      'p1-s21',
      'p2-s30',
      'p2-s31',
      'p2-s37',
      'p3-s42',
      'p3-s43',
    ]);
  });

  it('drafts the Initial Diligence Request List from its ticked boxes', () => {
    const prompt = buildStepSkillPrompt('p1-s13', 'Initial Diligence Request List', {
      list_drafted: true,
      nda_confirmed: true,
      banker_reviewed: true,
      sensitive_categorized: true,
    });
    expect(prompt.ok).toBe(true);
    if (prompt.ok) {
      expect(prompt.message).toContain('Initial diligence list drafted');
      expect(prompt.message).toContain('NDA execution confirmed on record');
      expect(prompt.message).toContain('Banker reviewed before send');
      expect(prompt.message).toContain('Sensitive vs general items categorized');
    }
  });

  it('carries the step summary so a checklist prompt is not a bare bullet list', () => {
    const prompt = buildStepSkillPrompt('p1-s13', 'Initial Diligence Request List', {
      list_drafted: true,
    });
    expect(prompt.ok).toBe(true);
    if (prompt.ok) {
      expect(prompt.message).toContain(MANUAL_STEP_DEFS['p1-s13'].summary);
    }
  });

  it('leaves unticked boxes out of the prompt', () => {
    const prompt = buildStepSkillPrompt('p1-s13', 'Initial Diligence Request List', {
      list_drafted: true,
      nda_confirmed: false,
    });
    expect(prompt.ok).toBe(true);
    if (prompt.ok) expect(prompt.message).not.toContain('NDA execution confirmed on record');
  });

  it('still refuses a checkbox-only step with nothing ticked', () => {
    for (const stepId of CHECKBOX_ONLY_STEPS) {
      const empty = buildStepSkillPrompt(stepId, 'Step', {});
      expect(empty.ok).toBe(false);
      if (!empty.ok) expect(empty.error).toMatch(/Fill and save/i);

      const allFalse = buildStepSkillPrompt(
        stepId,
        'Step',
        Object.fromEntries(MANUAL_STEP_DEFS[stepId].fields.map((field) => [field.id, false])),
      );
      expect(allFalse.ok).toBe(false);
    }
  });

  it('keeps the gate on steps that do have text boxes', () => {
    const tickedOnly = buildStepSkillPrompt('p1-s9', 'MD Briefing', { brief_reviewed: true });
    expect(tickedOnly.ok).toBe(false);

    const selectedOnly = buildStepSkillPrompt('p1-s11', 'Pursue or pass', {
      recommendation: 'Pursue',
    });
    expect(selectedOnly.ok).toBe(false);
    if (!selectedOnly.ok) expect(selectedOnly.error).toMatch(/Fill and save/i);
  });

  it('lets every checkbox-only step draft once one box is ticked', () => {
    for (const stepId of CHECKBOX_ONLY_STEPS) {
      const first = MANUAL_STEP_DEFS[stepId].fields[0];
      const prompt = buildStepSkillPrompt(stepId, 'Step', { [first.id]: true });
      expect(prompt.ok, `${stepId} should be draftable`).toBe(true);
      if (prompt.ok) expect(prompt.message).toContain(first.label);
    }
  });
});

describe('applySkillReply', () => {
  it('writes flags and actions onto the Meeting Intelligence boxes', () => {
    const next = applySkillReply(
      'p1-s10',
      { meeting_notes: 'raw transcript' },
      [
        '# Synthesis',
        'Workstream read.',
        '## Flags',
        'Upsell mix is unclean.',
        '## Action register',
        'Jane to send the cube by Friday.',
      ].join('\n'),
    );
    expect(next.meeting_notes).toBe('raw transcript');
    expect(next.sensitivities).toBe('Upsell mix is unclean.');
    expect(next.next_actions).toBe('Jane to send the cube by Friday.');
  });

  it('falls back to next actions when the reply has no headings', () => {
    const next = applySkillReply('p1-s10', {}, 'Just do the follow-up.');
    expect(next.next_actions).toBe('Just do the follow-up.');
  });

  it('files the Relationship Pathing reply onto the skill brief', () => {
    const next = applySkillReply('p1-s8', {}, '## Deciders\n\nAda signs.');
    expect(next[PATHING_BRIEF_FIELD]).toBe('## Deciders\n\nAda signs.');
  });
});

describe('loadLeadMapsForDeal', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the target and maps from the deal', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/deals/VILLA-2026-503') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              parties: [{ party_role: 'target', company: { id: 'c1', name: 'Villa Holdings' } }],
            }),
        });
      }
      if (url === '/api/v1/companies/c1/stakeholders') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ stakeholders: [{ name: 'Ada', role_in_decision: 'decision-maker' }] }),
        });
      }
      if (url === '/api/v1/companies/c1/relationships') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ relationships: [{ person_name: 'Rob', relationship_type: 'colleague' }] }),
        });
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchMock);

    const maps = await loadLeadMapsForDeal('VILLA-2026-503');
    expect(maps).toEqual({
      companyId: 'c1',
      companyName: 'Villa Holdings',
      stakeholders: [{ name: 'Ada', role_in_decision: 'decision-maker' }],
      relationships: [{ person_name: 'Rob', relationship_type: 'colleague' }],
    });
  });
});

describe('select option labels stay out of the model-facing prompt', () => {
  // The visible label of 'Fail — fixes required' is 'Fail: fixes required'.
  // The prompt is built from saved work, so it must see exactly what it saw
  // before labels existed.
  const work = { qc_result: 'Fail — fixes required', qc_notes: 'Page 4 numbers disagree.' };

  it('builds the same prompt for a filled QC step as before labels existed', () => {
    const prompt = buildStepSkillPrompt('p1-s22', 'Deck QC', work);
    expect(prompt.ok).toBe(true);
    if (!prompt.ok) return;
    expect(prompt.message).toBe(
      'Run the Deck QC skill against the step inputs below. ' +
        'Return a flags / sensitivities section and an action register / next actions section ' +
        'as markdown headings so they can be filed back onto the deal.\n\n' +
        '## Page-by-page fixes (if any)\n\nPage 4 numbers disagree.',
    );
    expect(prompt.message).not.toContain('Fail: fixes required');
  });

  it('passes saved work through filledFieldsFromWork unchanged', () => {
    expect(filledFieldsFromWork('p1-s22', work)).toEqual([
      { id: 'qc_notes', label: 'Page-by-page fixes (if any)', value: 'Page 4 numbers disagree.', kind: 'prose' },
    ]);
  });
});
