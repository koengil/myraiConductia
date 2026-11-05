/**
 * "Who has access" line for the Deal Folder and the Data Room, built only from
 * the deal's existing roster (GET /api/v1/deals/{dealId}/members). It states
 * who is on the deal; it does not widen or narrow what anyone can open.
 *
 * Bank viewers only. An outside viewer reads `outsideViewerAccessText`
 * instead: their own firm and the bank's deal team, never another outside
 * party's name or count. The roster API still returns every seat to outside
 * parties (handoff E25); the screens are not the boundary.
 */

import { DEAL_ROLE_LABELS, type DealRole } from '@/lib/constants/roles';

export type AccessMember = {
  displayName: string | null;
  fullName: string | null;
  email: string | null;
  isExternal: boolean;
  companyName: string | null;
  /** The seat's deal role ("seller", "buyer"), so a seat with no company still reads by its party. */
  dealRole: string | null;
};

export type AccessKind = 'deal-folder' | 'data-room';

function personName(member: AccessMember): string {
  return member.displayName?.trim() || member.fullName?.trim() || member.email?.trim() || 'Someone';
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

const LIMIT = ' Individual files can be limited further.';

const NAMES_SHOWN = 3;

function namesWithRemainder(names: readonly string[]): string {
  if (names.length <= NAMES_SHOWN) return list(names);
  const rest = names.length - NAMES_SHOWN;
  return `${names.slice(0, NAMES_SHOWN).join(', ')}, and ${rest} ${rest === 1 ? 'other' : 'others'}`;
}

/** One sentence naming who can open the room. Never blank: with no roster it says so plainly. */
export function whoHasAccessText(kind: AccessKind, members: readonly AccessMember[] | null): string {
  if (members === null) return 'Who has access on this deal: loading the deal team.';
  const inside = members.filter((member) => !member.isExternal);
  const outside = members.filter((member) => member.isExternal);
  const insideNames = namesWithRemainder(inside.map(personName));

  const team = inside.length > 0 ? `your firm's deal team (${insideNames})` : "your firm's deal team";
  if (kind === 'deal-folder') return `Who has access on this deal: ${team}.${LIMIT}`;

  const firms = new Map<string, number>();
  for (const member of outside) {
    const role = member.dealRole && Object.hasOwn(DEAL_ROLE_LABELS, member.dealRole)
      ? DEAL_ROLE_LABELS[member.dealRole as DealRole]
      : null;
    const firm = member.companyName?.trim() || role || 'Outside party';
    firms.set(firm, (firms.get(firm) ?? 0) + 1);
  }
  const firmText = Array.from(firms, ([firm, count]) => `${firm} (${count})`);
  if (firmText.length === 0) {
    return `Who has access on this deal: ${team}. No outside parties have been given access yet.${LIMIT}`;
  }
  return `Who has access on this deal: ${team}, plus ${list(firmText)}.${LIMIT}`;
}

/**
 * The line an outside viewer reads: their own firm and the bank's deal team,
 * and who decides access. It never names or counts another outside party.
 */
export function outsideViewerAccessText(ownFirm: string | null | undefined): string {
  const firm = ownFirm?.trim() || 'your firm';
  return `Who has access on this deal: ${firm} and the bank's deal team. The bank's deal team manages who has access.`;
}

/** Parse the roster response defensively; anything unexpected reads as "no roster". */
export function parseAccessMembers(payload: unknown): AccessMember[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const rows = (payload as { members?: unknown }).members;
  if (!Array.isArray(rows)) return null;
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  // A seat's company may be named only on the party list.
  const parties = (payload as { parties?: unknown }).parties;
  const partyNames = new Map<string, string>();
  if (Array.isArray(parties)) {
    for (const party of parties) {
      const p = (party ?? {}) as Record<string, unknown>;
      const id = text(p.companyId);
      const name = text(p.companyName);
      if (id && name) partyNames.set(id, name);
    }
  }
  return rows.map((row) => {
    const r = (row ?? {}) as Record<string, unknown>;
    const companyId = text(r.companyId);
    return {
      displayName: text(r.displayName),
      fullName: text(r.fullName),
      email: text(r.email),
      isExternal: r.isExternal === true,
      companyName: text(r.companyName) ?? (companyId ? (partyNames.get(companyId) ?? null) : null),
      dealRole: text(r.dealRole),
    };
  });
}
