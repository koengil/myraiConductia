import type { Viewer } from './inviteAccess';
import type { LiveRoster } from './roster';

/**
 * What Team shows an outside viewer (a seller's or a buyer's people): their
 * own seat, their own company's seats, and the bank's deal team. Never another
 * party's people, another bidder, or the parties list.
 *
 * Display filter only. The members API still returns every seat (handoff E25).
 * Bank viewers get the roster unchanged. A viewer not known (GET /me pending
 * or failed) gets the bank's people only: the filter fails closed.
 */
export function rosterShownTo(roster: LiveRoster, viewer: Viewer | null): LiveRoster {
  if (!viewer) {
    return {
      members: roster.members.filter((member) => !member.isExternal),
      parties: [],
      bankCompanyId: roster.bankCompanyId,
    };
  }
  if (!viewer.isExternal) return roster;
  const ownCompany = viewer.companyId;
  const isOwn = (companyId: string | null) => ownCompany !== null && companyId === ownCompany;
  return {
    members: roster.members.filter(
      (member) => member.userId === viewer.id || isOwn(member.companyId) || !member.isExternal,
    ),
    parties: roster.parties.filter((party) => isOwn(party.companyId)),
    bankCompanyId: roster.bankCompanyId,
  };
}

/** Pending invites an outside viewer may see: their own company's only. None while the viewer is not known. */
export function invitesShownTo<T extends { companyId: string }>(
  invites: readonly T[],
  viewer: Viewer | null,
): T[] {
  if (!viewer) return [];
  if (!viewer.isExternal) return [...invites];
  return invites.filter((invite) => viewer.companyId !== null && invite.companyId === viewer.companyId);
}
