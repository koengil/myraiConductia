import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

import { DealRail } from '../src/components/rail/DealRail';
import { StepContract } from '../src/components/rail/StepContract';
import { SessionProvider } from '../src/lib/session/store';
import { FlagsProvider } from '../src/lib/flags/FlagsContext';
import type { FlagMap } from '../src/lib/flags/resolveFlags';
import {
  MVP_DEAL_RAIL,
  TEASER_STEP_ID,
  TEASER_STEP_SEQ,
  orderedSteps,
  phaseForStep,
  stepNumberForSeq,
  stepBySeq,
  stepDisplayNumber,
  totalSteps,
  type RailStep,
} from '../src/lib/rail/dealRail';
import type { ProjectRailStep } from '../src/lib/rail/projectRail';

function projectStepFor(step: RailStep): ProjectRailStep {
  return {
    id: `deal-step-${step.id}`,
    stepId: step.id,
    origin: 'catalog',
    phaseIndex: 0,
    displayOrder: 0,
    seq: step.seq,
    status: 'pending',
    definition: null,
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
    catalog: step,
  };
}

/*
 * Rail numbering contract (CD-08) and the honest missing-station state (CD-07).
 *
 * One scale reaches the MD: the step number on the rendered MVP rail
 * (1..61). The canonical 65-step census seq stays an identifier — URLs,
 * deals.current_step_seq — and is translated at the edge. The progress meter
 * and the step identifier read in different idioms so neither can be
 * mistaken for the other.
 */

const MVP_TOTAL = totalSteps(MVP_DEAL_RAIL);
const MD_BRIEFING_SEQ = 9;

const replaceSpy = vi.fn();
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: replaceSpy,
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useParams: () => ({ projectId: 'project-summit' }),
  usePathname: () => '/projects/project-summit/rail',
  useSearchParams: () => new URLSearchParams(search),
}));

afterEach(() => {
  cleanup();
  search = '';
  vi.restoreAllMocks();
});

describe('rail numbering contract', () => {
  it('translates a canonical seq into the step number the MD reads', () => {
    expect(MVP_TOTAL).toBe(61);
    expect(stepNumberForSeq(MD_BRIEFING_SEQ)).toBe(5);
    expect(stepNumberForSeq(TEASER_STEP_SEQ)).toBe(32);
    expect(stepDisplayNumber(TEASER_STEP_ID, MVP_DEAL_RAIL)).toBe(32);
    expect(stepBySeq(TEASER_STEP_SEQ)?.seq).toBe(36);
  });

  it('returns no step for a census step that is off the rendered rail', () => {
    expect(stepNumberForSeq(1)).toBeNull();
  });

  it('never numbers a rendered step above the rail it is drawn on', () => {
    for (const step of orderedSteps(MVP_DEAL_RAIL)) {
      const n = stepDisplayNumber(step.id, MVP_DEAL_RAIL);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(MVP_TOTAL);
    }
  });
});

describe('rail surface numbering', () => {
  async function renderAtStep(seq: number) {
    search = `step=${seq}`;
    render(
      <SessionProvider>
        <DealRail />
      </SessionProvider>,
    );
    await waitFor(() =>
      expect(screen.queryByText(/Loading (the deal rail|your deal list)/i)).not.toBeInTheDocument(),
    );
  }

  it('names the zoomed step\'s phase, with no count, and the progress line by phase name', async () => {
    await renderAtStep(MD_BRIEFING_SEQ);

    const phase = phaseForStep('p1-s9', MVP_DEAL_RAIL)!;
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Zoom out to Origination' })).toBeInTheDocument(),
    );
    expect(phase.index).toBe(1);
    expect(screen.getByTestId('rail-progress-line')).toHaveTextContent(
      'Preparation · 10 of 13 steps done',
    );
    // Numbers recede: no bare "Phase N", no position out of the whole rail.
    expect(screen.queryByText(/Phase \d/)).not.toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`of ${MVP_TOTAL}`))).not.toBeInTheDocument();
  });

  it('walks to the neighbours by their step names', async () => {
    await renderAtStep(MD_BRIEFING_SEQ);

    await waitFor(() =>
      expect(
        screen.getByLabelText('Previous step · Relationship Pathing'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByLabelText(/^Next step · /)).toBeInTheDocument();
    expect(screen.queryByText(/station/i)).not.toBeInTheDocument();
  });

  it('reads the header as one progress line and one bar for the whole rail', async () => {
    render(
      <SessionProvider>
        <DealRail />
      </SessionProvider>,
    );
    await waitFor(() =>
      expect(screen.queryByText(/Loading (the deal rail|your deal list)/i)).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('rail-progress-line')).toHaveTextContent(
      'Preparation · 10 of 13 steps done',
    );
    expect(screen.getByRole('progressbar', { name: 'Rail progress' })).toHaveAttribute(
      'aria-valuetext',
      `31 of ${MVP_TOTAL} steps done on the whole rail`,
    );
    expect(screen.queryByText(/stations complete|Station \d+ of/)).not.toBeInTheDocument();
  });
});

const FLAGS: FlagMap = {
  rail_templates: false,
  template_change_review: false,
  deal_data_room_nav: false,
  gate0_api_create: true,
  platform_onboarding: false,
  work_identity_onboarding: false,
  mail_channel: false,
  mail_jev_second_opinion: false,
  teaser_sandbox_runner: false,
  company_access_management: false,
  setup_walkthroughs: false,
  book_view: false,
  project_rail_model: false,
  deal_discovery: false,
  discovery_worker_enabled: false,
  discovery_model_proposals_demo: false,
  workbench_top_nav: false,
  skill_authoring: false,
  skill_output_revisions: false,
};

/** Only the step endpoint is answered; every other client call fails, which is
 *  what the fixture surfaces already tolerate. */
function stubStepFetch(stepResponse: Partial<Response> & { json: () => Promise<unknown> }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/steps/')) return stepResponse as unknown as Response;
      return {
        ok: false,
        status: 404,
        json: async () => ({ error: 'Not found' }),
      } as unknown as Response;
    }),
  );
}

describe('a step the server does not hold', () => {
  const lastStep = orderedSteps(MVP_DEAL_RAIL)[MVP_TOTAL - 1];

  function renderContract() {
    return render(
      <FlagsProvider value={FLAGS}>
        <SessionProvider>
          <StepContract
            step={lastStep}
            projectStep={projectStepFor(lastStep)}
            phase={phaseForStep(lastStep.id, MVP_DEAL_RAIL)!}
            state="active"
            dealId="ATLAS-2026-001"
            receipts={[]}
            versions={[]}
            onComplete={vi.fn()}
            onSkip={vi.fn()}
            stepNumber={MVP_TOTAL}
          />
        </SessionProvider>
      </FlagsProvider>,
    );
  }

  beforeEach(() => {
    search = '';
  });

  it('says so and withholds the actions when the step 404s', async () => {
    stubStepFetch({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Step not found for this deal' }),
    });

    renderContract();

    await waitFor(() =>
      expect(screen.getByText('Not on the deal record')).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/No actions on a step the record does not hold/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Manual step work')).toBeNull();
  });

  it('stays silent when the server holds the step', async () => {
    stubStepFetch({
      ok: true,
      status: 200,
      json: async () => ({
        step: { stepId: lastStep.id, seq: lastStep.seq, status: 'current', work: {} },
        members: [],
        permissions: { isMd: true, canAssign: false, canComplete: true, canEditWork: true },
      }),
    });

    renderContract();

    await waitFor(() =>
      expect(screen.getByLabelText('Manual step work')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Not on the deal record')).toBeNull();
  });
});
