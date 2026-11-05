import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * D8.16 — the demo path of D7, driven end to end through the real route
 * handlers rather than described in a runbook.
 *
 * One MD composes an invitation for an external seller: lookup identifies the
 * company and proposes a seat, the preview says what that seat would see, the
 * invitation is sent carrying the confirmed phase, and the accepted seat's
 * welcome reading reports the same perimeter the preview promised.
 *
 * What this covers: the composed path across the real handlers — lookup,
 * preview, send, verify, accept, the second-factor record — driven from the
 * invite surface the MD actually uses and the two-factor page the invitee
 * actually sees, ending on the brief. One invitation runs the whole length of
 * it: the phase the MD confirms is the phase the send RPC carries, the seat
 * exists only because acceptance created it, the invitee reaches the deal only
 * once AAL2 holds, and the count the preview promised is the count the welcome
 * brief prints.
 *
 * What it does NOT cover, and what does: the database half — that acceptance
 * grants and audits the stored phase — is exercised against real SQL by
 * supabase/tests/invite_phase_accept.sql (wrapper: tests/db/…). Asserting that
 * here against a mocked client would prove the mock, not the migration. The
 * invitation store below records what was sent and answers from it; it
 * re-implements no authority.
 */
vi.mock('@/lib/api/v1/requireFlag', () => ({
  requireFlag: vi.fn(async () => null),
  isFlagEnabled: vi.fn(async () => false),
}));
vi.mock('@/lib/api/v1/access', () => ({
  // The invite family's deal-visibility gate (D65): the caller can see the deal.
  userCanAccessDeal: vi.fn(async () => true),
  userCanInvite: vi.fn(async () => true),
  userCanInviteChecked: vi.fn(async () => true),
  canManageCompanyMembers: vi.fn(async () => true),
  canManageDealMembers: vi.fn(async () => true),
  userIsDealMd: vi.fn(async () => true),
  userCanManageInvite: vi.fn(async () => true),
}));
vi.mock('@/lib/api/v1/inviteDelivery', () => ({
  deliverInvite: vi.fn(async () => ({ deliveryStatus: 'sent' })),
  fetchInviteEmailContext: vi.fn(async () => ({})),
}));
vi.mock('@/lib/api/v1/http', async (original) => {
  const actual = await original<typeof import('@/lib/api/v1/http')>();
  return {
    ...actual,
    requireApiUser: vi.fn(),
    resolveDealRef: vi.fn(async () => ({ id: 'deal-1', code: 'PROJECT-X' })),
  };
});
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));
vi.mock('@/lib/supabase/client', () => ({ createSupabaseBrowserClient: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: vi.fn() }));

process.env.INVITE_VERIFICATION_PEPPER ??= 'e2e-pepper';

import { createElement } from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { requireApiUser } from '@/lib/api/v1/http';
import { createSupabaseServerClient, createSupabaseAdminClient } from '@/lib/supabase/server';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';
import TwoFactorPageClient from '@/app/two-factor/page.client';
import { digestInviteChallengeCode } from '@/lib/api/v1/inviteChallenge';
import { TOS_VERSION } from '@/lib/constants/legal';
import { AUDIT_ACTION } from '@/lib/constants/audit';
import { POST as lookup } from '@/app/api/v1/invites/lookup/route';
import { POST as preview } from '@/app/api/v1/invites/perimeter-preview/route';
import { POST as sendInvite } from '@/app/api/v1/invites/route';
import { POST as verifyCode } from '@/app/api/v1/invites/verify/route';
import { POST as acceptInvite } from '@/app/api/v1/invites/accept/route';
import { perimeterForViewer } from '@/lib/perimeter/perimeter';
import { POST as completeMfa } from '@/app/api/v1/auth/mfa/complete/route';
import { WelcomeBrief } from '@/components/onboarding/WelcomeBrief';
import { accessPhaseName } from '@/lib/team/accessPhase';
import { InviteModal } from '@/components/team/InviteModal';
import type { LiveRoster } from '@/lib/team/roster';

type Resp = { data: unknown; error: unknown };

/** The seller seat the invitation is for, once accepted at the confirmed phase. */
const CONFIRMED_PHASE = 2;

/** Two documents the seat reaches at phase 2, two it does not. */
const DOCUMENTS = [
  { room: 'deal', classification: 2, min_phase: 0 },
  { room: 'deal', classification: 3, min_phase: 2 },
  { room: 'deal', classification: 2, min_phase: 4 }, // beyond the seat's phase
  { room: 'internal', classification: 2, min_phase: 0 }, // never, at any phase
];

const WORLD: Record<string, Resp> = {
  users: {
    data: {
      tenant_id: 't1',
      firm_role: null,
      is_external: false,
      company_id: 'bank-1',
      company_role: 'director',
      can_invite: false,
    },
    error: null,
  },
  companies: { data: { id: 'seller-1', tenant_id: 't1', name: 'Target Co', type: 'target' }, error: null },
  company_verified_domains: { data: [{ company_id: 'seller-1', domain: 'target.dev' }], error: null },
  deals: { data: { id: 'deal-1', tenant_id: 't1', bank_id: 'bank-1', code: 'PROJECT-X' }, error: null },
  // A list for the candidate query, a row for the party-role lookup: the mock
  // below hands `.maybeSingle()` the first element, which is what the real
  // client does.
  deal_parties: { data: [{ company_id: 'seller-1', party_role: 'target' }], error: null },
  deal_memberships: { data: { deal_role: 'seller', phase: CONFIRMED_PHASE }, error: null },
  documents: { data: DOCUMENTS, error: null },
  invites: { data: null, error: null },
};

type Rpc = (name: string, args: Record<string, unknown>) => Promise<Resp>;

/** The six-digit challenge the invitation email carries in this walk. */
const CODE = '314159';

/**
 * The invitation as the database holds it between send and acceptance.
 *
 * It records what was actually sent — address, company, deal, both roles, the
 * phase the MD confirmed — and acceptance answers from that record rather than
 * from constants. That is what makes this a walk: the seat the invitee lands
 * on is derived from the invitation the MD composed, so composing the wrong one
 * changes the ending. It re-implements no authority; the grant and its audit
 * row are proven against real SQL in supabase/tests/invite_phase_accept.sql.
 */
function invitation() {
  const row: {
    id: string;
    email: string | null;
    companyId: string | null;
    dealId: string | null;
    dealRole: string | null;
    companyRole: string | null;
    phase: number;
    verified: boolean;
    /** Created by acceptance, absent before it. */
    membership: { deal_role: string | null; phase: number } | null;
  } = {
    id: 'inv-1',
    email: null,
    companyId: null,
    dealId: null,
    dealRole: null,
    companyRole: null,
    phase: -1,
    verified: false,
    membership: null,
  };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>): Promise<Resp> => {
    if (name === 'create_invite') {
      row.email = args.p_email as string;
      row.companyId = args.p_company_id as string;
      row.companyRole = args.p_company_role as string;
      row.dealId = (args.p_deal_id ?? null) as string | null;
      row.dealRole = (args.p_deal_role ?? null) as string | null;
      row.phase = args.p_phase as number;
      return { data: { duplicate: false, id: row.id, delivery_status: 'sent' }, error: null };
    }
    if (name === 'verify_invite_challenge') {
      const matched = args.p_code_digest === digestInviteChallengeCode(CODE);
      if (matched) row.verified = true;
      return { data: { verified: matched, attempts_remaining: matched ? 5 : 4 }, error: null };
    }
    if (name === 'accept_invite') {
      if (args.p_invite_id !== row.id) return { data: null, error: { message: 'invite_not_found' } };
      // The gate the SQL enforces, restated here only so the HTTP refusal is
      // reachable: an unverified invitation is not acceptable.
      if (!row.verified) return { data: null, error: { message: 'invite_not_verified' } };
      // The grant. Acceptance is what creates the seat, so the membership does
      // not exist until this runs and carries exactly what was invited. The
      // real grant is SQL (supabase/tests/invite_phase_accept.sql); what is
      // reproduced here is only that the seat comes from the transition rather
      // than from a fixture the test laid out in advance.
      row.membership = { deal_role: row.dealRole, phase: row.phase };
      return {
        data: { deal_id: row.dealId, company_id: row.companyId, is_external: true },
        error: null,
      };
    }
    return { data: null, error: null };
  });
  return { row, rpc };
}

/**
 * A table may be given as a thunk, so a row that does not exist until some
 * step of the walk creates it can be read as absent before and present after.
 */
function admin(over: Record<string, Resp | (() => Resp)> = {}, rpcImpl?: Rpc) {
  const tables: Record<string, Resp | (() => Resp)> = { ...WORLD, ...over };
  const inserted: { table: string; row: Record<string, unknown> }[] = [];
  const rpc = vi.fn(
    rpcImpl ??
      (async () => ({ data: { duplicate: false, id: 'inv-1', delivery_status: 'sent' }, error: null })),
  );
  const from = (table: string) => {
    const entry = tables[table];
    const resp: Resp = (typeof entry === 'function' ? entry() : entry) ?? {
      data: null,
      error: null,
    };
    const b: Record<string, unknown> = {};
    const chain = () => b;
    b.select = chain; b.eq = chain; b.in = chain; b.order = chain; b.limit = chain;
    b.insert = (row: Record<string, unknown>) => { inserted.push({ table, row }); return b; };
    b.update = chain;
    const first = () =>
      Promise.resolve(
        Array.isArray(resp.data) ? { data: resp.data[0] ?? null, error: resp.error } : resp,
      );
    b.single = first; b.maybeSingle = first;
    b.then = (f: (v: Resp) => unknown) => Promise.resolve(resp).then(f);
    return b;
  };
  return { from, rpc, inserted };
}

function signIn(
  client: ReturnType<typeof admin>,
  user = { id: 'md-1', email: 'md@bank.dev' },
) {
  vi.mocked(requireApiUser).mockResolvedValue({
    ok: true,
    user,
    admin: client,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

/**
 * The invitee's own session. Verify and accept both run on the SESSION-BOUND
 * client so auth.uid() is the acceptor, and both read the invite id and nonce
 * from server-set metadata rather than the request body.
 */
function invitedSession(rpc: Rpc) {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: async () => ({
        data: {
          user: {
            id: 'invitee-1',
            email: 'alex@target.dev',
            user_metadata: { invite_id: 'inv-1', credential_nonce: 'nonce-1' },
          },
        },
        error: null,
      }),
    },
    rpc,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

function post(url: string, body: unknown) {
  return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/**
 * The MD's browser: fetch answered by the REAL route handlers rather than by
 * literal fixtures. The invite-surface tests stub bodies of their own, so
 * nothing else in the suite proves the UI reads the shape the handler actually
 * returns. Here it does.
 */
function browser() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      const request = new Request(new URL(path, 'http://t'), init);
      if (path.includes('/lookup')) return lookup(request);
      if (path.includes('/perimeter-preview')) return preview(request);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

/** The Team roster the MD invites from. Seller side is a party on the deal. */
const ROSTER: LiveRoster = {
  bankCompanyId: 'bank-1',
  members: [
    {
      userId: 'md-1',
      displayName: 'Storm Duncan',
      fullName: 'Storm Duncan',
      email: 'md@bank.dev',
      dealRole: 'md',
      phase: 0,
      isExternal: false,
      companyId: 'bank-1',
      companyName: 'Advisory Bank',
      companyRole: 'director',
    },
  ],
  parties: [{ companyId: 'seller-1', companyName: 'Target Co', partyRole: 'target' }],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('the demo path, end to end (D8.16)', () => {
  it('identifies, previews, sends, verifies, accepts, and lands on the matching brief', async () => {
    const invite = invitation();
    const client = admin({}, invite.rpc);
    signIn(client);

    // 1. The MD types one seller address into the real invite surface and SEES
    //    the company and the proposed seat come back.
    //
    //    Team, not Gate 0. Gate 0 says so itself: "Bank colleagues only. Buyer
    //    and seller invitations happen from Team once the deal exists."
    //    (Gate0Wizard.tsx). D7's address is a seller's, so Team is its surface.
    browser();
    render(
      createElement(InviteModal, {
        dealId: 'PROJECT-X',
        roster: ROSTER,
        viewer: {
          id: 'md-1',
          isExternal: false,
          firmRole: null,
          companyId: 'bank-1',
          companyRole: 'director',
          isDealMd: true,
        },
        onClose: () => {},
        onCreated: () => {},
        onResend: () => Promise.resolve({ ok: false }),
      }),
    );
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'Alex@Target.dev' } });
    await waitFor(() =>
      expect((screen.getByLabelText(/company/i) as HTMLSelectElement).value).toBe('seller-1'),
    );
    expect(screen.getByText(/take the seller seat on/i)).toBeInTheDocument();
    cleanup();

    // The same address, now walked through the handlers the surface just called.
    // 1b. Lookup names the company from a verified domain and proposes a seat.
    const lookupRes = await lookup(
      post('http://t/api/v1/invites/lookup', { email: 'Alex@Target.dev', dealId: 'PROJECT-X', companyId: 'seller-1' }),
    );
    expect(lookupRes.status).toBe(200);
    const found = await lookupRes.json();
    expect(found.normalizedEmail).toBe('alex@target.dev');
    expect(found.companyMatch).toMatchObject({ companyId: 'seller-1' });
    expect(found.recommendation).toMatchObject({ dealRole: 'seller' });
    // A11: nothing secret rides along.
    expect(JSON.stringify(found)).not.toMatch(/credential|nonce|digest|token/i);

    // 2. Before sending, the MD sees what that seat would reach.
    const previewRes = await preview(
      post('http://t/api/v1/invites/perimeter-preview', {
        proposal: {
          email: 'alex@target.dev',
          companyId: 'seller-1',
          companyRole: 'member',
          dealId: 'PROJECT-X',
          dealRole: 'seller',
          phase: CONFIRMED_PHASE,
        },
      }),
    );
    expect(previewRes.status).toBe(200);
    const previewed = (await previewRes.json()).perimeter;

    // Two of the four documents, and the invariants that hold at every phase.
    expect(previewed.documents.total).toBe(2);
    expect(previewed.documents.rooms.map((r: { room: string }) => r.room)).not.toContain('internal');
    expect(previewed.invariants).toEqual(
      expect.arrayContaining(['external_never_internal_room', 'external_never_mnpi']),
    );
    // B6: no document metadata rides along.
    expect(JSON.stringify(previewed)).not.toMatch(/title|filename|storage|uploaded/i);

    // 3. The MD confirms and sends. The phase they confirmed travels with it.
    const sendRes = await sendInvite(
      post('http://t/api/v1/invites', {
        email: 'alex@target.dev',
        companyId: 'seller-1',
        companyRole: 'member',
        dealId: 'PROJECT-X',
        dealRole: 'seller',
        phase: CONFIRMED_PHASE,
      }),
    );
    expect(sendRes.status).toBe(201);
    // The invitation the database now holds is the one the MD composed on the
    // form: same address, same company, same deal, same seat, same phase.
    expect(invite.row).toMatchObject({
      email: 'alex@target.dev',
      companyId: 'seller-1',
      companyRole: 'member',
      dealId: 'deal-1',
      dealRole: 'seller',
      phase: CONFIRMED_PHASE,
    });

    // 4. The invitee follows the link. Acceptance is refused until the emailed
    //    code is verified, and refused again until the terms are attested.
    const inviteeAdmin = admin(
      {
        users: {
          data: {
            tenant_id: 't1',
            firm_role: null,
            is_external: true,
            company_id: invite.row.companyId,
            company_role: invite.row.companyRole,
          },
          error: null,
        },
        // The seat acceptance CREATES. Read as a thunk, so before acceptance
        // there is no membership to find and after it there is exactly the one
        // the invitation carried. A fixture written here in advance would have
        // agreed with the ending no matter what acceptance did.
        deal_memberships: () => ({ data: invite.row.membership, error: null }),
      },
      invite.rpc,
    );
    signIn(inviteeAdmin, { id: 'invitee-1', email: 'alex@target.dev' });
    invitedSession(invite.rpc);

    const tooSoon = await acceptInvite(
      post('http://t/api/v1/invites/accept', { tosAccepted: true, password: 'secret-pass' }),
    );
    expect(tooSoon.status).toBe(409);

    // Nothing has been granted yet, and the product agrees: with no membership
    // the invitee has no seat on this deal. Without this reading, a membership
    // that appears later would prove nothing about what created it.
    const beforeGrant = await perimeterForViewer(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inviteeAdmin as any,
      'invitee-1',
      'deal-1',
    );
    expect(beforeGrant.ok).toBe(false);

    const wrongCode = await verifyCode(post('http://t/api/v1/invites/verify', { code: '000000' }));
    expect(wrongCode.status).toBe(400);
    expect(await wrongCode.json()).toMatchObject({ verified: false });

    const verified = await verifyCode(post('http://t/api/v1/invites/verify', { code: CODE }));
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({ verified: true });

    // D4: no attestation, no activation. The refusal happens before the RPC,
    // so the call count must not move (the verification refusal above already
    // reached it once).
    const accepts = () => invite.rpc.mock.calls.filter(([name]) => name === 'accept_invite').length;
    const before = accepts();
    const noTerms = await acceptInvite(post('http://t/api/v1/invites/accept', {}));
    expect(noTerms.status).toBe(400);
    expect(accepts()).toBe(before);

    const accepted = await acceptInvite(
      post('http://t/api/v1/invites/accept', {
        displayName: 'Alex Reyes',
        tosAccepted: true,
        password: 'secret-pass',
      }),
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ dealCode: 'PROJECT-X', isExternal: true });
    // The invitation finalized is the one that was sent, and the terms version
    // travels into the RPC, which records the attestation in the same
    // transaction that creates the seat.
    expect(invite.rpc).toHaveBeenCalledWith(
      'accept_invite',
      expect.objectContaining({ p_invite_id: 'inv-1', p_tos_version: TOS_VERSION }),
    );

    // 4b. Second factor. Acceptance runs at AAL1 by design — the invitee has
    //     just proven the emailed code, not a device — so the step that raises
    //     them to a full seat is the 2FA challenge, and it is recorded. This is
    //     the existing flow (D4), walked here rather than modified.
    //     Driven through the page the invitee actually sees, so the challenge,
    //     the verification and the assurance check are the real ones.
    const assurance = { level: 'aal1' };
    const challenge = vi.fn(async () => ({ data: { id: 'chal-1' }, error: null }));
    const verifyFactor = vi.fn(async () => {
      assurance.level = 'aal2';
      return { data: {}, error: null };
    });
    vi.mocked(createSupabaseBrowserClient).mockReturnValue({
      auth: {
        mfa: {
          getAuthenticatorAssuranceLevel: async () => ({
            data: { currentLevel: assurance.level },
            error: null,
          }),
          listFactors: async () => ({
            data: { totp: [{ id: 'f-1', friendly_name: 'Authenticator' }], all: [] },
            error: null,
          }),
          challenge,
          verify: verifyFactor,
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const replace = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(useRouter).mockReturnValue({ replace, refresh: vi.fn() } as any);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) =>
        completeMfa(new Request(new URL(String(url), 'http://t'), init)),
      ),
    );

    render(createElement(TwoFactorPageClient, { destination: '/projects/PROJECT-X' }));
    fireEvent.change(await screen.findByLabelText(/six-digit code/i), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: /verify and continue/i }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/projects/PROJECT-X'));

    expect(challenge).toHaveBeenCalledWith({ factorId: 'f-1' });
    expect(verifyFactor).toHaveBeenCalledWith(
      expect.objectContaining({ challengeId: 'chal-1', code: '123456' }),
    );
    expect(inviteeAdmin.inserted).toContainEqual(
      expect.objectContaining({
        table: 'audit_log',
        row: expect.objectContaining({
          actor_id: 'invitee-1',
          action: AUDIT_ACTION.MFA_CHALLENGED,
          detail: expect.objectContaining({ outcome: 'success' }),
        }),
      }),
    );
    cleanup();

    //     And the seat is only reachable once that assurance holds. This is the
    //     real guard every protected route runs, refusing the invitee one step
    //     earlier and admitting them one step later.
    const { requireApiUser: realRequireApiUser } =
      await vi.importActual<typeof import('@/lib/api/v1/http')>('@/lib/api/v1/http');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(createSupabaseAdminClient).mockReturnValue(inviteeAdmin as any);
    const sessionAt = (level: string) =>
      vi.mocked(createSupabaseServerClient).mockResolvedValue({
        auth: {
          getUser: async () => ({
            data: { user: { id: 'invitee-1', email: 'alex@target.dev' } },
            error: null,
          }),
          mfa: {
            getAuthenticatorAssuranceLevel: async () => ({
              data: { currentLevel: level },
              error: null,
            }),
          },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);

    sessionAt('aal1');
    expect((await realRequireApiUser()).ok).toBe(false);
    sessionAt('aal2');
    expect((await realRequireApiUser()).ok).toBe(true);

    // 5. The seat opens the deal. Its reading is the perimeter the MD was
    //    promised, and the brief prints that same number.
    const inviteeWorld = inviteeAdmin;
    const seat = await perimeterForViewer(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inviteeWorld as any,
      'invitee-1',
      'deal-1',
    );
    expect(seat.ok).toBe(true);
    if (!seat.ok) return;
    expect(seat.perimeter.documents.total).toBe(previewed.documents.total);
    expect(seat.perimeter.invariants).toEqual(previewed.invariants);
    expect(seat.perimeter.destinations.sort()).toEqual([
      'audit',
      'dataRoom',
      'mail',
      'mandate',
      'rail',
      'team',
    ]);

    // 6. The landing itself. Rendered, not inferred: the brief is what the
    //    invitee actually reads at the end of the demo.
    render(
      createElement(WelcomeBrief, {
        projectId: 'PROJECT-X',
        deal: { code: 'PROJECT-X', codename: 'Project Meridian', status: 'active' },
        companyName: 'Target Co',
        dealRole: 'seller',
        phase: invite.row.phase,
        perimeter: seat.perimeter,
      }),
    );
    const brief = screen.getByTestId('welcome-brief');
    // The brief names the seat's phase (CONFIRMED_PHASE 2 is Marketing), never a number.
    expect(brief).toHaveTextContent(`Access up to ${accessPhaseName(CONFIRMED_PHASE)}`);
    expect(brief).toHaveTextContent(
      `${previewed.documents.total} documents are available to you right now`,
    );
    // C6: the offered action is one this seat carries. (The negative archetypes
    // are D8.12's job, in welcome-brief.test.tsx; the access module is mocked
    // permissive here, so a negative asserted from this file would be a fixture
    // talking to itself.)
    expect(seat.perimeter.capabilities.canUploadToDataRoom).toBe(true);
    expect(screen.getByRole('link', { name: /upload a document/i })).toBeInTheDocument();
  });

  it('a seat one phase lower sees strictly less, and the preview says so first', async () => {
    // The promise the preview makes is that phase is what moves the number.
    const client = admin();
    signIn(client);

    const atPhase = async (phase: number) => {
      const res = await preview(
        post('http://t/api/v1/invites/perimeter-preview', {
          proposal: {
            email: 'alex@target.dev',
            companyId: 'seller-1',
            companyRole: 'member',
            dealId: 'PROJECT-X',
            dealRole: 'seller',
            phase,
          },
        }),
      );
      return (await res.json()).perimeter.documents.total as number;
    };

    expect(await atPhase(0)).toBe(1);
    expect(await atPhase(CONFIRMED_PHASE)).toBe(2);
  });
});
