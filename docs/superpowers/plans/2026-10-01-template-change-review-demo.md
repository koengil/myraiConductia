# Template Change Review Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A flagged, frontend-only demo in which a deal's team sees that its base rail template has a newer revision, reviews each added or removed step in a dialog, and sees accepted changes reflected on the rail.

**Architecture:** A typed contract (`TemplateChangeSet`) in `src/lib/railTemplates/changeReview.ts` is fed by a fixture through `useTemplateChanges`, which stores per-change decisions in localStorage. A pure overlay (`applyTemplateDecisions`) projects accepted decisions onto the server rail before `DealRail` renders it. A banner and a review dialog are the only new surfaces. The backend later replaces the fixture and the storage behind the same hook.

**Tech Stack:** Next.js 16 App Router, React, TypeScript, Tailwind 4 with Workbench CSS variables, Vitest + React Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-01-template-change-review-demo-design.md` (mockup alongside it).

## Global Constraints

- Branch `feat/template-change-review-demo` (already created from `origin/develop`, spec committed). Never commit to `develop` or `main`.
- No migrations, no `/api/v1` changes, no notification enum changes, no decision-log entry.
- Everything is gated by the new flag `template_change_review`; with it off, the rail renders exactly as today.
- No code comments (project rule).
- Visible copy has no em-dashes, uses statements rather than questions, never names the target company.
- Stage explicit paths only; never `git add -A` or `git add .`.
- Use existing atoms: `Button` (`primary | secondary | ghost`, `sm`), `Badge` (`positive | neutral`), `useModalDialog`.
- Before pushing: `git fetch origin && git rebase origin/develop`, then `npm run lint`, `npx tsc --noEmit`, `npm test`.

## Review Focus

1. **A removal the deal already made.** If the deal team already removed LinkedIn Post, the dialog must not offer to remove it again (covered in Task 2 and Task 4).
2. **Storage unavailable** (private window, quota). Decisions must still work for the session, and nothing may throw (Task 3, Task 4).
3. **Read-only viewer.** A user without `canEditStructure` sees the banner and dialog but cannot decide (Task 7, Task 8).
4. **Accepting a removal must not surface the step under "Removed steps"**, whose restore would call the real API (Task 8).
5. **Undo after acceptance** must restore the rail exactly, including the station numbering (Task 2, Task 8).

---

### Task 1: Flag, contract types and fixture

**Files:**
- Modify: `src/lib/flags/keys.ts` (after the `rail_templates` entry)
- Create: `src/lib/railTemplates/changeReview.ts`
- Create: `src/lib/railTemplates/templateChangeFixture.ts`
- Test: `tests/rail/templateChangeFixture.test.ts`

**Interfaces:**
- Produces: flag key `template_change_review`; types `TemplateRevisionRef`, `TemplateChangeSet`, `TemplateChangeAnchor`, `TemplateAddedChange`, `TemplateRemovedChange`, `TemplateChange`, `TemplateChangeDecision`, `TemplateChangeDecisions` from `@/lib/railTemplates/changeReview`; `TEMPLATE_CHANGE_FIXTURE: TemplateChangeSet` from `@/lib/railTemplates/templateChangeFixture`. Fixture change ids: `tpl-fairness-opinion`, `tpl-sanctions-rescreen`, `tpl-remove-linkedin-post`.

- [ ] **Step 1: Write the failing test**

`tests/rail/templateChangeFixture.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { FLAG_REGISTRY } from '@/lib/flags/keys';
import { resolveFlags } from '@/lib/flags/resolveFlags';
import { catalogFor } from '@/lib/rail/projectRail';
import { MVP_DEAL_RAIL, orderedSteps } from '@/lib/rail/dealRail';
import { TEMPLATE_CHANGE_FIXTURE } from '@/lib/railTemplates/templateChangeFixture';

const mvpIds = new Set(orderedSteps(MVP_DEAL_RAIL).map((step) => step.id));

describe('template change review flag', () => {
  it('is registered and fails closed', async () => {
    expect(FLAG_REGISTRY).toHaveProperty('template_change_review');
    const flags = await resolveFlags(async () => []);
    expect(flags.template_change_review).toBe(false);
  });
});

describe('TEMPLATE_CHANGE_FIXTURE', () => {
  it('moves Standard sell-side from v3 to v4', () => {
    expect(TEMPLATE_CHANGE_FIXTURE.template.name).toBe('Standard sell-side');
    expect(TEMPLATE_CHANGE_FIXTURE.baseRevision.label).toBe('v3');
    expect(TEMPLATE_CHANGE_FIXTURE.currentRevision.label).toBe('v4');
    expect(TEMPLATE_CHANGE_FIXTURE.currentRevision.savedBy.name).toBe('Storm Duncan');
  });

  it('anchors every addition and removal on a step of the live rail', () => {
    for (const change of TEMPLATE_CHANGE_FIXTURE.changes) {
      const stepId = change.kind === 'added' ? change.anchor.stepId : change.stepId;
      expect(mvpIds.has(stepId), stepId).toBe(true);
    }
  });

  it('titles each removal with the catalogue title of the step it removes', () => {
    for (const change of TEMPLATE_CHANGE_FIXTURE.changes) {
      if (change.kind !== 'removed') continue;
      expect(change.title).toBe(catalogFor(change.stepId)?.title);
    }
  });

  it('places each change in the phase of its anchor', () => {
    for (const change of TEMPLATE_CHANGE_FIXTURE.changes) {
      const stepId = change.kind === 'added' ? change.anchor.stepId : change.stepId;
      const phase = MVP_DEAL_RAIL.find((p) => p.steps.some((s) => s.id === stepId));
      expect(change.phaseIndex, stepId).toBe(phase?.index);
    }
  });

  it('keeps em-dashes out of visible copy', () => {
    const copy = TEMPLATE_CHANGE_FIXTURE.changes
      .map((change) => (change.kind === 'added' ? `${change.title} ${change.summary}` : change.title))
      .join(' ');
    expect(copy).not.toContain('—');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/rail/templateChangeFixture.test.ts`
Expected: FAIL. `Failed to resolve import "@/lib/railTemplates/templateChangeFixture"`.

- [ ] **Step 3: Add the flag**

In `src/lib/flags/keys.ts`, directly after the `rail_templates` entry:

```ts
  template_change_review: {
    description:
      'Frontend demo of template change review: a banner and dialog on the deal rail offering a fixture set of template changes, decided locally. Off = no banner, no dialog, rail unchanged.',
  },
```

- [ ] **Step 4: Create the contract**

`src/lib/railTemplates/changeReview.ts`:

```ts
export type TemplateRevisionRef = { id: string; label: string; savedAt: string };

export type TemplateChangeAnchor = { position: "after" | "before"; stepId: string };

export type TemplateAddedChange = {
  id: string;
  kind: "added";
  title: string;
  summary: string;
  phaseIndex: number;
  anchor: TemplateChangeAnchor;
};

export type TemplateRemovedChange = {
  id: string;
  kind: "removed";
  stepId: string;
  title: string;
  phaseIndex: number;
};

export type TemplateChange = TemplateAddedChange | TemplateRemovedChange;

export type TemplateChangeSet = {
  template: { id: string; name: string };
  baseRevision: TemplateRevisionRef;
  currentRevision: TemplateRevisionRef & { savedBy: { id: string; name: string } };
  changes: TemplateChange[];
};

export type TemplateChangeDecision = "accepted" | "discarded";

export type TemplateChangeDecisions = Record<string, TemplateChangeDecision>;
```

- [ ] **Step 5: Create the fixture**

`src/lib/railTemplates/templateChangeFixture.ts`:

```ts
import type { TemplateChangeSet } from "./changeReview";

export const TEMPLATE_CHANGE_FIXTURE: TemplateChangeSet = {
  template: { id: "demo-standard-sell-side", name: "Standard sell-side" },
  baseRevision: {
    id: "demo-standard-sell-side-v3",
    label: "v3",
    savedAt: "2026-09-02T15:00:00.000Z",
  },
  currentRevision: {
    id: "demo-standard-sell-side-v4",
    label: "v4",
    savedAt: "2026-09-30T15:00:00.000Z",
    savedBy: { id: "demo-storm-duncan", name: "Storm Duncan" },
  },
  changes: [
    {
      id: "tpl-fairness-opinion",
      kind: "added",
      title: "Fairness opinion",
      summary: "Independent fairness opinion from a qualified adviser before board approval.",
      phaseIndex: 4,
      anchor: { position: "after", stepId: "p4-s50" },
    },
    {
      id: "tpl-sanctions-rescreen",
      kind: "added",
      title: "Sanctions re-screen before signing",
      summary: "Re-run KYC and sanctions screening on the counterparty within 10 days of signing.",
      phaseIndex: 5,
      anchor: { position: "before", stepId: "p5-s51" },
    },
    {
      id: "tpl-remove-linkedin-post",
      kind: "removed",
      stepId: "p5-s53",
      title: "LinkedIn Post",
      phaseIndex: 5,
    },
  ],
};
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/rail/templateChangeFixture.test.ts`
Expected: PASS (5 + 1 tests). If the removal title assertion fails, set the fixture's `title` to the exact `catalogFor('p5-s53')?.title` value, and the phase assertion likewise. The catalogue is the truth.

- [ ] **Step 7: Commit**

```bash
git add src/lib/flags/keys.ts src/lib/railTemplates/changeReview.ts src/lib/railTemplates/templateChangeFixture.ts tests/rail/templateChangeFixture.test.ts
git commit -m "feat(rail-templates): template change contract, fixture and review flag"
```

---

### Task 2: Pure change logic and the rail overlay

**Files:**
- Modify: `src/lib/rail/projectRail.ts` (`ProjectRailStep` type, lines 36-50)
- Modify: `src/lib/railTemplates/changeReview.ts`
- Test: `tests/rail/templateChangeReview.test.ts`

**Interfaces:**
- Consumes: Task 1 types and `TEMPLATE_CHANGE_FIXTURE`.
- Produces:
  - `ProjectRailStep.fromTemplate?: { revisionLabel: string }`
  - `applicableChanges(changeSet: TemplateChangeSet, rail: ProjectRail): TemplateChangeSet`
  - `pendingChanges(changeSet: TemplateChangeSet, decisions: TemplateChangeDecisions): TemplateChange[]`
  - `applyTemplateDecisions(rail: ProjectRail, changeSet: TemplateChangeSet, decisions: TemplateChangeDecisions): ProjectRail`. It returns the same `rail` object when nothing is accepted. An accepted addition becomes a step with `id` and `stepId` equal to `template:<changeId>`.

- [ ] **Step 1: Write the failing test**

`tests/rail/templateChangeReview.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

import { activeSteps, type ProjectRail, type ProjectRailStep } from '@/lib/rail/projectRail';
import {
  applicableChanges,
  applyTemplateDecisions,
  pendingChanges,
} from '@/lib/railTemplates/changeReview';
import { TEMPLATE_CHANGE_FIXTURE } from '@/lib/railTemplates/templateChangeFixture';

function step(
  stepId: string,
  phaseIndex: number,
  displayOrder: number,
  overrides: Partial<ProjectRailStep> = {},
): ProjectRailStep {
  return {
    id: `uuid-${stepId}`,
    stepId,
    origin: 'catalog',
    phaseIndex,
    displayOrder,
    seq: displayOrder,
    status: 'pending',
    definition: null,
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
    ...overrides,
  };
}

function rail(steps: ProjectRailStep[]): ProjectRail {
  return {
    currentStepId: null,
    canEditStructure: true,
    phases: [
      { index: 4, name: 'Diligence, LOI & Definitive Docs', dealStatus: 'active' },
      { index: 5, name: 'Signing, Closing & Post-Close', dealStatus: 'active' },
    ],
    steps,
  };
}

const DEAL = rail([
  step('p4-s49', 4, 49),
  step('p4-s50', 4, 50),
  step('p5-s51', 5, 51),
  step('p5-s52', 5, 52),
  step('p5-s53', 5, 53),
]);

const order = (r: ProjectRail) => activeSteps(r).map((s) => s.stepId);

describe('applyTemplateDecisions', () => {
  it('returns the same rail when nothing is accepted', () => {
    expect(applyTemplateDecisions(DEAL, TEMPLATE_CHANGE_FIXTURE, {})).toBe(DEAL);
    expect(
      applyTemplateDecisions(DEAL, TEMPLATE_CHANGE_FIXTURE, {
        'tpl-fairness-opinion': 'discarded',
        'tpl-remove-linkedin-post': 'discarded',
      }),
    ).toBe(DEAL);
  });

  it('places accepted additions at their anchors without tying', () => {
    const next = applyTemplateDecisions(DEAL, TEMPLATE_CHANGE_FIXTURE, {
      'tpl-fairness-opinion': 'accepted',
      'tpl-sanctions-rescreen': 'accepted',
    });
    expect(order(next)).toEqual([
      'p4-s49',
      'p4-s50',
      'template:tpl-fairness-opinion',
      'template:tpl-sanctions-rescreen',
      'p5-s51',
      'p5-s52',
      'p5-s53',
    ]);
  });

  it('builds an accepted addition as a pending custom step marked with its revision', () => {
    const next = applyTemplateDecisions(DEAL, TEMPLATE_CHANGE_FIXTURE, {
      'tpl-fairness-opinion': 'accepted',
    });
    const added = next.steps.find((s) => s.stepId === 'template:tpl-fairness-opinion');
    expect(added).toMatchObject({
      id: 'template:tpl-fairness-opinion',
      origin: 'custom',
      phaseIndex: 4,
      seq: null,
      status: 'pending',
      removedAt: null,
      skip: null,
      definition: {
        title: 'Fairness opinion',
        description: 'Independent fairness opinion from a qualified adviser before board approval.',
      },
      fromTemplate: { revisionLabel: 'v4' },
    });
  });

  it('puts an addition at the end of its phase when its anchor is absent', () => {
    const withoutAnchor = rail([step('p4-s49', 4, 49), step('p5-s51', 5, 51)]);
    const next = applyTemplateDecisions(withoutAnchor, TEMPLATE_CHANGE_FIXTURE, {
      'tpl-fairness-opinion': 'accepted',
    });
    expect(order(next)).toEqual(['p4-s49', 'template:tpl-fairness-opinion', 'p5-s51']);
  });

  it('ignores an anchor that the deal has removed', () => {
    const anchorRemoved = rail([
      step('p4-s49', 4, 49),
      step('p4-s50', 4, 50, { removedAt: '2026-09-29T10:00:00.000Z' }),
      step('p5-s51', 5, 51),
    ]);
    const next = applyTemplateDecisions(anchorRemoved, TEMPLATE_CHANGE_FIXTURE, {
      'tpl-fairness-opinion': 'accepted',
    });
    expect(order(next)).toEqual(['p4-s49', 'template:tpl-fairness-opinion', 'p5-s51']);
  });

  it('hides a step whose removal is accepted', () => {
    const next = applyTemplateDecisions(DEAL, TEMPLATE_CHANGE_FIXTURE, {
      'tpl-remove-linkedin-post': 'accepted',
    });
    expect(order(next)).not.toContain('p5-s53');
    expect(next.steps.some((s) => s.stepId === 'p5-s53')).toBe(false);
  });

  it('restores the input order once decisions are cleared', () => {
    const decided = applyTemplateDecisions(DEAL, TEMPLATE_CHANGE_FIXTURE, {
      'tpl-fairness-opinion': 'accepted',
      'tpl-remove-linkedin-post': 'accepted',
    });
    expect(order(decided)).not.toEqual(order(DEAL));
    expect(order(applyTemplateDecisions(DEAL, TEMPLATE_CHANGE_FIXTURE, {}))).toEqual(order(DEAL));
  });
});

describe('applicableChanges', () => {
  it('keeps every change when the deal still has the removed step', () => {
    expect(applicableChanges(TEMPLATE_CHANGE_FIXTURE, DEAL).changes).toHaveLength(3);
  });

  it('drops a removal for a step the deal does not have', () => {
    const without = rail([step('p4-s50', 4, 50), step('p5-s51', 5, 51)]);
    const kinds = applicableChanges(TEMPLATE_CHANGE_FIXTURE, without).changes.map((c) => c.id);
    expect(kinds).toEqual(['tpl-fairness-opinion', 'tpl-sanctions-rescreen']);
  });

  it('drops a removal for a step the deal team already removed', () => {
    const removed = rail([
      step('p4-s50', 4, 50),
      step('p5-s53', 5, 53, { removedAt: '2026-09-29T10:00:00.000Z' }),
    ]);
    expect(
      applicableChanges(TEMPLATE_CHANGE_FIXTURE, removed).changes.some((c) => c.kind === 'removed'),
    ).toBe(false);
  });
});

describe('pendingChanges', () => {
  it('lists only undecided changes', () => {
    const pending = pendingChanges(TEMPLATE_CHANGE_FIXTURE, {
      'tpl-fairness-opinion': 'accepted',
      'tpl-remove-linkedin-post': 'discarded',
    });
    expect(pending.map((c) => c.id)).toEqual(['tpl-sanctions-rescreen']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/rail/templateChangeReview.test.ts`
Expected: FAIL. `applicableChanges` and the other functions are not exported.

- [ ] **Step 3: Add the marker to `ProjectRailStep`**

In `src/lib/rail/projectRail.ts`, add the last field of `ProjectRailStep`, after `catalog?: RailStep;`:

```ts
  fromTemplate?: { revisionLabel: string };
```

- [ ] **Step 4: Implement the functions**

Append to `src/lib/railTemplates/changeReview.ts`, and add the import at the top of the file:

```ts
import type { ProjectRail, ProjectRailStep } from "@/lib/rail/projectRail";
```

```ts
function liveSteps(rail: ProjectRail): ProjectRailStep[] {
  return rail.steps.filter((step) => step.removedAt === null);
}

export function applicableChanges(
  changeSet: TemplateChangeSet,
  rail: ProjectRail,
): TemplateChangeSet {
  const live = new Set(liveSteps(rail).map((step) => step.stepId));
  return {
    ...changeSet,
    changes: changeSet.changes.filter(
      (change) => change.kind === "added" || live.has(change.stepId),
    ),
  };
}

export function pendingChanges(
  changeSet: TemplateChangeSet,
  decisions: TemplateChangeDecisions,
): TemplateChange[] {
  return changeSet.changes.filter((change) => decisions[change.id] === undefined);
}

function addedDisplayOrder(rail: ProjectRail, change: TemplateAddedChange): number {
  const live = liveSteps(rail);
  const anchor = live.find((step) => step.stepId === change.anchor.stepId);
  if (anchor) {
    return anchor.displayOrder + (change.anchor.position === "after" ? 1 / 3 : -1 / 3);
  }
  const upToPhase = live
    .filter((step) => step.phaseIndex <= change.phaseIndex)
    .map((step) => step.displayOrder);
  return (upToPhase.length > 0 ? Math.max(...upToPhase) : 0) + 1 / 2;
}

function templateStep(
  rail: ProjectRail,
  change: TemplateAddedChange,
  revisionLabel: string,
): ProjectRailStep {
  return {
    id: `template:${change.id}`,
    stepId: `template:${change.id}`,
    origin: "custom",
    phaseIndex: change.phaseIndex,
    displayOrder: addedDisplayOrder(rail, change),
    seq: null,
    status: "pending",
    definition: { title: change.title, description: change.summary },
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
    fromTemplate: { revisionLabel },
  };
}

export function applyTemplateDecisions(
  rail: ProjectRail,
  changeSet: TemplateChangeSet,
  decisions: TemplateChangeDecisions,
): ProjectRail {
  const accepted = changeSet.changes.filter((change) => decisions[change.id] === "accepted");
  if (accepted.length === 0) return rail;
  const removedStepIds = new Set(
    accepted.flatMap((change) => (change.kind === "removed" ? [change.stepId] : [])),
  );
  const added = accepted.flatMap((change) =>
    change.kind === "added"
      ? [templateStep(rail, change, changeSet.currentRevision.label)]
      : [],
  );
  return {
    ...rail,
    steps: [
      ...rail.steps.filter(
        (step) => !(step.removedAt === null && removedStepIds.has(step.stepId)),
      ),
      ...added,
    ],
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/rail/templateChangeReview.test.ts tests/rail/templateChangeFixture.test.ts tests/rail/projectRail.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit`. Expected: no errors.

```bash
git add src/lib/rail/projectRail.ts src/lib/railTemplates/changeReview.ts tests/rail/templateChangeReview.test.ts
git commit -m "feat(rail-templates): apply template change decisions to the rail"
```

---

### Task 3: Decision storage

**Files:**
- Create: `src/lib/railTemplates/templateChangeDecisions.ts`
- Test: `tests/rail/templateChangeDecisions.test.ts`

**Interfaces:**
- Consumes: `TemplateChangeDecision`, `TemplateChangeDecisions` (Task 1).
- Produces:
  - `TEMPLATE_CHANGES_EVENT = "ib:template-changes"`
  - `readDecisions(dealId: string, revisionId: string): TemplateChangeDecisions`
  - `recordDecision(dealId, revisionId, changeId, decision): boolean`
  - `clearDecision(dealId, revisionId, changeId): boolean`
  - The boolean is `true` when the write was stored. The event fires only after a stored write.

- [ ] **Step 1: Write the failing test**

`tests/rail/templateChangeDecisions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  TEMPLATE_CHANGES_EVENT,
  clearDecision,
  readDecisions,
  recordDecision,
} from '@/lib/railTemplates/templateChangeDecisions';

describe('template change decisions storage', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('reads back a recorded decision', () => {
    expect(recordDecision('deal-1', 'rev-4', 'tpl-a', 'accepted')).toBe(true);
    expect(readDecisions('deal-1', 'rev-4')).toEqual({ 'tpl-a': 'accepted' });
  });

  it('keys decisions by deal and revision', () => {
    recordDecision('deal-1', 'rev-4', 'tpl-a', 'accepted');
    expect(readDecisions('deal-2', 'rev-4')).toEqual({});
    expect(readDecisions('deal-1', 'rev-5')).toEqual({});
  });

  it('clears one decision and keeps the others', () => {
    recordDecision('deal-1', 'rev-4', 'tpl-a', 'accepted');
    recordDecision('deal-1', 'rev-4', 'tpl-b', 'discarded');
    clearDecision('deal-1', 'rev-4', 'tpl-a');
    expect(readDecisions('deal-1', 'rev-4')).toEqual({ 'tpl-b': 'discarded' });
  });

  it('announces a stored write', () => {
    const listener = vi.fn();
    window.addEventListener(TEMPLATE_CHANGES_EVENT, listener);
    recordDecision('deal-1', 'rev-4', 'tpl-a', 'accepted');
    window.removeEventListener(TEMPLATE_CHANGES_EVENT, listener);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('treats malformed storage as no decisions', () => {
    window.localStorage.setItem('ib-template-changes:deal-1:rev-4', '{not json');
    expect(readDecisions('deal-1', 'rev-4')).toEqual({});
    window.localStorage.setItem('ib-template-changes:deal-1:rev-4', '["accepted"]');
    expect(readDecisions('deal-1', 'rev-4')).toEqual({});
  });

  it('drops stored values that are not decisions', () => {
    window.localStorage.setItem(
      'ib-template-changes:deal-1:rev-4',
      JSON.stringify({ 'tpl-a': 'accepted', 'tpl-b': 'maybe', 'tpl-c': 3 }),
    );
    expect(readDecisions('deal-1', 'rev-4')).toEqual({ 'tpl-a': 'accepted' });
  });

  it('reports a failed write without throwing or announcing it', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const listener = vi.fn();
    window.addEventListener(TEMPLATE_CHANGES_EVENT, listener);
    expect(recordDecision('deal-1', 'rev-4', 'tpl-a', 'accepted')).toBe(false);
    window.removeEventListener(TEMPLATE_CHANGES_EVENT, listener);
    expect(listener).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/rail/templateChangeDecisions.test.ts`
Expected: FAIL. The module cannot be resolved.

- [ ] **Step 3: Implement**

`src/lib/railTemplates/templateChangeDecisions.ts`:

```ts
import type { TemplateChangeDecision, TemplateChangeDecisions } from "./changeReview";

export const TEMPLATE_CHANGES_EVENT = "ib:template-changes";

const key = (dealId: string, revisionId: string) =>
  `ib-template-changes:${dealId}:${revisionId}`;

function isDecision(value: unknown): value is TemplateChangeDecision {
  return value === "accepted" || value === "discarded";
}

export function readDecisions(dealId: string, revisionId: string): TemplateChangeDecisions {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(key(dealId, revisionId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => isDecision(value)),
    ) as TemplateChangeDecisions;
  } catch {
    return {};
  }
}

function writeDecisions(
  dealId: string,
  revisionId: string,
  decisions: TemplateChangeDecisions,
): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(key(dealId, revisionId), JSON.stringify(decisions));
  } catch {
    return false;
  }
  window.dispatchEvent(new Event(TEMPLATE_CHANGES_EVENT));
  return true;
}

export function recordDecision(
  dealId: string,
  revisionId: string,
  changeId: string,
  decision: TemplateChangeDecision,
): boolean {
  return writeDecisions(dealId, revisionId, {
    ...readDecisions(dealId, revisionId),
    [changeId]: decision,
  });
}

export function clearDecision(dealId: string, revisionId: string, changeId: string): boolean {
  const remaining = Object.fromEntries(
    Object.entries(readDecisions(dealId, revisionId)).filter(([id]) => id !== changeId),
  ) as TemplateChangeDecisions;
  return writeDecisions(dealId, revisionId, remaining);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/rail/templateChangeDecisions.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/railTemplates/templateChangeDecisions.ts tests/rail/templateChangeDecisions.test.ts
git commit -m "feat(rail-templates): store template change decisions per deal and revision"
```

---

### Task 4: `useTemplateChanges` hook

**Files:**
- Create: `src/lib/railTemplates/useTemplateChanges.ts`
- Test: `tests/rail/useTemplateChanges.test.tsx`

**Interfaces:**
- Consumes: `useFlag` from `@/lib/flags/FlagsContext`, `TEMPLATE_CHANGE_FIXTURE`, `applicableChanges`, `pendingChanges`, and the Task 3 storage functions.
- Produces: `useTemplateChanges(projectId: string, rail: ProjectRail | null): TemplateChangesState`, where

```ts
type TemplateChangesState = {
  changeSet: TemplateChangeSet | null;
  pending: TemplateChange[];
  decisions: TemplateChangeDecisions;
  decide: (changeId: string, decision: TemplateChangeDecision) => void;
  undo: (changeId: string) => void;
};
```

  `changeSet` is `null` when the flag is off or the rail has not loaded. It is filtered by `applicableChanges` against the **unmodified** rail.

- [ ] **Step 1: Write the failing test**

`tests/rail/useTemplateChanges.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import type { ProjectRail, ProjectRailStep } from '@/lib/rail/projectRail';

const flags = { review: true };

vi.mock('@/lib/flags/FlagsContext', () => ({
  useFlag: (key: string) => (key === 'template_change_review' ? flags.review : false),
}));

import { useTemplateChanges } from '@/lib/railTemplates/useTemplateChanges';

function step(stepId: string, phaseIndex: number, displayOrder: number): ProjectRailStep {
  return {
    id: `uuid-${stepId}`,
    stepId,
    origin: 'catalog',
    phaseIndex,
    displayOrder,
    seq: displayOrder,
    status: 'pending',
    definition: null,
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
  };
}

function rail(steps: ProjectRailStep[]): ProjectRail {
  return { currentStepId: null, canEditStructure: true, phases: [], steps };
}

const DEAL = rail([step('p4-s50', 4, 50), step('p5-s51', 5, 51), step('p5-s53', 5, 53)]);

describe('useTemplateChanges', () => {
  beforeEach(() => {
    flags.review = true;
    window.localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('offers nothing with the flag off', () => {
    flags.review = false;
    const { result } = renderHook(() => useTemplateChanges('deal-1', DEAL));
    expect(result.current.changeSet).toBeNull();
    expect(result.current.pending).toEqual([]);
  });

  it('offers nothing before the rail loads', () => {
    const { result } = renderHook(() => useTemplateChanges('deal-1', null));
    expect(result.current.changeSet).toBeNull();
  });

  it('offers every applicable change as pending', () => {
    const { result } = renderHook(() => useTemplateChanges('deal-1', DEAL));
    expect(result.current.pending.map((c) => c.id)).toEqual([
      'tpl-fairness-opinion',
      'tpl-sanctions-rescreen',
      'tpl-remove-linkedin-post',
    ]);
  });

  it('does not offer a removal for a step the deal lacks', () => {
    const without = rail([step('p4-s50', 4, 50), step('p5-s51', 5, 51)]);
    const { result } = renderHook(() => useTemplateChanges('deal-1', without));
    expect(result.current.pending.some((c) => c.kind === 'removed')).toBe(false);
  });

  it('records a decision, persists it across remounts and undoes it', () => {
    const first = renderHook(() => useTemplateChanges('deal-1', DEAL));
    act(() => first.result.current.decide('tpl-fairness-opinion', 'accepted'));
    expect(first.result.current.decisions).toEqual({ 'tpl-fairness-opinion': 'accepted' });
    expect(first.result.current.pending).toHaveLength(2);
    first.unmount();

    const second = renderHook(() => useTemplateChanges('deal-1', DEAL));
    expect(second.result.current.decisions).toEqual({ 'tpl-fairness-opinion': 'accepted' });
    act(() => second.result.current.undo('tpl-fairness-opinion'));
    expect(second.result.current.decisions).toEqual({});
    expect(second.result.current.pending).toHaveLength(3);
  });

  it('keeps decisions of one deal away from another', () => {
    const one = renderHook(() => useTemplateChanges('deal-1', DEAL));
    act(() => one.result.current.decide('tpl-fairness-opinion', 'accepted'));
    const two = renderHook(() => useTemplateChanges('deal-2', DEAL));
    expect(two.result.current.decisions).toEqual({});
  });

  it('keeps two consumers of the same deal in step', () => {
    const one = renderHook(() => useTemplateChanges('deal-1', DEAL));
    const two = renderHook(() => useTemplateChanges('deal-1', DEAL));
    act(() => one.result.current.decide('tpl-remove-linkedin-post', 'discarded'));
    expect(two.result.current.decisions).toEqual({ 'tpl-remove-linkedin-post': 'discarded' });
  });

  it('still records decisions in the session when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useTemplateChanges('deal-1', DEAL));
    act(() => result.current.decide('tpl-fairness-opinion', 'accepted'));
    expect(result.current.decisions).toEqual({ 'tpl-fairness-opinion': 'accepted' });
    act(() => result.current.undo('tpl-fairness-opinion'));
    expect(result.current.decisions).toEqual({});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/rail/useTemplateChanges.test.tsx`
Expected: FAIL. The module cannot be resolved.

- [ ] **Step 3: Implement**

`src/lib/railTemplates/useTemplateChanges.ts`:

```ts
"use client";

import * as React from "react";

import { useFlag } from "@/lib/flags/FlagsContext";
import type { ProjectRail } from "@/lib/rail/projectRail";

import {
  applicableChanges,
  pendingChanges,
  type TemplateChange,
  type TemplateChangeDecision,
  type TemplateChangeDecisions,
  type TemplateChangeSet,
} from "./changeReview";
import {
  TEMPLATE_CHANGES_EVENT,
  clearDecision,
  readDecisions,
  recordDecision,
} from "./templateChangeDecisions";
import { TEMPLATE_CHANGE_FIXTURE } from "./templateChangeFixture";

export type TemplateChangesState = {
  changeSet: TemplateChangeSet | null;
  pending: TemplateChange[];
  decisions: TemplateChangeDecisions;
  decide: (changeId: string, decision: TemplateChangeDecision) => void;
  undo: (changeId: string) => void;
};

const NO_DECISIONS: TemplateChangeDecisions = {};

export function useTemplateChanges(
  projectId: string,
  rail: ProjectRail | null,
): TemplateChangesState {
  const enabled = useFlag("template_change_review");
  const source = enabled ? TEMPLATE_CHANGE_FIXTURE : null;
  const revisionId = source?.currentRevision.id ?? null;
  const scope = revisionId ? `${projectId}:${revisionId}` : null;

  const [stored, setStored] = React.useState<{
    scope: string;
    decisions: TemplateChangeDecisions;
  } | null>(null);

  React.useEffect(() => {
    if (!revisionId) return;
    const sync = () =>
      setStored({
        scope: `${projectId}:${revisionId}`,
        decisions: readDecisions(projectId, revisionId),
      });
    sync();
    window.addEventListener(TEMPLATE_CHANGES_EVENT, sync);
    return () => window.removeEventListener(TEMPLATE_CHANGES_EVENT, sync);
  }, [projectId, revisionId]);

  const decisions =
    scope !== null && stored?.scope === scope ? stored.decisions : NO_DECISIONS;

  const changeSet = React.useMemo(
    () => (source && rail ? applicableChanges(source, rail) : null),
    [source, rail],
  );

  const pending = React.useMemo(
    () => (changeSet ? pendingChanges(changeSet, decisions) : []),
    [changeSet, decisions],
  );

  const decide = React.useCallback(
    (changeId: string, decision: TemplateChangeDecision) => {
      if (!revisionId || scope === null) return;
      setStored((prev) => ({
        scope,
        decisions: {
          ...(prev?.scope === scope ? prev.decisions : {}),
          [changeId]: decision,
        },
      }));
      recordDecision(projectId, revisionId, changeId, decision);
    },
    [projectId, revisionId, scope],
  );

  const undo = React.useCallback(
    (changeId: string) => {
      if (!revisionId || scope === null) return;
      setStored((prev) => ({
        scope,
        decisions: Object.fromEntries(
          Object.entries(prev?.scope === scope ? prev.decisions : {}).filter(
            ([id]) => id !== changeId,
          ),
        ) as TemplateChangeDecisions,
      }));
      clearDecision(projectId, revisionId, changeId);
    },
    [projectId, revisionId, scope],
  );

  return { changeSet, pending, decisions, decide, undo };
}
```

Note: a stored write dispatches the event, and every consumer re-reads storage. When the write fails, no event fires and the local `setStored` keeps the session state. That is what the last test pins.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/rail/useTemplateChanges.test.tsx`
Expected: PASS (8 tests).

- [ ] **Step 5: Lint and commit**

Run: `npx eslint src/lib/railTemplates/useTemplateChanges.ts`. Expected: clean. If `react-hooks/set-state-in-effect` flags the `sync()` call, follow the same shape `DealRail.tsx` uses for `RAIL_RUN_EVENT` (`sync(); addEventListener`). If the rule still fires, move the initial read into a `useSyncExternalStore` subscription with `TEMPLATE_CHANGES_EVENT`. Do not add an eslint-disable comment.

```bash
git add src/lib/railTemplates/useTemplateChanges.ts tests/rail/useTemplateChanges.test.tsx
git commit -m "feat(rail-templates): useTemplateChanges hook over the fixture change set"
```

---

### Task 5: Template steps on the station card and in Focus

**Files:**
- Modify: `src/components/rail/StationCard.tsx` (`CustomStepPanel` ~lines 202-245; `StationCard` ~lines 251-367)
- Modify: `src/components/rail/StepFocus.tsx` (~line 107, the `onRemoved ?` block)
- Test: `tests/rail/templateChangeStation.test.tsx`

**Interfaces:**
- Consumes: `ProjectRailStep.fromTemplate` (Task 2).
- Produces: `FROM_TEMPLATE_CHIP` (exported class string) and the visible chip text `From template <revisionLabel>`. A step with `fromTemplate` has no remove control on the card or in Focus, and no skill runner and no Mark complete in `CustomStepPanel`.

- [ ] **Step 1: Write the failing test**

`tests/rail/templateChangeStation.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { ProjectRailStep } from '@/lib/rail/projectRail';

vi.mock('@/lib/flags/FlagsContext', () => ({ useFlag: () => true }));
vi.mock('@/components/rail/SkillStepRunner', () => ({
  SkillStepRunner: () => <div data-testid="skill-runner" />,
}));

import { CustomStepPanel, StationCard } from '@/components/rail/StationCard';

function step(overrides: Partial<ProjectRailStep> = {}): ProjectRailStep {
  return {
    id: 'template:tpl-fairness-opinion',
    stepId: 'template:tpl-fairness-opinion',
    origin: 'custom',
    phaseIndex: 4,
    displayOrder: 50.3,
    seq: null,
    status: 'pending',
    definition: { title: 'Fairness opinion', description: 'Independent opinion.' },
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
    ...overrides,
  };
}

describe('StationCard for a template step', () => {
  it('shows the template chip and no remove control', () => {
    render(
      <StationCard
        step={step({ fromTemplate: { revisionLabel: 'v4' } })}
        projectId="deal-1"
        canRemove
        onRemoved={vi.fn()}
      />,
    );
    expect(screen.getByText('From template v4')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^remove/i })).not.toBeInTheDocument();
  });

  it('keeps the remove control on an ordinary custom step', () => {
    render(<StationCard step={step()} projectId="deal-1" canRemove onRemoved={vi.fn()} />);
    expect(screen.queryByText(/From template/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^remove/i })).toBeInTheDocument();
  });
});

describe('CustomStepPanel for a template step', () => {
  it('hides the runner and completion', () => {
    render(
      <CustomStepPanel
        step={step({ fromTemplate: { revisionLabel: 'v4' } })}
        state="todo"
        dealId="deal-1"
        onComplete={vi.fn()}
      />,
    );
    expect(screen.getByText('From template v4')).toBeInTheDocument();
    expect(screen.queryByTestId('skill-runner')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark complete' })).not.toBeInTheDocument();
  });

  it('keeps the runner and completion on an ordinary custom step', () => {
    render(<CustomStepPanel step={step()} state="todo" dealId="deal-1" onComplete={vi.fn()} />);
    expect(screen.getByTestId('skill-runner')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark complete' })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/rail/templateChangeStation.test.tsx`
Expected: FAIL. `From template v4` is not found.

If the "ordinary custom step" remove assertion fails because `RemoveStepControl`'s button has a different accessible name, read `src/components/rail/RemoveStepControl.tsx`, use its real name in both tests, and re-run until only the template-step tests fail.

- [ ] **Step 3: Implement in `StationCard.tsx`**

Add the export after `STATION_STATE_CHIP`:

```ts
export const FROM_TEMPLATE_CHIP =
  'inline-flex rounded-[6px] bg-[color-mix(in_srgb,var(--sync)_14%,transparent)] px-1.5 py-px text-[length:var(--text-xxs)] font-medium text-[var(--sync)]';
```

In `CustomStepPanel`, replace `const canRun = useFlag('skill_authoring');` with:

```ts
  const fromTemplate = step.fromTemplate;
  const canRun = useFlag('skill_authoring') && !fromTemplate;
```

Then change its header chip span to:

```tsx
        <span className="flex shrink-0 items-center gap-1">
          {fromTemplate ? (
            <span className={FROM_TEMPLATE_CHIP}>From template {fromTemplate.revisionLabel}</span>
          ) : null}
          <span className={STATION_STATE_CHIP[state]}>{STATION_STATE_LABEL[state]}</span>
        </span>
```

and the Mark complete condition to `{state !== 'done' && state !== 'skipped' && !fromTemplate ? (`.

In `StationCard`, after the `<p …>{mode}</p>` line inside the button, add:

```tsx
        {step.fromTemplate ? (
          <span className={`mt-1 self-start ${FROM_TEMPLATE_CHIP}`}>
            From template {step.fromTemplate.revisionLabel}
          </span>
        ) : null}
```

and change the remove footer condition from `{projectId && onRemoved ? (` to `{projectId && onRemoved && !step.fromTemplate ? (`.

- [ ] **Step 4: Implement in `StepFocus.tsx`**

Change `{onRemoved ? (` (the block that renders `RemoveStepControl`) to `{onRemoved && !step.fromTemplate ? (`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/rail/templateChangeStation.test.tsx tests/rail-ui.test.tsx tests/rail/removeStep.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/rail/StationCard.tsx src/components/rail/StepFocus.tsx tests/rail/templateChangeStation.test.tsx
git commit -m "feat(rail): mark template steps and hide controls that need a server step"
```

---

### Task 6: `TemplateChangeBanner`

**Files:**
- Create: `src/components/rail/TemplateChangeBanner.tsx`
- Test: `tests/rail/templateChangeBanner.test.tsx`

**Interfaces:**
- Consumes: `TemplateChangeSet`, `TEMPLATE_CHANGE_FIXTURE`, `Button`.
- Produces:
  - `formatRevisionDate(iso: string): string`, for example `"Sep 30"` (UTC)
  - `TemplateChangeBanner({ changeSet, pendingCount, onReview }: { changeSet: TemplateChangeSet; pendingCount: number; onReview: () => void })`. It renders `null` when `pendingCount === 0`. Region: `role="status"`, `aria-label="Template updated"`.

- [ ] **Step 1: Write the failing test**

`tests/rail/templateChangeBanner.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { TemplateChangeBanner, formatRevisionDate } from '@/components/rail/TemplateChangeBanner';
import { TEMPLATE_CHANGE_FIXTURE } from '@/lib/railTemplates/templateChangeFixture';

describe('TemplateChangeBanner', () => {
  it('states the revision, author and pending count', () => {
    render(
      <TemplateChangeBanner changeSet={TEMPLATE_CHANGE_FIXTURE} pendingCount={3} onReview={vi.fn()} />,
    );
    const banner = screen.getByRole('status', { name: 'Template updated' });
    expect(banner).toHaveTextContent(
      'Standard sell-side moved to v4 on Sep 30 (Storm Duncan). 3 changes wait for your decision. Your rail stays as it is until you choose.',
    );
    expect(banner.textContent).not.toContain('—');
  });

  it('uses the singular for one change', () => {
    render(
      <TemplateChangeBanner changeSet={TEMPLATE_CHANGE_FIXTURE} pendingCount={1} onReview={vi.fn()} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('1 change waits for your decision.');
  });

  it('renders nothing once every change is decided', () => {
    const { container } = render(
      <TemplateChangeBanner changeSet={TEMPLATE_CHANGE_FIXTURE} pendingCount={0} onReview={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('opens the review from its button', () => {
    const onReview = vi.fn();
    render(
      <TemplateChangeBanner changeSet={TEMPLATE_CHANGE_FIXTURE} pendingCount={3} onReview={onReview} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it('formats revision dates in UTC', () => {
    expect(formatRevisionDate('2026-09-30T23:30:00.000Z')).toBe('Sep 30');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/rail/templateChangeBanner.test.tsx`
Expected: FAIL. The module cannot be resolved.

- [ ] **Step 3: Implement**

`src/components/rail/TemplateChangeBanner.tsx`:

```tsx
"use client";

import * as React from "react";

import { Button } from "@/components/atoms/Button";
import type { TemplateChangeSet } from "@/lib/railTemplates/changeReview";

export function formatRevisionDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function TemplateChangeBanner({
  changeSet,
  pendingCount,
  onReview,
}: {
  changeSet: TemplateChangeSet;
  pendingCount: number;
  onReview: () => void;
}) {
  if (pendingCount === 0) return null;
  const { template, currentRevision } = changeSet;
  const waiting =
    pendingCount === 1 ? "1 change waits" : `${pendingCount} changes wait`;
  const body = `${template.name} moved to ${currentRevision.label} on ${formatRevisionDate(currentRevision.savedAt)} (${currentRevision.savedBy.name}). ${waiting} for your decision. Your rail stays as it is until you choose.`;

  return (
    <div
      role="status"
      aria-label="Template updated"
      className="mb-[var(--space-4)] flex flex-wrap items-center justify-between gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface-raised)] px-[var(--space-4)] py-[var(--space-3)]"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-mono text-[length:var(--text-xs)] uppercase tracking-[0.04em] text-[var(--ink-tertiary)]">
          Template updated
        </p>
        <p className="text-[length:var(--text-sm)] text-[var(--ink)]">{body}</p>
      </div>
      <Button variant="secondary" size="sm" onClick={onReview}>
        Review changes
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/rail/templateChangeBanner.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/rail/TemplateChangeBanner.tsx tests/rail/templateChangeBanner.test.tsx
git commit -m "feat(rail): template updated banner"
```

---

### Task 7: `TemplateChangesDialog`

**Files:**
- Create: `src/components/rail/TemplateChangesDialog.tsx`
- Test: `tests/rail/templateChangesDialog.test.tsx`

**Interfaces:**
- Consumes: `formatRevisionDate` (Task 6), `stepTitle` and `ProjectRail` from `@/lib/rail/projectRail`, the Task 1 types, `Badge`, `Button`, `useModalDialog`.
- Produces: `TemplateChangesDialog`, which takes these props:

```ts
{
  changeSet: TemplateChangeSet;
  decisions: TemplateChangeDecisions;
  rail: ProjectRail;
  canDecide: boolean;
  onDecide: (changeId: string, decision: TemplateChangeDecision) => void;
  onUndo: (changeId: string) => void;
  onClose: () => void;
}
```

  Its button accessible names are `Add <title>`, `Discard <title>`, `Remove <title>`, `Keep <title>`, `Undo <title>` and `Close`.

- [ ] **Step 1: Write the failing test**

`tests/rail/templateChangesDialog.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { TemplateChangesDialog } from '@/components/rail/TemplateChangesDialog';
import type { ProjectRail, ProjectRailStep } from '@/lib/rail/projectRail';
import type { TemplateChangeDecisions } from '@/lib/railTemplates/changeReview';
import { TEMPLATE_CHANGE_FIXTURE } from '@/lib/railTemplates/templateChangeFixture';

function step(stepId: string, title: string, phaseIndex: number, displayOrder: number): ProjectRailStep {
  return {
    id: `uuid-${stepId}`,
    stepId,
    origin: 'custom',
    phaseIndex,
    displayOrder,
    seq: null,
    status: 'pending',
    definition: { title, description: '' },
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
  };
}

const RAIL: ProjectRail = {
  currentStepId: null,
  canEditStructure: true,
  phases: [
    { index: 4, name: 'Diligence, LOI & Definitive Docs', dealStatus: 'active' },
    { index: 5, name: 'Signing, Closing & Post-Close', dealStatus: 'active' },
  ],
  steps: [
    step('p4-s50', 'Definitive Agreement Support', 4, 50),
    step('p5-s51', 'Signing / Announcement Prep', 5, 51),
    step('p5-s53', 'LinkedIn Post', 5, 53),
  ],
};

function renderDialog(decisions: TemplateChangeDecisions = {}, canDecide = true) {
  const handlers = { onDecide: vi.fn(), onUndo: vi.fn(), onClose: vi.fn() };
  render(
    <TemplateChangesDialog
      changeSet={TEMPLATE_CHANGE_FIXTURE}
      decisions={decisions}
      rail={RAIL}
      canDecide={canDecide}
      {...handlers}
    />,
  );
  return handlers;
}

describe('TemplateChangesDialog', () => {
  it('names the template, the revision step and its author', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Standard sell-side · v3 → v4' });
    expect(dialog).toHaveTextContent('Saved Sep 30 by Storm Duncan');
    expect(dialog.textContent).not.toContain('—');
  });

  it('places additions and removals in their own sections with position lines', () => {
    renderDialog();
    const added = screen.getByRole('region', { name: 'Added to the template' });
    expect(added).toHaveTextContent('Fairness opinion');
    expect(added).toHaveTextContent('Diligence, LOI & Definitive Docs · After Definitive Agreement Support');
    expect(added).toHaveTextContent('Signing, Closing & Post-Close · Before Signing / Announcement Prep');
    expect(added).toHaveTextContent('Independent fairness opinion from a qualified adviser before board approval.');
    const removed = screen.getByRole('region', { name: 'Removed from the template' });
    expect(removed).toHaveTextContent('LinkedIn Post');
    expect(removed).toHaveTextContent('Signing, Closing & Post-Close · On your rail today');
  });

  it('records each of the four decisions', () => {
    const { onDecide } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Add Fairness opinion' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard Sanctions re-screen before signing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove LinkedIn Post' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep LinkedIn Post' }));
    expect(onDecide.mock.calls).toEqual([
      ['tpl-fairness-opinion', 'accepted'],
      ['tpl-sanctions-rescreen', 'discarded'],
      ['tpl-remove-linkedin-post', 'accepted'],
      ['tpl-remove-linkedin-post', 'discarded'],
    ]);
  });

  it('collapses decided rows to a badge with undo', () => {
    const { onUndo } = renderDialog({
      'tpl-fairness-opinion': 'accepted',
      'tpl-sanctions-rescreen': 'discarded',
      'tpl-remove-linkedin-post': 'discarded',
    });
    const added = screen.getByRole('region', { name: 'Added to the template' });
    expect(within(added).getByText('Added')).toBeInTheDocument();
    expect(within(added).getByText('Discarded')).toBeInTheDocument();
    expect(within(added).queryByRole('button', { name: 'Add Fairness opinion' })).not.toBeInTheDocument();
    const removed = screen.getByRole('region', { name: 'Removed from the template' });
    expect(within(removed).getByText('Kept')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo Fairness opinion' }));
    expect(onUndo).toHaveBeenCalledWith('tpl-fairness-opinion');
  });

  it('labels an accepted removal as removed', () => {
    renderDialog({ 'tpl-remove-linkedin-post': 'accepted' });
    const removed = screen.getByRole('region', { name: 'Removed from the template' });
    expect(within(removed).getByText('Removed')).toBeInTheDocument();
  });

  it('says where an addition goes when its anchor is missing', () => {
    render(
      <TemplateChangesDialog
        changeSet={TEMPLATE_CHANGE_FIXTURE}
        decisions={{}}
        rail={{ ...RAIL, steps: RAIL.steps.filter((s) => s.stepId !== 'p4-s50') }}
        canDecide
        onDecide={vi.fn()}
        onUndo={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('region', { name: 'Added to the template' })).toHaveTextContent(
      'Diligence, LOI & Definitive Docs · End of phase',
    );
  });

  it('disables decisions for a reader without structural authority', () => {
    const { onDecide } = renderDialog({}, false);
    expect(screen.getByText('Only the deal team can change this rail.')).toBeInTheDocument();
    const add = screen.getByRole('button', { name: 'Add Fairness opinion' });
    expect(add).toBeDisabled();
    fireEvent.click(add);
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('closes from the close button and from Escape', () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('states that nothing changes until the team decides', () => {
    renderDialog();
    expect(
      screen.getByText(
        'Nothing changes on your rail until you decide. Discarded changes are not offered again for this version.',
      ),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/rail/templateChangesDialog.test.tsx`
Expected: FAIL. The module cannot be resolved.

- [ ] **Step 3: Implement**

`src/components/rail/TemplateChangesDialog.tsx`:

```tsx
"use client";

import * as React from "react";

import { Badge } from "@/components/atoms/Badge";
import { Button } from "@/components/atoms/Button";
import { stepTitle, type ProjectRail } from "@/lib/rail/projectRail";
import type {
  TemplateChange,
  TemplateChangeDecision,
  TemplateChangeDecisions,
  TemplateChangeSet,
} from "@/lib/railTemplates/changeReview";
import { useModalDialog } from "@/lib/ui/useModalDialog";

import { formatRevisionDate } from "./TemplateChangeBanner";

const FOOTER_TEXT =
  "Nothing changes on your rail until you decide. Discarded changes are not offered again for this version.";
const READ_ONLY_TEXT = "Only the deal team can change this rail.";

const ACTION_LABEL: Record<TemplateChange["kind"], { accept: string; discard: string }> = {
  added: { accept: "Add", discard: "Discard" },
  removed: { accept: "Remove", discard: "Keep" },
};

const DECIDED: Record<
  TemplateChange["kind"],
  Record<TemplateChangeDecision, { label: string; tone: "positive" | "neutral" }>
> = {
  added: {
    accepted: { label: "Added", tone: "positive" },
    discarded: { label: "Discarded", tone: "neutral" },
  },
  removed: {
    accepted: { label: "Removed", tone: "positive" },
    discarded: { label: "Kept", tone: "neutral" },
  },
};

function phaseName(rail: ProjectRail, index: number): string {
  return rail.phases.find((phase) => phase.index === index)?.name ?? `Phase ${index}`;
}

function changeMeta(rail: ProjectRail, change: TemplateChange): string {
  const phase = phaseName(rail, change.phaseIndex);
  if (change.kind === "removed") return `${phase} · On your rail today`;
  const anchor = rail.steps.find(
    (step) => step.removedAt === null && step.stepId === change.anchor.stepId,
  );
  if (!anchor) return `${phase} · End of phase`;
  const position = change.anchor.position === "after" ? "After" : "Before";
  return `${phase} · ${position} ${stepTitle(anchor)}`;
}

function ChangeRow({
  change,
  decision,
  meta,
  canDecide,
  onDecide,
  onUndo,
}: {
  change: TemplateChange;
  decision: TemplateChangeDecision | undefined;
  meta: string;
  canDecide: boolean;
  onDecide: (changeId: string, decision: TemplateChangeDecision) => void;
  onUndo: (changeId: string) => void;
}) {
  const actions = ACTION_LABEL[change.kind];
  return (
    <li className="rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)]">
      <div className="flex flex-wrap items-start justify-between gap-[var(--space-3)]">
        <div className="min-w-0 flex-1">
          <p className="text-[length:var(--text-sm)] font-semibold text-[var(--ink)]">
            {change.title}
          </p>
          <p className="mt-0.5 font-mono text-[length:var(--text-xxs)] text-[var(--ink-tertiary)]">
            {meta}
          </p>
          {change.kind === "added" && decision === undefined ? (
            <p className="mt-1 text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
              {change.summary}
            </p>
          ) : null}
        </div>
        {decision ? (
          <div className="flex shrink-0 items-center gap-[var(--space-2)]">
            <Badge tone={DECIDED[change.kind][decision].tone}>
              {DECIDED[change.kind][decision].label}
            </Badge>
            <button
              type="button"
              disabled={!canDecide}
              onClick={() => onUndo(change.id)}
              aria-label={`Undo ${change.title}`}
              className="text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)] underline underline-offset-2 hover:text-[var(--ink)] disabled:opacity-60"
            >
              Undo
            </button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-[var(--space-2)]">
            <Button
              variant="primary"
              size="sm"
              disabled={!canDecide}
              onClick={() => onDecide(change.id, "accepted")}
              aria-label={`${actions.accept} ${change.title}`}
            >
              {actions.accept}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!canDecide}
              onClick={() => onDecide(change.id, "discarded")}
              aria-label={`${actions.discard} ${change.title}`}
            >
              {actions.discard}
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}

function ChangeSection({
  id,
  title,
  changes,
  rail,
  decisions,
  canDecide,
  onDecide,
  onUndo,
}: {
  id: string;
  title: string;
  changes: TemplateChange[];
  rail: ProjectRail;
  decisions: TemplateChangeDecisions;
  canDecide: boolean;
  onDecide: (changeId: string, decision: TemplateChangeDecision) => void;
  onUndo: (changeId: string) => void;
}) {
  if (changes.length === 0) return null;
  return (
    <section aria-labelledby={id} className="mt-[var(--space-4)]">
      <h3
        id={id}
        className="text-[length:var(--text-xs)] font-semibold uppercase tracking-[0.04em] text-[var(--ink-tertiary)]"
      >
        {title}
      </h3>
      <ul className="mt-[var(--space-2)] flex flex-col gap-[var(--space-2)]">
        {changes.map((change) => (
          <ChangeRow
            key={change.id}
            change={change}
            decision={decisions[change.id]}
            meta={changeMeta(rail, change)}
            canDecide={canDecide}
            onDecide={onDecide}
            onUndo={onUndo}
          />
        ))}
      </ul>
    </section>
  );
}

export function TemplateChangesDialog({
  changeSet,
  decisions,
  rail,
  canDecide,
  onDecide,
  onUndo,
  onClose,
}: {
  changeSet: TemplateChangeSet;
  decisions: TemplateChangeDecisions;
  rail: ProjectRail;
  canDecide: boolean;
  onDecide: (changeId: string, decision: TemplateChangeDecision) => void;
  onUndo: (changeId: string) => void;
  onClose: () => void;
}) {
  const dialogRef = React.useRef<HTMLDivElement>(null);
  useModalDialog(dialogRef, onClose);
  const { template, baseRevision, currentRevision } = changeSet;
  const sectionProps = { rail, decisions, canDecide, onDecide, onUndo };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[color-mix(in_srgb,var(--ink)_55%,transparent)] p-[var(--space-4)]"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="template-changes-heading"
        onClick={(event) => event.stopPropagation()}
        className="max-h-[85vh] w-full max-w-[560px] overflow-y-auto rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-4)] shadow-[var(--shadow-ambient)]"
      >
        <p className="eyebrow">Company rail</p>
        <h2
          id="template-changes-heading"
          className="mt-1 text-[length:var(--text-lg)] font-semibold text-[var(--ink)]"
        >
          {template.name} · {baseRevision.label} → {currentRevision.label}
        </h2>
        <p className="mt-1 text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          Saved {formatRevisionDate(currentRevision.savedAt)} by {currentRevision.savedBy.name}
        </p>
        {canDecide ? null : (
          <p className="mt-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
            {READ_ONLY_TEXT}
          </p>
        )}
        <ChangeSection
          id="template-changes-added"
          title="Added to the template"
          changes={changeSet.changes.filter((change) => change.kind === "added")}
          {...sectionProps}
        />
        <ChangeSection
          id="template-changes-removed"
          title="Removed from the template"
          changes={changeSet.changes.filter((change) => change.kind === "removed")}
          {...sectionProps}
        />
        <footer className="mt-[var(--space-4)] flex flex-wrap items-center justify-between gap-[var(--space-3)] border-t border-[var(--stroke)] pt-[var(--space-3)]">
          <p className="max-w-[380px] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
            {FOOTER_TEXT}
          </p>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        </footer>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/rail/templateChangesDialog.test.tsx`
Expected: PASS (9 tests). If `getByRole('region', { name })` does not resolve, confirm the `section` has `aria-labelledby` pointing at the `h3` id. A labelled `section` is a `region`.

- [ ] **Step 5: Commit**

```bash
git add src/components/rail/TemplateChangesDialog.tsx tests/rail/templateChangesDialog.test.tsx
git commit -m "feat(rail): template changes review dialog"
```

---

### Task 8: Wire into `DealRail`

**Files:**
- Modify: `src/components/rail/DealRail.tsx`
- Modify: `tests/rail/dealRail.test.tsx`

**Interfaces:**
- Consumes: `useTemplateChanges` (Task 4), `applyTemplateDecisions` (Task 2), `TemplateChangeBanner` (Task 6), `TemplateChangesDialog` (Task 7).
- Produces: the finished demo. `RemovedStepsSection`, `canSaveRail`, `SaveRailDialog`, the skill builder and `StepFocus` callbacks keep receiving the **unmodified** `rail`. Only the station list (`steps`) is derived from the overlaid rail.

- [ ] **Step 1: Extend the DealRail test harness**

In `tests/rail/dealRail.test.tsx`:

1. Change the flag state and mock:

```ts
const state = { flagOn: false, reviewOn: false, rail: null as ProjectRail | null };
```

```ts
vi.mock('@/lib/flags/FlagsContext', () => ({
  useFlag: (key: string) =>
    key === 'project_rail_model'
      ? state.flagOn
      : key === 'template_change_review'
        ? state.reviewOn
        : false,
}));
```

2. In `beforeEach`, add `state.reviewOn = false;` and `window.localStorage.clear();`.

3. Add `catalogFor` to the import from `@/lib/rail/projectRail` (it becomes `import { catalogFor, type ProjectRail, type ProjectRailStep } from '@/lib/rail/projectRail';`), and add this helper below `serverStep`:

```ts
function templateDealRail(canEditStructure = true): ProjectRail {
  const ids = ['p4-s49', 'p4-s50', 'p5-s51', 'p5-s52', 'p5-s53'];
  return {
    currentStepId: 'uuid-p4-s49',
    canEditStructure,
    phases: MVP_DEAL_RAIL.map((p) => ({ index: p.index, name: p.name, dealStatus: p.dealStatus })),
    steps: ids.map((stepId, index) => {
      const entry = catalogFor(stepId);
      if (!entry) throw new Error(`missing catalogue step ${stepId}`);
      return serverStep({
        id: `uuid-${stepId}`,
        stepId,
        phaseIndex: phaseForStep(stepId, MVP_DEAL_RAIL)?.index ?? 0,
        displayOrder: entry.seq,
        seq: entry.seq,
        status: index === 0 ? 'current' : 'pending',
        catalog: entry,
      });
    }),
  };
}

const linkedInTitle = catalogFor('p5-s53')?.title ?? 'LinkedIn Post';
```

4. Add these tests inside `describe('DealRail', …)`:

```ts
  it('shows no template review with the flag off', async () => {
    state.flagOn = true;
    state.rail = templateDealRail();
    await renderRail();
    expect(screen.queryByRole('status', { name: 'Template updated' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review changes' })).not.toBeInTheDocument();
  });

  it('applies accepted template changes to the rail and keeps the rest pending', async () => {
    state.flagOn = true;
    state.reviewOn = true;
    state.rail = templateDealRail();
    await renderRail();

    expect(screen.getByRole('status', { name: 'Template updated' })).toHaveTextContent(
      '3 changes wait for your decision.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Fairness opinion' }));
    fireEvent.click(within(dialog).getByRole('button', { name: `Remove ${linkedInTitle}` }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Fairness opinion')).toBeInTheDocument();
    expect(screen.getByText('From template v4')).toBeInTheDocument();
    expect(screen.queryByText(linkedInTitle)).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Template updated' })).toHaveTextContent(
      '1 change waits for your decision.',
    );
    expect(screen.queryByText(/Removed steps/)).not.toBeInTheDocument();
  });

  it('restores the rail when an accepted change is undone', async () => {
    state.flagOn = true;
    state.reviewOn = true;
    state.rail = templateDealRail();
    await renderRail();
    const before = screen.getAllByRole('button', { name: /^Station / }).map((b) => b.getAttribute('aria-label'));

    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: `Remove ${linkedInTitle}` }));
    fireEvent.click(within(dialog).getByRole('button', { name: `Undo ${linkedInTitle}` }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    const after = screen.getAllByRole('button', { name: /^Station / }).map((b) => b.getAttribute('aria-label'));
    expect(after).toEqual(before);
  });

  it('hides the banner once every change is decided', async () => {
    state.flagOn = true;
    state.reviewOn = true;
    state.rail = templateDealRail();
    await renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard Fairness opinion' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard Sanctions re-screen before signing' }));
    fireEvent.click(within(dialog).getByRole('button', { name: `Keep ${linkedInTitle}` }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('status', { name: 'Template updated' })).not.toBeInTheDocument();
    expect(screen.getByText(linkedInTitle)).toBeInTheDocument();
    expect(screen.queryByText('Fairness opinion')).not.toBeInTheDocument();
  });

  it('lets a read-only member see but not decide template changes', async () => {
    state.flagOn = true;
    state.reviewOn = true;
    state.rail = templateDealRail(false);
    await renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Only the deal team can change this rail.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Add Fairness opinion' })).toBeDisabled();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/rail/dealRail.test.tsx`
Expected: the new tests other than "flag off" FAIL with `Unable to find role="status" and name "Template updated"`. The existing tests still PASS.

- [ ] **Step 3: Wire `DealRail.tsx`**

Imports, added beside the existing rail imports:

```ts
import { applyTemplateDecisions } from "@/lib/railTemplates/changeReview";
import { useTemplateChanges } from "@/lib/railTemplates/useTemplateChanges";
import { TemplateChangeBanner } from "./TemplateChangeBanner";
import { TemplateChangesDialog } from "./TemplateChangesDialog";
```

Directly after the `useProjectRail(...)` destructuring:

```ts
  const templateChanges = useTemplateChanges(projectId, rail);
  const [templateReviewOpen, setTemplateReviewOpen] = React.useState(false);
  const reviewedRail = React.useMemo(
    () =>
      rail && templateChanges.changeSet
        ? applyTemplateDecisions(rail, templateChanges.changeSet, templateChanges.decisions)
        : rail,
    [rail, templateChanges.changeSet, templateChanges.decisions],
  );
```

In the `steps` memo, replace `const base = rail ? activeSteps(rail) : [];` with `const base = reviewedRail ? activeSteps(reviewedRail) : [];`. In its dependency array, replace `rail` with `reviewedRail`.

Directly after the `<Gate0ReceiptBanner … />` element:

```tsx
          {templateChanges.changeSet ? (
            <TemplateChangeBanner
              changeSet={templateChanges.changeSet}
              pendingCount={templateChanges.pending.length}
              onReview={() => setTemplateReviewOpen(true)}
            />
          ) : null}
```

Directly before `{saveRailOpen ? (`:

```tsx
          {templateReviewOpen && templateChanges.changeSet ? (
            <TemplateChangesDialog
              changeSet={templateChanges.changeSet}
              decisions={templateChanges.decisions}
              rail={rail}
              canDecide={rail.canEditStructure}
              onDecide={templateChanges.decide}
              onUndo={templateChanges.undo}
              onClose={() => setTemplateReviewOpen(false)}
            />
          ) : null}
```

Leave every other `rail` reference unchanged (`canSaveRail`, `RemovedStepsSection`, `builder.launch(rail)`, `liveRail={rail}`, `rail.phases`, `rail.canEditStructure`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/rail tests/rail-ui.test.tsx tests/rail-numbering.test.tsx tests/save-rail-dialog.test.tsx tests/skill-authoring-rail-entry.test.tsx`
Expected: PASS.

- [ ] **Step 5: Full local CI**

Run: `npm run lint && npx tsc --noEmit && npm test`
Expected: all green. `tests/discovery-export.test.ts` is known to fail locally on macOS temp paths, independent of this change. Confirm that it is the only failure and that it also fails on `origin/develop`.

- [ ] **Step 6: Commit**

```bash
git add src/components/rail/DealRail.tsx tests/rail/dealRail.test.tsx
git commit -m "feat(rail): template change review on the deal rail behind template_change_review"
```

---

### Task 9: Browser validation and PR

**Files:** none changed unless validation finds a defect. A defect goes back to the owning task's test first.

- [ ] **Step 1: Turn the flags on locally**

```bash
npx supabase status -o env
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c '\d feature_flags'
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "insert into feature_flags (key, enabled) values ('project_rail_model', true), ('template_change_review', true) on conflict (key) do update set enabled = excluded.enabled;"
```

If `\d feature_flags` shows other non-null columns without defaults, include them in the insert. Local database only.

- [ ] **Step 2: Walk the three mockup moments**

Run `npm run dev`, sign in with a seeded user (`npm run seed:users` if needed), and open a deal's rail at `/projects/<id>/rail`. Check that the deal has phase 4 and 5 steps, including `p5-s53`. Using Chrome, capture:

1. The banner, which reads "Standard sell-side moved to v4 on Sep 30 (Storm Duncan). 3 changes wait for your decision. …", with the rail unchanged.
2. The dialog after clicking **Add** on Fairness opinion. The row shows an "Added" badge with Undo, Sanctions re-screen and LinkedIn Post are still pending, Escape closes the dialog, and Tab stays inside it.
3. The rail after adding both additions and removing LinkedIn Post:
   - Fairness opinion sits at the end of phase 4.
   - Sanctions re-screen sits at the start of phase 5.
   - Both show "From template v4" and have no Remove control.
   - LinkedIn Post is gone and is not listed under Removed steps.
   - The banner is gone, and opening Fairness opinion in Focus shows no runner, no Mark complete and no Remove.
4. After a reload, the decisions persist.
5. With `template_change_review` off, the rail is identical to `develop`.

Save the screenshots to the scratchpad for the PR.

- [ ] **Step 3: Rebase, re-run, push and open the PR**

```bash
git fetch origin && git rebase origin/develop
npm run lint && npx tsc --noEmit && npm test
git push -u origin feat/template-change-review-demo
gh pr create --base develop --title "feat(rail): template change review demo behind template_change_review" --body-file <scratchpad>/pr-body.md
```

The PR body says:
- what Storm will see, with the screenshots
- that it is frontend-only, with fixture data and local decisions
- the flag and its prerequisite `project_rail_model`
- a link to the spec's "What the backend replaces" section

No rollout sequence. End the body with the attribution line from the session.
