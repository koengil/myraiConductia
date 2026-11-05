import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { NO_SKILL_MESSAGE, SkillStepRunner } from '@/components/rail/SkillStepRunner';
import { FlagsProvider } from '@/lib/flags/FlagsContext';
import { FLAG_REGISTRY, type FlagKey } from '@/lib/flags/keys';
import type { FlagMap } from '@/lib/flags/resolveFlags';
import type { ProjectRailStep } from '@/lib/rail/projectRail';

/*
 * A step whose skill no longer resolves still shows its completed run
 * with the "What should change?" box (the revision runs on the run's own
 * recorded skill). The no-skill line stays above it.
 */

const CATALOG_STEP: ProjectRailStep = {
  id: 'deal-step-uuid-11',
  stepId: 'p3-s41',
  origin: 'catalog',
  phaseIndex: 3,
  displayOrder: 11,
  seq: 41,
  status: 'pending',
  anchorStepId: null,
  removedAt: null,
  removedBy: null,
  skip: null,
  definition: null,
};

const BINDING = {
  skillId: '2d362e20-0709-4ba0-bbd7-d21831148282',
  versionId: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
  digest: 'a'.repeat(64),
};

const RUN = {
  id: 'run-2',
  outcome: 'succeeded',
  actorName: 'Storm Duncan',
  input: 'swot',
  inputs: {},
  resultText: 'first draft',
  errorMessage: null,
  costUsd: null,
  startedAt: null,
  createdAt: '2026-09-14T11:00:00.000Z',
  binding: BINDING,
  documents: [],
  headId: 'rev-2',
  headText: 'Strengths: a loyal customer base.',
  revisions: [
    {
      id: 'rev-2',
      parentId: 'run-2',
      kind: 'edits',
      outcome: 'succeeded',
      errorMessage: null,
      actorName: 'Lance Park',
      createdAt: '2026-09-14T12:00:00.000Z',
      version: 2,
      edits: [],
      restoredFrom: null,
      skillMounted: true,
    },
  ],
};

function flagsWith(...enabled: FlagKey[]): FlagMap {
  return Object.fromEntries(
    Object.keys(FLAG_REGISTRY).map((key) => [key, enabled.includes(key as FlagKey)]),
  ) as FlagMap;
}

let runs: unknown[] = [];

beforeEach(() => {
  runs = [RUN];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/skill-runs')) return new Response(JSON.stringify({ runs }), { status: 200 });
      if (url.endsWith('/skill-versions')) {
        return new Response(
          JSON.stringify({ current: null, project: [], projectUnavailableReason: null, catalog: [], ancestorContract: null }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ step: { work: {} } }), { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a step with no resolvable skill and a completed run', () => {
  it('shows the no-skill line and, below it, the v2 output with the What should change? box', async () => {
    render(
      <FlagsProvider value={flagsWith('skill_authoring', 'skill_output_revisions')}>
        <SkillStepRunner projectId="SUMMIT-2026-003" step={CATALOG_STEP} />
      </FlagsProvider>,
    );
    expect(await screen.findByText(NO_SKILL_MESSAGE)).toBeInTheDocument();
    expect(await screen.findByText('Strengths: a loyal customer base.')).toBeInTheDocument();
    expect(screen.getByLabelText('What should change?')).toBeInTheDocument();
  });

  it('keeps a removed step reference only: no revise box', async () => {
    render(
      <FlagsProvider value={flagsWith('skill_authoring', 'skill_output_revisions')}>
        <SkillStepRunner projectId="SUMMIT-2026-003" step={{ ...CATALOG_STEP, removedAt: '2026-10-01T00:00:00Z' }} />
      </FlagsProvider>,
    );
    expect(await screen.findByText('Strengths: a loyal customer base.')).toBeInTheDocument();
    expect(screen.queryByLabelText('What should change?')).not.toBeInTheDocument();
  });
});
