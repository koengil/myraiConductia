import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { parseStepSkip, resolveSkipApprover } from '../src/lib/api/v1/stepSkip';
import { toAuditEvent, type ServerAuditRow } from '../src/lib/audit/serverAudit';
import { skipFromRecord, withServerSkips, type DealStepRecord } from '../src/lib/rail/dealStepRecord';
import { SEED_DEALS } from '../src/lib/rail/deals';
import { RELATIONSHIP_PATHING_STEP_ID } from '../src/lib/rail/dealRail';
import { CONFLICTS_STEP_ID, stepCompletedBy } from '../src/lib/rail/stepRecords';
import type { ProjectRailStep } from '../src/lib/rail/projectRail';

/*
 * Prod bug bash Findings 5 and 6 (Sep 7–10). A skipped step's approver and
 * reason lived only in the browser; a completed execution step showed no
 * "Completed by" although completed_by was stored. Both now read from the
 * deal's step records.
 */

const record = (over: Partial<DealStepRecord>): DealStepRecord => ({
  stepId: 'p1-s8',
  seq: 8,
  status: 'complete',
  assignedTo: null,
  assignedToName: null,
  completedBy: null,
  completedByName: null,
  completedAt: null,
  completionNote: null,
  skip: null,
  ...over,
});

describe('parseStepSkip — the skip record the route accepts', () => {
  it('takes an approver id and a trimmed reason; the id is optional', () => {
    expect(parseStepSkip({ approverId: 'user-2', reason: ' Client teaser ' })).toEqual({
      ok: true,
      skip: { approverId: 'user-2', reason: 'Client teaser' },
    });
    expect(parseStepSkip({ reason: 'Client teaser' })).toEqual({
      ok: true,
      skip: { reason: 'Client teaser' },
    });
  });

  it('ignores the old free-text approver and role keys (#312)', () => {
    const parsed = parseStepSkip({
      approver: 'Free Text',
      approverRole: 'MD',
      reason: 'Client teaser',
    });
    expect(parsed).toEqual({ ok: true, skip: { reason: 'Client teaser' } });
    expect(JSON.stringify(parsed)).not.toContain('Free Text');
  });

  it('rejects a missing reason or a non-object', () => {
    expect(parseStepSkip({ approverId: 'x', reason: '  ' })).toEqual({
      ok: false,
      error: 'skip.reason is required',
    });
    expect(parseStepSkip('nope')).toEqual({ ok: false, error: 'skip must be an object with a reason' });
    expect(parseStepSkip(null).ok).toBe(false);
  });
});

describe('resolveSkipApprover — the server names the approver (#312)', () => {
  const DEAL = '00000000-0000-4000-8000-0000000000d1';
  const ACTOR = '00000000-0000-4000-8000-0000000000a1';
  const LEGAL = '00000000-0000-4000-8000-0000000000b2';

  type Seat = { deal_role: string; user: Record<string, unknown> | null } | null;

  function fakeAdmin(result: { data: Seat; error?: { message: string } | null }) {
    const calls = { table: '', select: '', eq: [] as [string, unknown][] };
    const builder = {
      select(text: string) {
        calls.select = text;
        return builder;
      },
      eq(column: string, value: unknown) {
        calls.eq.push([column, value]);
        return builder;
      },
      maybeSingle: () => Promise.resolve({ data: result.data, error: result.error ?? null }),
    };
    const admin = {
      from(table: string) {
        calls.table = table;
        return builder;
      },
    } as unknown as SupabaseClient;
    return { admin, calls };
  }

  const seat = (dealRole: string, user: Record<string, unknown> | null = {}): Seat => ({
    deal_role: dealRole,
    user:
      user === null
        ? null
        : { status: 'active', display_name: 'Priya Mehta', full_name: 'Priya M', email: 'p@bank.dev', ...user },
  });

  it('resolves the named seat holder, reading name and role from the database', async () => {
    const { admin, calls } = fakeAdmin({ data: seat('legal') });
    expect(await resolveSkipApprover(admin, DEAL, ACTOR, LEGAL)).toEqual({
      ok: true,
      id: LEGAL,
      name: 'Priya Mehta',
      dealRole: 'legal',
    });
    expect(calls.table).toBe('deal_memberships');
    expect(calls.eq).toEqual([
      ['deal_id', DEAL],
      ['user_id', LEGAL],
    ]);
  });

  it('embeds users through the user_id FK hint (a bare embed is PGRST201 on two FKs)', async () => {
    const { admin, calls } = fakeAdmin({ data: seat('md') });
    await resolveSkipApprover(admin, DEAL, ACTOR, LEGAL);
    expect(calls.select).toContain('users!deal_memberships_user_id_fkey(');
  });

  it('takes the actor as approver when the request names none', async () => {
    for (const raw of [undefined, null]) {
      const { admin, calls } = fakeAdmin({ data: seat('md', { display_name: 'Storm Duncan' }) });
      const result = await resolveSkipApprover(admin, DEAL, ACTOR, raw);
      expect(result).toMatchObject({ ok: true, id: ACTOR, name: 'Storm Duncan', dealRole: 'md' });
      expect(calls.eq).toContainEqual(['user_id', ACTOR]);
    }
  });

  it('rejects a value that is not a user id without reading', async () => {
    for (const raw of ['Free Text', '', 42, { id: LEGAL }]) {
      const { admin, calls } = fakeAdmin({ data: seat('md') });
      expect(await resolveSkipApprover(admin, DEAL, ACTOR, raw)).toEqual({
        ok: false,
        status: 400,
        error: 'skip.approverId must be a user id',
      });
      expect(calls.table).toBe('');
    }
  });

  it.each([
    ['no seat on the deal', null],
    ['a suspended account', seat('deal_team', { status: 'suspended' })],
    ['an invited account', seat('deal_team', { status: 'invited' })],
    ['a seat with no user row', seat('deal_team', null)],
    ['a read_only seat', seat('read_only')],
    ['a buyer seat', seat('buyer')],
    ['a seller seat', seat('seller')],
  ])('refuses %s with one 400', async (_label, data) => {
    const { admin } = fakeAdmin({ data });
    expect(await resolveSkipApprover(admin, DEAL, ACTOR, LEGAL)).toEqual({
      ok: false,
      status: 400,
      error: 'The approver must hold an active, eligible seat on this deal',
    });
  });

  it('accepts each eligible seat: md, deal_team, legal (owner decision 2026-10-16, 1B)', async () => {
    for (const role of ['md', 'deal_team', 'legal']) {
      const { admin } = fakeAdmin({ data: seat(role) });
      expect(await resolveSkipApprover(admin, DEAL, ACTOR, LEGAL)).toMatchObject({ ok: true, dealRole: role });
    }
  });

  it('answers a failed seat read with a 500, never the eligibility 400', async () => {
    const { admin } = fakeAdmin({ data: null, error: { message: 'boom' } });
    expect(await resolveSkipApprover(admin, DEAL, ACTOR, LEGAL)).toEqual({
      ok: false,
      status: 500,
      error: 'Approver lookup failed',
    });
  });
});

describe('audit trail — a logged skip reads as a skip, not a bare advance', () => {
  const row = (detail: Record<string, unknown>): ServerAuditRow => ({
    id: 'a1',
    ts: '2026-09-10T12:00:00Z',
    action: 'advance',
    document_id: null,
    detail,
    actor: { id: 'u1', full_name: 'Marcelo Gumiero', display_name: null },
  });

  it('names the step, the approver and the reason', () => {
    const e = toAuditEvent(
      row({
        kind: 'skip',
        stepId: 'p1-s10',
        stepTitle: 'Meeting Intelligence',
        seq: 10,
        approver: 'Storm Duncan',
        approverRole: 'MD',
        reason: 'No meeting on this deal',
        from: 10,
        to: 11,
      }),
      'ZZ TEST ORBIT',
    );
    expect(e.action).toBe('Skipped a step');
    expect(e.target).toBe('Meeting Intelligence · approved by Storm Duncan (MD) · No meeting on this deal');
  });

  it('labels the verified deal role the server stores (#312)', () => {
    const e = toAuditEvent(
      row({
        kind: 'skip',
        stepTitle: 'Meeting Intelligence',
        approverId: '00000000-0000-4000-8000-0000000000b3',
        approver: 'Avery Lindqvist',
        approverRole: 'deal_team',
        reason: 'Off platform',
      }),
      'ZZ TEST ORBIT',
    );
    expect(e.target).toBe('Meeting Intelligence · approved by Avery Lindqvist (Deal Team) · Off platform');
  });

  it('leaves a plain advance row untouched', () => {
    const e = toAuditEvent(row({ from: 10, to: 11 }), 'ZZ TEST ORBIT');
    expect(e.action).toBe('Advanced the rail');
    // Named by its steps, never by seq.
    expect(e.target).toBe('Meeting Intelligence → Deal Qualification');
  });
});

describe('withServerSkips — the platform skip wins over the browser copy', () => {
  const step = (over: Partial<ProjectRailStep>): ProjectRailStep => ({
    id: over.stepId ?? 'p1-s8',
    stepId: 'p1-s8',
    origin: 'catalog',
    phaseIndex: 1,
    displayOrder: 8,
    seq: 8,
    status: 'pending',
    definition: null,
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
    ...over,
  });
  const steps: ProjectRailStep[] = [
    step({ stepId: 'p1-s9', seq: 9, displayOrder: 9, status: 'complete' }),
    step({
      stepId: 'p1-s10',
      seq: 10,
      displayOrder: 10,
      skip: { at: '2026-09-01', by: '', approver: 'Local', reason: 'stale' },
    }),
  ];

  it('returns the same steps when there are no records or no skips', () => {
    expect(withServerSkips(steps, null)).toBe(steps);
    expect(withServerSkips(steps, [record({ status: 'complete' })])).toBe(steps);
  });

  it('overlays every skipped record without touching the other steps', () => {
    const skipped = record({
      stepId: 'p1-s10',
      seq: 10,
      status: 'skipped',
      skip: { approver: 'Storm Duncan', approverRole: 'MD', reason: 'Server', at: '2026-09-10' },
    });
    const next = withServerSkips(steps, [skipped]);
    expect(next).not.toBe(steps);
    expect(next[1].skip).toEqual(skipFromRecord(skipped));
    expect(next[1].skip?.approver).toBe('Storm Duncan');
    expect(next[1].status).toBe('skipped');
    expect(next[0]).toBe(steps[0]);
  });
});

describe('stepCompletedBy — execution steps credit the record', () => {
  const deal = SEED_DEALS[0];

  it('still resolves the Gate 0 steps from the deal', () => {
    expect(stepCompletedBy(deal, CONFLICTS_STEP_ID)).toBe(
      deal.conflictsAttestation?.approvedBy ?? null,
    );
  });

  it('is blank for an execution step without a record (Finding 6 before)', () => {
    expect(stepCompletedBy(deal, RELATIONSHIP_PATHING_STEP_ID)).toBeNull();
  });

  it('credits the completer from the step record', () => {
    const withRecords = {
      ...deal,
      stepRecords: [record({ completedBy: 'u-md', completedByName: 'Marcelo Gumiero' })],
    };
    expect(stepCompletedBy(withRecords, RELATIONSHIP_PATHING_STEP_ID)).toBe('Marcelo Gumiero');
  });

  it('credits the skip approver from the step record, and the local skip first', () => {
    const withRecords = {
      ...deal,
      stepRecords: [
        record({
          status: 'skipped',
          completedByName: 'Marcelo Gumiero',
          skip: { approver: 'Storm Duncan', approverRole: 'MD', reason: 'r', at: 't' },
        }),
      ],
    };
    expect(stepCompletedBy(withRecords, RELATIONSHIP_PATHING_STEP_ID)).toBe('Storm Duncan');
    expect(
      stepCompletedBy(withRecords, RELATIONSHIP_PATHING_STEP_ID, { approver: 'Local Approver' }),
    ).toBe('Local Approver');
  });
});
