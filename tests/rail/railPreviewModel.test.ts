import { describe, expect, it } from 'vitest';

import { PROTECTED_STEP_IDS } from '@/lib/rail/protectedSteps';
import type { ProjectRailStep } from '@/lib/rail/projectRail';
import { dropTarget } from '@/components/rail/SortableStack';
import {
  allowedMoveIndices,
  applyPreviewOrder,
  isMovableStep,
  linkProblem,
  datesProblem,
  moveId,
  orderDiffers,
  parsePlan,
  railPlanKey,
  soonestStepDate,
  waitingOn,
  type DrawnLink,
} from '@/lib/rail/railPreview';

function step(id: string, extra: Partial<ProjectRailStep> = {}): ProjectRailStep {
  return {
    id,
    stepId: `custom:${id}`,
    origin: 'custom',
    phaseIndex: 1,
    displayOrder: 1,
    seq: null,
    status: 'pending',
    definition: { title: id, description: '' },
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
    ...extra,
  };
}

const a = step('a');
const b = step('b');
const c = step('c');

describe('reorder Preview (E1)', () => {
  it('moves an id within a phase and leaves a no-op list untouched', () => {
    expect(moveId(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(moveId(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
    const same = ['a', 'b'];
    expect(moveId(same, 'a', 0)).toBe(same);
    expect(moveId(same, 'zz', 1)).toBe(same);
  });

  it('applies a previewed order and keeps a step it does not name at its saved place', () => {
    expect(applyPreviewOrder([a, b, c], ['c', 'a']).map((s) => s.id)).toEqual(['c', 'a', 'b']);
    // A step added at the phase start after the Preview began leads, not trails.
    const n = step('n');
    expect(applyPreviewOrder([n, a, b, c], ['c', 'a', 'b']).map((s) => s.id)).toEqual(['n', 'c', 'a', 'b']);
    // One added after b follows b wherever b now sits.
    expect(applyPreviewOrder([a, b, n, c], ['b', 'c', 'a']).map((s) => s.id)).toEqual(['b', 'n', 'c', 'a']);
    expect(applyPreviewOrder([a, b, c], undefined)).toEqual([a, b, c]);
    expect(orderDiffers([a, b, c], ['a', 'b', 'c'])).toBe(false);
    expect(orderDiffers([a, b, c], ['b', 'a'])).toBe(true);
  });

  it('moves only open work: never a done, required or pre-entry step', () => {
    expect(isMovableStep(a, 'todo')).toBe(true);
    expect(isMovableStep(a, 'active')).toBe(true);
    expect(isMovableStep(a, 'done')).toBe(false);
    expect(isMovableStep(a, 'prior')).toBe(false);
    const required = step('r', { stepId: [...PROTECTED_STEP_IDS][0] });
    expect(isMovableStep(required, 'todo')).toBe(false);
  });
});

describe('where a step may go (m2, m3)', () => {
  const done = step('d');
  const fixed = (s: ProjectRailStep) => s.id === 'd';

  it('never ahead of a step that cannot move, and always where it is', () => {
    // a, d(done), b, c: b may sit right after d or later, never before d.
    expect([...allowedMoveIndices([a, done, b, c], b, fixed)].sort()).toEqual([2, 3]);
    // a step already ahead of d may stay put or go after d, nowhere else.
    expect([...allowedMoveIndices([a, b, done], a, fixed)].sort()).toEqual([0, 2]);
    expect([...allowedMoveIndices([a, b, c], c, () => false)].sort()).toEqual([0, 1, 2]);
  });

  it('a drop on itself, outside, or onto a refused place is no move, so it is never announced as one', () => {
    expect(dropTarget([a, b, c], 'a', 'a')).toBeNull();
    expect(dropTarget([a, b, c], 'a', undefined)).toBeNull();
    expect(dropTarget([a, b, c], 'a', null)).toBeNull();
    expect(dropTarget([a, b, c], 'c', 'a', (_s, to) => to > 0)).toBeNull();
    expect(dropTarget([a, b, c], 'c', 'b')).toEqual({ step: c, toIndex: 1 });
  });
});

describe('drawn links and dates (E4)', () => {
  const links: DrawnLink[] = [
    { id: 'l1', fromId: 'a', toId: 'b', kind: 'hard' },
    { id: 'l2', fromId: 'c', toId: 'b', kind: 'soft' },
  ];

  it('says "waiting" only for a drawn link whose earlier step is not done', () => {
    expect(waitingOn('b', links, (id) => id === 'a').map((l) => l.id)).toEqual(['l2']);
    expect(waitingOn('a', links, () => false)).toEqual([]);
    expect(waitingOn('b', [], () => false)).toEqual([]);
  });

  it('refuses a self link, a repeat and a reverse link', () => {
    expect(linkProblem(links, 'a', 'a')).toMatch(/itself/);
    expect(linkProblem(links, 'a', 'b')).toMatch(/already drawn/);
    expect(linkProblem(links, 'b', 'a')).toMatch(/other way/);
    expect(linkProblem(links, 'a', 'c')).toBeNull();
    expect(linkProblem(links, '', 'c')).toMatch(/both/);
    // A longer loop is refused too (a→b, b→c; c→a would close it).
    const chain = [
      { id: 'x1', fromId: 'a', toId: 'b', kind: 'hard' as const },
      { id: 'x2', fromId: 'b', toId: 'c', kind: 'soft' as const },
    ];
    expect(linkProblem(chain, 'c', 'a')).toBe('That would make these steps wait on each other in a loop.');
    expect(linkProblem(chain, 'a', 'c')).toBeNull();
    expect(datesProblem('2026-11-20', '2026-11-10')).toBe('The drop-dead date cannot be before the target date.');
    expect(datesProblem('2026-11-10', '2026-11-20')).toBeNull();
    expect(datesProblem('', '2026-11-20')).toBeNull();
  });

  it('finds the soonest date on steps still on the rail', () => {
    const dates = { a: { target: '2026-12-01' }, b: { dropDead: '2026-11-20' }, gone: { target: '2026-01-01' } };
    expect(soonestStepDate(dates, new Set(['a', 'b']))).toEqual({ stepId: 'b', day: '2026-11-20', kind: 'dropDead' });
    expect(soonestStepDate({}, new Set(['a']))).toBeNull();
  });

  it('reads a stored plan defensively', () => {
    expect(parsePlan(null).links).toEqual([]);
    expect(parsePlan('not json').links).toEqual([]);
    const plan = parsePlan(
      JSON.stringify({
        links: [{ id: 'l', fromId: 'a', toId: 'b', kind: 'hard' }, { id: 'x', kind: 'maybe' }],
        dates: { a: { target: '2026-12-01', dropDead: 'soon' }, b: { target: 3 } },
        proposals: [{ id: 'p', stepId: null, text: 'Move it', createdAt: '2026-10-22T00:00:00Z', decision: null }, { id: 1 }],
      }),
    );
    expect(plan.links).toHaveLength(1);
    expect(plan.dates).toEqual({ a: { target: '2026-12-01' } });
    expect(plan.proposals).toHaveLength(1);
  });

  it('keeps one plan per person and deal', () => {
    expect(railPlanKey('u-1', 'SUM-1')).not.toBe(railPlanKey('u-2', 'SUM-1'));
    expect(railPlanKey('u-1', 'SUM-1')).not.toBe(railPlanKey('u-1', 'SUM-2'));
  });
});
