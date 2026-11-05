// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { preferredAssessment } from '@/lib/discovery/preferredAssessment';
import { MVP_DEAL_RAIL, type RailPhase } from '@/lib/rail/dealRail';

// The display rule (#173 G-07, design R5) over the rows RLS let a reader see: a team inbox's latest row wins while
// it names a step (furthest along the rail, then latest), else the latest shared row.

type Row = { id: string; step_id: string | null; team_mailbox_id?: string | null; as_of: string };
const row = (id: string, step_id: string | null, as_of: string, team_mailbox_id: string | null = null): Row => ({
  id,
  step_id,
  as_of,
  team_mailbox_id,
});

describe('preferredAssessment', () => {
  it('is null when the reader sees no row', () => {
    expect(preferredAssessment([])).toBeNull();
  });

  it('takes the latest shared row when no team row is visible, whatever order the rows arrive in', () => {
    const rows = [row('s-1', 'p2-s28', '2026-09-01T10:00:00Z'), row('s-2', 'p4-s48', '2026-09-30T10:00:00Z')];
    expect(preferredAssessment(rows)?.id).toBe('s-2');
    expect(preferredAssessment([...rows].reverse())?.id).toBe('s-2');
  });

  it('reads a row without the audience column as shared (the schema before 20261023130100)', () => {
    expect(preferredAssessment([{ id: 'old', step_id: 'p4-s48', as_of: '2026-09-30T10:00:00Z' }])?.id).toBe('old');
  });

  it('breaks an as_of tie by id, as the writer does', () => {
    expect(preferredAssessment([row('a', 'p2-s28', '2026-09-30T10:00:00Z'), row('b', 'p4-s48', '2026-09-30T10:00:00Z')])?.id).toBe('b');
  });

  it('prefers a team row that names a step over a newer shared row, even one further along', () => {
    const rows = [row('s-1', 'p5-s51', '2026-10-02T10:00:00Z'), row('t-1', 'p4-s48', '2026-09-30T10:00:00Z', 'tm-1')];
    expect(preferredAssessment(rows)?.id).toBe('t-1');
  });

  it('falls back to the shared row once an inbox stream ends with a tombstone', () => {
    const rows = [
      row('s-1', 'p2-s28', '2026-09-01T10:00:00Z'),
      row('t-1', 'p4-s48', '2026-09-30T10:00:00Z', 'tm-1'),
      row('t-2', null, '2026-10-01T10:00:00Z', 'tm-1'),
    ];
    expect(preferredAssessment(rows)?.id).toBe('s-1');
  });

  it('takes only each inbox\'s latest row: an older step under a tombstone never resurfaces', () => {
    const rows = [row('t-1', 'p5-s51', '2026-09-30T10:00:00Z', 'tm-1'), row('t-2', null, '2026-10-01T10:00:00Z', 'tm-1')];
    expect(preferredAssessment(rows)).toBeNull();
  });

  it('between inboxes, takes the one furthest along the rail, then the latest', () => {
    const rows = [
      row('a-1', 'p5-s51', '2026-09-01T10:00:00Z', 'tm-a'),
      row('b-1', 'p4-s48', '2026-10-01T10:00:00Z', 'tm-b'),
      row('s-1', 'p2-s28', '2026-10-02T10:00:00Z'),
    ];
    expect(preferredAssessment(rows)?.id).toBe('a-1');
    const tied = [row('a-1', 'p4-s48', '2026-09-01T10:00:00Z', 'tm-a'), row('b-1', 'p4-s48', '2026-10-01T10:00:00Z', 'tm-b')];
    expect(preferredAssessment(tied)?.id).toBe('b-1');
  });

  it('ranks by the rail it is given: a step the rail no longer has ranks lowest', () => {
    const trimmed: RailPhase[] = MVP_DEAL_RAIL.map((p) => ({ ...p, steps: p.steps.filter((s) => s.id !== 'p5-s51') }));
    const rows = [row('a-1', 'p5-s51', '2026-10-01T10:00:00Z', 'tm-a'), row('b-1', 'p2-s28', '2026-09-01T10:00:00Z', 'tm-b')];
    expect(preferredAssessment(rows, trimmed)?.id).toBe('b-1');
  });
});
