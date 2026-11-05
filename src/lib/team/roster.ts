/**
 * Team roster across every party on a live deal.
 *
 * Team is the perpetually-updated list of everyone on the deal, across all
 * four sides: the client (seller), our sell-side advisory team, the buyers, and
 * their buy-side advisors. It is the human counterpart to the document rooms —
 * people, not files — and the seed for the platform's network effects (each
 * contact carries an email + a `platformStatus`, so an off-platform party can be
 * invited in later).
 *
 * This is a FIXTURE seed for the demo. The sell-advisor rows mirror the deal
 * team from `getTeam()` (Storm Duncan / James Watt / Sarah Reid) and the buyer
 * rows mirror the acquirer fixtures (Anthropic / Salesforce / …) so every
 * surface agrees. Live platform memberships stay beside the `ConductiaAPI`
 * seam; the fixture shape mirrors the roster that platform data returns.
 */

/** The four sides of a sell-side deal. */
export type TeamSide = 'client' | 'sell-advisor' | 'buyer' | 'buy-advisor';

/**
 * Whether a person is reachable on the platform yet. `off-platform` parties are
 * the invite targets (network-effects seed); the invite affordance is disabled
 * (`[Later]`) until real invitations ship.
 */
export type PlatformStatus = 'on-platform' | 'invited' | 'off-platform';

/** One person on the deal. `email` + `platformStatus` are the network seed. */
export type TeamPerson = {
  id: string;
  name: string;
  firm: string;
  side: TeamSide;
  role: string;
  email: string;
  phone?: string;
  platformStatus?: PlatformStatus;
};

/** Display order + labels for the four sides. */
export const TEAM_SIDE_ORDER: readonly TeamSide[] = [
  'client',
  'sell-advisor',
  'buyer',
  'buy-advisor',
];

export const TEAM_SIDE_LABELS: Record<TeamSide, string> = {
  client: 'Client (Seller)',
  'sell-advisor': 'Sell-side Advisors',
  buyer: 'Buyers',
  'buy-advisor': 'Buy-side Advisors',
};

/**
 * The seeded roster. Sell-advisors mirror the `getTeam()` names; buyers mirror
 * the acquirer fixtures. Client + buy-advisor rows are placeholders. Contact
 * details are fictional demo data.
 */
export const SEED_TEAM: readonly TeamPerson[] = [
  // Client (seller) — placeholder principals on the sell side.
  {
    id: 'client-cfo',
    name: 'Alex Whitfield',
    firm: 'Project Destiny (Client)',
    side: 'client',
    role: 'Chief Financial Officer',
    email: 'alex.whitfield@client.example',
    phone: '+61 2 8000 1200',
    platformStatus: 'off-platform',
  },
  {
    id: 'client-gc',
    name: 'Jordan Pace',
    firm: 'Project Destiny (Client)',
    side: 'client',
    role: 'General Counsel',
    email: 'jordan.pace@client.example',
    platformStatus: 'off-platform',
  },

  // Sell-side advisors — our deal team (mirrors getTeam(): Storm / James / Sarah).
  {
    id: 'sd',
    name: 'Storm Duncan',
    firm: 'Conductia Advisory',
    side: 'sell-advisor',
    role: 'Managing Director',
    email: 'storm.duncan@intelibank.example',
    phone: '+44 20 7100 3400',
    platformStatus: 'on-platform',
  },
  {
    id: 'jw',
    name: 'James Watt',
    firm: 'Conductia Advisory',
    side: 'sell-advisor',
    role: 'CFO Advisory',
    email: 'james.watt@intelibank.example',
    phone: '+44 20 7100 3401',
    platformStatus: 'on-platform',
  },
  {
    id: 'sr',
    name: 'Sarah Reid',
    firm: 'Conductia Advisory',
    side: 'sell-advisor',
    role: 'M&A Advisor',
    email: 'sarah.reid@intelibank.example',
    phone: '+44 20 7100 3402',
    platformStatus: 'on-platform',
  },

  // Buyers — corporate development contacts at the ranked acquirers.
  {
    id: 'buyer-anthropic',
    name: 'Priya Nair',
    firm: 'Anthropic',
    side: 'buyer',
    role: 'Head of Corporate Development',
    email: 'priya.nair@anthropic.example',
    phone: '+1 415 555 0110',
    platformStatus: 'off-platform',
  },
  {
    id: 'buyer-salesforce',
    name: 'Daniel Cole',
    firm: 'Salesforce',
    side: 'buyer',
    role: 'VP, Corporate Development',
    email: 'daniel.cole@salesforce.example',
    phone: '+1 415 555 0142',
    platformStatus: 'off-platform',
  },
  {
    id: 'buyer-microsoft',
    name: 'Rachel Kim',
    firm: 'Microsoft',
    side: 'buyer',
    role: 'Director, M&A',
    email: 'rachel.kim@microsoft.example',
    platformStatus: 'off-platform',
  },

  // Buy-side advisors — advisors representing a buyer (placeholder).
  {
    id: 'buy-advisor-1',
    name: 'Helena Ford',
    firm: 'Lazard',
    side: 'buy-advisor',
    role: 'Buy-side M&A Advisor',
    email: 'helena.ford@lazard.example',
    phone: '+1 212 555 0177',
    platformStatus: 'off-platform',
  },
];

// --- Project Harbor (GitLab) roster ------------------------------------------
// A genuinely different Team roster so switching deals changes the people,
// not just the label. Sell-advisors mirror the Harbor deal team; buyers mirror
// the Harbor acquirer set.
const HARBOR_TEAM: readonly TeamPerson[] = [
  { id: 'h-client-cfo', name: 'Dana Brooks', firm: 'Project Harbor (Client)', side: 'client', role: 'Chief Financial Officer', email: 'dana.brooks@client.example', phone: '+1 415 555 0301', platformStatus: 'off-platform' },
  { id: 'h-client-gc', name: 'Marcus Webb', firm: 'Project Harbor (Client)', side: 'client', role: 'General Counsel', email: 'marcus.webb@client.example', platformStatus: 'off-platform' },
  { id: 'sd', name: 'Storm Duncan', firm: 'Conductia Advisory', side: 'sell-advisor', role: 'Managing Director', email: 'storm.duncan@conductia.example', phone: '+44 20 7100 3400', platformStatus: 'on-platform' },
  { id: 'pm', name: 'Priya Mehta', firm: 'Conductia Advisory', side: 'sell-advisor', role: 'Vice President', email: 'priya.mehta@conductia.example', phone: '+44 20 7100 3410', platformStatus: 'on-platform' },
  { id: 'tc', name: 'Tom Clarke', firm: 'Conductia Advisory', side: 'sell-advisor', role: 'Associate', email: 'tom.clarke@conductia.example', phone: '+44 20 7100 3411', platformStatus: 'on-platform' },
  { id: 'h-buyer-google', name: 'Wei Zhang', firm: 'Google Cloud', side: 'buyer', role: 'Head of Corporate Development', email: 'wei.zhang@google.example', phone: '+1 650 555 0120', platformStatus: 'off-platform' },
  { id: 'h-buyer-msgithub', name: 'Elena Rossi', firm: 'Microsoft (GitHub)', side: 'buyer', role: 'Director, M&A', email: 'elena.rossi@microsoft.example', platformStatus: 'off-platform' },
  { id: 'h-buyer-atlassian', name: 'Sam Okafor', firm: 'Atlassian', side: 'buyer', role: 'VP, Corporate Development', email: 'sam.okafor@atlassian.example', platformStatus: 'off-platform' },
  { id: 'h-buy-advisor-1', name: 'Nina Patel', firm: 'Qatalyst Partners', side: 'buy-advisor', role: 'Buy-side M&A Advisor', email: 'nina.patel@qatalyst.example', phone: '+1 415 555 0188', platformStatus: 'off-platform' },
];

/** Roster keyed by deal (the /projects/[projectId] slug). Adding a deal is one
 *  entry; a deal with no authored roster (created / unknown) resolves to an
 *  EMPTY roster — never another deal's people (coherent with the empty content
 *  dataset + empty Data Room). */
const TEAM_BY_DEAL: Record<string, readonly TeamPerson[]> = {
  'project-summit': SEED_TEAM,
  atlassian: SEED_TEAM,
  'project-harbor': HARBOR_TEAM,
};

const EMPTY_TEAM: readonly TeamPerson[] = [];

/** Resolve a deal's Team roster. */
export function teamRosterFor(dealId: string | undefined): readonly TeamPerson[] {
  return (dealId && TEAM_BY_DEAL[dealId]) || EMPTY_TEAM;
}

/** A side plus its people, in canonical order. Empty sides are dropped. */
export type TeamSection = { side: TeamSide; label: string; people: TeamPerson[] };

/** Group a roster into ordered, non-empty sections (one per side). */
export function groupBySide(
  people: readonly TeamPerson[] = SEED_TEAM,
): TeamSection[] {
  return TEAM_SIDE_ORDER.map((side) => ({
    side,
    label: TEAM_SIDE_LABELS[side],
    people: people.filter((p) => p.side === side),
  })).filter((section) => section.people.length > 0);
}

// --- Live roster (platform_onboarding) ---------------------------------------
// Shapes returned by GET /api/v1/deals/{dealId}/members. The fixture types
// above stay untouched: flag-off keeps rendering the seeded roster.

/** One live seat on the deal, joined to its holder. */
export type LiveMember = {
  userId: string;
  displayName: string | null;
  fullName: string | null;
  email: string | null;
  dealRole: string;
  phase: number;
  isExternal: boolean;
  companyId: string | null;
  companyName: string | null;
  companyRole: string | null;
};

/** One party company on the deal (target / co-seller / shortlisted acquirer). */
export type LiveParty = {
  companyId: string;
  companyName: string | null;
  partyRole: string;
};

/** The full GET /members payload. */
export type LiveRoster = {
  members: LiveMember[];
  parties: LiveParty[];
  bankCompanyId: string | null;
};

/** A company plus the members seated under it, for the grouped live roster. */
export type LiveCompanySection = {
  companyId: string;
  companyName: string;
  /** Party role for party companies; 'bank' for the owning bank; null otherwise. */
  partyRole: string | null;
  members: LiveMember[];
};

/**
 * Group the live roster by company: the bank first, then the deal's parties in
 * party order, then any remaining member firms. Members with no company fall
 * into a trailing "Unaffiliated" section so nobody silently disappears.
 */
export function groupByCompany(roster: LiveRoster): LiveCompanySection[] {
  const sections: LiveCompanySection[] = [];
  const seen = new Set<string>();

  const push = (companyId: string, companyName: string | null, partyRole: string | null) => {
    if (seen.has(companyId)) return;
    seen.add(companyId);
    sections.push({
      companyId,
      companyName: companyName ?? 'Unknown company',
      partyRole,
      members: roster.members.filter((m) => m.companyId === companyId),
    });
  };

  if (roster.bankCompanyId) {
    const bankMember = roster.members.find((m) => m.companyId === roster.bankCompanyId);
    push(roster.bankCompanyId, bankMember?.companyName ?? null, 'bank');
  }
  for (const party of roster.parties) {
    push(party.companyId, party.companyName, party.partyRole);
  }
  for (const member of roster.members) {
    if (member.companyId) push(member.companyId, member.companyName, null);
  }

  const unaffiliated = roster.members.filter((m) => !m.companyId);
  if (unaffiliated.length > 0) {
    sections.push({
      companyId: '__unaffiliated__',
      companyName: 'Unaffiliated',
      partyRole: null,
      members: unaffiliated,
    });
  }

  return sections;
}
