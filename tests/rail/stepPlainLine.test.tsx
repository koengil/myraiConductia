import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';

import { StepContract } from '@/components/rail/StepContract';
import {
  MANUAL_PLAIN_LINE,
  PRIOR_PLAIN_LINE,
  RELATIONSHIP_PATHING_PLAIN_LINE,
  SKIPPED_PLAIN_LINE,
  draftPlainLine,
  gate0PlainLine,
} from '@/components/rail/stepActionCopy';
import type { StepState } from '@/components/rail/stepState';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import { FLAG_REGISTRY } from '@/lib/flags/keys';
import type { FlagMap } from '@/lib/flags/resolveFlags';
import {
  DEAL_RAIL,
  MD_BRIEFING_STEP_ID,
  MVP_DEAL_RAIL,
  RELATIONSHIP_PATHING_STEP_ID,
  TEASER_STEP_ID,
  orderedSteps,
  phaseForStep,
} from '@/lib/rail/dealRail';
import { MANUAL_STEP_DEFS } from '@/lib/rail/manualStepDefs';
import { stepSkillCopy } from '@/lib/ignatious/stepSkillIo';
import type { ProjectRailStep } from '@/lib/rail/projectRail';

/*
 * Every zoomed step says, in one plain line under its name, what the banker
 * does and what Conductia does; a manual step shows its description once
 * (S6-25).
 */

vi.mock('@/lib/deals/useDeals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/deals/useDeals')>();
  return {
    ...actual,
    useActiveDeal: () => ({ id: 'deal-1', code: 'deal-1', codename: 'Project Ridge', dealRole: 'md' }),
  };
});
vi.mock('@/lib/auth/useCurrentUser', () => ({ useCurrentUser: () => ({ state: { status: 'loading' } }) }));
vi.mock('@/lib/audit/store', () => ({ logAudit: vi.fn() }));

const MANUAL_STEP_ID = 'p1-s11';

function flags(on: string[] = []): FlagMap {
  return Object.fromEntries(Object.keys(FLAG_REGISTRY).map((k) => [k, on.includes(k)])) as FlagMap;
}

function projectStepFor(stepId: string, rail = DEAL_RAIL): ProjectRailStep {
  const catalog = orderedSteps(rail).find((s) => s.id === stepId)!;
  return {
    id: `uuid-${stepId}`,
    stepId,
    origin: 'catalog',
    phaseIndex: phaseForStep(stepId, rail)!.index,
    displayOrder: 1,
    seq: catalog.seq,
    status: 'current',
    definition: null,
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
    catalog,
  };
}

function renderContract(
  stepId: string,
  on: string[] = [],
  state: StepState = 'active',
  rail = DEAL_RAIL,
  versions: { version: number; label: string; note?: string; at: string }[] = [],
) {
  const projectStep = projectStepFor(stepId, rail);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        step: { stepId, status: 'current', assignedTo: null, assignedToName: null, work: {} },
        currentStepId: stepId,
        members: [],
        permissions: { isMd: true, canAssign: true, canComplete: true, canEditWork: true },
        runs: [],
      }),
    })),
  );
  render(
    <FlagsProvider value={flags(on)}>
      <StepContract
        step={projectStep.catalog!}
        projectStep={projectStep}
        phase={phaseForStep(stepId, rail)!}
        state={state}
        dealId="deal-1"
        receipts={[]}
        versions={versions}
        onComplete={() => {}}
        onSkip={() => {}}
        stepNumber={12}
      />
    </FlagsProvider>,
  );
  return projectStep.catalog!;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the plain line under the step name', () => {
  it('a manual step says the banker completes the checklist and Conductia records it', async () => {
    const step = renderContract(MANUAL_STEP_ID, ['gate0_api_create']);
    const heading = await screen.findByRole('heading', { level: 2, name: step.title });
    await screen.findByRole('button', { name: 'Save progress' });
    expect(within(heading.parentElement!).getByText(MANUAL_PLAIN_LINE)).toBeInTheDocument();
  });

  it('a manual step shows its description once, without the shorter summary under it', async () => {
    const step = renderContract(MANUAL_STEP_ID, ['gate0_api_create']);
    await screen.findByRole('button', { name: 'Save progress' });
    // The section names the work area; no name carries the step slug (S6-08).
    const work = screen.getByRole('region', { name: 'Manual step work' });
    expect(document.querySelector(`[aria-label*="${MANUAL_STEP_ID}"]`)).toBeNull();
    expect(within(work).getAllByText(step.description)).toHaveLength(1);
    expect(screen.queryByText(MANUAL_STEP_DEFS[MANUAL_STEP_ID].summary)).not.toBeInTheDocument();
  });

  it('the Teaser says what Conductia drafts in the step view, before its runner opens', async () => {
    const step = renderContract(TEASER_STEP_ID);
    const heading = await screen.findByRole('heading', { level: 2, name: step.title });
    expect(
      await within(heading.parentElement!).findByText(draftPlainLine(TEASER_STEP_ID, step.title)),
    ).toBeInTheDocument();
  });

  it('a reference-only manual step says only that it is reference, never the checklist line', async () => {
    const step = renderContract(MANUAL_STEP_ID, ['gate0_api_create'], 'prior');
    const heading = await screen.findByRole('heading', { level: 2, name: step.title });
    expect(await within(heading.parentElement!).findByText(PRIOR_PLAIN_LINE)).toBeInTheDocument();
    expect(screen.queryByText(MANUAL_PLAIN_LINE)).not.toBeInTheDocument();
    expect(screen.getAllByText(PRIOR_PLAIN_LINE)).toHaveLength(1);
  });

  it('a reference-only skill step carries the reference sentence as its plain line', async () => {
    const step = renderContract(RELATIONSHIP_PATHING_STEP_ID, ['gate0_api_create'], 'prior');
    const heading = await screen.findByRole('heading', { level: 2, name: step.title });
    expect(await within(heading.parentElement!).findByText(PRIOR_PLAIN_LINE)).toBeInTheDocument();
    expect(screen.getAllByText(PRIOR_PLAIN_LINE)).toHaveLength(1);
  });

  it('a reference-only MD Briefing says only that it is reference: no drafting line, no runner note', async () => {
    // Summit, Alder, Beacon, Cinder opened after MD Briefing (S6R4-01).
    const step = renderContract(MD_BRIEFING_STEP_ID, ['gate0_api_create'], 'prior');
    expect(step.note).toBeTruthy();
    const heading = await screen.findByRole('heading', { level: 2, name: step.title });
    expect(await within(heading.parentElement!).findByText(PRIOR_PLAIN_LINE)).toBeInTheDocument();
    expect(screen.getAllByText(PRIOR_PLAIN_LINE)).toHaveLength(1);
    expect(screen.queryByText(stepSkillCopy(step.id, step.title).uses)).not.toBeInTheDocument();
    expect(screen.queryByText(step.note!)).not.toBeInTheDocument();
    expect(screen.queryByText(/Review before you mark it complete/)).not.toBeInTheDocument();
  });

  it('a live MD Briefing keeps its uses line and runner note', async () => {
    const step = renderContract(MD_BRIEFING_STEP_ID, ['gate0_api_create'], 'active');
    await screen.findByRole('heading', { level: 2, name: step.title });
    expect(await screen.findByText(stepSkillCopy(step.id, step.title).uses)).toBeInTheDocument();
    expect(screen.getByText(step.note!)).toBeInTheDocument();
  });

  it.each(['p1-s7', 'p1-s6', 'g0-notify'])('Gate 0 step %s says what intake recorded, and nothing about an Edit that is not there', async (stepId) => {
    // The deal rail the app renders marks the intake steps as Gate 0.
    const step = renderContract(stepId, ['gate0_api_create'], 'done', MVP_DEAL_RAIL);
    expect(step.gate0).toBe(true);
    const heading = await screen.findByRole('heading', { level: 2, name: step.title });
    expect(
      await within(heading.parentElement!).findByText(gate0PlainLine(stepId)!),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Edit appends a new version/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
  });

  it('a done step with an output version shows the Edit control and the sentence about it', async () => {
    // A skill step (not manual, not Gate 0, not live), done, with one filed version.
    const step = renderContract('p1-s2', ['gate0_api_create'], 'done', DEAL_RAIL, [
      { version: 1, label: 'First draft', at: '2026-10-20T10:00:00Z' },
    ]);
    expect(step.gate0).toBeFalsy();
    await screen.findByRole('heading', { level: 2, name: step.title });
    expect(await screen.findByRole('button', { name: 'Edit · append version' })).toBeInTheDocument();
    expect(
      screen.getByText('Complete. Edit appends a new version, nothing is overwritten.'),
    ).toBeInTheDocument();
  });

  it('the Teaser says who drafts and who signs off once in the step view, About included', async () => {
    renderContract(TEASER_STEP_ID);
    await screen.findByText(draftPlainLine(TEASER_STEP_ID, 'Teaser'));
    expect(screen.getAllByText(/Conductia drafts the teaser/)).toHaveLength(1);
  });

  it('claims no draft while the step is loading or when the record does not hold it', async () => {
    const step = projectStepFor(TEASER_STEP_ID).catalog!;
    // The step's record read answers 404: the step is not on the deal.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/steps/')
          ? { ok: false, status: 404, json: async () => ({ error: 'Not found' }) }
          : { ok: true, status: 200, json: async () => ({}) },
      ),
    );
    render(
      <FlagsProvider value={flags(['gate0_api_create'])}>
        <StepContract
          step={step}
          projectStep={projectStepFor(TEASER_STEP_ID)}
          phase={phaseForStep(TEASER_STEP_ID, DEAL_RAIL)!}
          state="active"
          dealId="deal-missing"
          receipts={[]}
          versions={[]}
          onComplete={() => {}}
          onSkip={() => {}}
          stepNumber={12}
        />
      </FlagsProvider>,
    );
    const heading = screen.getByRole('heading', { level: 2, name: step.title });
    // Loading: no line yet.
    expect(within(heading.parentElement!).queryByText(/^Conductia drafts/)).not.toBeInTheDocument();
    expect(await screen.findByText('No actions on a step the record does not hold.')).toBeInTheDocument();
    // (The About tooltip keeps the step's own note; the step view claims nothing.)
    expect(within(heading.parentElement!).queryByText(/^Conductia drafts/)).not.toBeInTheDocument();
  });

  it('a live Relationship Pathing step says what the banker chooses and what Conductia records (S6R5-01)', async () => {
    // Atlas ?step=8: the step is live, with no skill attached.
    const step = renderContract(RELATIONSHIP_PATHING_STEP_ID, ['gate0_api_create'], 'active', MVP_DEAL_RAIL);
    const heading = await screen.findByRole('heading', { level: 2, name: step.title });
    expect(
      await within(heading.parentElement!).findByText(RELATIONSHIP_PATHING_PLAIN_LINE),
    ).toBeInTheDocument();
    expect(screen.getAllByText(RELATIONSHIP_PATHING_PLAIN_LINE)).toHaveLength(1);
    expect(screen.queryByText(/Adding a relationship only lists an introducer/)).not.toBeInTheDocument();
    // The paths live on the target company (shared with Leads); only the
    // step's completion is on the deal (S6R5-R1 M1).
    expect(RELATIONSHIP_PATHING_PLAIN_LINE).toMatch(/saves them to the target and records the step on the deal\.$/);
  });
});

/*
 * S6R5-01 guard: every step on the rendered rail says, under its name, what
 * the banker does and what Conductia does, in every state it can render in
 * (loaded and on the record). The MD brief says it in its own uses line.
 */
describe('every catalog step has a plain line in every state', () => {
  const STATES: StepState[] = ['active', 'todo', 'done', 'prior', 'skipped'];
  const cases = orderedSteps(MVP_DEAL_RAIL).flatMap((step) =>
    STATES.map((state) => [step.id, state, step.title] as const),
  );

  it.each(cases)('%s (%s): %s', async (stepId, state) => {
    const step = renderContract(stepId, ['gate0_api_create'], state, MVP_DEAL_RAIL);
    const heading = await screen.findByRole('heading', { level: 2, name: step.title });
    const header = heading.parentElement!;
    const line = () => {
      const plain = [...header.querySelectorAll('p')].find(
        (p) => p.previousElementSibling === heading && (p.textContent ?? '').trim().length > 0,
      );
      const mdUses =
        stepId === MD_BRIEFING_STEP_ID && state !== 'prior' && state !== 'skipped'
          ? screen.queryByText(stepSkillCopy(step.id, step.title).uses)
          : null;
      return plain ?? mdUses ?? null;
    };
    await waitFor(() => expect(line()).toBeTruthy());
    // The line must outlast loading, not just appear once (S6R5-R1 M3): let
    // the step's and the panel's reads settle, flush what they schedule,
    // then read the line again.
    await waitFor(() => {
      expect(screen.queryByText('Loading this step…')).not.toBeInTheDocument();
      expect(screen.queryByText('Loading step…')).not.toBeInTheDocument();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(line()).toBeTruthy();
    if (state === 'prior') expect(within(header).getByText(PRIOR_PLAIN_LINE)).toBeInTheDocument();
    if (state === 'skipped') expect(within(header).getByText(SKIPPED_PLAIN_LINE)).toBeInTheDocument();
  });
});
