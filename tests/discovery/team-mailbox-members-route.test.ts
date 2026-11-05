import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/api/v1/requireFlag', () => ({ requireFlag: vi.fn() }));
vi.mock('@/lib/api/v1/httpScoped', () => ({ requireApiUserScoped: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import { requireFlag } from '@/lib/api/v1/requireFlag';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { POST } from '@/app/api/v1/discovery/team-mailboxes/[teamMailboxId]/members/route';
import { DELETE } from '@/app/api/v1/discovery/team-mailboxes/[teamMailboxId]/members/[userId]/route';

const flag = vi.mocked(requireFlag);
const scoped = vi.mocked(requireApiUserScoped);

const TEAM_MAILBOX = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const USER = '0b9a8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d';

const member = { userId: USER, name: 'Storm Duncan', email: 'storm@bank.example', addedAt: '2026-10-19T10:00:00Z' };

type RpcResult = { data: unknown; error: { code: string; message: string } | null };

function signedIn(result: RpcResult) {
  const rpc = vi.fn(async (): Promise<RpcResult> => result);
  scoped.mockResolvedValue({ ok: true, user: { id: 'u1', email: 'a@bank.example', companyId: null }, db: { rpc } as never });
  return rpc;
}

function refusal(code: string, message: string): RpcResult {
  return { data: null, error: { code, message } };
}

function post(body: unknown, teamMailboxId = TEAM_MAILBOX) {
  return POST(
    new Request('http://localhost/api/v1/discovery/team-mailboxes/x/members', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ teamMailboxId }) },
  );
}

function del(teamMailboxId: string, userId: string) {
  return DELETE(new Request('http://localhost/api/v1/discovery/team-mailboxes/x/members/y', { method: 'DELETE' }), {
    params: Promise.resolve({ teamMailboxId, userId }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  flag.mockResolvedValue(null);
});

describe('POST /api/v1/discovery/team-mailboxes/[teamMailboxId]/members', () => {
  it('is 404 when deal_discovery is off, and never reaches the session or the RPC', async () => {
    flag.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }));
    const rpc = signedIn({ data: null, error: null });
    expect((await post({ userId: USER })).status).toBe(404);
    expect(flag).toHaveBeenCalledWith('deal_discovery');
    expect(scoped).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('returns the scoped helper 401 when unauthenticated', async () => {
    scoped.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await post({ userId: USER })).status).toBe(401);
  });

  it('is 400 for an inbox id that is not a UUID, and never reaches the RPC', async () => {
    const rpc = signedIn({ data: null, error: null });
    const res = await post({ userId: USER }, 'not-a-uuid');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'teamMailboxId must be a UUID' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['not JSON', 'not json'],
    ['a JSON array', []],
    ['a JSON string', '"x"'],
    ['null', 'null'],
  ])('is 400 for a body that is %s', async (_label, body) => {
    const rpc = signedIn({ data: null, error: null });
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON body' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', {}],
    ['a number', { userId: 5 }],
    ['null', { userId: null }],
    ['not a UUID', { userId: 'storm@bank.example' }],
  ])('is 400 when userId is %s', async (_label, body) => {
    const rpc = signedIn({ data: null, error: null });
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'userId must be a UUID' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('adds under the caller session and answers 201 { member }', async () => {
    const rpc = signedIn({ data: { added: true, member }, error: null });
    const res = await post({ userId: USER });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ member });
    expect(rpc).toHaveBeenCalledWith('discovery_add_team_mailbox_member', { p_id: TEAM_MAILBOX, p_user: USER });
  });

  it('answers 200 for a person who already is a member', async () => {
    signedIn({ data: { added: false, member }, error: null });
    const res = await post({ userId: USER });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ member });
  });

  it('answers 422 not_eligible_member for an external, an admin, the caller or an unseated person', async () => {
    signedIn(refusal('22023', 'not_eligible_member'));
    const res = await post({ userId: USER });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'not_eligible_member' });
  });

  it('answers 404 to the RPC 42501 refusal, whatever the reason', async () => {
    signedIn(refusal('42501', 'not_available'));
    const res = await post({ userId: USER });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('does not take a refusal message under the wrong SQLSTATE', async () => {
    signedIn(refusal('42501', 'not_eligible_member'));
    expect((await post({ userId: USER })).status).toBe(500);
    signedIn(refusal('22023', 'not_available'));
    expect((await post({ userId: USER })).status).toBe(500);
  });

  it('answers 500 to any other failure, without the database message', async () => {
    signedIn(refusal('XX000', 'relation team_mailbox_members is on fire'));
    const res = await post({ userId: USER });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('on fire');
  });

  it('answers 500 when the RPC returns no member', async () => {
    signedIn({ data: { added: true }, error: null });
    expect((await post({ userId: USER })).status).toBe(500);
  });
});

describe('DELETE /api/v1/discovery/team-mailboxes/[teamMailboxId]/members/[userId]', () => {
  it('returns the scoped helper 401 when unauthenticated', async () => {
    scoped.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await del(TEAM_MAILBOX, USER)).status).toBe(401);
  });

  it('is 400 for an id that is not a UUID, and never reaches the RPC', async () => {
    const rpc = signedIn({ data: null, error: null });
    const inbox = await del('not-a-uuid', USER);
    expect(inbox.status).toBe(400);
    expect(await inbox.json()).toEqual({ error: 'teamMailboxId must be a UUID' });
    const person = await del(TEAM_MAILBOX, 'storm@bank.example');
    expect(person.status).toBe(400);
    expect(await person.json()).toEqual({ error: 'userId must be a UUID' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('removes under the caller session and answers 204 with no body', async () => {
    const rpc = signedIn({ data: { removed: true }, error: null });
    const res = await del(TEAM_MAILBOX, USER);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(rpc).toHaveBeenCalledWith('discovery_remove_team_mailbox_member', { p_id: TEAM_MAILBOX, p_user: USER });
  });

  it('answers 204 as well for a person who was not a member: removing is idempotent', async () => {
    signedIn({ data: { removed: false }, error: null });
    expect((await del(TEAM_MAILBOX, USER)).status).toBe(204);
  });

  it('answers 404 to the RPC 42501 refusal, whatever the reason', async () => {
    signedIn(refusal('42501', 'not_available'));
    const res = await del(TEAM_MAILBOX, USER);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('answers 500 to any other failure, without the database message', async () => {
    signedIn(refusal('XX000', 'relation team_mailbox_members is on fire'));
    const res = await del(TEAM_MAILBOX, USER);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('on fire');
  });

  it('answers 500 when the RPC returns no outcome', async () => {
    signedIn({ data: null, error: null });
    expect((await del(TEAM_MAILBOX, USER)).status).toBe(500);
  });

  it('is not behind deal_discovery: a way to stop someone reading stays reachable', async () => {
    flag.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }));
    signedIn({ data: { removed: true }, error: null });
    expect((await del(TEAM_MAILBOX, USER)).status).toBe(204);
    expect(flag).not.toHaveBeenCalled();
  });
});
