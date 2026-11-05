import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { StepContract } from '@/components/rail/StepContract';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import { FLAG_REGISTRY } from '@/lib/flags/keys';
import type { FlagMap } from '@/lib/flags/resolveFlags';
import { DEAL_RAIL, STEP_OVERRIDE_IDS, orderedSteps, phaseForStep } from '@/lib/rail/dealRail';
import type { ProjectRailStep } from '@/lib/rail/projectRail';

/*
 * "About this step" never shows engineering build notes. Every step
 * with an override renders its tooltip without build-status words.
 */

vi.mock('@/lib/auth/useCurrentUser', () => ({
  useCurrentUser: () => ({ state: { status: 'loading' } }),
}));

const BANNED = [
  'Ignatious',
  'mock',
  'not yet wired',
  'not wired',
  'not built',
  'D31',
  'Schema real',
  'Gate real',
  'Audit real',
  'Remote skill',
];

const flags = Object.fromEntries(Object.keys(FLAG_REGISTRY).map((k) => [k, false])) as FlagMap;
const catalog = orderedSteps(DEAL_RAIL);

function projectStep(stepId: string): ProjectRailStep {
  const step = catalog.find((s) => s.id === stepId)!;
  return {
    id: `uuid-${stepId}`,
    stepId,
    origin: 'catalog',
    phaseIndex: phaseForStep(stepId, DEAL_RAIL)?.index ?? 1,
    displayOrder: 1,
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('About this step', () => {
  it('has overrides to check', () => {
    expect(STEP_OVERRIDE_IDS.length).toBeGreaterThan(5);
  });

  for (const stepId of STEP_OVERRIDE_IDS) {
    it(`shows no build notes for ${stepId}`, () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
      const step = catalog.find((s) => s.id === stepId);
      expect(step, stepId).toBeDefined();
      render(
        <FlagsProvider value={flags}>
          <StepContract
            step={step!}
            projectStep={projectStep(stepId)}
            phase={phaseForStep(stepId, DEAL_RAIL)!}
            state="todo"
            dealId="deal-1"
            receipts={[]}
            versions={[]}
            onComplete={() => {}}
            onSkip={() => {}}
            stepNumber={1}
          />
        </FlagsProvider>,
      );
      const tooltip = screen.getByRole('tooltip', { hidden: true });
      for (const word of BANNED) expect(tooltip.textContent, `${stepId}: ${word}`).not.toContain(word);
    });
  }
});
