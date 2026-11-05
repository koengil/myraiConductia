// Fixture deal set for the demo flow (login → portfolio → insight → create →
// rail). Deals are FIXTURES for now: the logged-in user is "on" a couple of
// seeded deals, can research any company (also fixture-backed, all resolving to
// the Atlassian sandbox dataset), and can create a new mandate that lands on
// the rail at day one. Created deals persist in localStorage so a refresh mid
// demo does not lose them. The real swap is POST /api/v1/deals (ADR-0008); the
// shape here mirrors what that returns so the swap is mechanical.

import type { LifecycleCategory, ScheduleStatus } from '../constants/deals';
import type { DealStepRecord } from './dealStepRecord';
import { TEASER_STEP_ID, stepIdForSeq, stepIndexById, MVP_DEAL_RAIL, firstStepAfterGate0 } from './dealRail';

export type ConflictsAttestation = {
  approvedBy: string;
  approvedOn: string;
};

/** One deal-team access grant with provenance (who seated whom, when). */
export type DealTeamGrant = {
  id: string;
  role: string;
  addedBy: string;
  addedOn: string;
};

export type DealCurrentStep = {
  stepId: string;
  seq: number | null;
  phaseIndex: number | null;
  title: string | null;
};

export type FixtureDeal = {
  /** Slug used as the /projects/[id] segment. */
  id: string;
  /** Code name the MD gives the deal (Project X). */
  codename: string;
  /** Minted deal code (PREFIX-YEAR-NNN), mirrors mintDealCode. */
  code: string;
  /** The company being taken to market. */
  target: string;
  /** The selected lead's company id (Task 3: a project is created by
   *  SELECTING an existing lead, not typing a name). Always set for deals
   *  created through the wizard's lead typeahead. */
  targetCompanyId?: string;
  sector: string;
  /** Human-readable phase label for the portfolio card. */
  status: string;
  /** The rail step the deal is currently on (drives the cursor). */
  cursorStepId: string;
  currentStep?: DealCurrentStep | null;
  /** The canonical step seq (1..65) where the deal entered the lifecycle —
   *  Gate 0's "confirm where in the lifecycle the deal is entering". */
  entryStepSeq: number;
  /** Whether the Gate 0 actions (team, code name, notifications, entry point)
   *  are complete for this deal. Seeded deals are past the gate. */
  gate0Complete: boolean;
  /** Gate 0 team selection — ids + fixture persona roles from the wizard. */
  team?: { id: string; role: string }[];
  /** Team seated at mandate intake, with who added each member. */
  teamIntake?: DealTeamGrant[];
  /** Members added after project creation. */
  teamLater?: DealTeamGrant[];
  /** Seq 6 conflicts attestation — recorded at mandate intake (Gate 0). */
  conflictsAttestation?: ConflictsAttestation;
  /** The logged-in user's deal role on this deal. */
  dealRole: string;
  /** When the mandate was created (ISO). Gate 0 step 1 reads this for "Created on". */
  createdAt?: string;
  /** Display name of the MD who opened the deal. Gate 0 step 1 reads this for "Created by". */
  createdBy?: string;
  /** The MD's target close date (ISO date), a real column since the Book
   *  graduation (#191). Null / absent = not set. */
  targetCloseDate?: string | null;
  /** The mandate fee in whole USD, a real column since the Book graduation
   *  (#191). Null / absent = not set. */
  feeUsd?: number | null;
  /** The MD's read of the deal against plan (ahead | on_time | late), a real
   *  column since the Book graduation (#191). Null / absent = not set. */
  scheduleStatus?: ScheduleStatus | null;
  /** Storm's Book lifecycle category, a real column since the Book graduation
   *  (#191). Absent = 'live' (the column's default). */
  lifecycleCategory?: LifecycleCategory;
  /** The platform's per-step records (assignee, completer, logged skip),
   *  loaded beside the deal on the rail surface. Absent on fixtures. */
  stepRecords?: readonly DealStepRecord[];
  isNew?: boolean;
};

/** The deals the logged-in MD is already on (seeded fixtures). Typed as a
 *  two-element tuple so consumers that index the seeds (DealHome's default
 *  code name, the rail tests) are compile-checked: trimming the fixture
 *  becomes a type error, not a runtime crash. */
export const SEED_DEALS: readonly [FixtureDeal, FixtureDeal] = [
  {
    id: 'project-summit',
    codename: 'Project Summit',
    code: 'SUM-2026-014',
    target: 'Atlassian',
    sector: 'Collaboration software',
    status: 'Preparation',
    cursorStepId: TEASER_STEP_ID,
    entryStepSeq: 1,
    gate0Complete: true,
    dealRole: 'Managing Director',
    createdBy: 'Storm Duncan',
    createdAt: '2026-05-01T10:00:00.000Z',
    conflictsAttestation: { approvedBy: 'Avery Lindqvist', approvedOn: '2026-05-12' },
    teamIntake: [
      { id: 'sd', role: 'MD', addedBy: 'Storm Duncan', addedOn: '2026-05-01' },
      { id: 'jw', role: 'CFO', addedBy: 'Storm Duncan', addedOn: '2026-05-01' },
      { id: 'sr', role: 'M&A Advisor', addedBy: 'Storm Duncan', addedOn: '2026-05-01' },
    ],
  },
  {
    id: 'project-harbor',
    codename: 'Project Harbor',
    code: 'HAR-2026-021',
    target: 'GitLab',
    sector: 'DevOps platform',
    status: 'Origination',
    cursorStepId: 'p1-s12',
    entryStepSeq: 1,
    gate0Complete: true,
    dealRole: 'Managing Director',
    createdBy: 'Storm Duncan',
    createdAt: '2026-04-20T14:30:00.000Z',
    conflictsAttestation: { approvedBy: 'Avery Lindqvist', approvedOn: '2026-04-28' },
    teamIntake: [
      { id: 'sd', role: 'MD', addedBy: 'Storm Duncan', addedOn: '2026-04-20' },
      { id: 'pm', role: 'VP', addedBy: 'Storm Duncan', addedOn: '2026-04-20' },
      { id: 'tc', role: 'Associate', addedBy: 'Storm Duncan', addedOn: '2026-04-20' },
    ],
    teamLater: [
      { id: 'sr', role: 'M&A Advisor', addedBy: 'Storm Duncan', addedOn: '2026-05-10' },
    ],
  },
] as const;

/** Companies the user can research and then create a mandate on. */
export type SearchableCompany = { id: string; name: string; sector: string };

export const SEARCHABLE_COMPANIES: readonly SearchableCompany[] = [
  { id: 'canva', name: 'Canva', sector: 'Visual design platform' },
  { id: 'figma', name: 'Figma', sector: 'Design collaboration' },
  { id: 'databricks', name: 'Databricks', sector: 'Data & AI platform' },
  { id: 'notion', name: 'Notion', sector: 'Productivity software' },
] as const;

/** localStorage key of the fixture deal store. A cross-tab `storage` event on
 *  this key (or a storage clear) is a deal-list change; no other key is. */
export const DEALS_STORE_KEY = 'ib-fixture-deals';
const STORE_KEY = DEALS_STORE_KEY;

/** Slugify a free-text company name into a URL-safe id. */
export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'target'
  );
}

/** Resolve a searchable company by slug, or derive one from the raw query. */
export function resolveCompany(query: string): SearchableCompany {
  const slug = slugify(query);
  const known = SEARCHABLE_COMPANIES.find(
    (c) => c.id === slug || c.name.toLowerCase() === query.toLowerCase().trim(),
  );
  if (known) return known;
  const name = query.trim().replace(/\b\w/g, (m) => m.toUpperCase()) || 'Target';
  return { id: slug, name, sector: 'Private company' };
}

/** Mint a demo deal code (PREFIX-YEAR-NNN) from a codename. */
export function mintDemoCode(codename: string): string {
  const prefix = (codename.replace(/[^a-zA-Z]/g, '').slice(0, 3) || 'DEA').toUpperCase();
  const n = Math.floor(100 + Math.random() * 899);
  return `${prefix}-2026-${n}`;
}

// Themed code words — a banker picks a theme and every name (and later every
// counterparty in the deal) stays on that theme (Storm's Easter egg, 2026-07-09:
// "project bird → everyone's a bird"). None reference a company, so a code name
// built from them always masks the target (the compliance requirement).
export type CodenameTheme = 'birds' | 'football' | 'movies';

export const CODENAME_THEME_LABELS: Record<CodenameTheme, string> = {
  birds: 'Birds',
  football: 'Football',
  movies: 'Movies',
};

const CODENAME_THEMES: Record<CodenameTheme, string[]> = {
  birds: ['Falcon', 'Osprey', 'Kestrel', 'Heron', 'Raven', 'Sparrow', 'Condor', 'Merlin', 'Puffin', 'Ibis', 'Egret', 'Harrier'],
  football: ['Gunners', 'Rovers', 'Wanderers', 'Rangers', 'Albion', 'Forest', 'Hotspur', 'Athletic', 'Villa', 'County', 'Palace', 'Saints'],
  movies: ['Meridian', 'Vertex', 'Halcyon', 'Cascade', 'Orion', 'Zephyr', 'Cobalt', 'Lumen', 'Atlas', 'Beacon', 'Summit', 'Harbor'],
};

export const CODENAME_THEME_IDS = Object.keys(CODENAME_THEMES) as CodenameTheme[];

/**
 * Propose a few good code names ON A THEME. Deterministic for a given company +
 * theme + offset (SSR-stable); pass a random offset to regenerate. Uses a stride
 * coprime with the word count so the picks are always distinct.
 */
export function proposeCodenamesByTheme(
  theme: CodenameTheme,
  company: SearchableCompany,
  count = 4,
  offset = 0,
): string[] {
  const words = CODENAME_THEMES[theme];
  const n = words.length;
  const start = (company.id.length + offset) % n;
  const out: string[] = [];
  for (let i = 0; i < Math.min(count, n); i += 1) {
    out.push(`Project ${words[(start + i * 5) % n]}`);
  }
  return out;
}

/** Back-compat wrapper — themed proposal defaulting to the neutral 'movies' set. */
export function proposeCodenames(
  company: SearchableCompany,
  count = 4,
  offset = 0,
): string[] {
  return proposeCodenamesByTheme('movies', company, count, offset);
}

/** A default codename for a freshly researched company. */
export function proposeCodename(company: SearchableCompany): string {
  return proposeCodenames(company, 1)[0];
}

/** A code name must not contain the target's name — it has to mask it. */
export function codenameMasksCompany(
  codename: string,
  company: SearchableCompany,
): boolean {
  const name = company.name.trim().toLowerCase();
  if (!name) return true;
  return !codename.trim().toLowerCase().includes(name);
}

// --- localStorage-backed created deals -----------------------------------

/**
 * Normalize a stored deal against the current rail census: default the Gate 0
 * fields (records persisted before the 5/65 re-census lack them) and remap a
 * cursor pointing at a retired step id onto the deal's entry step.
 */
function localDateFromIso(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function normalizeStoredDeal(deal: FixtureDeal): FixtureDeal {
  const entryStepSeq =
    typeof deal.entryStepSeq === 'number' && deal.entryStepSeq >= 1
      ? deal.entryStepSeq
      : 1;
  const gate0Complete =
    typeof deal.gate0Complete === 'boolean' ? deal.gate0Complete : true;
  const cursorStepId =
    stepIndexById(deal.cursorStepId, MVP_DEAL_RAIL) >= 0
      ? deal.cursorStepId
      : stepIdForSeq(entryStepSeq, MVP_DEAL_RAIL);
  let teamIntake = deal.teamIntake;
  if (!teamIntake?.length && deal.team?.length) {
    const addedBy = deal.createdBy?.trim() || 'Storm Duncan';
    const addedOn = localDateFromIso(deal.createdAt) || '2026-01-01';
    teamIntake = deal.team.map((m) => ({ ...m, addedBy, addedOn }));
  }
  return {
    ...deal,
    entryStepSeq,
    gate0Complete,
    cursorStepId,
    ...(teamIntake?.length ? { teamIntake } : {}),
  };
}

function readStore(): FixtureDeal[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as FixtureDeal[];
    return Array.isArray(parsed) ? parsed.map(normalizeStoredDeal) : [];
  } catch {
    return [];
  }
}

/** Fires whenever the deal set changes (a deal is created), so any surface
 *  showing the deal list (the sidebar) re-reads and shows the new deal
 *  immediately — the same first-class path every future deal follows. */
export const DEALS_EVENT = 'ib:deals';

function writeStore(deals: FixtureDeal[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(deals));
    window.dispatchEvent(new Event(DEALS_EVENT));
  } catch {
    // ignore quota / disabled storage — the demo still works in-session
  }
}

/** All deals the user is on: seeded + any they created this/last session. */
export function getAllDeals(): FixtureDeal[] {
  const stored = readStore();
  const seedIds = new Set(SEED_DEALS.map((d) => d.id));
  return [...SEED_DEALS, ...stored.filter((d) => !seedIds.has(d.id))];
}

/** True when a deal answers to a /projects/[projectId] segment. Real
 *  navigation puts the deal CODE there; the demo puts the fixture slug. */
export function dealMatchesId(deal: FixtureDeal, id: string): boolean {
  return deal.id === id || deal.code === id;
}

/** Resolve a deal by its route segment — the fixture slug OR the deal code.
 *  Returns null when nothing matches: an unknown segment must never render a
 *  different, real deal's identity. */
export function resolveDeal(id: string): FixtureDeal | null {
  return getAllDeals().find((d) => dealMatchesId(d, id)) ?? null;
}

/** Overlay Gate 0 intake fields from the fixture store when the platform list
 *  row is sparse (API path) or the route id differs from the stored slug. */
export function overlayFixtureDealFields(deal: FixtureDeal): FixtureDeal {
  const stored = getAllDeals().find(
    (d) => d.id === deal.id || d.code === deal.code || d.id === deal.code,
  );
  if (!stored) return deal;
  return {
    ...stored,
    ...deal,
    team: deal.team?.length ? deal.team : stored.team,
    teamIntake: deal.teamIntake?.length ? deal.teamIntake : stored.teamIntake,
    conflictsAttestation: deal.conflictsAttestation ?? stored.conflictsAttestation,
    createdBy: deal.createdBy ?? stored.createdBy,
    createdAt: deal.createdAt ?? stored.createdAt,
    gate0Complete: deal.gate0Complete || stored.gate0Complete,
  };
}

/** Create a new fixture deal from a researched company and persist it.
 *  The Gate 0 wizard passes the lifecycle entry point (`entryStepSeq`); the
 *  plain create path defaults to day one (seq 1, Target Universe). */
export function createDeal(
  company: SearchableCompany,
  codename: string,
  opts: {
    entryStepSeq?: number;
    gate0Complete?: boolean;
    team?: { id: string; role: string }[];
    conflictsAttestation?: ConflictsAttestation;
    createdBy?: string;
  } = {},
): FixtureDeal {
  const postGate0 = firstStepAfterGate0();
  const entryStepSeq = opts.entryStepSeq ?? postGate0?.seq ?? 12;
  const resolvedCodename = codename.trim() || proposeCodename(company);
  const createdAt = new Date().toISOString();
  const createdBy = opts.createdBy?.trim() || 'Storm Duncan';
  const addedOn = localDateFromIso(createdAt);
  const teamIntake = opts.team?.length
    ? opts.team.map((m) => ({ ...m, addedBy: createdBy, addedOn }))
    : undefined;
  const deal: FixtureDeal = {
    // COMPLIANCE: the slug is the deal's CODE NAME, never the target company.
    // The URL, browser history, and any shared link must not name the masked
    // seller — the target lives only in `target` below. (Two deals sharing a
    // code name would collide on one slug; acceptable for the fixture store,
    // which overwrites by id.)
    id: slugify(resolvedCodename),
    codename: resolvedCodename,
    code: mintDemoCode(resolvedCodename),
    target: company.name,
    targetCompanyId: company.id,
    sector: company.sector,
    status: 'Origination',
    // Gate 0 complete → cursor lands on the first post-intake step (Relationship Pathing).
    cursorStepId:
      opts.gate0Complete && postGate0 && opts.entryStepSeq == null
        ? postGate0.id
        : stepIdForSeq(entryStepSeq, MVP_DEAL_RAIL),
    entryStepSeq,
    gate0Complete: opts.gate0Complete ?? true,
    ...(opts.team?.length ? { team: opts.team } : {}),
    ...(teamIntake ? { teamIntake } : {}),
    ...(opts.conflictsAttestation ? { conflictsAttestation: opts.conflictsAttestation } : {}),
    dealRole: 'Managing Director',
    isNew: true,
    createdAt,
    createdBy,
  };
  const stored = readStore().filter((d) => d.id !== deal.id);
  writeStore([...stored, deal]);
  return deal;
}

// --- per-deal token consumption ------------------------------------------
// Agent work consumes tokens; we allocate that consumption to the deal so a
// budget-consumed view can be built on top. Persisted in localStorage; a window
// event lets any surface re-read the running total live.

const TOKENS_KEY = 'ib-deal-tokens';
export const DEAL_TOKENS_EVENT = 'ib:deal-tokens';

function readTokens(): Record<string, number> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(TOKENS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, number>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Tokens allocated to a deal so far. */
export function getDealTokens(dealId: string): number {
  return readTokens()[dealId] ?? 0;
}

/** Allocate token consumption to a deal and notify listeners. */
export function addDealTokens(dealId: string, tokens: number): void {
  if (typeof window === 'undefined' || !dealId || tokens <= 0) return;
  const map = readTokens();
  map[dealId] = (map[dealId] ?? 0) + tokens;
  try {
    window.localStorage.setItem(TOKENS_KEY, JSON.stringify(map));
    window.dispatchEvent(new Event(DEAL_TOKENS_EVENT));
  } catch {
    // ignore quota / disabled storage
  }
}

export function clearStoredDeals(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(STORE_KEY);
  window.dispatchEvent(new Event(DEALS_EVENT));
}

export function clearDealTokens(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(TOKENS_KEY);
  window.dispatchEvent(new Event(DEAL_TOKENS_EVENT));
}
