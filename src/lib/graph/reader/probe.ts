// The reader's scope probe (step 4 of scripts/m365/README.md, ADR-005): asks
// Graph, with the registration's own credential, for one message id from a
// mailbox or the libraries of a site, and reports only the HTTP status and
// Graph's error code. A mailbox outside the RBAC for Applications scope, or a
// site not granted under Sites.Selected, must answer 403.
//
// It deliberately asks about addresses the allowlist does not admit: the point
// is that Microsoft refuses them too. So it reads nothing: `$select=id`,
// `$top=1`, and the response body is discarded unread. Demands the reader
// capability like every reader factory (#262), so only
// src/lib/mailboxAccess/readers.ts can run it.
//
// The `group` target (#275, design R9) answers the owner's live questions
// about the Exchange scope group before the group mirror is built. It lists
// the group's direct members, compares their object ids with the operator's
// Exchange export per mailbox type (shared mailboxes included), and checks,
// on members that are in both lists and have mail and a UPN, that the UPN and
// the object id reach the same inbox, that two members' inboxes differ, and
// which key form Graph's delta links use. The checked member is a shared
// mailbox whose UPN differs from its mail when there is one, since that is
// the binding the mirror relies on most. Only counts, booleans and enums come
// back: no id, address or body leaves this module.

import { requireReaderCapability, type ReaderCapability } from '@/lib/discovery/source/capability';
import { graphFetch, GraphHttpError, graphJson, graphPages, type GraphHttpOptions } from '@/lib/graph/http';
// The reader's own key parser (mail.ts), so the link key form printed is the one assertCheckpointKey accepts.
import { MAIL_PAGE_SIZE, mailboxKeyOfLink } from './mail';

/** An Exchange RecipientTypeDetails, as the operator's export names it; anything else is `Other`. */
export type ExchangeMailboxType = 'UserMailbox' | 'SharedMailbox' | 'RoomMailbox' | 'EquipmentMailbox' | 'Other';

export type ScopeProbeTarget =
  | { kind: 'mailbox'; address: string }
  | { kind: 'site'; siteId: string }
  // GET /groups/{id}/members?$select=id,mail,userPrincipalName&$top=999, nextLink followed.
  | { kind: 'group'; groupId: string; exchange: ReadonlyArray<{ id: string; type: ExchangeMailboxType }> };

export type GroupTypeComparison = { exchange: number; both: number; onlyInExchange: number };

export type GroupProbeReport = {
  /** Members Graph lists as #microsoft.graph.user (user, shared, room and equipment mailboxes alike). */
  users: number;
  withMail: number;
  withUpn: number;
  /** Nested groups, contacts, devices and anything else that is not a user. */
  otherTypes: number;
  /** Q1, per Exchange type: object ids in the export, in both lists, and in the export only. */
  byType: Record<ExchangeMailboxType, GroupTypeComparison>;
  onlyInGraph: number;
  equal: boolean;
  /** R4 binding hazards: a UPN that is not the member's mail, and a UPN that is another member's mail. */
  upnDiffersFromMail: number;
  upnEqualsOtherMail: number;
  /** The inbox id via /users/{id} equals the one via /users/{upn}, with the mail reader's headers on both. Null: not checked. */
  sameMailboxByUpnAndId: boolean | null;
  /** Negative control: two members' inbox ids differ. Null: not checked. */
  differentMembersDiffer: boolean | null;
  /** The mailbox key in a delta link Graph returns for /users/{upn}/...: the UPN, the object id, or another form. Null: not checked. */
  linkKeyForm: 'upn' | 'id' | 'other' | null;
  /** The status of the first check request that failed, so a "not checked" line says why. Null when none failed. */
  checkStatus: number | null;
  /**
   * Which member the three checks above ran on, by its Exchange type only, and the negative control's type. Null
   * when no member in both lists has mail and a UPN, so nothing was checked.
   */
  checked: { type: ExchangeMailboxType; upnDiffersFromMail: boolean; controlType: ExchangeMailboxType | null } | null;
};

export type ScopeProbeResult = { status: number; code: string | null; group?: GroupProbeReport };

const EXCHANGE_TYPES: readonly ExchangeMailboxType[] = ['UserMailbox', 'SharedMailbox', 'RoomMailbox', 'EquipmentMailbox', 'Other'];
const GRAPH_USER = '#microsoft.graph.user';
// The mail reader's own Prefer header (mail.ts): folder ids depend on IdType, so the
// ids compared here are the ones the reader would see.
const READER_PREFER = `odata.maxpagesize=${MAIL_PAGE_SIZE}, IdType="ImmutableId"`;
// One message id per page: the link is all the probe wants from the delta request.
const LINK_PREFER = 'odata.maxpagesize=1, IdType="ImmutableId"';

type GraphMember = { '@odata.type'?: unknown; id?: unknown; mail?: unknown; userPrincipalName?: unknown };
type GroupUser = { id: string; mail: string | null; upn: string | null };
type DeltaPage = { '@odata.nextLink'?: unknown; '@odata.deltaLink'?: unknown };

function pathOf(target: Exclude<ScopeProbeTarget, { kind: 'group' }>): string {
  return target.kind === 'mailbox'
    ? `/users/${encodeURIComponent(target.address)}/messages?$top=1&$select=id`
    : `/sites/${encodeURIComponent(target.siteId)}/drives?$select=id`;
}

function lowered(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().toLowerCase() : null;
}

async function probeGroup(target: Extract<ScopeProbeTarget, { kind: 'group' }>, http: GraphHttpOptions): Promise<ScopeProbeResult> {
  const users: GroupUser[] = [];
  let otherTypes = 0;
  try {
    const members = `/groups/${encodeURIComponent(target.groupId)}/members?$select=id,mail,userPrincipalName&$top=999`;
    for await (const page of graphPages<GraphMember>(members, http)) {
      for (const member of page.value) {
        const id = lowered(member.id);
        if (member['@odata.type'] !== GRAPH_USER || id === null) {
          otherTypes += 1;
          continue;
        }
        users.push({ id, mail: lowered(member.mail), upn: lowered(member.userPrincipalName) });
      }
    }
  } catch (error) {
    if (error instanceof GraphHttpError) return { status: error.status, code: error.code };
    throw error;
  }

  // Q1: an object-id set comparison against the Exchange export, per type.
  const graphIds = new Set(users.map((user) => user.id));
  const exchangeIds = new Map<string, ExchangeMailboxType>();
  for (const member of target.exchange) {
    const id = member.id.trim().toLowerCase();
    if (!exchangeIds.has(id)) exchangeIds.set(id, EXCHANGE_TYPES.includes(member.type) ? member.type : 'Other');
  }
  const byType = Object.fromEntries(
    EXCHANGE_TYPES.map((type) => [type, { exchange: 0, both: 0, onlyInExchange: 0 }]),
  ) as Record<ExchangeMailboxType, GroupTypeComparison>;
  for (const [id, type] of exchangeIds) {
    const row = byType[type];
    row.exchange += 1;
    if (graphIds.has(id)) row.both += 1;
    else row.onlyInExchange += 1;
  }
  const onlyInGraph = [...graphIds].filter((id) => !exchangeIds.has(id)).length;
  const equal = onlyInGraph === 0 && EXCHANGE_TYPES.every((type) => byType[type].onlyInExchange === 0);

  // R4 binding hazards.
  const mailCount = new Map<string, number>();
  for (const user of users) if (user.mail) mailCount.set(user.mail, (mailCount.get(user.mail) ?? 0) + 1);
  const upnDiffersFromMail = users.filter((user) => user.mail && user.upn && user.mail !== user.upn).length;
  const upnEqualsOtherMail = users.filter(
    (user) => user.upn && (mailCount.get(user.upn) ?? 0) - (user.mail === user.upn ? 1 : 0) > 0,
  ).length;

  // The binding check, its negative control and the link key form, on members in both lists with mail and a UPN:
  // a Graph-only member says nothing about the mailboxes the scope admits. A shared mailbox whose UPN differs from
  // its mail goes first (the binding the mirror relies on most), then any shared mailbox, then any member; the
  // control is another member in both lists.
  let checkStatus: number | null = null;
  const attempt = async <T>(run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof GraphHttpError)) throw error;
      checkStatus ??= error.status;
      return null;
    }
  };
  const inboxId = async (key: string): Promise<string | null> => {
    const folder = await attempt(() =>
      graphJson<{ id?: unknown }>(`/users/${encodeURIComponent(key)}/mailFolders/inbox?$select=id`, http, {
        headers: { Prefer: READER_PREFER },
      }),
    );
    return typeof folder?.id === 'string' && folder.id !== '' ? folder.id : null;
  };

  let sameMailboxByUpnAndId: boolean | null = null;
  let differentMembersDiffer: boolean | null = null;
  let linkKeyForm: GroupProbeReport['linkKeyForm'] = null;
  const candidates = users.filter(
    (user): user is GroupUser & { mail: string; upn: string } => !!user.mail && !!user.upn && exchangeIds.has(user.id),
  );
  const typeOf = (user: GroupUser): ExchangeMailboxType => exchangeIds.get(user.id) ?? 'Other';
  const shared = candidates.filter((user) => typeOf(user) === 'SharedMailbox');
  const first = shared.find((user) => user.upn !== user.mail) ?? shared[0] ?? candidates[0];
  const second = first ? candidates.find((user) => user.id !== first.id) : undefined;
  const checked: GroupProbeReport['checked'] = first
    ? { type: typeOf(first), upnDiffersFromMail: first.upn !== first.mail, controlType: second ? typeOf(second) : null }
    : null;
  if (first) {
    const byId = await inboxId(first.id);
    const byUpn = await inboxId(first.upn);
    if (byId !== null && byUpn !== null) sameMailboxByUpnAndId = byId === byUpn;
    if (second && byId !== null) {
      const other = await inboxId(second.id);
      if (other !== null) differentMembersDiffer = other !== byId;
    }
    const delta = await attempt(() =>
      graphJson<DeltaPage>(`/users/${encodeURIComponent(first.upn)}/mailFolders/inbox/messages/delta?$select=id`, http, {
        headers: { Prefer: LINK_PREFER },
      }),
    );
    // Only the link is read; the page's message ids are dropped here.
    const link = delta?.['@odata.nextLink'] ?? delta?.['@odata.deltaLink'];
    if (typeof link === 'string') {
      const key = mailboxKeyOfLink(link);
      linkKeyForm = key === first.upn ? 'upn' : key === first.id ? 'id' : 'other';
    }
  }

  return {
    status: 200,
    code: null,
    group: {
      users: users.length,
      withMail: users.filter((user) => user.mail).length,
      withUpn: users.filter((user) => user.upn).length,
      otherTypes,
      byType,
      onlyInGraph,
      equal,
      upnDiffersFromMail,
      upnEqualsOtherMail,
      sameMailboxByUpnAndId,
      differentMembersDiffer,
      linkKeyForm,
      checkStatus,
      checked,
    },
  };
}

export async function probeGraphScope(
  capability: ReaderCapability,
  http: GraphHttpOptions,
  target: ScopeProbeTarget,
): Promise<ScopeProbeResult> {
  requireReaderCapability(capability);
  // One attempt: a probe must not wait out throttling to look successful.
  const once: GraphHttpOptions = { ...http, maxAttempts: 1 };
  if (target.kind === 'group') return probeGroup(target, once);
  try {
    const res = await graphFetch(pathOf(target), { headers: { Accept: 'application/json' } }, once);
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status, code: null };
  } catch (error) {
    if (error instanceof GraphHttpError) return { status: error.status, code: error.code };
    throw error;
  }
}
