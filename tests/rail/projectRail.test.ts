import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  activeSteps,
  projectServerRail,
  railFromCatalog,
  removedSteps,
  stepDescription,
  stepTitle,
  type ProjectRail,
  type ProjectRailStep,
} from '@/lib/rail/projectRail';
import { MVP_DEAL_RAIL, orderedSteps, stepIdForSeq, TEASER_STEP_ID } from '@/lib/rail/dealRail';

function custom(overrides: Partial<ProjectRailStep> = {}): ProjectRailStep {
  return {
    id: 'uuid-1',
    stepId: 'custom:abc',
    origin: 'custom',
    phaseIndex: 2,
    displayOrder: 5,
    seq: null,
    status: 'pending',
    definition: { title: 'Weekly project update', description: 'Turns notes into an update.' },
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
    ...overrides,
  };
}

describe('stepTitle and stepDescription', () => {
  it('read a retired census step from the full census catalogue', () => {
    const rail = projectServerRail({
      currentStepId: null,
      canEditStructure: false,
      canSaveTemplate: false,
      phases: [],
      steps: [
        custom({
          stepId: 'p1-s1',
          origin: 'catalog',
          seq: 1,
          definition: null,
          removedAt: '2026-09-11T10:00:00Z',
        }),
      ],
    });
    expect(stepTitle(rail.steps[0])).toBe('Target Universe');
  });

  it('read a custom step from its definition', () => {
    expect(stepTitle(custom())).toBe('Weekly project update');
    expect(stepDescription(custom())).toBe('Turns notes into an update.');
  });

  it('read a catalogue step from the catalogue', () => {
    const entry = orderedSteps(MVP_DEAL_RAIL)[0];
    const step = custom({
      origin: 'catalog',
      stepId: entry.id,
      definition: null,
      catalog: entry,
    });
    expect(stepTitle(step)).toBe(entry.title);
    expect(stepDescription(step)).toBe(entry.description);
  });

  it('falls back to the step id when there is neither definition nor catalog', () => {
    const step = custom({ definition: null, catalog: undefined, stepId: 'custom:orphan' });
    expect(stepTitle(step)).toBe('custom:orphan');
    expect(stepDescription(step)).toBe('');
  });
});

describe('activeSteps and removedSteps', () => {
  it('partition on removedAt and preserve display order', () => {
    const rail: ProjectRail = {
      currentStepId: null,
      canEditStructure: true,
      canSaveTemplate: false,
      phases: [],
      steps: [
        custom({ id: 'a', displayOrder: 1 }),
        custom({ id: 'b', displayOrder: 2, removedAt: '2026-09-09T00:00:00Z' }),
        custom({ id: 'c', displayOrder: 3 }),
      ],
    };
    expect(activeSteps(rail).map((s) => s.id)).toEqual(['a', 'c']);
    expect(removedSteps(rail).map((s) => s.id)).toEqual(['b']);
  });

  it('orders by displayOrder, not by seq, regardless of arrival order', () => {
    const rail: ProjectRail = {
      currentStepId: null,
      canEditStructure: true,
      canSaveTemplate: false,
      phases: [],
      steps: [
        custom({ id: 'a', displayOrder: 3, seq: 1 }),
        custom({ id: 'b', displayOrder: 1, seq: null }),
        custom({ id: 'c', displayOrder: 2, seq: 5 }),
      ],
    };
    expect(activeSteps(rail).map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('carries a removedBy object with a resolved display name, not a bare id', () => {
    const removed = custom({
      id: 'b',
      removedAt: '2026-09-09T00:00:00Z',
      removedBy: { id: 'user-1', name: 'Storm Duncan' },
    });
    expect(removed.removedBy).toEqual({ id: 'user-1', name: 'Storm Duncan' });
  });
});

describe('railFromCatalog', () => {
  it('emits the same shape as the server producer, with nothing removed', () => {
    const rail = railFromCatalog(TEASER_STEP_ID);
    expect(removedSteps(rail)).toEqual([]);
    expect(rail.steps.every((step) => step.origin === 'catalog')).toBe(true);
    expect(rail.steps.every((step) => step.catalog !== undefined)).toBe(true);
    expect(rail.currentStepId).toBe(
      rail.steps.find((step) => step.stepId === TEASER_STEP_ID)?.id,
    );
  });

  it('reports no structural authority, since the flag-off path has no write routes', () => {
    expect(railFromCatalog(TEASER_STEP_ID).canEditStructure).toBe(false);
  });

  it('falls back to the first step when the cursor step id is unknown', () => {
    const rail = railFromCatalog('p9-s99');
    expect(rail.currentStepId).toBe(rail.steps[0].id);
    expect(rail.steps[0].status).toBe('current');
  });

  it('derives status from the cursor exactly as the static rail did', () => {
    const rail = railFromCatalog(TEASER_STEP_ID);
    const cursor = rail.steps.findIndex((step) => step.stepId === TEASER_STEP_ID);
    expect(rail.steps[cursor - 1].status).toBe('complete');
    expect(rail.steps[cursor].status).toBe('current');
    expect(rail.steps[cursor + 1].status).toBe('pending');
  });

  it('emits removedBy as null, never a bare id, for the flag-off producer', () => {
    const rail = railFromCatalog(TEASER_STEP_ID);
    expect(rail.steps.every((step) => step.removedBy === null)).toBe(true);
  });

  it('marks every step before the entry skipped_entry, as the server seeds it', () => {
    const rail = railFromCatalog(stepIdForSeq(20, MVP_DEAL_RAIL), 12);
    for (const step of rail.steps) {
      const seq = step.seq ?? -1;
      const expected =
        seq < 12 ? 'skipped_entry' : seq < 20 ? 'complete' : seq === 20 ? 'current' : 'pending';
      expect({ stepId: step.stepId, status: step.status }).toEqual({
        stepId: step.stepId,
        status: expected,
      });
    }
    expect(rail.steps.filter((step) => step.status === 'skipped_entry')).toHaveLength(
      rail.steps.filter((step) => (step.seq ?? -1) < 12).length,
    );
    expect(rail.currentStepId).toBe(stepIdForSeq(20, MVP_DEAL_RAIL));
  });

  it('keeps a cursor that sits before the entry current, never Before entry', () => {
    const cursorId = stepIdForSeq(5, MVP_DEAL_RAIL);
    const rail = railFromCatalog(cursorId, 12);
    expect(rail.currentStepId).toBe(cursorId);
    const cursorRow = rail.steps.find((step) => step.stepId === cursorId);
    expect(cursorRow?.status).toBe('current');
    for (const step of rail.steps) {
      if (step.stepId === cursorId) continue;
      const seq = step.seq ?? -1;
      expect({ stepId: step.stepId, status: step.status }).toEqual({
        stepId: step.stepId,
        status: seq < 12 ? 'skipped_entry' : 'pending',
      });
    }
  });

  it('reads exactly as before for a deal entered at the start (entry 1)', () => {
    const rail = railFromCatalog(TEASER_STEP_ID, 1);
    const cursor = rail.steps.findIndex((step) => step.stepId === TEASER_STEP_ID);
    expect(rail).toEqual(railFromCatalog(TEASER_STEP_ID));
    expect(rail.steps.map((step) => step.status)).toEqual(
      rail.steps.map((_, index) =>
        index < cursor ? 'complete' : index === cursor ? 'current' : 'pending',
      ),
    );
    expect(rail.steps.some((step) => step.status === 'skipped_entry')).toBe(false);
  });
});

describe('shape parity between the two producers', () => {
  function rawServerBody() {
    const entry = orderedSteps(MVP_DEAL_RAIL)[0];
    return {
      currentStepId: 'srv-1' as string | null,
      canEditStructure: true,
      canSaveTemplate: false,
      phases: MVP_DEAL_RAIL.map((phase) => ({
        index: phase.index,
        name: phase.name,
        dealStatus: phase.dealStatus,
        roles: ['banker'],
        tools: ['box'],
      })),
      steps: [
        {
          id: 'srv-1',
          stepId: entry.id,
          origin: 'catalog' as const,
          phaseIndex: 1,
          displayOrder: 1,
          seq: entry.seq,
          status: 'current' as const,
          censusVersion: 'hv-5x65-2026-07-08',
          definition: null,
          anchorStepId: null,
          removedAt: null,
          removedBy: null,
          assignedTo: null,
          skip: null,
        },
        {
          id: 'srv-2',
          stepId: 'custom:xyz',
          origin: 'custom' as const,
          phaseIndex: 2,
          displayOrder: 2,
          seq: null,
          status: 'complete' as const,
          censusVersion: 'hv-5x65-2026-07-08',
          definition: { title: 'Custom step', description: 'A custom step.' },
          anchorStepId: 'srv-1',
          removedAt: '2026-09-09T00:00:00Z',
          removedBy: { id: 'user-9', name: 'Storm Duncan' },
          assignedTo: 'user-3',
          skip: { at: '2026-09-08T00:00:00Z', by: 'user-1', approver: 'user-2', reason: 'n/a' },
        },
      ],
    };
  }

  it('the server producer, projected onto the seam, has the same runtime key set as the flag-off producer', () => {
    const projectedRail = projectServerRail(rawServerBody());
    const catalogRail = railFromCatalog(TEASER_STEP_ID);

    expect(Object.keys(projectedRail).sort()).toEqual(Object.keys(catalogRail).sort());

    expect(Object.keys(projectedRail.phases[0]).sort()).toEqual(
      Object.keys(catalogRail.phases[0]).sort(),
    );

    const projectedStep = projectedRail.steps[0];
    const catalogStep = catalogRail.steps[0];
    expect(Object.keys(projectedStep).sort()).toEqual(Object.keys(catalogStep).sort());

    for (const key of Object.keys(catalogStep) as (keyof ProjectRailStep)[]) {
      expect(typeof projectedStep[key]).toBe(
        catalogStep[key] === null ? typeof null : typeof catalogStep[key],
      );
    }
  });

  it('the projection drops server-only fields not on the declared step and phase types', () => {
    const projectedRail = projectServerRail(rawServerBody());
    const projectedStep = projectedRail.steps[1] as Record<string, unknown>;
    const projectedPhase = projectedRail.phases[0] as Record<string, unknown>;

    expect('censusVersion' in projectedStep).toBe(false);
    expect('assignedTo' in projectedStep).toBe(false);
    expect('roles' in projectedPhase).toBe(false);
    expect('tools' in projectedPhase).toBe(false);
  });

  it('the server producer passes a null currentStepId through as null', () => {
    const body = rawServerBody();
    body.currentStepId = null;
    expect(projectServerRail(body).currentStepId).toBeNull();
  });
});

describe('catalog independence', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/rail/dealRail');
    vi.resetModules();
  });

  function catalogModule(steps: { id: string; seq: number; title: string; description: string }[]) {
    const rail = [{ id: 'phase-1', index: 1, name: 'Mandate', dealStatus: 'intake', steps }];
    return async (importOriginal: () => Promise<Record<string, unknown>>) => {
      const actual = await importOriginal();
      return {
        ...actual,
        MVP_DEAL_RAIL: rail,
        orderedSteps: () => steps,
        phaseForStep: () => rail[0],
        stepIndexById: () => 0,
      };
    };
  }

  function serverBody() {
    return {
      currentStepId: 'srv-1' as string | null,
      canEditStructure: true,
      canSaveTemplate: false,
      phases: [{ index: 1, name: 'Mandate', dealStatus: 'intake' }],
      steps: [
        {
          id: 'srv-1',
          stepId: 'p1-s1',
          origin: 'catalog' as const,
          phaseIndex: 1,
          displayOrder: 1,
          seq: 1,
          status: 'current' as const,
          definition: null,
          anchorStepId: null,
          removedAt: null,
          removedBy: null,
          skip: null,
        },
        {
          id: 'srv-2',
          stepId: 'custom:xyz',
          origin: 'custom' as const,
          phaseIndex: 1,
          displayOrder: 2,
          seq: null,
          status: 'pending' as const,
          definition: { title: 'Custom step', description: 'A custom step.' },
          anchorStepId: 'srv-1',
          removedAt: null,
          removedBy: null,
          skip: null,
        },
      ],
    };
  }

  it('leaves a project rail structure unchanged when the catalog gains or loses steps, and only the resolved catalog field follows', async () => {
    const body = serverBody();

    vi.resetModules();
    vi.doMock(
      '@/lib/rail/dealRail',
      catalogModule([
        { id: 'p1-s1', seq: 1, title: 'Old title', description: 'Old description' },
      ]),
    );
    const before = await import('@/lib/rail/projectRail');
    const railBeforeCatalogChange = before.projectServerRail(body);

    vi.resetModules();
    vi.doMock(
      '@/lib/rail/dealRail',
      catalogModule([
        { id: 'p1-s1', seq: 1, title: 'New title', description: 'New description' },
        { id: 'p1-s99', seq: 99, title: 'Newly added catalog step', description: 'd' },
      ]),
    );
    const after = await import('@/lib/rail/projectRail');
    const railAfterCatalogChange = after.projectServerRail(body);

    const stripCatalog = (rail: ProjectRail) =>
      rail.steps.map(({ catalog, ...structural }) => structural);

    expect(stripCatalog(railAfterCatalogChange)).toEqual(stripCatalog(railBeforeCatalogChange));
    expect(railAfterCatalogChange.currentStepId).toBe(railBeforeCatalogChange.currentStepId);
    expect(railAfterCatalogChange.phases).toEqual(railBeforeCatalogChange.phases);

    expect(railBeforeCatalogChange.steps[0].catalog?.title).toBe('Old title');
    expect(railAfterCatalogChange.steps[0].catalog?.title).toBe('New title');
    expect(railAfterCatalogChange.steps.find((step) => step.stepId === 'p1-s99')).toBeUndefined();
  });
});
