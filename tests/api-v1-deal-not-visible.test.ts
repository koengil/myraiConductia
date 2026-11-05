import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The deal-existence oracle is closed (decision-log D65).
 *
 * Deal codes are guessable (CODENAME5-YYYY-NNN), so a caller with no seat and
 * no oversight must not be able to tell a real deal from a made-up one. For
 * every deal-scoped handler this suite runs the same request twice:
 *
 *   - "unseated": the code resolves to a real deal in the caller's own
 *     tenant, but the caller holds no seat and is not an overseer;
 *   - "missing":  the code resolves to nothing.
 *
 * Both answers must be identical: status, body and headers. Only timing may
 * differ (the missing branch skips the access query), which is the accepted
 * residual recorded with the fetch-then-filter debt.
 *
 * Seated callers keep their role 403s; those are covered route by route in
 * the existing suites.
 *
 * Two route censuses at the end of the file keep the table complete. The
 * path census walks every route under `deals/[dealId]` and fails on any
 * exported HTTP method that is neither a CASES row nor an EXEMPT entry naming
 * the suite that covers it. The deal-input census does the same for every other
 * /api/v1 route that names a deal resolver or `userCanAccessDeal`, or takes a
 * deal under `dealId`, `dealCode`, `sourceDealId` or `get('deal')`, against
 * BODY_EXEMPT. So a new deal route cannot ship uncovered, within the blind spot
 * stated on DEAL_PARAM.
 */

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
}));

import { createSupabaseAdminClient, createSupabaseServerClient } from '@/lib/supabase/server';

import * as aiSpend from '@/app/api/v1/ai-spend/route';
import * as inbox from '@/app/api/v1/inbox/route';
import * as outbox from '@/app/api/v1/outbox/route';
import * as invites from '@/app/api/v1/invites/route';
import * as inviteLookup from '@/app/api/v1/invites/lookup/route';
import * as invitePerimeter from '@/app/api/v1/invites/perimeter-preview/route';
import * as invitePreflight from '@/app/api/v1/invites/preflight/route';
import * as railTemplates from '@/app/api/v1/rail-templates/route';
import * as peopleSearch from '@/app/api/v1/people/search/route';
import * as discoverySuggestions from '@/app/api/v1/discovery/suggestions/route';
import * as discoverySuggestionDismiss from '@/app/api/v1/discovery/suggestions/dismiss/route';
import * as discoveryDealEmail from '@/app/api/v1/discovery/deal-email/route';
import * as discoveryDealEmailThread from '@/app/api/v1/discovery/deal-email/thread/route';
import * as screen from '@/app/api/v1/screen/route';
import * as deal from '@/app/api/v1/deals/[dealId]/route';
import * as audit from '@/app/api/v1/deals/[dealId]/audit/route';
import * as benchChat from '@/app/api/v1/deals/[dealId]/bench/chat/route';
import * as benchSkills from '@/app/api/v1/deals/[dealId]/bench/skills/route';
import * as dealDataroom from '@/app/api/v1/deals/[dealId]/dataroom/route';
import * as documents from '@/app/api/v1/deals/[dealId]/documents/route';
import * as document from '@/app/api/v1/deals/[dealId]/documents/[documentId]/route';
import * as documentDownload from '@/app/api/v1/deals/[dealId]/documents/[documentId]/download/route';
import * as documentView from '@/app/api/v1/deals/[dealId]/documents/[documentId]/view/route';
import * as members from '@/app/api/v1/deals/[dealId]/members/route';
import * as member from '@/app/api/v1/deals/[dealId]/members/[userId]/route';
import * as progress from '@/app/api/v1/deals/[dealId]/progress/route';
import * as rail from '@/app/api/v1/deals/[dealId]/rail/route';
import * as railStep from '@/app/api/v1/deals/[dealId]/rail/steps/[stepId]/route';
import * as railStepRestore from '@/app/api/v1/deals/[dealId]/rail/steps/[stepId]/restore/route';
import * as railStepSkip from '@/app/api/v1/deals/[dealId]/rail/steps/[stepId]/skip/route';
import * as templateChanges from '@/app/api/v1/deals/[dealId]/rail/template-changes/route';
import * as templateChangeDecision from '@/app/api/v1/deals/[dealId]/rail/template-changes/[changeId]/decision/route';
import * as recipientAffiliations from '@/app/api/v1/deals/[dealId]/recipient-affiliations/route';
import * as recipientCheck from '@/app/api/v1/deals/[dealId]/recipient-check/route';
import * as skillDrafts from '@/app/api/v1/deals/[dealId]/skill-drafts/route';
import * as skillDraft from '@/app/api/v1/deals/[dealId]/skill-drafts/[draftId]/route';
import * as skillDraftDiscard from '@/app/api/v1/deals/[dealId]/skill-drafts/[draftId]/discard/route';
import * as skillDraftMessages from '@/app/api/v1/deals/[dealId]/skill-drafts/[draftId]/messages/route';
import * as skillDraftRetry from '@/app/api/v1/deals/[dealId]/skill-drafts/[draftId]/messages/[messageId]/retry/route';
import * as skillDraftPublish from '@/app/api/v1/deals/[dealId]/skill-drafts/[draftId]/publish/route';
import * as publicationDuplicate from '@/app/api/v1/deals/[dealId]/skill-publications/[publicationId]/duplicate-decision/route';
import * as publicationPlacement from '@/app/api/v1/deals/[dealId]/skill-publications/[publicationId]/placement/route';
import * as stepRecords from '@/app/api/v1/deals/[dealId]/step-records/route';
import * as steps from '@/app/api/v1/deals/[dealId]/steps/route';
import * as step from '@/app/api/v1/deals/[dealId]/steps/[stepId]/route';
import * as stepDataroom from '@/app/api/v1/deals/[dealId]/steps/[stepId]/dataroom/route';
import * as stepDataroomUpload from '@/app/api/v1/deals/[dealId]/steps/[stepId]/dataroom/upload/route';
import * as stepIgnatious from '@/app/api/v1/deals/[dealId]/steps/[stepId]/ignatious/route';
import * as stepIgnatiousArtifacts from '@/app/api/v1/deals/[dealId]/steps/[stepId]/ignatious/artifacts/route';
import * as stepIgnatiousInput from '@/app/api/v1/deals/[dealId]/steps/[stepId]/ignatious/input/route';
import * as skillBinding from '@/app/api/v1/deals/[dealId]/steps/[stepId]/skill-binding/route';
import * as skillRuns from '@/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/route';
import * as skillRunStream from '@/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/stream/route';
import * as skillRunRevisions from '@/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/[runId]/revisions/route';
import * as skillRunRevision from '@/app/api/v1/deals/[dealId]/steps/[stepId]/skill-runs/[runId]/revisions/[revisionId]/route';
import * as skillVersions from '@/app/api/v1/deals/[dealId]/steps/[stepId]/skill-versions/route';

const CALLER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_MEMBER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEAL_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DOCUMENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DRAFT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const MESSAGE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const PUBLICATION_ID = '99999999-9999-4999-8999-999999999999';
const STEP_ROW_ID = '88888888-8888-4888-8888-888888888888';
/** The MD Briefing step: the one step with an Ignatious skill wired. */
const STEP_ID = 'p1-s9';
const TENANT = '77777777-7777-4777-8777-777777777777';

/** A guessable code for a deal that exists, and one for a deal that does not. */
const REAL_CODE = 'FALCO-2026-001';
const MADE_UP_CODE = 'FALCO-2026-999';
/** The codes probe() sends. The unusual-code block swaps in off-shape ones. */
let codes = { real: REAL_CODE, missing: MADE_UP_CODE };

/**
 * Who calls, on a deal that exists. 'missing' is the same request on a code
 * that resolves to nothing; it runs as the unseated caller unless a test names
 * another (the missing answer comes before any caller-specific read).
 *
 *   unseated          no seat, no oversight: the D65 case
 *   seated            a non-MD, non-manager seat: role 403s survive
 *   nonPartyDirector  external director whose company is not a party
 *   foreignAdmin      firm admin of another tenant
 *   partyDirector     external director whose company is a party, no seat
 *   bankDirector      internal director of the deal's bank_id, no seat
 */
type Caller =
  | 'unseated'
  | 'seated'
  | 'nonPartyDirector'
  | 'foreignAdmin'
  | 'partyDirector'
  | 'bankDirector';
type World = 'missing' | Caller;
type Row = Record<string, unknown>;

const OTHER_TENANT = '74747474-7474-4747-8747-747474747474';
const CALLER_COMPANY = '66666666-6666-4666-8666-666666666666';
const BANK_ID = '55555555-5555-4555-8555-555555555555';
/** A company that is a party to the real deal, and one that is not. */
const PARTY_COMPANY = '44444444-4444-4444-8444-444444444444';
const NON_PARTY_COMPANY = '43434343-4343-4343-8343-434343434343';
/** Who added OTHER_MEMBER's seat. The former-adder block sets it to CALLER. */
let seatAddedBy = OTHER_MEMBER;
/** The caller's own seat on the real deal. Null everywhere but the seated-adder control. */
let callerSeat: Row | null = null;

const CALLER_PROFILE: Row = {
  id: CALLER,
  status: 'active',
  firm_role: null,
  tenant_id: TENANT,
  is_external: false,
  company_id: CALLER_COMPANY,
  company_role: null,
  department: 'banking',
  email: 'outsider@bank.dev',
};

const PROFILES: Record<Caller, Row> = {
  unseated: CALLER_PROFILE,
  seated: CALLER_PROFILE,
  nonPartyDirector: {
    ...CALLER_PROFILE,
    is_external: true,
    company_id: NON_PARTY_COMPANY,
    company_role: 'director',
    department: null,
  },
  foreignAdmin: { ...CALLER_PROFILE, firm_role: 'admin', tenant_id: OTHER_TENANT },
  partyDirector: {
    ...CALLER_PROFILE,
    is_external: true,
    company_id: PARTY_COMPANY,
    company_role: 'director',
    department: null,
  },
  bankDirector: { ...CALLER_PROFILE, company_id: BANK_ID, company_role: 'director' },
};

const DEAL_ROW: Row = {
  id: DEAL_ID,
  code: REAL_CODE,
  tenant_id: TENANT,
  bank_id: BANK_ID,
  current_step_seq: 1,
  lifecycle_category: 'live',
  status: 'active',
};

/** Another deal in the caller's tenant, for mail tagged to it. */
const OTHER_DEAL_ID = '76767676-7676-4767-8767-767676767676';

/*
 * The caller's own mail, the same in every world. Without it a dropped deal
 * filter would also read as an empty list and the mail rows would prove
 * nothing: a made-up code used to list everything, a real deal only its own.
 */
const outboundRow = (id: string, dealId: string | null): Row => ({
  id,
  deal_id: dealId,
  sender_id: CALLER,
  tenant_id: TENANT,
  status: 'sent',
  verdict: 'compliant',
  reasons: [],
  to_emails: ['counsel@client.example'],
  subject: 'Process update',
  body: 'The room opens Monday.',
  created_at: '2026-10-01T00:00:00Z',
});
const OUTBOUND_ROWS: Row[] = [outboundRow('out-untagged', null), outboundRow('out-on-deal', DEAL_ID)];

const inboundRow = (id: string, dealId: string | null): Row => ({
  id,
  deal_id: dealId,
  tenant_id: TENANT,
  from_email: 'founder@target.example',
  to_email: 'deals@bank.dev',
  subject: 'Re: Process update',
  body: 'Monday works.',
  received_at: '2026-10-01T00:00:00Z',
  read_at: null,
});
const INBOUND_ROWS: Row[] = [
  inboundRow('in-untagged', null),
  inboundRow('in-on-deal', DEAL_ID),
  inboundRow('in-other-deal', OTHER_DEAL_ID),
];

/**
 * Filter mail rows the way PostgREST would: `eq` on a column the row has,
 * `is` (recorded as "<column> is"), and the inbox's `or(deal_id.eq.X,deal_id.is.null)`
 * (recorded as " or").
 */
function mailRows(rows: Row[], filters: Record<string, unknown>): Row[] {
  const orMatches = (row: Row, expr: string) =>
    expr.split(',').some((term) => {
      const [column, op, ...rest] = term.split('.');
      const value = rest.join('.');
      return op === 'is' && value === 'null' ? row[column] === null : op === 'eq' && row[column] === value;
    });
  return rows.filter((row) =>
    Object.entries(filters).every(([key, value]) => {
      if (key === ' or') return orMatches(row, value as string);
      if (key.endsWith(' is')) return row[key.slice(0, -3)] === value;
      return !(key in row) || row[key] === value;
    }),
  );
}

/**
 * The other member's profile, embedded in their seat the way the roster read
 * selects it. A people search that listed the deal's roster to a caller who
 * cannot see the deal would show this row; without it a roster leak would read
 * as an empty list and the people/search row would prove nothing.
 */
const OTHER_MEMBER_USER: Row = { id: OTHER_MEMBER, display_name: 'Dana Member', email: 'dana@bank.dev' };

const SEAT = (userId: string): Row => ({
  id: `seat-${userId}`,
  deal_id: DEAL_ID,
  user_id: userId,
  added_by: OTHER_MEMBER,
  deal_role: 'deal_team',
  access_scope: {},
  phase: 0,
});

/**
 * A service-role stand-in. It answers from the world: the deal exists or not,
 * every flag is on or off, and who the caller is. Only the 'seated' caller
 * holds a seat. Another member does hold one on the real deal, so seat lookups
 * by target user find a row. The deal has one party company, and every
 * company sits in the deal's tenant.
 */
function fakeAdmin(world: World, flagsOn: boolean, caller: Caller) {
  const exists = world !== 'missing';
  const rowsFor = (table: string, filters: Record<string, unknown>): Row[] => {
    switch (table) {
      case 'feature_flags':
        return [{ key: filters.key, enabled: flagsOn }];
      case 'users':
        return filters.id === undefined || filters.id === CALLER ? [PROFILES[caller]] : [];
      case 'deals':
        return exists ? [DEAL_ROW] : [];
      case 'deal_memberships': {
        if (!exists) return [];
        const seats = [
          { ...SEAT(OTHER_MEMBER), added_by: seatAddedBy, user: OTHER_MEMBER_USER },
          ...(caller === 'seated' ? [SEAT(CALLER)] : []),
          ...(callerSeat ? [callerSeat] : []),
        ];
        return filters.user_id === undefined ? seats : seats.filter((r) => r.user_id === filters.user_id);
      }
      case 'deal_parties': {
        if (!exists) return [];
        const party = { deal_id: DEAL_ID, company_id: PARTY_COMPANY, party_role: 'target' };
        return filters.company_id === undefined || filters.company_id === PARTY_COMPANY ? [party] : [];
      }
      case 'companies': {
        const id = (filters.id as string | undefined) ?? PARTY_COMPANY;
        return [{ id, name: 'Party Co', tenant_id: TENANT, type: id === BANK_ID ? 'bank' : 'target' }];
      }
      case 'invite_domain_confirmations':
        return [{ id: 'confirm-1', expires_at: '2026-11-01T00:00:00Z' }];
      case 'invites':
        // The deal's invite list: a firm admin of another tenant used to read it.
        return exists && filters.email === undefined
          ? [
              {
                id: 'invite-1',
                email: 'pending@party.example',
                company_id: PARTY_COMPANY,
                company_role: 'member',
                deal_id: DEAL_ID,
                deal_role: 'seller',
                status: 'pending',
                delivery_status: 'sent',
                expires_at: '2026-11-01T00:00:00Z',
                created_at: '2026-10-01T00:00:00Z',
                invited_by: OTHER_MEMBER,
              },
            ]
          : [];
      case 'outbound_messages':
        return mailRows(OUTBOUND_ROWS, filters);
      case 'inbound_messages':
        return mailRows(INBOUND_ROWS, filters);
      default:
        return [];
    }
  };

  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const settle = (single: boolean) => {
      const rows = rowsFor(table, filters);
      return Promise.resolve({ data: single ? (rows[0] ?? null) : rows, error: null });
    };
    const builder: Record<string | symbol, unknown> = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'eq') {
            return (column: string, value: unknown) => {
              filters[column] = value;
              return builder;
            };
          }
          if (prop === 'is') {
            return (column: string, value: unknown) => {
              filters[`${column} is`] = value;
              return builder;
            };
          }
          if (prop === 'or') {
            return (expression: string) => {
              filters[' or'] = expression;
              return builder;
            };
          }
          if (prop === 'maybeSingle' || prop === 'single') return () => settle(true);
          if (prop === 'then') {
            return (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
              settle(false).then(onFulfilled, onRejected);
          }
          return () => builder;
        },
      },
    );
    return builder;
  };

  return {
    from,
    rpc: vi.fn((name: string) =>
      Promise.resolve({ data: Object.hasOwn(rpcData, name) ? rpcData[name] : null, error: null }),
    ),
    storage: { from: () => ({}) },
  };
}

/** What a named RPC returns; any other RPC returns null. Reset before each test. */
let rpcData: Record<string, unknown> = {};

function enter(world: World, flagsOn: boolean, caller: Caller) {
  const admin = fakeAdmin(world, flagsOn, caller);
  // The discovery routes read through the caller's own RLS client, where
  // `deals_select` shows the deal row to a seated caller only. So the scoped
  // client reads "no deal" for a hidden deal and a missing one alike; the
  // service-role fake above would hand the hidden deal's row to it.
  const scoped = fakeAdmin(caller === 'seated' ? world : 'missing', flagsOn, caller);
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: () =>
        Promise.resolve({ data: { user: { id: CALLER, email: 'outsider@bank.dev' } }, error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: () =>
          Promise.resolve({ data: { currentLevel: 'aal2' }, error: null }),
      },
    },
    from: (table: string) => (table === 'deals' ? scoped.from(table) : admin.from(table)),
  } as never);
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin as never);
}

type Handler = (request: Request, context: never) => Promise<Response>;
type Params = Record<string, string>;
type Case = {
  name: string;
  handler: Handler;
  method: string;
  params?: Params;
  body?: unknown;
  /** Build the URL for handlers that take the deal as a query parameter. */
  url?: (dealRef: string) => string;
  /**
   * The route's own "no such deal" answer, when it is not the 404 `Deal not
   * found`: the mail reads answer a missing deal with a list, not an error.
   */
  missing?: { status: number; body: unknown };
};

const json = (value: unknown) => value;
/** Stands for the deal code in a body; probe() puts the real or made-up code there. */
const REF = '<deal-ref>';
const INVITEE = 'alex@party.example';
const PLACEMENT = { kind: 'phase_end', phaseIndex: 0 };
const REFERENCE = { kind: 'mount', name: 'md-briefing', version: 1, digest: 'd'.repeat(64) };
const RUN_ID = '12121212-1212-4212-8212-121212121212';
const SKILL_REVISION_ID = '15151515-1515-4515-8515-151515151515';
const TEMPLATE_CHANGE_ID = 'added:custom-fairness';
const TEMPLATE_REVISION_ID = '13131313-1313-4313-8313-131313131313';
/**
 * The client's idempotency key for a rail-template save. The family echoes it
 * in every error body, and it is the same in both worlds, so the bodies are
 * compared whole rather than with it stripped.
 */
const SAVE_REQUEST_ID = '14141414-1414-4414-8414-141414141414';
/** A well-formed assessment and mail item id, so the discovery routes reach their deal lookup. */
const ASSESSMENT_ID = '16161616-1616-4616-8616-161616161616';
const SOURCE_ITEM_ID = '17171717-1717-4717-8717-171717171717';

const CASES: Case[] = [
  { name: 'GET /deals/{id}', handler: deal.GET, method: 'GET' },
  { name: 'PATCH /deals/{id}', handler: deal.PATCH, method: 'PATCH', body: json({ targetCloseDate: null }) },
  { name: 'GET /deals/{id}/audit', handler: audit.GET, method: 'GET' },
  {
    name: 'POST /deals/{id}/bench/chat',
    handler: benchChat.POST,
    method: 'POST',
    body: json({ messages: [{ role: 'user', content: 'Status' }] }),
  },
  { name: 'GET /deals/{id}/bench/skills', handler: benchSkills.GET, method: 'GET' },
  { name: 'GET /deals/{id}/dataroom', handler: dealDataroom.GET, method: 'GET' },
  { name: 'POST /deals/{id}/dataroom', handler: dealDataroom.POST, method: 'POST' },
  { name: 'GET /deals/{id}/documents', handler: documents.GET, method: 'GET' },
  { name: 'POST /deals/{id}/documents', handler: documents.POST, method: 'POST', body: new FormData() },
  {
    name: 'PATCH /deals/{id}/documents/{doc}',
    handler: document.PATCH,
    method: 'PATCH',
    params: { documentId: DOCUMENT_ID },
    body: json({ minPhase: 1 }),
  },
  {
    name: 'GET /deals/{id}/documents/{doc}/download',
    handler: documentDownload.GET,
    method: 'GET',
    params: { documentId: DOCUMENT_ID },
  },
  {
    name: 'POST /deals/{id}/documents/{doc}/view',
    handler: documentView.POST,
    method: 'POST',
    params: { documentId: DOCUMENT_ID },
  },
  { name: 'GET /deals/{id}/members', handler: members.GET, method: 'GET' },
  {
    name: 'POST /deals/{id}/members',
    handler: members.POST,
    method: 'POST',
    body: json({ email: 'new@bank.dev', dealRole: 'deal_team' }),
  },
  {
    name: 'DELETE /deals/{id}/members/{user} (seated target)',
    handler: member.DELETE,
    method: 'DELETE',
    params: { userId: OTHER_MEMBER },
  },
  {
    name: 'DELETE /deals/{id}/members/{user} (no such seat)',
    handler: member.DELETE,
    method: 'DELETE',
    params: { userId: CALLER },
  },
  {
    name: 'PATCH /deals/{id}/members/{user}',
    handler: member.PATCH,
    method: 'PATCH',
    params: { userId: OTHER_MEMBER },
    body: json({ canManageMembers: true }),
  },
  {
    name: 'PATCH /deals/{id}/progress',
    handler: progress.PATCH,
    method: 'PATCH',
    body: json({ currentStepSeq: 2 }),
  },
  { name: 'GET /deals/{id}/rail', handler: rail.GET, method: 'GET' },
  {
    name: 'DELETE /deals/{id}/rail/steps/{step}',
    handler: railStep.DELETE,
    method: 'DELETE',
    params: { stepId: STEP_ROW_ID },
  },
  {
    name: 'POST /deals/{id}/rail/steps/{step}/restore',
    handler: railStepRestore.POST,
    method: 'POST',
    params: { stepId: STEP_ROW_ID },
  },
  {
    name: 'POST /deals/{id}/rail/steps/{step}/skip',
    handler: railStepSkip.POST,
    method: 'POST',
    params: { stepId: STEP_ROW_ID },
    body: json({ reason: 'Not needed on this mandate' }),
  },
  { name: 'GET /deals/{id}/rail/template-changes', handler: templateChanges.GET, method: 'GET' },
  {
    name: 'POST /deals/{id}/rail/template-changes/{change}/decision',
    handler: templateChangeDecision.POST,
    method: 'POST',
    params: { changeId: TEMPLATE_CHANGE_ID },
    body: json({ decision: 'accepted', revisionId: TEMPLATE_REVISION_ID }),
  },
  {
    name: 'DELETE /deals/{id}/rail/template-changes/{change}/decision',
    handler: templateChangeDecision.DELETE,
    method: 'DELETE',
    params: { changeId: TEMPLATE_CHANGE_ID },
  },
  { name: 'GET /deals/{id}/recipient-affiliations', handler: recipientAffiliations.GET, method: 'GET' },
  {
    name: 'PUT /deals/{id}/recipient-affiliations',
    handler: recipientAffiliations.PUT,
    method: 'PUT',
    body: json({
      email: 'counsel@client.example',
      companyId: '44444444-4444-4444-8444-444444444444',
      affiliation: 'client',
      representedCompanyId: null,
      userId: OTHER_MEMBER,
      inviteId: null,
      expectedRevision: null,
    }),
  },
  {
    name: 'POST /deals/{id}/recipient-check',
    handler: recipientCheck.POST,
    method: 'POST',
    body: json({ to: ['counsel@client.example'], cc: [], bcc: [] }),
  },
  {
    name: 'POST /deals/{id}/skill-drafts',
    handler: skillDrafts.POST,
    method: 'POST',
    body: json({ name: 'Buyer screen', placement: PLACEMENT }),
  },
  {
    name: 'GET /deals/{id}/skill-drafts/{draft}',
    handler: skillDraft.GET,
    method: 'GET',
    params: { draftId: DRAFT_ID },
  },
  {
    name: 'PATCH /deals/{id}/skill-drafts/{draft}',
    handler: skillDraft.PATCH,
    method: 'PATCH',
    params: { draftId: DRAFT_ID },
    body: json({ name: 'Buyer screen', editRevision: 1 }),
  },
  {
    name: 'POST /deals/{id}/skill-drafts/{draft}/discard',
    handler: skillDraftDiscard.POST,
    method: 'POST',
    params: { draftId: DRAFT_ID },
    body: json({ editRevision: 1 }),
  },
  {
    name: 'POST /deals/{id}/skill-drafts/{draft}/messages',
    handler: skillDraftMessages.POST,
    method: 'POST',
    params: { draftId: DRAFT_ID },
    body: json({ text: 'Screen strategic buyers', editRevision: 1 }),
  },
  {
    name: 'POST /deals/{id}/skill-drafts/{draft}/messages/{message}/retry',
    handler: skillDraftRetry.POST,
    method: 'POST',
    params: { draftId: DRAFT_ID, messageId: MESSAGE_ID },
    body: json({ editRevision: 1 }),
  },
  {
    name: 'POST /deals/{id}/skill-drafts/{draft}/publish',
    handler: skillDraftPublish.POST,
    method: 'POST',
    params: { draftId: DRAFT_ID },
    body: json({ candidateId: MESSAGE_ID, candidateDigest: 'sha256:x', placement: PLACEMENT }),
  },
  {
    name: 'POST /deals/{id}/skill-publications/{pub}/duplicate-decision',
    handler: publicationDuplicate.POST,
    method: 'POST',
    params: { publicationId: PUBLICATION_ID },
    body: json({ decision: 'publish_anyway' }),
  },
  {
    name: 'POST /deals/{id}/skill-publications/{pub}/placement',
    handler: publicationPlacement.POST,
    method: 'POST',
    params: { publicationId: PUBLICATION_ID },
    body: json({ placement: PLACEMENT }),
  },
  { name: 'GET /deals/{id}/step-records', handler: stepRecords.GET, method: 'GET' },
  { name: 'GET /deals/{id}/steps', handler: steps.GET, method: 'GET' },
  { name: 'GET /deals/{id}/steps/{step}', handler: step.GET, method: 'GET', params: { stepId: STEP_ID } },
  {
    name: 'PATCH /deals/{id}/steps/{step}',
    handler: step.PATCH,
    method: 'PATCH',
    params: { stepId: STEP_ID },
    body: json({ status: 'in_progress' }),
  },
  {
    name: 'GET /deals/{id}/steps/{step}/dataroom',
    handler: stepDataroom.GET,
    method: 'GET',
    params: { stepId: STEP_ID },
  },
  {
    name: 'POST /deals/{id}/steps/{step}/dataroom/upload',
    handler: stepDataroomUpload.POST,
    method: 'POST',
    params: { stepId: STEP_ID },
    body: new FormData(),
  },
  {
    name: 'POST /deals/{id}/steps/{step}/ignatious',
    handler: stepIgnatious.POST,
    method: 'POST',
    params: { stepId: STEP_ID },
    body: json({}),
  },
  {
    name: 'GET /deals/{id}/steps/{step}/ignatious',
    handler: stepIgnatious.GET,
    method: 'GET',
    params: { stepId: STEP_ID },
  },
  {
    name: 'DELETE /deals/{id}/steps/{step}/ignatious',
    handler: stepIgnatious.DELETE,
    method: 'DELETE',
    params: { stepId: STEP_ID },
  },
  {
    name: 'GET /deals/{id}/steps/{step}/ignatious/artifacts',
    handler: stepIgnatiousArtifacts.GET,
    method: 'GET',
    params: { stepId: STEP_ID },
  },
  {
    name: 'POST /deals/{id}/steps/{step}/ignatious/input',
    handler: stepIgnatiousInput.POST,
    method: 'POST',
    params: { stepId: STEP_ID },
    body: json({ text: 'Proceed' }),
  },
  {
    name: 'PUT /deals/{id}/steps/{step}/skill-binding',
    handler: skillBinding.PUT,
    method: 'PUT',
    params: { stepId: STEP_ID },
    body: json({ reference: REFERENCE }),
  },
  {
    name: 'POST /deals/{id}/steps/{step}/skill-runs',
    handler: skillRuns.POST,
    method: 'POST',
    params: { stepId: STEP_ID },
    body: json({ runId: RUN_ID, outcome: 'succeeded', resultText: 'Briefing ready' }),
  },
  {
    name: 'GET /deals/{id}/steps/{step}/skill-runs',
    handler: skillRuns.GET,
    method: 'GET',
    params: { stepId: STEP_ID },
  },
  {
    name: 'POST /deals/{id}/steps/{step}/skill-runs/stream',
    handler: skillRunStream.POST,
    method: 'POST',
    params: { stepId: STEP_ID },
    body: json({ runId: RUN_ID }),
  },
  {
    name: 'POST /deals/{id}/steps/{step}/skill-runs/{run}/revisions',
    handler: skillRunRevisions.POST,
    method: 'POST',
    params: { stepId: STEP_ID, runId: RUN_ID },
    body: json({ parentId: RUN_ID, restoreOf: SKILL_REVISION_ID }),
  },
  {
    name: 'GET /deals/{id}/steps/{step}/skill-runs/{run}/revisions/{revision}',
    handler: skillRunRevision.GET,
    method: 'GET',
    params: { stepId: STEP_ID, runId: RUN_ID, revisionId: SKILL_REVISION_ID },
  },
  {
    name: 'GET /deals/{id}/steps/{step}/skill-versions',
    handler: skillVersions.GET,
    method: 'GET',
    params: { stepId: STEP_ID },
  },
  {
    name: 'GET /ai-spend?dealId=',
    handler: aiSpend.GET as Handler,
    method: 'GET',
    url: (dealRef) => `http://localhost/api/v1/ai-spend?dealId=${encodeURIComponent(dealRef)}`,
  },
  // The invite family takes the deal in the body or query (#245).
  {
    name: 'POST /invites',
    handler: invites.POST as Handler,
    method: 'POST',
    url: () => 'http://localhost/api/v1/invites',
    body: json({ email: INVITEE, companyId: PARTY_COMPANY, dealId: REF, dealRole: 'seller' }),
  },
  {
    name: 'GET /invites?dealId=',
    handler: invites.GET as Handler,
    method: 'GET',
    url: (dealRef) => `http://localhost/api/v1/invites?dealId=${encodeURIComponent(dealRef)}`,
  },
  {
    name: 'POST /invites/preflight',
    handler: invitePreflight.POST as Handler,
    method: 'POST',
    url: () => 'http://localhost/api/v1/invites/preflight',
    body: json({
      email: INVITEE,
      companyId: PARTY_COMPANY,
      companyRole: 'member',
      dealId: REF,
      dealRole: 'seller',
    }),
  },
  {
    name: 'POST /invites/perimeter-preview (member)',
    handler: invitePerimeter.POST as Handler,
    method: 'POST',
    url: () => 'http://localhost/api/v1/invites/perimeter-preview',
    body: json({ member: { dealId: REF, userId: OTHER_MEMBER, phase: 1 } }),
  },
  {
    name: 'POST /invites/perimeter-preview (member, invalid phase)',
    handler: invitePerimeter.POST as Handler,
    method: 'POST',
    url: () => 'http://localhost/api/v1/invites/perimeter-preview',
    body: json({ member: { dealId: REF, userId: OTHER_MEMBER, phase: -1 } }),
  },
  {
    name: 'POST /invites/perimeter-preview (proposal)',
    handler: invitePerimeter.POST as Handler,
    method: 'POST',
    url: () => 'http://localhost/api/v1/invites/perimeter-preview',
    body: json({
      proposal: {
        email: INVITEE,
        companyId: PARTY_COMPANY,
        companyRole: 'member',
        dealId: REF,
        dealRole: 'seller',
        phase: 1,
      },
    }),
  },
  {
    name: 'POST /invites/lookup',
    handler: inviteLookup.POST as Handler,
    method: 'POST',
    url: () => 'http://localhost/api/v1/invites/lookup',
    body: json({ email: INVITEE, dealId: REF }),
  },
  // Mail takes the deal in the body or query and resolves it leniently: only
  // a sandbox slug sends untagged or reads unfiltered (#245).
  {
    name: 'POST /outbox',
    handler: outbox.POST as Handler,
    method: 'POST',
    url: () => 'http://localhost/api/v1/outbox',
    body: json({
      to: ['counsel@client.example'],
      subject: 'Process update',
      body: 'The room opens Monday.',
      dealId: REF,
    }),
  },
  {
    name: 'GET /outbox?dealId=',
    handler: outbox.GET as Handler,
    method: 'GET',
    url: (dealRef) => `http://localhost/api/v1/outbox?dealId=${encodeURIComponent(dealRef)}`,
    // The caller's own mail exists, yet neither world lists any of it.
    missing: { status: 200, body: { messages: [] } },
  },
  {
    name: 'GET /inbox?dealId=',
    handler: inbox.GET as Handler,
    method: 'GET',
    url: (dealRef) => `http://localhost/api/v1/inbox?dealId=${encodeURIComponent(dealRef)}`,
    // Untagged mail only: neither the deal's own mail nor another deal's.
    missing: { status: 200, body: { messages: [expect.objectContaining({ id: 'in-untagged' })] } },
  },
  // Saving a deal's rail as a company template names the source deal in the
  // body, and the rail-template family answers with its own error shape (#245).
  {
    name: 'POST /rail-templates',
    handler: railTemplates.POST as Handler,
    method: 'POST',
    url: () => 'http://localhost/api/v1/rail-templates',
    body: json({
      requestId: SAVE_REQUEST_ID,
      sourceDealId: REF,
      description: '',
      target: { kind: 'new', name: 'Mid-market sale' },
    }),
    missing: {
      status: 404,
      body: {
        error: 'That deal is not available.',
        code: 'not_found',
        retryable: false,
        requestId: SAVE_REQUEST_ID,
      },
    },
  },
  // These routes take the deal in the body or query but resolve it behind a
  // helper or the caller's own RLS client. They already answer a hidden deal
  // like a missing one, so each row below is a regression guard that passes on
  // day one (design R8, R19).
  //
  // The caller's own company colleague matches the query in both worlds, and
  // the other member's roster entry would match it too: a roster listed for a
  // hidden deal would add a `deal-member` row to the unseated answer.
  {
    name: 'POST /people/search',
    handler: peopleSearch.POST as Handler,
    method: 'POST',
    url: () => 'http://localhost/api/v1/people/search',
    body: json({ query: 'bank.dev', dealId: REF }),
    missing: {
      status: 200,
      body: { people: [expect.objectContaining({ id: `company-user:${CALLER}`, source: 'company_user' })] },
    },
  },
  {
    name: 'GET /discovery/suggestions?deal=',
    handler: discoverySuggestions.GET as Handler,
    method: 'GET',
    url: (dealRef) => `http://localhost/api/v1/discovery/suggestions?deal=${encodeURIComponent(dealRef)}`,
    missing: { status: 200, body: { suggestion: null, origin: 'rules' } },
  },
  {
    name: 'POST /discovery/suggestions/dismiss',
    handler: discoverySuggestionDismiss.POST as Handler,
    method: 'POST',
    url: () => 'http://localhost/api/v1/discovery/suggestions/dismiss',
    body: json({ dealCode: REF, assessmentId: ASSESSMENT_ID, reason: 'Not relevant to this mandate' }),
    missing: { status: 404, body: { error: 'Suggestion not found' } },
  },
  {
    name: 'GET /discovery/deal-email?deal=',
    handler: discoveryDealEmail.GET as Handler,
    method: 'GET',
    url: (dealRef) => `http://localhost/api/v1/discovery/deal-email?deal=${encodeURIComponent(dealRef)}`,
    missing: { status: 200, body: { items: [], truncated: false } },
  },
  {
    name: 'GET /discovery/deal-email/thread?deal=',
    handler: discoveryDealEmailThread.GET as Handler,
    method: 'GET',
    url: (dealRef) =>
      `http://localhost/api/v1/discovery/deal-email/thread?deal=${encodeURIComponent(dealRef)}&item=${SOURCE_ITEM_ID}`,
    missing: { status: 404, body: { error: 'Not found' } },
  },
  // /screen hands the raw body.dealId to userCanAccessDeal without resolving
  // it, so a hidden deal and a missing one both get the 403 below. That 403 is
  // deliberate and unchanged (D95), not the family's 404.
  {
    name: 'POST /screen',
    handler: screen.POST as Handler,
    method: 'POST',
    url: () => 'http://localhost/api/v1/screen',
    body: json({ text: 'The room opens Monday.', mode: 'fast', dealId: REF }),
    missing: { status: 403, body: { error: 'Forbidden' } },
  },
];

/**
 * Body routes that resolve the deal inside a library helper, so the deal-input
 * census cannot see them: their CASES rows are their only guard.
 */
const INDIRECT_ROUTE_HANDLERS = new Set<unknown>([
  railTemplates.POST, // requireTemplateSave in src/lib/railTemplates/access.ts
]);
const INVITE_HANDLERS = new Set<unknown>([
  invites.POST,
  invites.GET,
  invitePreflight.POST,
  invitePerimeter.POST,
  inviteLookup.POST,
]);
const INVITE_CASES = CASES.filter((c) => INVITE_HANDLERS.has(c.handler));

type Answer = { status: number; body: string; headers: [string, string][] };

/**
 * Run one request. `caller` defaults to the world's own caller, and to the
 * unseated caller in the 'missing' world.
 */
async function probe(
  testCase: Case,
  world: World,
  flagsOn: boolean,
  caller: Caller = world === 'missing' ? 'unseated' : world,
): Promise<Answer> {
  enter(world, flagsOn, caller);
  const dealRef = world === 'missing' ? codes.missing : codes.real;
  const url = testCase.url?.(dealRef) ?? `http://localhost/api/v1/deals/${dealRef}`;
  const body =
    testCase.body === undefined
      ? undefined
      : testCase.body instanceof FormData
        ? testCase.body
        : JSON.stringify(testCase.body).replaceAll(REF, dealRef);
  const request = new Request(url, {
    method: testCase.method,
    ...(body === undefined ? {} : { body }),
    ...(body === undefined || body instanceof FormData
      ? {}
      : { headers: { 'content-type': 'application/json' } }),
  });
  const context = { params: Promise.resolve({ dealId: dealRef, ...(testCase.params ?? {}) }) };
  const response = await testCase.handler(request, context as never);
  const headers = [...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b));
  return { status: response.status, body: await response.text(), headers };
}

beforeEach(() => {
  rpcData = {};
  vi.stubEnv('IGNATIOUS_API_URL', 'https://ignatious.test');
  vi.stubEnv('IGNATIOUS_API_KEY', 'test-key');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  seatAddedBy = OTHER_MEMBER;
  callerSeat = null;
  codes = { real: REAL_CODE, missing: MADE_UP_CODE };
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('deal-scoped routes do not reveal whether a deal exists (D65)', () => {
  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s: an unseated caller gets the missing-deal answer, byte for byte',
    async (_name, testCase) => {
      const missing = await probe(testCase, 'missing', true);
      const unseated = await probe(testCase, 'unseated', true);

      // The missing branch really is the "no such deal" answer, not an earlier
      // validation failure that would make the comparison vacuous.
      const expected = testCase.missing ?? {
        status: 404,
        body: { error: expect.stringMatching(/^Deal not found\.?$/) },
      };
      expect(missing.status).toBe(expected.status);
      expect(JSON.parse(missing.body)).toEqual(expected.body);
      expect(unseated).toEqual(missing);
    },
  );

  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s: with every flag off, the two answers still match',
    async (_name, testCase) => {
      const missing = await probe(testCase, 'missing', false);
      const unseated = await probe(testCase, 'unseated', false);
      expect(unseated).toEqual(missing);
    },
  );
});

describe('a former adder holds no authority over the seat they added (D65)', () => {
  const removeOther = CASES.find((c) => c.name === 'DELETE /deals/{id}/members/{user} (seated target)')!;

  it.each([true, false])(
    'flags on=%s: a caller who added the seat but can no longer see the deal gets the missing-deal answer',
    async (flagsOn) => {
      const missing = await probe(removeOther, 'missing', flagsOn);
      seatAddedBy = CALLER;
      const formerAdder = await probe(removeOther, 'unseated', flagsOn);
      expect(formerAdder.status).toBe(404);
      expect(formerAdder).toEqual(missing);
    },
  );

  it('control: an adder who still holds a seat can remove the seat they added', async () => {
    seatAddedBy = CALLER;
    callerSeat = {
      id: 'seat-caller',
      deal_id: DEAL_ID,
      user_id: CALLER,
      added_by: OTHER_MEMBER,
      deal_role: 'deal_team',
      access_scope: {},
      phase: 0,
    };
    const answer = await probe(removeOther, 'unseated', true);
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({ removed: { dealId: DEAL_ID, userId: OTHER_MEMBER } });
  });
});

/*
 * The invite family (#245). One gate runs right after the deal resolves, so
 * every disclosure path is covered, not only the refusals: another firm's
 * admin used to get a full lookup and the deal's invite list, a non-party
 * external director a 200 on GET /invites, and a malformed phase a 400.
 */
type Expected = { status: number; error?: string };
const FORBIDDEN: Expected = { status: 403, error: 'Forbidden' };
const INVALID_PHASE: Expected = { status: 400, error: 'This proposal is not valid for that company or deal' };

/** A seated caller without invite authority already knows the deal exists: answers unchanged. */
const SEATED_ANSWERS: Record<string, Expected> = {
  'POST /invites': FORBIDDEN,
  'GET /invites?dealId=': FORBIDDEN,
  'POST /invites/preflight': FORBIDDEN,
  'POST /invites/perimeter-preview (member)': FORBIDDEN,
  'POST /invites/perimeter-preview (member, invalid phase)': INVALID_PHASE,
  'POST /invites/perimeter-preview (proposal)': FORBIDDEN,
  // "No candidates": nothing to look up and nothing to disclose.
  'POST /invites/lookup': { status: 200 },
};

/**
 * Party and bank directors hold invite authority without a seat, so they pass
 * the gate and reach the route's own answer.
 */
const AUTHORITY_ANSWERS: Record<string, Expected> = {
  // Past the gate, the authority check, the company and party checks: this
  // fake world has no invite-code pepper configured, so creation stops here.
  'POST /invites': { status: 500, error: 'Invite verification is not configured' },
  'GET /invites?dealId=': { status: 200 },
  'POST /invites/preflight': { status: 200 },
  // Neither director is the deal's MD, so the phase raise preview keeps its 403.
  'POST /invites/perimeter-preview (member)': FORBIDDEN,
  'POST /invites/perimeter-preview (member, invalid phase)': INVALID_PHASE,
  'POST /invites/perimeter-preview (proposal)': { status: 200 },
  'POST /invites/lookup': { status: 200 },
};

function expectAnswer(answer: Answer, expected: Expected) {
  expect(answer.status).toBe(expected.status);
  if (expected.error) expect(JSON.parse(answer.body)).toEqual({ error: expected.error });
  else expect(JSON.parse(answer.body)).not.toHaveProperty('error');
}

const HIDDEN_CALLERS: Caller[] = ['nonPartyDirector', 'foreignAdmin'];
const AUTHORITY_CALLERS: Caller[] = ['partyDirector', 'bankDirector'];

describe('invite family: one visibility gate after the deal resolves (D65, #245)', () => {
  it.each(HIDDEN_CALLERS.flatMap((caller) => INVITE_CASES.map((c) => [c.name, caller, c] as const)))(
    '%s: a %s gets the missing-deal answer, byte for byte',
    async (_name, caller, testCase) => {
      const missing = await probe(testCase, 'missing', true, caller);
      const real = await probe(testCase, caller, true);

      expect(missing.status).toBe(404);
      expect(JSON.parse(missing.body)).toEqual({ error: 'Deal not found' });
      expect(real).toEqual(missing);
    },
  );

  it.each(INVITE_CASES.map((c) => [c.name, c] as const))(
    '%s: a seated caller without authority keeps its answer',
    async (name, testCase) => {
      expectAnswer(await probe(testCase, 'seated', true), SEATED_ANSWERS[name]);
    },
  );

  it.each(AUTHORITY_CALLERS.flatMap((caller) => INVITE_CASES.map((c) => [c.name, caller, c] as const)))(
    '%s: a %s with no seat passes the gate',
    async (name, caller, testCase) => {
      expectAnswer(await probe(testCase, caller, true), AUTHORITY_ANSWERS[name]);
    },
  );

  it('every invite row has a seated and an authority expectation', () => {
    const names = INVITE_CASES.map((c) => c.name).sort();
    expect(Object.keys(SEATED_ANSWERS).sort()).toEqual(names);
    expect(Object.keys(AUTHORITY_ANSWERS).sort()).toEqual(names);
  });
});

/*
 * Mail (#245). A caller who can see the deal still reads its mail: the deal
 * filter survives, so the hidden answer above is not the only one these
 * routes can give.
 */
describe('mail routes: a seated caller still reads the deal\'s mail (D65, #245)', () => {
  const mailCase = (name: string) => CASES.find((c) => c.name === name)!;
  const ids = (answer: Answer) =>
    (JSON.parse(answer.body) as { messages: { id: string }[] }).messages.map((m) => m.id);

  it('GET /outbox?dealId= lists the caller\'s messages on that deal', async () => {
    const answer = await probe(mailCase('GET /outbox?dealId='), 'seated', true);
    expect(answer.status).toBe(200);
    expect(ids(answer)).toEqual(['out-on-deal']);
  });

  it('GET /inbox?dealId= keeps that deal\'s mail and untagged mail, not another deal\'s', async () => {
    const answer = await probe(mailCase('GET /inbox?dealId='), 'seated', true);
    expect(answer.status).toBe(200);
    expect(ids(answer)).toEqual(['in-untagged', 'in-on-deal']);
  });
});

/*
 * A real deal whose code is not deal-shaped (a legacy or hand-entered code).
 * The mail resolver reads a miss of that shape as a sandbox slug, so a hidden
 * deal with such a code must answer like the slug too, never like a 404 that
 * a made-up slug of the same shape cannot produce (#245, audit H1).
 */
describe('mail routes: a hidden deal with an unusual code answers like a miss of that shape (D65, #245)', () => {
  // POST /outbox gets past the resolver in both worlds and stops at the
  // unconfigured send (500); the GETs list unfiltered mail. Before the fix the
  // hidden deal answered 404 and filtered.
  const MAIL_ROWS = ['POST /outbox', 'GET /outbox?dealId=', 'GET /inbox?dealId='];

  it.each(MAIL_ROWS)('%s: unseated on LEGACY-DEAL equals missing LEGACY-DEAX', async (name) => {
    const testCase = CASES.find((c) => c.name === name)!;
    codes = { real: 'LEGACY-DEAL', missing: 'LEGACY-DEAX' };
    const missing = await probe(testCase, 'missing', true);
    const unseated = await probe(testCase, 'unseated', true);
    expect(missing.status).not.toBe(404);
    expect(unseated).toEqual(missing);
  });
});

/*
 * Rail-template save (#245). The unseated answer above is the family's own
 * missing answer; a seated caller already knows the deal exists and keeps the
 * family's 'forbidden' refusal when it lacks the template permission.
 */
describe('rail-template save: a seated caller keeps its refusal (D65, #245)', () => {
  const saveCase = () => CASES.find((c) => c.name === 'POST /rail-templates')!;

  it('a seated caller without the template-manage permission gets 403 forbidden', async () => {
    rpcData = { app_has_company_permission: false };
    const answer = await probe(saveCase(), 'seated', true);
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.body)).toEqual({
      error: 'This company rail is not available to you.',
      code: 'forbidden',
      retryable: false,
      requestId: SAVE_REQUEST_ID,
    });
  });

  it('the permission is what refuses it: with it, the save goes past the access checks', async () => {
    rpcData = { app_has_company_permission: true };
    const answer = await probe(saveCase(), 'seated', true);
    // This fake world has no rail to save, so the save itself fails later on.
    expect([403, 404]).not.toContain(answer.status);
    expect(JSON.parse(answer.body)).not.toMatchObject({ code: 'forbidden' });
    expect(JSON.parse(answer.body)).not.toMatchObject({ code: 'not_found' });
  });
});

/*
 * Route censuses. Keys are `METHOD path`, the path relative to src/app/api/v1
 * without `/route.ts`, e.g. `GET deals/[dealId]/rail/template-changes`.
 */
const API_ROOT = join(process.cwd(), 'src', 'app', 'api', 'v1');
const DEAL_ROUTES = join(API_ROOT, 'deals', '[dealId]');
const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

/**
 * Deal-scoped route methods deliberately left out of CASES, each mapped to the
 * suite that proves its unseated answer equals its missing answer. Empty today:
 * every route under `deals/[dealId]` has a row above. Add an entry only when a
 * route cannot run in this file's fake world, never to silence the census.
 */
const EXEMPT: Record<string, string> = {};

/**
 * Names that resolve a deal reference or decide whether the caller can see a
 * deal. A route outside `deals/[dealId]` that names one reads a deal from its
 * body or query, so it needs a CASES row or a BODY_EXEMPT reason.
 */
const DEAL_RESOLVER = /\b(resolveDealRef|resolveDealRefLenient|loadDealByIdOrCode|userCanAccessDeal)\b/;

/**
 * Names a route takes a deal under in its body or query: `dealId`, `dealCode`,
 * `sourceDealId`, and `searchParams.get('deal')`. A route outside
 * `deals/[dealId]` that matches this or DEAL_RESOLVER needs a CASES row or a
 * BODY_EXEMPT reason (design R8). Over-matching is the safe direction: a false
 * positive costs one exempt line with a reason, a false negative is a silent
 * leak.
 *
 * Known blind spot (design R19). A route that reads its deal from a `deal_id`
 * or `body.deal` key, or under any other name outside this pattern, still
 * escapes the census. `deal_id` stays out on purpose: it would match every
 * `.eq('deal_id', ...)` column filter in the tree. The routes that resolve a
 * deal inside a library helper and never name it in the route file are pinned
 * in INDIRECT_ROUTE_HANDLERS instead.
 */
const DEAL_PARAM = /\b(dealId|dealCode|sourceDealId)\b|get\(['"]deal['"]\)/;

/**
 * Body or query route methods whose file matches DEAL_RESOLVER or DEAL_PARAM and
 * that are deliberately not CASES rows. Each one is a name collision: the match
 * is not a deal the caller names, so there is no hidden-versus-missing answer to
 * compare. A route that does take a deal as input gets a CASES row instead.
 */
const COMPANY_TOKEN =
  'name collision: the company id in the path is the only input, and `dealId` is the claim name of the Ignatious trigger token, which carries that company id (a company is the lead scope, not a deal)';
const INVITE_ID =
  'name collision: the caller names an invite id, not a deal; the `dealId` passed to userCanManageInvite is read from the stored invite row after the invite lookup, so the request carries no deal reference';
const CREATED_DEAL =
  'name collision: `dealId` and `dealCode` name a deal this handler just created or just read back for its own receipt; the request carries no deal reference';
const RAIL_CATALOG_DRAFT =
  'name collision: the template id in the path is the only scope, and `dealId: null` only tells the usage recorder that the authoring turn belongs to no deal';
const ACCEPT_RESULT =
  'name collision: `dealId` and `dealCode` are fields of the acceptance receipt, read from the invite the caller redeems; the request body carries no deal reference';

const BODY_EXEMPT: Record<string, string> = {
  'POST companies/[companyId]/bench/chat': COMPANY_TOKEN,
  'POST companies/[companyId]/debrief': COMPANY_TOKEN,
  'POST companies/[companyId]/presearch': COMPANY_TOKEN,
  'GET companies/[companyId]/presearch': COMPANY_TOKEN,
  'DELETE companies/[companyId]/presearch': COMPANY_TOKEN,
  'POST companies/[companyId]/twins/[personaId]/chat': COMPANY_TOKEN,
  'GET deals':
    'name collision: the list takes no deal; `dealId` and `dealCode` are parameters of the dataroom-provisioning helper in the same file',
  'POST deals': CREATED_DEAL,
  'GET deals/template-creations/[requestId]':
    'name collision: the caller names a creation request id, read under the caller\'s own id; the match is `dealId` on the receipt the POST returns, in the same file',
  'POST deals/template-creations/[requestId]': CREATED_DEAL,
  'POST invites/accept': ACCEPT_RESULT,
  'POST invites/[inviteId]/resend': INVITE_ID,
  'DELETE invites/[inviteId]': INVITE_ID,
  'GET me':
    'name collision: the caller\'s own profile takes no deal; `dealId` is a field of the `mandate` the handler derives from the caller\'s own first seat',
  'PATCH me':
    'name collision: the body is fullName and displayName only; `dealId` is a field of the `mandate` the GET derives from the caller\'s own first seat, in the same file',
  'POST rail-catalog/[templateId]/skill-drafts/[draftId]/messages': RAIL_CATALOG_DRAFT,
  'POST rail-catalog/[templateId]/skill-drafts/[draftId]/messages/[messageId]/retry': RAIL_CATALOG_DRAFT,
  'POST work-identity/accept': ACCEPT_RESULT,
};

function routeFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeFilesUnder(path);
    return entry.name === 'route.ts' ? [path] : [];
  });
}

const routeKey = (method: string, file: string) =>
  `${method} ${relative(API_ROOT, file).split(sep).slice(0, -1).join('/')}`;

/**
 * Every exported HTTP method in `files`, with its handler. The modules are the
 * ones CASES already imported (same module instance), so a row covers a route
 * by handler identity, not by its free-text name.
 */
async function routeMethodsIn(files: string[]): Promise<{ key: string; handler: unknown }[]> {
  const found: { key: string; handler: unknown }[] = [];
  for (const file of [...files].sort()) {
    const mod = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
    for (const method of HTTP_METHODS) {
      if (typeof mod[method] === 'function') found.push({ key: routeKey(method, file), handler: mod[method] });
    }
  }
  return found;
}

const pathRouteMethods = () => routeMethodsIn(routeFilesUnder(DEAL_ROUTES));

/** Route methods outside `deals/[dealId]` whose file names a deal resolver or a deal parameter. */
const dealInputRouteMethods = () =>
  routeMethodsIn(
    routeFilesUnder(API_ROOT).filter((file) => {
      if (file.startsWith(DEAL_ROUTES + sep)) return false;
      const source = readFileSync(file, 'utf8');
      return DEAL_RESOLVER.test(source) || DEAL_PARAM.test(source);
    }),
  );

describe('route census: every deal-scoped route method is proven (D65)', () => {
  it('every route method under deals/[dealId] has a CASES row or a named exemption', async () => {
    const rowHandlers = new Set<unknown>(CASES.map((c) => c.handler));
    const uncovered = (await pathRouteMethods())
      .filter(({ key, handler }) => !rowHandlers.has(handler) && !(key in EXEMPT))
      .map(({ key }) => key);
    expect(uncovered).toEqual([]);
  });

  it('every other route method that names a deal resolver or takes a deal parameter has a CASES row or a named exemption', async () => {
    const rowHandlers = new Set<unknown>(CASES.map((c) => c.handler));
    const uncovered = (await dealInputRouteMethods())
      .filter(({ key, handler }) => !rowHandlers.has(handler) && !(key in BODY_EXEMPT))
      .map(({ key }) => key);
    expect(uncovered).toEqual([]);
  });

  it('every CASES row runs a handler one of the censuses found, or a named indirect route', async () => {
    const known = new Set<unknown>(
      [...(await pathRouteMethods()), ...(await dealInputRouteMethods())].map(({ handler }) => handler),
    );
    for (const handler of INDIRECT_ROUTE_HANDLERS) known.add(handler);
    const stale = CASES.filter((c) => !known.has(c.handler)).map((c) => c.name);
    expect(stale).toEqual([]);
  });

  it('every path exemption names a live route and a suite that exists', async () => {
    const keys = new Set((await pathRouteMethods()).map(({ key }) => key));
    const broken = Object.entries(EXEMPT)
      .filter(([key, suite]) => !keys.has(key) || !existsSync(join(process.cwd(), suite)))
      .map(([key, suite]) => `${key} -> ${suite}`);
    expect(broken).toEqual([]);
  });

  it('every body exemption names a route method the deal-input census still finds', async () => {
    const keys = new Set((await dealInputRouteMethods()).map(({ key }) => key));
    expect(Object.keys(BODY_EXEMPT).filter((key) => !keys.has(key))).toEqual([]);
  });

  it('an indirect route is not also one the deal-input census can see', async () => {
    const seen = new Set((await dealInputRouteMethods()).map(({ handler }) => handler));
    expect([...INDIRECT_ROUTE_HANDLERS].filter((handler) => seen.has(handler))).toEqual([]);
  });
});
