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
import { TEAM_MAILBOX_ATTESTATION_VERSION } from '@/lib/constants/discovery';
import { GET, POST } from '@/app/api/v1/discovery/team-mailboxes/route';
import { DELETE } from '@/app/api/v1/discovery/team-mailboxes/[teamMailboxId]/route';

const flag = vi.mocked(requireFlag);
const scoped = vi.mocked(requireApiUserScoped);

const TEAM_MAILBOX = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const SOURCE = '0b9a8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c6d';

const registration = {
  id: TEAM_MAILBOX,
  address: 'deals@bank.example',
  provider: 'google',
  connectedAt: '2026-10-19T10:00:00Z',
  checkStatus: 'pending',
  checkReason: null,
  checkedAt: null,
  sourceId: SOURCE,
  backfillSince: '2026-09-19',
};

type RpcResult = { data: unknown; error: { code: string; message: string } | null };

function signedIn(result: RpcResult) {
  const rpc = vi.fn(async (): Promise<RpcResult> => result);
  scoped.mockResolvedValue({ ok: true, user: { id: 'u1', email: 'a@bank.example', companyId: null }, db: { rpc } as never });
  return rpc;
}

function refusal(code: string, message: string): RpcResult {
  return { data: null, error: { code, message } };
}

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/v1/discovery/team-mailboxes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

function del(teamMailboxId: string) {
  return DELETE(new Request('http://localhost/api/v1/discovery/team-mailboxes/x', { method: 'DELETE' }), {
    params: Promise.resolve({ teamMailboxId }),
  });
}

const valid = { address: 'deals@bank.example', attestationVersion: TEAM_MAILBOX_ATTESTATION_VERSION };

beforeEach(() => {
  vi.clearAllMocks();
  flag.mockResolvedValue(null);
});

describe('GET /api/v1/discovery/team-mailboxes', () => {
  it('is 404 when deal_discovery is off, and never reaches the session', async () => {
    flag.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }));
    const res = await GET();
    expect(res.status).toBe(404);
    expect(flag).toHaveBeenCalledWith('deal_discovery');
    expect(scoped).not.toHaveBeenCalled();
  });

  it('returns the scoped helper 401 when unauthenticated', async () => {
    scoped.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await GET()).status).toBe(401);
  });

  it('calls the list RPC under the caller session and answers { teamMailboxes }', async () => {
    const entry = { ...registration, lastCheckError: null, sourceStatus: 'active', removable: true };
    const rpc = signedIn({ data: [entry], error: null });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ teamMailboxes: [entry] });
    expect(rpc).toHaveBeenCalledWith('discovery_team_mailboxes');
  });

  it('answers an empty list as an empty list', async () => {
    signedIn({ data: [], error: null });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ teamMailboxes: [] });
  });

  it('answers 404 to the RPC 42501 refusal: a caller who is not the firm admin learns nothing', async () => {
    signedIn(refusal('42501', 'not_available'));
    const res = await GET();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('answers 500 to any other failure, without the database message', async () => {
    signedIn(refusal('XX000', 'relation team_mailboxes is on fire'));
    const res = await GET();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('on fire');
  });

  it('answers 500 when the RPC returns something that is not a list', async () => {
    signedIn({ data: { teamMailboxes: [] }, error: null });
    expect((await GET()).status).toBe(500);
  });
});

describe('POST /api/v1/discovery/team-mailboxes', () => {
  it('is 404 when deal_discovery is off, and never reaches the RPC', async () => {
    flag.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }));
    const rpc = signedIn({ data: null, error: null });
    expect((await post(valid)).status).toBe(404);
    expect(scoped).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('returns the scoped helper 401 when unauthenticated', async () => {
    scoped.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await post(valid)).status).toBe(401);
  });

  it.each([
    ['not JSON', 'not json'],
    ['a JSON array', []],
    ['a JSON string', '"deals@bank.example"'],
    ['null', 'null'],
  ])('is 400 for a body that is %s', async (_label, body) => {
    const rpc = signedIn({ data: null, error: null });
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON body' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', { attestationVersion: 1 }],
    ['a number', { address: 5, attestationVersion: 1 }],
    ['null', { address: null, attestationVersion: 1 }],
    ['over 400 characters', { address: `${'a'.repeat(401)}@bank.example`, attestationVersion: 1 }],
  ])('is 400 when the address is %s', async (_label, body) => {
    const rpc = signedIn({ data: null, error: null });
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'address is required' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', { address: 'deals@bank.example' }],
    ['a string', { address: 'deals@bank.example', attestationVersion: '1' }],
    ['fractional', { address: 'deals@bank.example', attestationVersion: 1.5 }],
    ['true', { address: 'deals@bank.example', attestationVersion: true }],
  ])('is 400 when attestationVersion is %s', async (_label, body) => {
    const rpc = signedIn({ data: null, error: null });
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'attestationVersion is required' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([0, TEAM_MAILBOX_ATTESTATION_VERSION + 1, -1])(
    'is 422 attestation_required for the attestation version %s, without calling the RPC',
    async (attestationVersion) => {
      const rpc = signedIn({ data: null, error: null });
      const res = await post({ ...valid, attestationVersion });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: 'attestation_required' });
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['a number', 20261019],
    ['not a date', 'yesterday'],
    ['a timestamp', '2026-10-19T00:00:00Z'],
    ['an impossible day', '2026-02-30'],
    ['a month 13', '2026-13-01'],
    ['US order', '10/19/2026'],
  ])('is 400 when backfillSince is %s', async (_label, backfillSince) => {
    const rpc = signedIn({ data: null, error: null });
    const res = await post({ ...valid, backfillSince });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'backfillSince must be a date, YYYY-MM-DD' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('connects: passes the address, the attestation and no window, and answers 201 { teamMailbox }', async () => {
    const rpc = signedIn({ data: { created: true, teamMailbox: registration }, error: null });
    const res = await post(valid);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ teamMailbox: registration });
    expect(rpc).toHaveBeenCalledWith('discovery_connect_team_mailbox', {
      p_address: 'deals@bank.example',
      p_attestation_version: TEAM_MAILBOX_ATTESTATION_VERSION,
      p_backfill_since: null,
    });
  });

  it('passes the first-read window through, and treats a null window as none', async () => {
    const rpc = signedIn({ data: { created: true, teamMailbox: registration }, error: null });
    await post({ ...valid, backfillSince: '2026-09-19' });
    expect(rpc).toHaveBeenLastCalledWith('discovery_connect_team_mailbox', expect.objectContaining({ p_backfill_since: '2026-09-19' }));
    await post({ ...valid, backfillSince: null });
    expect(rpc).toHaveBeenLastCalledWith('discovery_connect_team_mailbox', expect.objectContaining({ p_backfill_since: null }));
  });

  it('hands the address on as typed: the RPC trims, lower-cases and judges it', async () => {
    const rpc = signedIn({ data: { created: true, teamMailbox: registration }, error: null });
    await post({ ...valid, address: '  Deals@Bank.example ' });
    expect(rpc).toHaveBeenCalledWith(
      'discovery_connect_team_mailbox',
      expect.objectContaining({ p_address: '  Deals@Bank.example ' }),
    );
  });

  it('answers 200 for an inbox that is already connected', async () => {
    signedIn({ data: { created: false, teamMailbox: registration }, error: null });
    const res = await post(valid);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ teamMailbox: registration });
  });

  it.each([
    ['42501', 'not_eligible', 403],
    ['23505', 'person_address', 409],
    ['22023', 'provider_unresolved', 422],
    ['22023', 'provider_unsupported', 422],
    ['22023', 'out_of_range', 422],
    ['22023', 'invalid_address', 422],
    ['22023', 'attestation_required', 422],
  ])('maps the RPC refusal %s %s to %s with the code as the body', async (code, message, status) => {
    signedIn(refusal(code, message));
    const res = await post(valid);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: message });
  });

  it('answers 404 when the RPC finds discovery off (the flag moved between the two reads)', async () => {
    signedIn(refusal('P0001', 'discovery_disabled'));
    const res = await post(valid);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('does not take a refusal message under the wrong SQLSTATE for that refusal', async () => {
    signedIn(refusal('42501', 'person_address'));
    expect((await post(valid)).status).toBe(500);
  });

  it('answers 500 to any other failure, without the database message', async () => {
    signedIn(refusal('XX000', 'relation team_mailboxes is on fire'));
    const res = await post(valid);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('on fire');
  });

  it('answers 500 when the RPC returns no registration', async () => {
    signedIn({ data: { created: true }, error: null });
    expect((await post(valid)).status).toBe(500);
  });

  it('does not echo a constructor-like refusal message as a known code', async () => {
    signedIn(refusal('XX000', 'constructor'));
    expect((await post(valid)).status).toBe(500);
  });
});

describe('DELETE /api/v1/discovery/team-mailboxes/[teamMailboxId]', () => {
  it('returns the scoped helper 401 when unauthenticated', async () => {
    scoped.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    expect((await del(TEAM_MAILBOX)).status).toBe(401);
  });

  it('is 400 for a non-uuid id, and never reaches the RPC', async () => {
    const rpc = signedIn({ data: null, error: null });
    const res = await del('not-a-uuid');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'teamMailboxId must be a UUID' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('removes under the caller session and answers 204 with no body', async () => {
    const rpc = signedIn({ data: { id: TEAM_MAILBOX, sourceId: SOURCE, removed: true }, error: null });
    const res = await del(TEAM_MAILBOX);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(rpc).toHaveBeenCalledWith('discovery_remove_team_mailbox', { p_id: TEAM_MAILBOX });
  });

  it('answers 404 to the RPC 42501 refusal, whatever the reason', async () => {
    signedIn(refusal('42501', 'not_available'));
    const res = await del(TEAM_MAILBOX);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('answers 409 not_removable when the registration holds mail', async () => {
    signedIn(refusal('55000', 'not_removable'));
    const res = await del(TEAM_MAILBOX);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_removable' });
  });

  it('answers 500 to any other failure, without the database message', async () => {
    signedIn(refusal('XX000', 'relation team_mailboxes is on fire'));
    const res = await del(TEAM_MAILBOX);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('on fire');
  });

  it('is not behind deal_discovery: a way out stays reachable', async () => {
    flag.mockResolvedValue(NextResponse.json({ error: 'Not found' }, { status: 404 }));
    signedIn({ data: { id: TEAM_MAILBOX, sourceId: SOURCE, removed: true }, error: null });
    expect((await del(TEAM_MAILBOX)).status).toBe(204);
    expect(flag).not.toHaveBeenCalled();
  });
});
