import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import * as React from 'react';

import { ManualStepPanel } from '@/components/rail/ManualStepPanel';
import { manualStepDef, validateManualWork } from '@/lib/rail/manualStepDefs';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import type { FlagMap } from '@/lib/flags/resolveFlags';

vi.mock('next/navigation', () => ({
  useParams: () => ({ projectId: 'atlas-2026' }),
}));

vi.mock('@/lib/deals/useDeals', () => ({
  useActiveDeal: () => ({ codename: 'Project Solstice' }),
}));

/*
 * Bug bash Finding 6 (Sep 4): a required select rendered options[0] ("Pursue")
 * as if chosen while the step work held no value, so Mark step complete was
 * refused by the server ("Recommendation is required before completing this
 * step.") until the user actively changed the select. The select must never
 * display a value the saved work does not hold: untouched means the
 * placeholder, and only an actual choice fills the state that validation sees.
 */

const flags: FlagMap = {
  rail_templates: false,
  template_change_review: false,
  deal_data_room_nav: false,
  gate0_api_create: true,
  mail_channel: false,
  mail_jev_second_opinion: false,
  teaser_sandbox_runner: false,
  platform_onboarding: false,
  work_identity_onboarding: false,
  company_access_management: false,
  setup_walkthroughs: false,
  workbench_top_nav: false,
  book_view: false,
  skill_authoring: false,
  project_rail_model: false,
  deal_discovery: false,
  discovery_worker_enabled: false,
  discovery_model_proposals_demo: false,
  skill_output_revisions: false,
};

function mockStep(work: Record<string, unknown>, stepId = 'p1-s11') {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      step: {
        stepId,
        status: 'current',
        assignedTo: null,
        assignedToName: null,
        work,
      },
      currentStepId: 'committed-next-step',
      members: [],
      permissions: { isMd: true, canAssign: true, canComplete: true, canEditWork: true },
    }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPanel(stepId = 'p1-s11') {
  return render(
    <FlagsProvider value={flags}>
      <ManualStepPanel dealId="atlas-2026" stepId={stepId} />
    </FlagsProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ManualStepPanel — required select honesty (Finding 6)', () => {
  it('shows the placeholder, not options[0], when the saved work holds no value', async () => {
    mockStep({});
    renderPanel();

    const select = (await screen.findByLabelText('Recommendation')) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(screen.getByRole('option', { name: 'Select…' })).toBeInTheDocument();
  });

  it('holds the chosen value in state once the user actually picks one', async () => {
    mockStep({});
    renderPanel();

    const select = (await screen.findByLabelText('Recommendation')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'Pursue' } });
    expect(select.value).toBe('Pursue');
  });

  it('renders the saved value when the work already holds one', async () => {
    mockStep({ recommendation: 'Hold' });
    renderPanel();

    const select = (await screen.findByLabelText('Recommendation')) as HTMLSelectElement;
    expect(select.value).toBe('Hold');
  });
});

it('forwards the cursor returned by a completed step save', async () => {
  const fetchMock = mockStep({ recommendation: 'Pursue' });
  const onCompleted = vi.fn();
  render(<FlagsProvider value={flags}><ManualStepPanel dealId="atlas-2026" stepId="p1-s11" onCompleted={onCompleted} /></FlagsProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Mark step complete' }));
  await waitFor(() => expect(onCompleted).toHaveBeenCalledWith('committed-next-step'));
  // The manual step completes through the step PATCH, never PATCH /progress.
  const calls = fetchMock.mock.calls as unknown as [RequestInfo | URL, RequestInit | undefined][];
  const patches = calls.filter(([, init]) => init?.method === 'PATCH').map(([u]) => String(u));
  expect(patches.some((u) => u.includes('/steps/'))).toBe(true);
  expect(patches.some((u) => u.endsWith('/progress'))).toBe(false);
});

describe('ManualStepPanel: stored select values stay stable while the label is plain', () => {
  // Records saved before the copy sweep hold these exact strings (with an em dash).
  const LEGACY = [
    { stepId: 'p1-s22', label: 'QC result', stored: 'Fail \u2014 fixes required', shown: 'Fail: fixes required' },
    { stepId: 'p5-s65', label: 'Activation trigger', stored: 'Terminated \u2014 expiration', shown: 'Terminated: expiration' },
    { stepId: 'p5-s65', label: 'Activation trigger', stored: 'Terminated \u2014 voluntary', shown: 'Terminated: voluntary' },
  ];

  for (const c of LEGACY) {
    it(`a saved "${c.stored}" still selects its option and reads "${c.shown}"`, async () => {
      mockStep({ [c.label === 'QC result' ? 'qc_result' : 'trigger_type']: c.stored });
      renderPanel(c.stepId);
      const select = (await screen.findByLabelText(c.label)) as HTMLSelectElement;
      expect(select.value).toBe(c.stored);
      const option = screen.getByRole('option', { name: c.shown }) as HTMLOptionElement;
      expect(option.value).toBe(c.stored);
      expect(option.textContent).not.toContain('\u2014');
    });
  }

  it('a new choice selects the same stored value as before', async () => {
    mockStep({});
    renderPanel('p1-s22');
    const select = (await screen.findByLabelText('QC result')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'Fail \u2014 fixes required' } });
    expect(select.value).toBe('Fail \u2014 fixes required');
  });
});

/*
 * Brand rule: no em-dashes in visible copy. Some select options stored an
 * em-dash in their value before the rule, so the label changed and the stored
 * value did not: saved work keeps loading and validating byte for byte.
 */
describe('ManualStepPanel — option labels differ from stored values', () => {
  it('shows the em-dash-free label while the option keeps the stored value', async () => {
    mockStep({}, 'p1-s22');
    renderPanel('p1-s22');

    await screen.findByLabelText('QC result');
    const option = screen.getByRole('option', { name: 'Fail: fixes required' }) as HTMLOptionElement;
    expect(option.value).toBe('Fail — fixes required');
    expect(screen.queryByRole('option', { name: /—/ })).toBeNull();
  });

  it('shows Terminated labels without em-dashes on the tail monitor', async () => {
    mockStep({}, 'p5-s65');
    renderPanel('p5-s65');

    await screen.findByLabelText('Activation trigger');
    expect(
      (screen.getByRole('option', { name: 'Terminated: expiration' }) as HTMLOptionElement).value,
    ).toBe('Terminated — expiration');
    expect(
      (screen.getByRole('option', { name: 'Terminated: voluntary' }) as HTMLOptionElement).value,
    ).toBe('Terminated — voluntary');
  });

  it('renders a saved legacy value as selected, and it still validates', async () => {
    mockStep({ qc_result: 'Fail — fixes required' }, 'p1-s22');
    renderPanel('p1-s22');

    const select = (await screen.findByLabelText('QC result')) as HTMLSelectElement;
    expect(select.value).toBe('Fail — fixes required');
    expect(select.selectedOptions[0]?.textContent).toBe('Fail: fixes required');

    const def = manualStepDef('p1-s22');
    expect(def).toBeDefined();
    const ticked = Object.fromEntries(
      def!.fields.filter((f) => f.required && f.type === 'checkbox').map((f) => [f.id, true]),
    );
    expect(validateManualWork(def!, { ...ticked, qc_result: 'Fail — fixes required' })).toBeNull();
  });

  it('saves the stored value, not the label, when the banker picks it', async () => {
    mockStep({}, 'p1-s22');
    renderPanel('p1-s22');

    const select = (await screen.findByLabelText('QC result')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'Fail — fixes required' } });
    expect(select.value).toBe('Fail — fixes required');
  });
});
