export type PerspectiveId = 'storm' | 'mike' | 'dana' | 'external';

export type DestinationId =
  | 'mandate'
  | 'chat'
  | 'rail'
  | 'acquirers'
  | 'team'
  | 'mail'
  | 'dealFolder'
  | 'dataRoom'
  | 'skills'
  | 'audit';

// Exported so the perimeter preview reports the same permitted set the shell
// enforces, rather than keeping a second copy of it that could drift.
export const ALLOWED_DESTINATIONS: Record<PerspectiveId, ReadonlySet<DestinationId>> = {
  storm: new Set<DestinationId>([
    'mandate',
    'rail',
    'acquirers',
    'team',
    // The compliance email client is an internal (bank-side) instrument —
    // clients and buyers never see the firm's outbox.
    'mail',
    // The MD sees BOTH the internal Deal Folder and the external Data Room.
    'dealFolder',
    'dataRoom',
    'skills',
    'audit',
  ]),
  // The client (seller) sees the deal home, rail, the ranked buyers, the
  // cross-party Team, and the Data Room they stage into — but NOT
  // the internal Deal Folder (our work product; a nav-level internal-only
  // guarantee). Ask /chat is not in the MVP.
  mike: new Set<DestinationId>([
    'mandate',
    'rail',
    'acquirers',
    'team',
    'dataRoom',
  ]),
  // The buyer reaches the deal, its rail, Team, and the
  // Data Room — never the internal Deal Folder. NOTE: document-level gating
  // (MNPI classification + minPhase filtering) that the previous DataRoom
  // carried is not yet reintroduced in the current explorer; the room lists
  // every manifest entry regardless of perspective. Deferred to the backend
  // swap — see ADR-0009.
  dana: new Set<DestinationId>([
    'mandate',
    'rail',
    'team',
    'dataRoom',
  ]),
  // A real external user (platform_onboarding): a client-company or buyer-side
  // team member, resolved from users.is_external at the (authed) layout.
  // Reaches the deal rail, cross-party Team, Data Room, Mail, and Audit for
  // deals they are on. Never the internal Deal Folder, Buyers, or Skills.
  external: new Set<DestinationId>([
    'mandate',
    'rail',
    'dataRoom',
    'team',
    'mail',
    'audit',
  ]),
};

export function canAccessDestination(
  perspective: PerspectiveId,
  destination: DestinationId,
): boolean {
  return ALLOWED_DESTINATIONS[perspective].has(destination);
}

export function destinationFromPathname(pathname: string | null): DestinationId | null {
  if (!pathname) return null;
  if (!pathname.startsWith('/projects/')) return null;
  if (pathname.includes('/rail')) return 'rail';
  // The Book deal view (#191) carries the bank's fee, schedule and internal
  // phase roll-up, so it is bank-only: it takes the internal Deal Folder's
  // classification, and the shell sends outside parties to the deal home as
  // it does from the Deal Folder. Presentation only (ADR-0009); the server
  // still answers the Book's reads (handoff E26).
  if (pathname.includes('/book')) return 'dealFolder';
  if (pathname.includes('/acquirers')) return 'acquirers';
  // Historical links resolve through the compatibility redirect to Team.
  if (pathname.includes('/working-group')) return 'team';
  if (pathname.includes('/team')) return 'team';
  if (pathname.includes('/mail')) return 'mail';
  // Match the external Data Room BEFORE the internal Deal Folder.
  if (pathname.includes('/data-room')) return 'dataRoom';
  if (pathname.includes('/deal-folder')) return 'dealFolder';
  if (pathname.includes('/skills')) return 'skills';
  if (pathname.includes('/audit')) return 'audit';
  if (pathname.includes('/chat')) return 'chat';
  return 'mandate';
}
