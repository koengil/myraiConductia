// POST /api/v1/invites/perimeter-preview — route behavior.
//
// The perimeter computation itself is pinned in tests/perimeter-parity.test.ts.
// This suite pins what the route adds: the flag gate running BEFORE auth, mode
// validation, opaque failure mapping, and the Gate 0 no-deal case.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/v1/requireFlag', () => ({ requireFlag: vi.fn(async () => null) }));
vi.mock('@/lib/api/v1/http', async (original) => {
  const actual = await original<typeof import('@/lib/api/v1/http')>();
  return {
    ...actual,
    requireApiUser: vi.fn(),
    resolveDealRef: vi.fn(async () => ({ id: 'deal-uuid', code: 'PROJECT-X' })),
  };
});
vi.mock('@/lib/perimeter/perimeter', () => ({
  perimeterForProposal: vi.fn(),
  perimeterForMember: vi.fn(),
}));
// The invite family's visibility gate (D65). By default the caller can see the
// deal; the gate's own tests flip these.
vi.mock('@/lib/api/v1/access', async (original) => ({
  ...(await original<typeof import('@/lib/api/v1/access')>()),
  userCanAccessDeal: vi.fn(async () => true),
  userCanInviteChecked: vi.fn(async () => false),
}));

import { POST } from '@/app/api/v1/invites/perimeter-preview/route';
import { requireApiUser, resolveDealRef } from '@/lib/api/v1/http';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { perimeterForMember, perimeterForProposal } from '@/lib/perimeter/perimeter';
import { jsonError } from '@/lib/api/v1/http';
import { userCanAccessDeal, userCanInviteChecked } from '@/lib/api/v1/access';

const PERIMETER = {
  destinations: ['mandate', 'rail', 'dataRoom', 'team'],
  documents: { total: 4, rooms: [{ room: 'deal', count: 4 }] },
  capabilities: { canUploadToDataRoom: true, canInviteTeammate: false },
  invariants: ['external_never_internal_room', 'external_never_mnpi'],
};

function signedIn() {
  vi.mocked(requireApiUser).mockResolvedValue({
    ok: true,
    user: { id: 'md-1', email: 'storm@bank.dev' },
    admin: { from: vi.fn() },
  } as never);
}

const post = (body: unknown) =>
  POST(
    new Request('http://test/api/v1/invites/perimeter-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

const proposal = (over: Record<string, unknown> = {}) => ({
  proposal: {
    email: 'alex@target.example',
    companyId: 'seller-1',
    companyRole: 'member',
    dealId: 'PROJECT-X',
    dealRole: 'seller',
    phase: 1,
    ...over,
  },
});

afterEach(() => vi.clearAllMocks());

describe('perimeter-preview — the flag gate closes before anything else', () => {
  it('404s with the flag off, without ever authenticating', async () => {
    vi.mocked(requireFlag).mockResolvedValueOnce(jsonError('Not found', 404));

    const res = await post(proposal());

    expect(res.status).toBe(404);
    expect(requireApiUser).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller', async () => {
    vi.mocked(requireApiUser).mockResolvedValue({
      ok: false,
      response: jsonError('Unauthorized', 401),
    } as never);

    expect((await post(proposal())).status).toBe(401);
    expect(perimeterForProposal).not.toHaveBeenCalled();
  });
});

describe('perimeter-preview — mode validation', () => {
  it('rejects a request carrying both modes, and one carrying neither', async () => {
    signedIn();

    expect((await post({ ...proposal(), member: { dealId: 'd', userId: 'u', phase: 1 } })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it('requires dealId and dealRole together', async () => {
    signedIn();

    expect((await post(proposal({ dealRole: null }))).status).toBe(400);
  });

  it('rejects a malformed email before computing anything', async () => {
    signedIn();

    expect((await post(proposal({ email: 'not-an-email' }))).status).toBe(400);
    expect(perimeterForProposal).not.toHaveBeenCalled();
  });
});

describe('perimeter-preview — proposal mode', () => {
  it('returns the perimeter for an authorized proposal', async () => {
    signedIn();
    vi.mocked(perimeterForProposal).mockResolvedValue({ ok: true, perimeter: PERIMETER } as never);

    const res = await post(proposal());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.dealContext).toBe('existing');
    expect(body.perimeter.documents.total).toBe(4);
  });

  it('previews a Gate 0 proposal that has no deal yet', async () => {
    // The wizard composes invitations before the deal exists. Absent deal
    // context is a first-class case, not an error.
    signedIn();
    vi.mocked(perimeterForProposal).mockResolvedValue({
      ok: true,
      perimeter: { ...PERIMETER, documents: { total: 0, rooms: [] } },
    } as never);

    const res = await post(proposal({ dealId: null, dealRole: null }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.dealContext).toBe('proposed');
    expect(body.perimeter.documents.total).toBe(0);
    expect(resolveDealRef).not.toHaveBeenCalled();
  });

  it('answers an unauthorized proposal opaquely', async () => {
    // Criterion B12. The response must not distinguish "no authority" from
    // "no such company", or the preview becomes a probe.
    signedIn();
    vi.mocked(perimeterForProposal).mockResolvedValue({ ok: false, reason: 'forbidden' } as never);

    const res = await post(proposal());
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(JSON.stringify(body)).not.toMatch(/seller-1|tenant|company|deal/i);
  });

  it('explains that an unclaimed company needs its first director', async () => {
    signedIn();
    vi.mocked(perimeterForProposal).mockResolvedValue({
      ok: false,
      reason: 'company_requires_director',
    } as never);

    const res = await post(proposal());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      error: 'This company needs its first active director. Invite this person as Company Director.',
      code: 'company_requires_director',
    });
  });

  it('fails closed rather than reporting an empty perimeter', async () => {
    // Criterion B10: "unavailable" must never arrive dressed as "they can see
    // nothing", which would read as a real zero-access answer.
    signedIn();
    vi.mocked(perimeterForProposal).mockResolvedValue({ ok: false, reason: 'unavailable' } as never);

    const res = await post(proposal());
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body).not.toHaveProperty('perimeter');
  });
});

describe('perimeter-preview — member mode', () => {
  it('returns the perimeter for a proposed phase raise', async () => {
    signedIn();
    vi.mocked(perimeterForMember).mockResolvedValue({ ok: true, perimeter: PERIMETER } as never);

    const res = await post({ member: { dealId: 'PROJECT-X', userId: 'u-2', phase: 2 } });

    expect(res.status).toBe(200);
    expect(perimeterForMember).toHaveBeenCalledWith(
      expect.anything(),
      'md-1',
      'deal-uuid',
      'u-2',
      2,
    );
  });

  it('refuses a downgrade with the same answer the real phase raise gives', async () => {
    signedIn();
    vi.mocked(perimeterForMember).mockResolvedValue({
      ok: false,
      reason: 'phase_downgrade',
    } as never);

    const res = await post({ member: { dealId: 'PROJECT-X', userId: 'u-2', phase: 0 } });

    expect(res.status).toBe(409);
  });

  it('answers an actor without authority over the member opaquely', async () => {
    signedIn();
    vi.mocked(perimeterForMember).mockResolvedValue({ ok: false, reason: 'forbidden' } as never);

    expect((await post({ member: { dealId: 'PROJECT-X', userId: 'u-2', phase: 2 } })).status).toBe(403);
  });

  it('requires a phase', async () => {
    signedIn();

    expect((await post({ member: { dealId: 'PROJECT-X', userId: 'u-2' } })).status).toBe(400);
  });

  it('keeps the role 403 for a caller who can see the deal but is not its MD', async () => {
    // A seated CCO or deal-team member already knows the deal exists.
    signedIn();
    vi.mocked(perimeterForMember).mockResolvedValue({ ok: false, reason: 'forbidden' } as never);

    const res = await post({ member: { dealId: 'PROJECT-X', userId: 'u-2', phase: 2 } });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });
});

describe('perimeter-preview — a caller who cannot see the deal (D65)', () => {
  function unseated() {
    signedIn();
    vi.mocked(userCanAccessDeal).mockResolvedValueOnce(false);
    vi.mocked(userCanInviteChecked).mockResolvedValueOnce(false);
  }

  it('gets the missing-deal answer in member mode, before any perimeter is computed', async () => {
    unseated();

    const res = await post({ member: { dealId: 'PROJECT-X', userId: 'u-2', phase: 2 } });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Deal not found' });
    expect(perimeterForMember).not.toHaveBeenCalled();
  });

  it('gets the missing-deal answer for a malformed phase, not the 400 a visible deal gives', async () => {
    unseated();

    const res = await post({ member: { dealId: 'PROJECT-X', userId: 'u-2', phase: -1 } });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Deal not found' });
  });

  it('gets the missing-deal answer in proposal mode', async () => {
    unseated();

    const res = await post(proposal());

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Deal not found' });
    expect(perimeterForProposal).not.toHaveBeenCalled();
  });

  it('passes a caller who holds invite authority on the deal without a seat', async () => {
    // A party company's director or the owning bank's director.
    signedIn();
    vi.mocked(userCanAccessDeal).mockResolvedValueOnce(false);
    vi.mocked(userCanInviteChecked).mockResolvedValueOnce(true);
    vi.mocked(perimeterForProposal).mockResolvedValue({ ok: true, perimeter: PERIMETER } as never);

    expect((await post(proposal())).status).toBe(200);
  });

  it('answers 503 when the authority read fails, never a pass', async () => {
    signedIn();
    vi.mocked(userCanAccessDeal).mockResolvedValueOnce(false);
    vi.mocked(userCanInviteChecked).mockResolvedValueOnce('unreadable');

    expect((await post(proposal())).status).toBe(503);
    expect(perimeterForProposal).not.toHaveBeenCalled();
  });
});

describe('perimeter-preview — the response carries no document metadata', () => {
  it('returns counts and capabilities only', async () => {
    // Criterion B6. Titles, filenames, uploaders, timestamps and storage ids
    // are never read by the computation, so they cannot appear here.
    signedIn();
    vi.mocked(perimeterForProposal).mockResolvedValue({ ok: true, perimeter: PERIMETER } as never);

    const body = await (await post(proposal())).json();
    const serialized = JSON.stringify(body);

    for (const forbidden of ['title', 'name', 'filename', 'storage', 'uploaded', 'created_at']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
    expect(Object.keys(body.perimeter).sort()).toEqual([
      'capabilities',
      'destinations',
      'documents',
      'invariants',
    ]);
  });
});
