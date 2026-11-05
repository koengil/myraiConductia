// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import { DEAL_RAIL, orderedSteps, phaseForStep } from '@/lib/rail/dealRail';
import { withRecordedCloses, type DealStepRecord } from '@/lib/rail/dealStepRecord';
import { citedSeqs, drawsOnFor } from '@/lib/rail/drawsOn';
import { stepTitle, type ProjectRailStep } from '@/lib/rail/projectRail';
import { AUDIT_READ_CAP, stepActivityFromAudit, withCurrentAssignment } from '@/lib/rail/stepActivity';
import { RAIL_POLL_MS, useRailFreshness } from '@/lib/rail/useRailFreshness';
import { activityLine } from '@/components/rail/StepOwnerFooter';
import { completedByLine } from '@/components/rail/StepCard';
import { stepInView, stepMatchesSearch } from '@/components/rail/RailViewFilter';
import { ownersFromStepRecords } from '@/components/rail/railBoardModel';

/*
 * Rail multiplayer on real data (8b a): who owns each step and the last thing
 * done on it, read once for the rail; a teammate's completion arriving with
 * fresher records; "Draws on" from the step brief; the personal views; and
 * the focus / 30-second refresh.
 */

const catalog = orderedSteps(DEAL_RAIL);
const bySeq = (seq: number) => catalog.find((s) => s.seq === seq)!;

function row(seq: number, status: ProjectRailStep['status']): ProjectRailStep {
  const step = bySeq(seq);
  return {
    id: `uuid-${seq}`,
    stepId: step.id,
    origin: 'catalog',
    phaseIndex: phaseForStep(step.id, DEAL_RAIL)?.index ?? 1,
    displayOrder: seq,
    seq,
    status,
    definition: null,
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
    catalog: step,
  };
}

function record(seq: number, status: string, extra: Partial<DealStepRecord> = {}): DealStepRecord {
  return {
    stepId: bySeq(seq).id,
    seq,
    status,
    assignedTo: null,
    assignedToName: null,
    completedBy: null,
    completedByName: null,
    completedAt: null,
    completionNote: null,
    skip: null,
    ...extra,
  };
}

const alex = { display_name: 'Alex Chen', full_name: 'Alex Chen' };
const storm = { display_name: 'Storm Duncan', full_name: 'Storm Duncan' };

describe('stepActivityFromAudit', () => {
  it('keeps the latest assign, draft save or completion per step, naming the actor', () => {
    const read = stepActivityFromAudit([
      { ts: '2026-10-22T12:00:00Z', action: 'step_work', detail: { stepId: 'p1-s12' }, actor: alex },
      { ts: '2026-10-22T10:00:00Z', action: 'assign_step', detail: { stepId: 'p1-s12' }, actor: storm },
      { ts: '2026-10-22T09:00:00Z', action: 'assign_step', detail: { stepId: 'p1-s15' }, actor: [storm] },
    ]);
    expect(read.byStep.get('p1-s12')).toEqual({ kind: 'draft_saved', actorName: 'Alex Chen', at: '2026-10-22T12:00:00Z' });
    expect(read.byStep.get('p1-s15')).toMatchObject({ kind: 'assigned', actorName: 'Storm Duncan' });
    expect(read.capped).toBe(false);
  });

  it('reads a save that wrote work and completion together as the completion', () => {
    const ts = '2026-10-22T12:00:00Z';
    const read = stepActivityFromAudit([
      { ts, action: 'step_work', detail: { stepId: 'p1-s13' }, actor: alex },
      { ts, action: 'complete_step', detail: { stepId: 'p1-s13' }, actor: alex },
    ]);
    expect(read.byStep.get('p1-s13')?.kind).toBe('completed');
  });

  it('skips rows with no named person, no step, or another action (rail structure rows)', () => {
    const read = stepActivityFromAudit([
      { ts: '2026-10-22T12:00:00Z', action: 'step_work', detail: { stepId: 'p1-s12' }, actor: null },
      { ts: '2026-10-22T12:00:00Z', action: 'update', detail: { rail: 'skip', stepId: 'uuid-12' }, actor: storm },
      { ts: '2026-10-22T12:00:00Z', action: 'step_work', detail: {}, actor: storm },
    ]);
    expect(read.byStep.size).toBe(0);
  });

  it('flags a read that filled the audit cap, so the rail says less', () => {
    const events = Array.from({ length: AUDIT_READ_CAP }, () => ({ action: 'view' }));
    expect(stepActivityFromAudit(events).capped).toBe(true);
  });
});

describe('activity and completion lines', () => {
  const now = Date.parse('2026-10-22T14:00:00Z');
  it('names the actor, the action and when, with the shared date helper', () => {
    expect(activityLine({ kind: 'draft_saved', actorName: 'Alex Chen', at: '2026-10-22T12:00:00Z' }, now)).toBe(
      'Draft saved by Alex Chen · 2h ago',
    );
    expect(activityLine({ kind: 'assigned', actorName: 'Storm Duncan', at: '2026-10-22T13:55:00Z' }, now)).toBe(
      'Assigned by Storm Duncan · 5 min ago',
    );
    expect(activityLine({ kind: 'completed', actorName: 'Morgan Vale', at: '2026-10-07T13:00:00Z' }, now)).toBe(
      'Done by Morgan Vale · Oct 7, 2026',
    );
  });

  it('credits a done step "Done by" with its time, and keeps the skip credit', () => {
    expect(completedByLine(row(13, 'complete'), 'done', 'Morgan Vale', '2026-10-22T12:00:00Z', now)).toBe(
      'Done by Morgan Vale · 2h ago',
    );
    expect(completedByLine(row(13, 'complete'), 'done', 'Morgan Vale')).toBe('Done by Morgan Vale');
    expect(completedByLine(row(6, 'complete'), 'done', 'On record')).toBe('Done · On record');
    expect(completedByLine(row(13, 'skipped'), 'skipped', 'Avery Lindqvist')).toBe('Completed by: Avery Lindqvist');
  });
});

describe('ownersFromStepRecords with activity', () => {
  it('puts owners and activity in one map: activity alone still counts', () => {
    const owners = ownersFromStepRecords(
      [record(12, 'current', { assignedTo: 'u-alex', assignedToName: 'Alex Chen' })],
      new Map([['p1-s14', { kind: 'assigned' as const, actorName: 'Storm Duncan', at: '2026-10-22T12:00:00Z' }]]),
    );
    expect(owners.get('p1-s12')?.owner).toMatchObject({ name: 'Alex Chen', initials: 'AC' });
    expect(owners.get('p1-s14')).toMatchObject({ activity: { kind: 'assigned' } });
    expect(owners.get('p1-s14')?.owner).toBeUndefined();
  });
});

describe('withRecordedCloses', () => {
  const steps = [row(12, 'current'), row(13, 'pending'), row(14, 'pending')];

  it('shows a teammate\'s out-of-order completion without moving the deal\'s position', () => {
    const out = withRecordedCloses(steps, 'uuid-12', [record(12, 'current'), record(13, 'complete')]);
    expect(out.steps.map((s) => s.status)).toEqual(['current', 'complete', 'pending']);
    expect(out.currentStepId).toBe('uuid-12');
  });

  it('moves the cursor to the records\' current step when they close the rail\'s current one', () => {
    const out = withRecordedCloses(steps, 'uuid-12', [record(12, 'complete'), record(13, 'current')]);
    expect(out.steps.map((s) => s.status)).toEqual(['complete', 'current', 'pending']);
    expect(out.currentStepId).toBe('uuid-13');
  });

  it('never reopens a step and changes nothing when the records agree', () => {
    const done = [row(12, 'complete'), row(13, 'current')];
    const out = withRecordedCloses(done, 'uuid-13', [record(12, 'pending'), record(13, 'current')]);
    expect(out.steps).toBe(done);
    expect(out.currentStepId).toBe('uuid-13');
  });
});

describe('Draws on', () => {
  it('reads the step brief\'s input references, lists and ranges included, never its own seq', () => {
    expect(citedSeqs(bySeq(21))).toEqual([15, 17, 19, 18, 55]);
    expect(citedSeqs(bySeq(40))).toEqual([39, 34, 37]);
    expect(citedSeqs(bySeq(1))).toEqual([]);
  });

  it('cites steps on 24 of the 65 catalog steps, and ignores outputs ("handed to Seq 30")', () => {
    const all = orderedSteps(DEAL_RAIL);
    expect(all.filter((s) => citedSeqs(s).length > 0)).toHaveLength(24);
    expect(citedSeqs(bySeq(28))).toEqual([]);
  });

  // S6R3-R1 I-2: the shown descriptions lost their "Seq NN" notes; the inputs
  // keep them, so "Draws on" lists the same steps it did.
  it('still lists the cited steps for a step whose shown description no longer names seqs', () => {
    expect(bySeq(38).description).not.toMatch(/\bSeq\s*\d/);
    expect(citedSeqs(bySeq(38))).toEqual([44, 45]);
    expect(bySeq(62).description).not.toMatch(/\bSeq\s*\d/);
    expect(citedSeqs(bySeq(62))).toEqual([55]);
    const rail = [38, 44, 45].map((seq) => row(seq, seq === 38 ? 'current' : 'pending'));
    const refs = drawsOnFor(rail[0], rail, stepTitle, (seq) => bySeq(seq)?.title);
    expect(refs.map((r) => [r.seq, r.title, r.later])).toEqual([
      [44, bySeq(44).title, true],
      [45, bySeq(45).title, true],
    ]);
  });

  it('resolves references on this rail with forward ones marked later', () => {
    const rail = [15, 17, 18, 19, 21, 55].map((seq) => row(seq, seq < 21 ? 'complete' : 'pending'));
    const refs = drawsOnFor(rail[4], rail, stepTitle, (seq) => bySeq(seq)?.title);
    expect(refs.map((r) => [r.seq, r.later, r.step?.id ?? null])).toEqual([
      [15, false, 'uuid-15'],
      [17, false, 'uuid-17'],
      [19, false, 'uuid-19'],
      [18, false, 'uuid-18'],
      [55, true, 'uuid-55'],
    ]);
  });

  it('keeps a reference to a step not on this rail, by its catalog name', () => {
    const rail = [row(21, 'current')];
    const refs = drawsOnFor(rail[0], rail, stepTitle, (seq) => bySeq(seq)?.title);
    expect(refs[0]).toMatchObject({ seq: 15, step: null, later: false, title: bySeq(15).title });
    expect(refs.find((r) => r.seq === 55)?.later).toBe(true);
  });
});

describe('stepMatchesSearch', () => {
  it('matches a title in any case, or the exact number on the card', () => {
    expect(stepMatchesSearch('loi', 'LOI Review', 44)).toBe(true);
    expect(stepMatchesSearch('44', 'LOI Review', 44)).toBe(true);
    expect(stepMatchesSearch('044', 'LOI Review', 44)).toBe(true);
    expect(stepMatchesSearch('4', 'LOI Review', 44)).toBe(false);
    expect(stepMatchesSearch('nda', 'LOI Review', 44)).toBe(false);
    expect(stepMatchesSearch('  ', 'LOI Review', 44)).toBe(true);
  });
});

describe('stepInView', () => {
  const facts = { ownerId: null as string | null, meId: 'me', hasActivity: false };
  it('Open is the work still to do', () => {
    expect(stepInView('open', row(14, 'pending'), 'todo', facts)).toBe(true);
    expect(stepInView('open', row(14, 'current'), 'active', facts)).toBe(true);
    expect(stepInView('open', row(13, 'complete'), 'done', facts)).toBe(false);
    expect(stepInView('open', row(13, 'skipped'), 'skipped', facts)).toBe(false);
    expect(stepInView('open', row(1, 'skipped_entry'), 'prior', facts)).toBe(false);
  });
  it('All shows everything; the others leave steps before the entry out', () => {
    expect(stepInView('all', row(1, 'skipped_entry'), 'prior', facts)).toBe(true);
    expect(stepInView('unassigned', row(1, 'skipped_entry'), 'prior', facts)).toBe(false);
  });
  it('Mine is what I own; Unassigned is open work nobody owns; Has activity follows the trail', () => {
    expect(stepInView('mine', row(15, 'pending'), 'todo', { ...facts, ownerId: 'me' })).toBe(true);
    expect(stepInView('mine', row(15, 'pending'), 'todo', { ...facts, ownerId: 'other' })).toBe(false);
    expect(stepInView('unassigned', row(14, 'pending'), 'todo', facts)).toBe(true);
    expect(stepInView('unassigned', row(13, 'complete'), 'done', facts)).toBe(false);
    expect(stepInView('has_activity', row(13, 'complete'), 'done', { ...facts, hasActivity: true })).toBe(true);
    expect(stepInView('has_activity', row(14, 'pending'), 'todo', facts)).toBe(false);
  });
});

describe('useRailFreshness', () => {
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  it('refreshes on focus, coalesces focus + visibility, and polls every 30 seconds while visible', () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    renderHook(() => useRailFreshness(refresh, true));
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(RAIL_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    vi.advanceTimersByTime(RAIL_POLL_MS * 3);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('stops polling and listening once unmounted', () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const { unmount } = renderHook(() => useRailFreshness(refresh, true));
    unmount();
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(RAIL_POLL_MS * 3);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does nothing when off (the fixture rail)', () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    renderHook(() => useRailFreshness(refresh, false));
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(RAIL_POLL_MS);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('withCurrentAssignment (an "Assigned by" line the records still bear out)', () => {
  const assignRow = (seq: number, assignee?: string) => ({
    ts: '2026-10-22T10:00:00Z',
    action: 'assign_step',
    detail: { stepId: bySeq(seq).id, ...(assignee ? { assignee } : {}) },
    actor: storm,
  });

  it('keeps the assignee the row named', () => {
    const { byStep } = stepActivityFromAudit([assignRow(14, 'u-alex')]);
    expect(byStep.get(bySeq(14).id)).toMatchObject({ kind: 'assigned', assignee: 'u-alex' });
  });

  it('drops the line when the owner was removed, so the step shows none and has no activity', () => {
    const { byStep } = stepActivityFromAudit([assignRow(14, 'u-alex')]);
    const kept = withCurrentAssignment(byStep, [record(14, 'pending')]);
    expect(kept.has(bySeq(14).id)).toBe(false);
    expect(
      stepInView('has_activity', row(14, 'pending'), 'todo', { ownerId: null, meId: null, hasActivity: kept.has(bySeq(14).id) }),
    ).toBe(false);
  });

  it('drops the line when the step now belongs to someone else, keeps it while it still matches', () => {
    const { byStep } = stepActivityFromAudit([assignRow(14, 'u-alex'), assignRow(15, 'u-morgan')]);
    const kept = withCurrentAssignment(byStep, [
      record(14, 'pending', { assignedTo: 'u-morgan', assignedToName: 'Morgan Vale' }),
      record(15, 'pending', { assignedTo: 'u-morgan', assignedToName: 'Morgan Vale' }),
    ]);
    expect(kept.has(bySeq(14).id)).toBe(false);
    expect(kept.get(bySeq(15).id)?.actorName).toBe('Storm Duncan');
  });

  it('leaves drafts, completions and steps with no record yet alone', () => {
    const { byStep } = stepActivityFromAudit([
      { ts: '2026-10-22T10:00:00Z', action: 'step_work', detail: { stepId: bySeq(14).id }, actor: alex },
      assignRow(16, 'u-alex'),
    ]);
    expect(withCurrentAssignment(byStep, [record(14, 'pending')]).has(bySeq(14).id)).toBe(true);
    expect(withCurrentAssignment(byStep, [record(14, 'pending')]).has(bySeq(16).id)).toBe(true);
    expect(withCurrentAssignment(byStep, [])).toBe(byStep);
  });
});
