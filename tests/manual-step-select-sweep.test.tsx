import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

import { ManualStepPanel } from '@/components/rail/ManualStepPanel';
import {
  MANUAL_STEP_DEFS,
  optionValue,
  type ManualFieldDef,
  type ManualStepDef,
} from '@/lib/rail/manualStepDefs';
import { stepNumber } from '@/lib/rail/dealRail';

/*
 * Finding 6 was reported as "likely systemic", and it was: the shared field
 * renderer showed options[0] on every required select, not just the two
 * steps the bug bash reached. tests/manual-step-select.test.tsx proves the
 * behaviour in depth on step 07; this sweeps the rest of the blast radius
 * and fails if a newly added required select reintroduces a shown-but-unsaved
 * default. The defaults matter beyond the completion gate: step 06 is
 * AI-consent and step 18 is deck QC, so a preselected first option would
 * record 'Not yet asked' and 'In review' as answers nobody gave.
 */

vi.mock('@/lib/flags/FlagsContext', () => ({
  useFlag: () => true,
}));

vi.mock('@/lib/deals/useDeals', () => ({
  useActiveDeal: () => ({ codename: 'Project Solstice' }),
}));

vi.mock('@/lib/audit/store', () => ({
  logAudit: () => undefined,
}));

vi.mock('@/components/people/PersonCombobox', () => ({
  PersonCombobox: () => null,
}));

vi.mock('@/components/dataroom/DealFolderDestinationSelect', () => ({
  DealFolderDestinationSelect: () => null,
  appendFilingDestination: () => undefined,
  DEFAULT_DESTINATION_KEY: 'deal-folder',
}));

/** Steps whose completion gate depends on a select the banker must answer. */
const REQUIRED_SELECT_STEPS: Array<{ def: ManualStepDef; selects: ManualFieldDef[] }> =
  Object.values(MANUAL_STEP_DEFS)
    .map((def) => ({
      def,
      selects: def.fields.filter((f) => f.type === 'select' && f.required),
    }))
    .filter((entry) => entry.selects.length > 0);

/** A step nobody has touched: status current, empty work. */
function mockStepFetch(stepId: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          step: {
            stepId,
            status: 'current',
            assignedTo: null,
            assignedToName: null,
            work: {},
          },
          members: [],
          // canAssign false so the only selects on screen are checklist fields.
          permissions: { isMd: true, canAssign: false, canComplete: true, canEditWork: true },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('required selects across the rail (Finding 6 blast radius)', () => {
  it('is the set of steps a shown-but-unsaved default could strand', () => {
    // A new required select must be added here deliberately, with the sweep
    // below proving it starts empty.
    expect(REQUIRED_SELECT_STEPS.map((e) => stepNumber(e.def.stepId)).sort()).toEqual([
      '06',
      '07',
      '18',
      '23',
      '45',
      '61',
    ]);
  });

  it.each(REQUIRED_SELECT_STEPS)(
    'shows no unsaved answer on $def.stepId',
    async ({ def, selects }) => {
      mockStepFetch(def.stepId);
      render(<ManualStepPanel dealId="VILLA-2026-503" stepId={def.stepId} />);

      await waitFor(() => {
        expect(screen.queryByRole('status')).toBeNull();
      });

      for (const field of selects) {
        const select = screen.getByLabelText(field.label) as HTMLSelectElement;

        // What the banker reads is what the server holds.
        expect(select.value).toBe('');
        const first = field.options?.[0];
        if (first !== undefined) expect(select.value).not.toBe(optionValue(first));
      }
    },
  );
});
