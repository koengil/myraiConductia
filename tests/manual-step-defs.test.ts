import { describe, expect, it } from 'vitest';

import { validateManualWork, MANUAL_STEP_DEFS, MANUAL_STEP_IDS, optionLabel, optionValue } from '@/lib/rail/manualStepDefs';

describe('manualStepDefs', () => {
  it('covers seq 9 through 25 on the mandate-formation spine', () => {
    for (let seq = 9; seq <= 25; seq += 1) {
      expect(MANUAL_STEP_IDS.has(`p1-s${seq}`)).toBe(true);
    }
  });

  it('covers Phase 2 prep steps 26–38 except the live Teaser runner (36)', () => {
    for (let seq = 26; seq <= 38; seq += 1) {
      if (seq === 36) {
        expect(MANUAL_STEP_IDS.has('p2-s36')).toBe(false);
        continue;
      }
      expect(MANUAL_STEP_IDS.has(`p2-s${seq}`)).toBe(true);
    }
  });

  it('covers Phase 3 marketing steps 39–45', () => {
    for (let seq = 39; seq <= 45; seq += 1) {
      expect(MANUAL_STEP_IDS.has(`p3-s${seq}`)).toBe(true);
    }
  });

  it('covers Phase 4 diligence and LOI steps 46–50', () => {
    for (let seq = 46; seq <= 50; seq += 1) {
      expect(MANUAL_STEP_IDS.has(`p4-s${seq}`)).toBe(true);
    }
  });

  it('covers Phase 5 closing and post-close steps 51–65', () => {
    for (let seq = 51; seq <= 65; seq += 1) {
      expect(MANUAL_STEP_IDS.has(`p5-s${seq}`)).toBe(true);
    }
  });

  it('requires MD briefing review checkbox before complete', () => {
    const err = validateManualWork(
      {
        stepId: 'p1-s9',
        summary: '',
        fields: [{ id: 'brief_reviewed', type: 'checkbox', label: 'Reviewed', required: true }],
      },
      { call_objectives: 'Qualify timing' },
    );
    expect(err).toMatch(/Reviewed/);
  });

  it('shows every select option without an em dash, while the stored value is kept', () => {
    // Some stored values carry an em dash from before the copy rule; those
    // options use the { value, label } form so the banker never reads one.
    const options = Object.values(MANUAL_STEP_DEFS).flatMap((def) =>
      def.fields.flatMap((f) => (f.options ?? []).map((opt) => ({ where: `${def.stepId}.${f.id}`, opt }))),
    );
    expect(options.some(({ opt }) => typeof opt !== 'string' && optionValue(opt).includes('\u2014'))).toBe(true);
    const dashed = options
      .filter(({ opt }) => optionLabel(opt).includes('\u2014'))
      .map(({ where, opt }) => `${where}: ${optionLabel(opt)}`);
    expect(dashed).toEqual([]);
  });
});
