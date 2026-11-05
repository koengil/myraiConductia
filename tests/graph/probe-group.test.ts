// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { GraphHttpOptions } from '@/lib/graph/http';
import { probeGraphScope, type ExchangeMailboxType, type ScopeProbeTarget } from '@/lib/graph/reader/probe';
import { readerCapability } from './readerCapability';

/*
 * The scope probe's group target (#275, design R9): the owner's Oct 19 check of
 * the Exchange scope group, over a scripted Graph. It must answer Q1 per
 * mailbox type by object id (shared mailboxes included), count the R4 binding
 * hazards, run the binding check with its negative control and report the
 * delta link's key form, on members in both lists (a shared mailbox whose UPN
 * differs from its mail first), and return only counts, booleans and enums.
 * Every request is a GET with no body.
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';
const GROUP = '0a0a0a0a-0000-4000-8000-00000000000a';
const STORM = { id: '11111111-0000-4000-8000-000000000001', mail: 'storm.duncan@bank.example', upn: 'storm.duncan@bank.example' };
const DEALS = { id: '22222222-0000-4000-8000-000000000002', mail: 'deals@bank.example', upn: 'deals@bankexample.onmicrosoft.com' };
const MORGAN = { id: '33333333-0000-4000-8000-000000000003', mail: 'morgan@bank.example', upn: 'morgan@bank.example' };
// In Graph's listing, not in the Exchange export: never a checked member.
const EXTRA = { id: '88888888-0000-4000-8000-000000000008', mail: 'extra@bank.example', upn: 'extra@bank.example' };
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

type Member = { id: string; mail?: string | null; upn?: string | null; type?: string };
type Reply = { status: number; body?: unknown };

const user = (m: Member) => ({
  '@odata.type': m.type ?? '#microsoft.graph.user',
  id: m.id,
  ...(m.mail === undefined ? {} : { mail: m.mail }),
  ...(m.upn === undefined ? {} : { userPrincipalName: m.upn }),
});
const MEMBERS = `/groups/${GROUP}/members?$select=id,mail,userPrincipalName&$top=999`;
const NEXT = `${GRAPH}${MEMBERS}&$skiptoken=r1`;
const inbox = (key: string) => `/users/${key}/mailFolders/inbox?$select=id`;
const delta = (key: string) => `/users/${key}/mailFolders/inbox/messages/delta?$select=id`;

/** A Graph that answers by route (the decoded path after /v1.0), records every request, and throws on any other. */
function graph(routes: Record<string, Reply>) {
  const calls: Array<{ route: string; headers: Headers; method: string; body: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const route = decodeURIComponent(String(url).replace(GRAPH, ''));
    calls.push({ route, headers: new Headers(init?.headers), method: (init?.method ?? 'GET').toUpperCase(), body: init?.body ?? null });
    const reply = routes[route];
    if (!reply) throw new Error(`unexpected request ${route}`);
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
  });
  const http: GraphHttpOptions = { getToken: async () => 'token', fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => undefined };
  return { http, calls };
}

/** Two pages of members: Storm, a nested group, the shared mailbox; then a contact and Morgan. */
function listing(page1: Member[], page2: Member[]): Record<string, Reply> {
  return {
    [MEMBERS]: { status: 200, body: { value: page1.map(user), '@odata.nextLink': NEXT } },
    [decodeURIComponent(NEXT.replace(GRAPH, ''))]: { status: 200, body: { value: page2.map(user) } },
  };
}
const NESTED = { id: '44444444-0000-4000-8000-000000000004', type: '#microsoft.graph.group' };
const CONTACT = { id: '55555555-0000-4000-8000-000000000005', type: '#microsoft.graph.orgContact' };
const fullListing = () => listing([STORM, NESTED, DEALS], [CONTACT, MORGAN]);

type Box = { id: string; upn: string };

/**
 * The binding check (the checked member by id and by UPN), the negative control (another member by id) and the
 * delta link. By default the checked member is the shared mailbox, whose UPN differs from its mail, and the control
 * is Storm, the first other member in both lists.
 */
function checks(
  over: { byUpn?: Reply; controlById?: Reply; link?: Reply } = {},
  subject: Box = DEALS,
  control: Box = STORM,
): Record<string, Reply> {
  return {
    [inbox(subject.id)]: { status: 200, body: { id: 'INBOX-SUBJECT' } },
    [inbox(subject.upn)]: over.byUpn ?? { status: 200, body: { id: 'INBOX-SUBJECT' } },
    [inbox(control.id)]: over.controlById ?? { status: 200, body: { id: 'INBOX-CONTROL' } },
    [delta(subject.upn)]: over.link ?? {
      status: 200,
      body: { value: [{ id: 'M1' }], '@odata.nextLink': `${GRAPH}/users/${encodeURIComponent(subject.upn)}/mailFolders/inbox/messages/delta?$skiptoken=r2` },
    },
  };
}

const exportOf = (...rows: Array<[{ id: string }, ExchangeMailboxType]>) => rows.map(([m, type]) => ({ id: m.id, type }));
const ALL_EXPORTED = exportOf([STORM, 'UserMailbox'], [DEALS, 'SharedMailbox'], [MORGAN, 'UserMailbox']);
const target = (exchange = ALL_EXPORTED): ScopeProbeTarget => ({ kind: 'group', groupId: GROUP, exchange });

async function run(routes: Record<string, Reply>, exchange = ALL_EXPORTED) {
  const { http, calls } = graph(routes);
  const result = await probeGraphScope(readerCapability, http, target(exchange));
  return { result, report: result.group!, calls };
}

describe('the scope probe group target (#275, design R9)', () => {
  it('follows nextLink, counts users and other member types, and keeps the shared mailbox as a user', async () => {
    const { result, report, calls } = await run({ ...fullListing(), ...checks() });
    expect(result.status).toBe(200);
    expect(calls[0].route).toBe(MEMBERS);
    expect(calls[1].route).toBe(decodeURIComponent(NEXT.replace(GRAPH, '')));
    expect(report).toMatchObject({ users: 3, withMail: 3, withUpn: 3, otherTypes: 2 });
  });

  it('counts mail and UPN as missing when the role returns ids only, and runs no check', async () => {
    const stripped = (m: Member) => ({ id: m.id });
    const { report, calls } = await run(listing([stripped(STORM), stripped(DEALS)], [stripped(MORGAN)]));
    expect(report).toMatchObject({ users: 3, withMail: 0, withUpn: 0 });
    expect(report).toMatchObject({ sameMailboxByUpnAndId: null, differentMembersDiffer: null, linkKeyForm: null, checkStatus: null });
    expect(calls.every((c) => c.route.startsWith('/groups/'))).toBe(true);
  });

  it('counts mail and UPN separately when only one is returned', async () => {
    const { report } = await run(listing([{ id: STORM.id, upn: STORM.upn }, { id: DEALS.id, mail: DEALS.mail }], [{ id: MORGAN.id, upn: MORGAN.upn }]));
    expect(report).toMatchObject({ users: 3, withMail: 1, withUpn: 2 });
  });

  it('answers Q1 per type by object id: every type equal', async () => {
    const { report } = await run({ ...fullListing(), ...checks() });
    expect(report.byType).toEqual({
      UserMailbox: { exchange: 2, both: 2, onlyInExchange: 0 },
      SharedMailbox: { exchange: 1, both: 1, onlyInExchange: 0 },
      RoomMailbox: { exchange: 0, both: 0, onlyInExchange: 0 },
      EquipmentMailbox: { exchange: 0, both: 0, onlyInExchange: 0 },
      Other: { exchange: 0, both: 0, onlyInExchange: 0 },
    });
    expect(report).toMatchObject({ onlyInGraph: 0, equal: true });
  });

  it('shows a shared mailbox Graph does not list as only in Exchange', async () => {
    const { report } = await run({ ...listing([STORM], [MORGAN]), ...checks({}, STORM, MORGAN) }, ALL_EXPORTED);
    expect(report.byType.SharedMailbox).toEqual({ exchange: 1, both: 0, onlyInExchange: 1 });
    expect(report.byType.UserMailbox.onlyInExchange).toBe(0);
    expect(report.equal).toBe(false);
  });

  it('is not equal when the counts match but one member is missing and another is extra', async () => {
    const stranger = { id: '66666666-0000-4000-8000-000000000006' };
    const exchange = exportOf([STORM, 'UserMailbox'], [MORGAN, 'UserMailbox'], [stranger, 'UserMailbox']);
    // The shared mailbox is not exported here, so Storm is the checked member and Morgan the control.
    const { report } = await run({ ...fullListing(), ...checks({}, STORM, MORGAN) }, exchange);
    expect(report.users).toBe(3);
    expect(report.byType.UserMailbox).toEqual({ exchange: 3, both: 2, onlyInExchange: 1 });
    expect(report.onlyInGraph).toBe(1);
    expect(report.equal).toBe(false);
  });

  it('compares ids case-insensitively and counts a repeated export id once', async () => {
    const exchange = [...ALL_EXPORTED, { id: STORM.id.toUpperCase(), type: 'UserMailbox' as const }];
    const { report } = await run({ ...fullListing(), ...checks() }, exchange);
    expect(report.byType.UserMailbox).toEqual({ exchange: 2, both: 2, onlyInExchange: 0 });
    expect(report.equal).toBe(true);
  });

  it('counts the binding hazards: a UPN that is not the mail, and a UPN that is another member mail', async () => {
    const hijack = { id: '77777777-0000-4000-8000-000000000007', mail: 'h@bank.example', upn: MORGAN.mail };
    const { report } = await run({ ...listing([STORM, NESTED, DEALS], [CONTACT, MORGAN, hijack]), ...checks() });
    // The shared mailbox (onmicrosoft UPN) and the hijack differ; only the hijack's UPN is another member's mail.
    expect(report).toMatchObject({ upnDiffersFromMail: 2, upnEqualsOtherMail: 1 });
  });

  it('does not count a member whose UPN is its own mail as a hazard', async () => {
    const { report } = await run(
      { ...listing([STORM], [MORGAN]), ...checks({}, STORM, MORGAN) },
      exportOf([STORM, 'UserMailbox'], [MORGAN, 'UserMailbox']),
    );
    expect(report).toMatchObject({ upnDiffersFromMail: 0, upnEqualsOtherMail: 0 });
  });

  it('reports the same mailbox by UPN and id, and that two members differ', async () => {
    const { report } = await run({ ...fullListing(), ...checks() });
    expect(report).toMatchObject({ sameMailboxByUpnAndId: true, differentMembersDiffer: true, checkStatus: null });
  });

  it('reports a UPN that reaches another inbox than the id', async () => {
    const { report } = await run({ ...fullListing(), ...checks({ byUpn: { status: 200, body: { id: 'INBOX-ELSEWHERE' } } }) });
    expect(report.sameMailboxByUpnAndId).toBe(false);
  });

  it('fails the negative control when two members show the same inbox id', async () => {
    const { report } = await run({ ...fullListing(), ...checks({ controlById: { status: 200, body: { id: 'INBOX-SUBJECT' } } }) });
    expect(report.differentMembersDiffer).toBe(false);
  });

  it('sends the mail reader headers, identically, on both binding requests', async () => {
    const { calls } = await run({ ...fullListing(), ...checks() });
    const byId = calls.find((c) => c.route === inbox(DEALS.id))!;
    const byUpn = calls.find((c) => c.route === inbox(DEALS.upn))!;
    expect(byId.headers.get('Prefer')).toContain('IdType="ImmutableId"');
    expect(byUpn.headers.get('Prefer')).toBe(byId.headers.get('Prefer'));
    expect(byUpn.headers.get('Accept')).toBe(byId.headers.get('Accept'));
    const link = calls.find((c) => c.route === delta(DEALS.upn))!;
    expect(link.headers.get('Prefer')).toBe('odata.maxpagesize=1, IdType="ImmutableId"');
  });

  it.each([
    ['upn', `${GRAPH}/users/deals%40bankexample.onmicrosoft.com/mailFolders/inbox/messages/delta?$skiptoken=r2`, 'nextLink'],
    ['upn', `${GRAPH}/users('DEALS@bankexample.onmicrosoft.com')/mailFolders('AAMk')/messages/delta?$skiptoken=r2`, 'nextLink'],
    ['id', `${GRAPH}/users/${DEALS.id}/mailFolders/inbox/messages/delta?$deltatoken=r3`, 'deltaLink'],
    ['id', `${GRAPH}/users('${DEALS.id.toUpperCase()}')/mailFolders('AAMk')/messages/delta?$deltatoken=r3`, 'deltaLink'],
    // The shared mailbox's mail, not its UPN: another key form.
    ['other', `${GRAPH}/users/deals%40bank.example/mailFolders/inbox/messages/delta?$skiptoken=r2`, 'nextLink'],
    ['other', `${GRAPH}/me/mailFolders/inbox/messages/delta?$skiptoken=r2`, 'nextLink'],
    ['other', 'https://elsewhere.example/v1.0/users/deals@bankexample.onmicrosoft.com/messages', 'nextLink'],
  ])('reads the link key form %s from %s', async (form, link, kind) => {
    const body = { value: [{ id: 'M1' }], [`@odata.${kind}`]: link };
    const { report } = await run({ ...fullListing(), ...checks({ link: { status: 200, body } }) });
    expect(report.linkKeyForm).toBe(form);
  });

  it('leaves the link key form unchecked when Graph returns no link', async () => {
    const { report } = await run({ ...fullListing(), ...checks({ link: { status: 200, body: { value: [] } } }) });
    expect(report.linkKeyForm).toBeNull();
  });

  it('says which status stopped a check, and leaves that answer unchecked', async () => {
    const denied = { status: 403, body: { error: { code: 'ErrorAccessDenied', message: 'Access to the deals inbox is denied' } } };
    const { report } = await run({ ...fullListing(), ...checks({ byUpn: denied }) });
    expect(report).toMatchObject({ sameMailboxByUpnAndId: null, differentMembersDiffer: true, linkKeyForm: 'upn', checkStatus: 403 });
  });

  it('returns only the status and code when the listing is refused, in one attempt', async () => {
    const { http, calls } = graph({ [MEMBERS]: { status: 403, body: { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' } } } });
    const result = await probeGraphScope(readerCapability, http, target());
    expect(result).toEqual({ status: 403, code: 'Authorization_RequestDenied' });
    expect(calls).toHaveLength(1);
  });

  it('checks only members in both lists: a Graph-only member listed first is never sampled', async () => {
    const { report, calls } = await run({ ...listing([EXTRA, STORM, NESTED, DEALS], [CONTACT, MORGAN]), ...checks() });
    expect(report.checked).toEqual({ type: 'SharedMailbox', upnDiffersFromMail: true, controlType: 'UserMailbox' });
    expect(report.onlyInGraph).toBe(1);
    expect(calls.some((c) => c.route.startsWith(`/users/${EXTRA.id}`) || c.route.startsWith(`/users/${EXTRA.upn}`))).toBe(false);
    expect(report).toMatchObject({ sameMailboxByUpnAndId: true, differentMembersDiffer: true, linkKeyForm: 'upn' });
  });

  it('prefers a shared mailbox whose UPN differs from its mail over one whose UPN is its mail', async () => {
    const plain = { id: '99999999-0000-4000-8000-000000000009', mail: 'ops@bank.example', upn: 'ops@bank.example' };
    const exchange = exportOf([plain, 'SharedMailbox'], [STORM, 'UserMailbox'], [DEALS, 'SharedMailbox'], [MORGAN, 'UserMailbox']);
    const { report, calls } = await run({ ...listing([plain, STORM, DEALS], [MORGAN]), ...checks({}, DEALS, plain) }, exchange);
    expect(report.checked).toEqual({ type: 'SharedMailbox', upnDiffersFromMail: true, controlType: 'SharedMailbox' });
    expect(calls.some((c) => c.route === inbox(plain.upn))).toBe(false);
  });

  it('falls back to a user mailbox when the group lists no shared mailbox, and says so', async () => {
    const { report } = await run({ ...listing([STORM], [MORGAN]), ...checks({}, STORM, MORGAN) }, exportOf([STORM, 'UserMailbox'], [MORGAN, 'UserMailbox']));
    expect(report.checked).toEqual({ type: 'UserMailbox', upnDiffersFromMail: false, controlType: 'UserMailbox' });
    expect(report.sameMailboxByUpnAndId).toBe(true);
  });

  it('runs no check when no member is in both lists', async () => {
    const stranger = { id: '66666666-0000-4000-8000-000000000006' };
    const { report, calls } = await run(fullListing(), exportOf([stranger, 'SharedMailbox']));
    expect(report.checked).toBeNull();
    expect(report).toMatchObject({ sameMailboxByUpnAndId: null, differentMembersDiffer: null, linkKeyForm: null });
    expect(calls.every((c) => c.route.startsWith('/groups/'))).toBe(true);
  });

  it('sends only GET requests with no body', async () => {
    const { calls } = await run({ ...fullListing(), ...checks() });
    expect(calls.length).toBeGreaterThan(2);
    for (const call of calls) expect({ method: call.method, body: call.body }).toEqual({ method: 'GET', body: null });
  });

  it('returns no id, address or body', async () => {
    const { result } = await run({ ...fullListing(), ...checks() });
    const text = JSON.stringify(result);
    expect(text).not.toContain('@');
    expect(text).not.toMatch(GUID);
    expect(text).not.toContain('INBOX-');
    expect(text).not.toContain('M1');
  });

  it('demands the reader capability before any request', async () => {
    const { http, calls } = graph({});
    await expect(probeGraphScope({} as never, http, target())).rejects.toMatchObject({ reason: 'no_capability' });
    expect(calls).toHaveLength(0);
  });
});
