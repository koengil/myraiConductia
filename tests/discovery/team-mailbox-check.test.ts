// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TeamMailboxCheck, TeamMailboxVerifier } from '@/lib/mailboxAccess';
import { checkTeamMailbox, recheckTeamMailbox } from '../../worker/teamMailbox';

// The worker's half of the team inbox check (#581): ask the database whether the check is due, verify only when it
// is, and record each outcome. The database decides "due" and what a recorded outcome does to the registration
// (supabase/tests/team_mailboxes.sql); the hook's place in both entry points is pinned in worker-providers.test.ts
// and reader-pass-pins.test.ts.

const TENANT = '11111111-1111-4111-8111-111111111111';
const SOURCE = '33333333-3333-4333-8333-333333333333';
const TEAM = '44444444-4444-4444-8444-444444444444';
const ADDRESS = 'deals@bank.example';

type Answer = { data: unknown; error: { code: string; message: string } | null };

function fakeDb(answers: { due?: Answer; record?: Answer }) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === 'discovery_team_mailbox_check_due') return answers.due ?? { data: null, error: null };
    return answers.record ?? { data: { recorded: true }, error: null };
  });
  return { db: { rpc } as unknown as SupabaseClient, calls };
}

const DUE: Answer = { data: { due: true, teamMailboxId: TEAM, address: ADDRESS, pinnedId: null }, error: null };
const NOT_DUE: Answer = { data: { due: false, teamMailboxId: TEAM, address: ADDRESS, pinnedId: null }, error: null };
const source = { id: SOURCE, tenantId: TENANT };

function verifierReturning(result: TeamMailboxCheck | Error) {
  const verify = vi.fn<TeamMailboxVerifier['verify']>(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  const verifier: TeamMailboxVerifier = { verify };
  return { verifier, verify };
}

afterEach(() => vi.restoreAllMocks());

describe('the hook asks the database, verifies only when due, and records the outcome', () => {
  it('asks whether the check is due for this source, by id', async () => {
    const { db, calls } = fakeDb({ due: NOT_DUE });
    const { verifier } = verifierReturning({ status: 'verified', directoryUserId: 'dir-1' });
    await checkTeamMailbox(db, source, verifier);
    expect(calls).toEqual([{ name: 'discovery_team_mailbox_check_due', args: { p_source_id: SOURCE } }]);
  });

  it('does not verify or record when the check is not due', async () => {
    const { db, calls } = fakeDb({ due: NOT_DUE });
    const { verifier, verify } = verifierReturning({ status: 'verified', directoryUserId: 'dir-1' });
    await checkTeamMailbox(db, source, verifier);
    expect(verify).not.toHaveBeenCalled();
    expect(calls.map((c) => c.name)).toEqual(['discovery_team_mailbox_check_due']);
  });

  it.each([
    ['no open registration', { due: false, teamMailboxId: null, address: null, pinnedId: null }],
    ['a due answer with no registration', { due: true, teamMailboxId: null, address: ADDRESS, pinnedId: null }],
    ['a due answer with no address', { due: true, teamMailboxId: TEAM, address: null, pinnedId: null }],
    ['an answer of the wrong shape', 'due'],
    ['no answer', null],
  ])('verifies nothing on %s', async (_name, data) => {
    const { db, calls } = fakeDb({ due: { data, error: null } });
    const { verifier, verify } = verifierReturning({ status: 'verified', directoryUserId: 'dir-1' });
    await checkTeamMailbox(db, source, verifier);
    expect(verify).not.toHaveBeenCalled();
    expect(calls.map((c) => c.name)).toEqual(['discovery_team_mailbox_check_due']);
  });

  it('verifies the registration\'s address for the source\'s tenant, with the pinned id, when due', async () => {
    const { db } = fakeDb({ due: { data: { due: true, teamMailboxId: TEAM, address: ADDRESS, pinnedId: 'dir-0' }, error: null } });
    const { verifier, verify } = verifierReturning({ status: 'verified', directoryUserId: 'dir-0' });
    await checkTeamMailbox(db, source, verifier);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(TENANT, ADDRESS, 'dir-0');
  });

  it('records a verified outcome with the Directory id', async () => {
    const { db, calls } = fakeDb({ due: DUE });
    await checkTeamMailbox(db, source, verifierReturning({ status: 'verified', directoryUserId: 'dir-1' }).verifier);
    expect(calls[1]).toEqual({
      name: 'discovery_record_team_mailbox_check',
      args: { p_id: TEAM, p_status: 'verified', p_reason: null, p_directory_user_id: 'dir-1' },
    });
  });

  it.each(['group', 'alias', 'suspended', 'no_mailbox', 'not_found', 'identity_changed', 'directory_denied'] as const)(
    'records a definitive refusal (%s) with its reason and no id',
    async (reason) => {
      const { db, calls } = fakeDb({ due: DUE });
      await checkTeamMailbox(db, source, verifierReturning({ status: 'refused', reason }).verifier);
      expect(calls[1]).toEqual({
        name: 'discovery_record_team_mailbox_check',
        args: { p_id: TEAM, p_status: 'refused', p_reason: reason, p_directory_user_id: null },
      });
    },
  );

  it('records a transient error as an error, not a refusal', async () => {
    const { db, calls } = fakeDb({ due: DUE });
    await checkTeamMailbox(db, source, verifierReturning({ status: 'error', reason: 'directory_error' }).verifier);
    expect(calls[1]).toEqual({
      name: 'discovery_record_team_mailbox_check',
      args: { p_id: TEAM, p_status: 'error', p_reason: 'directory_error', p_directory_user_id: null },
    });
  });

  it('records a verifier that throws as a transient error, and the message goes nowhere', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info')];
    const { db, calls } = fakeDb({ due: DUE });
    await expect(
      checkTeamMailbox(db, source, verifierReturning(new Error(`directory refused ${ADDRESS}`)).verifier),
    ).resolves.toBeUndefined();
    expect(calls[1].args).toEqual({ p_id: TEAM, p_status: 'error', p_reason: 'directory_error', p_directory_user_id: null });
    expect(JSON.stringify(calls)).not.toContain('refused deals');
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });
});

describe('without a verifier nothing happens', () => {
  it('does not even ask the database, so the registration stays as it is', async () => {
    const { db, calls } = fakeDb({ due: DUE });
    await checkTeamMailbox(db, source, null);
    expect(calls).toEqual([]);
  });
});

describe('a database failure fails the pass instead of reading on an unrecorded check', () => {
  it('throws with a code only when the due lookup fails, and verifies and records nothing', async () => {
    const { db, calls } = fakeDb({ due: { data: null, error: { code: '57014', message: `canceling for ${ADDRESS}` } } });
    const { verifier, verify } = verifierReturning({ status: 'verified', directoryUserId: 'dir-1' });
    const error = await checkTeamMailbox(db, source, verifier).catch((e: unknown) => e);
    expect((error as Error).message).toBe('team mailbox check lookup failed (57014)');
    expect(verify).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('throws with a code only when the outcome cannot be recorded', async () => {
    const { db } = fakeDb({ due: DUE, record: { data: null, error: { code: '22023', message: `bad ${ADDRESS}` } } });
    const error = await checkTeamMailbox(
      db,
      source,
      verifierReturning({ status: 'verified', directoryUserId: 'dir-1' }).verifier,
    ).catch((e: unknown) => e);
    expect((error as Error).message).toBe('team mailbox check could not be recorded (22023)');
    expect((error as Error).message).not.toContain('@');
  });
});

// The mid-pass renewal (#581, design R7): the guarded reader calls it once when the guard says the confirmation aged out
// between two pages. It runs the same check without waiting for the database to call it due, because the guard has just
// said it is overdue; it writes the registry and nothing else, and the guard decides what happens next.
describe('the mid-pass renewal verifies whether or not the database calls the check due', () => {
  it('verifies and records when the check is not due', async () => {
    const { db, calls } = fakeDb({ due: NOT_DUE });
    const { verifier, verify } = verifierReturning({ status: 'verified', directoryUserId: 'dir-1' });
    await recheckTeamMailbox(db, source, verifier);
    expect(verify).toHaveBeenCalledWith(TENANT, ADDRESS, null);
    expect(calls.map((c) => c.name)).toEqual(['discovery_team_mailbox_check_due', 'discovery_record_team_mailbox_check']);
    expect(calls[1].args).toEqual({ p_id: TEAM, p_status: 'verified', p_reason: null, p_directory_user_id: 'dir-1' });
  });

  it('verifies against the pinned id, as the start-of-pass check does', async () => {
    const { db } = fakeDb({ due: { data: { due: false, teamMailboxId: TEAM, address: ADDRESS, pinnedId: 'dir-0' }, error: null } });
    const { verifier, verify } = verifierReturning({ status: 'verified', directoryUserId: 'dir-0' });
    await recheckTeamMailbox(db, source, verifier);
    expect(verify).toHaveBeenCalledWith(TENANT, ADDRESS, 'dir-0');
  });

  it('records a definitive refusal and a transient error the same way', async () => {
    const refused = fakeDb({ due: NOT_DUE });
    await recheckTeamMailbox(refused.db, source, verifierReturning({ status: 'refused', reason: 'suspended' }).verifier);
    expect(refused.calls[1].args).toEqual({ p_id: TEAM, p_status: 'refused', p_reason: 'suspended', p_directory_user_id: null });
    const thrown = fakeDb({ due: NOT_DUE });
    await recheckTeamMailbox(thrown.db, source, verifierReturning(new Error(`down ${ADDRESS}`)).verifier);
    expect(thrown.calls[1].args).toEqual({ p_id: TEAM, p_status: 'error', p_reason: 'directory_error', p_directory_user_id: null });
  });

  it.each([
    ['no open registration', { due: false, teamMailboxId: null, address: null, pinnedId: null }],
    ['an answer of the wrong shape', 'due'],
    ['no answer', null],
  ])('verifies nothing on %s: there is no registration to renew', async (_name, data) => {
    const { db, calls } = fakeDb({ due: { data, error: null } });
    const { verifier, verify } = verifierReturning({ status: 'verified', directoryUserId: 'dir-1' });
    await recheckTeamMailbox(db, source, verifier);
    expect(verify).not.toHaveBeenCalled();
    expect(calls.map((c) => c.name)).toEqual(['discovery_team_mailbox_check_due']);
  });

  it('renews nothing without a verifier, so the guard asked again refuses again', async () => {
    const { db, calls } = fakeDb({ due: DUE });
    await recheckTeamMailbox(db, source, null);
    expect(calls).toEqual([]);
  });

  it('fails with a code only when the database cannot answer or record', async () => {
    const lookup = fakeDb({ due: { data: null, error: { code: '57014', message: `canceling for ${ADDRESS}` } } });
    const lookupError = await recheckTeamMailbox(lookup.db, source, verifierReturning({ status: 'verified', directoryUserId: 'd' }).verifier).catch(
      (e: unknown) => e,
    );
    expect((lookupError as Error).message).toBe('team mailbox check lookup failed (57014)');
    const record = fakeDb({ due: NOT_DUE, record: { data: null, error: { code: '22023', message: `bad ${ADDRESS}` } } });
    const recordError = await recheckTeamMailbox(record.db, source, verifierReturning({ status: 'verified', directoryUserId: 'd' }).verifier).catch(
      (e: unknown) => e,
    );
    expect((recordError as Error).message).toBe('team mailbox check could not be recorded (22023)');
  });
});
