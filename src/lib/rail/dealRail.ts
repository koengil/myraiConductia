// The Deal Rail — the sell-side lifecycle as a sequential checklist.
//
// 2026-07-08 re-census: the rail now consumes the canonical HV ledger
// (5 phases / 65 steps) via `railData.generated.ts` instead of the hand-set
// 7-phase / 26-step fixture. The generated file is the source of truth for the
// census (seq, phase, name, description, layer, buildOwner, executionClass,
// io, tools, priorityBuild, approvalBy, compliance); this module layers the
// product domain on top: reality, agent features, cursor helpers, always-on
// split, and the typed link toward the seam `Skill` ids.
//
// Two axes, kept separate:
//   • reality — how real the step is in the repo TODAY (live / schema /
//     planned). Derived here: the one spine-wired step (Teaser, seq 36) is
//     live; steps with canned agent features are schema; the rest planned.
//     This never changes as the deal progresses.
//   • state  — the checklist status (done / active / to-do) for a given deal.
//     NOT stored per step; it is DERIVED from a progress cursor so the same
//     rail can render "day one" (cursor at step 0) or any point mid-process,
//     and can be stepped forward in a demo.
//
// Two steps (`live: true`) are wired to a real runner: Teaser (in-process
// orchestration spine) and MD Briefing (Ignatious control plane).

import {
  GATE0_NOTIFY_STEP_ID,
  GATE0_STEP_IDS,
  GATE0_STEP_ID_SET,
} from './gate0';
import {
  GENERATED_PHASES,
  GENERATED_STEPS,
  type ExecutionClass,
  type GeneratedBuildOwner,
  type GeneratedIo,
  type GeneratedLayer,
  type GeneratedStep,
} from './railData.generated';

export {
  GATE0_MODAL_ENTRY_ENABLED,
  GATE0_NOTIFY_STEP_ID,
  GATE0_STEP_IDS,
  GATE0_STEP_ID_SET,
} from './gate0';
export type { Gate0StepId } from './gate0';
export {
  GATE0_ACTIONS,
  ALWAYS_ON_APPS,
  EXECUTION_CLASS_LABELS,
} from './railData.generated';
export type {
  ExecutionClass,
  GeneratedApp as AlwaysOnApp,
  GeneratedBuildOwner as RailBuildOwner,
  GeneratedIo as RailStepIo,
  GeneratedIoItem as RailStepIoItem,
  GeneratedLayer as RailLayer,
} from './railData.generated';

/** Who executes the step. Storm's rule: low-stakes → agent; high/external →
 *  agent drafts, human confirms + signs off. `both` = an agent-drafted step a
 *  human must approve. Derived from the ledger's execution class. */
export type RailActor = 'human' | 'agent' | 'both';

/** Derived checklist state of a step: what to do → doing → done. */
export type RailState = 'done' | 'active' | 'todo';

/** How real the step is in the repo today (honest status, not aspiration).
 *  live → wired to the orchestration spine · schema → canned agent features
 *  only, no real wiring · planned → not built. */
export type RailReality = 'live' | 'schema' | 'planned';

/** Which timeline a step belongs to. New Business Development (phase-1
 *  origination / pitch work) is a separate pre-mandate timeline, cut from the
 *  MVP execution rail. The execution timeline is the sell-side mandate itself
 *  (phases 2-5) plus the handful of phase-1 mandate-formation steps that always
 *  fire regardless of skips (see PERSISTENT_STEP_IDS). */
export type RailTimeline = 'new-biz-dev' | 'execution';

/** A person the agent suggests reaching out to, with public-signal context. */
export type AgentContact = { name: string; role: string; note: string };

/** A single agent capability available on a step. Rendered as a button; opens
 *  a modal that runs a short loader, then shows the draft / contacts. */
export type AgentFeature = {
  id: string;
  /** Button label. */
  label: string;
  /** Modal title. */
  title: string;
  /** Modal description of what the agent did. */
  description: string;
  /** Loader lines shown before the output reveals. */
  loading: string[];
  /** A proposed draft (email / document), shown verbatim. Illustrative. */
  draft?: string;
  /** Structured contact suggestions. */
  contacts?: AgentContact[];
};

export type RailStep = {
  /** Canonical step id, `p{phase}-s{seq}` (from the ledger). */
  id: string;
  /** Canonical 1-based sequence across the whole rail (1..65). */
  seq: number;
  title: string;
  /** What the step does, per the ledger. */
  description: string;
  /** Owner label rendered on the card (derived from `buildOwner`). */
  owner: string;
  actor: RailActor;
  /** Vertical (deal-lifecycle) vs hybrid (platform/OS) step. */
  layer: GeneratedLayer;
  /** Who builds it: RTS (vertical skills) or the Futureproofing OS. */
  buildOwner: GeneratedBuildOwner;
  /** Agent/human execution class (A / A+H / H+A / H). */
  executionClass: ExecutionClass;
  /** The step's contract: inputs → transformation → outputs + constraints. */
  io: GeneratedIo;
  tools: string[];
  /** ★ — one of the 16 priority builds. */
  priorityBuild: boolean;
  /** Who gates the step before its output is used. */
  approvalBy: string;
  compliance: string[];
  /** The mechanism note — the API/rule that backs the step in this repo. */
  skill?: string;
  /** Typed link to a seam `Skill.id` (src/lib/api/types.ts) where one exists. */
  skillId?: string;
  reality: RailReality;
  /** When true, this step launches the live orchestration runner. */
  live?: boolean;
  /** Handled entirely off the platform (e.g. a pitch meeting); no system
   *  action, only a human confirmation that it happened. */
  offPlatform?: boolean;
  /** One-line description of what an agent WOULD do on this step, surfaced as a
   *  preview on agent-owned steps that are not yet wired to a real workflow. */
  agentPreview?: string;
  /** A sample artifact the agent would produce (e.g. a draft outreach email),
   *  shown verbatim in the preview. Illustrative fixture, not generated. */
  agentDraft?: string;
  /** Explicit agent capabilities on this step (each opens a modal). When
   *  present, these replace the central STEP_FEATURES entry. */
  agentFeatures?: AgentFeature[];
  note?: string;
  /** New Business Development (pre-mandate origination) vs the execution rail.
   *  Derived: phase-1 non-persistent steps are new-biz-dev; everything else is
   *  execution. */
  timeline: RailTimeline;
  /** True for the mandate-formation steps that always fire regardless of skips.
   *  They stay on the execution (MVP) rail even though they live in phase 1. */
  persistent?: boolean;
  /** One-line value proposition shown on the governed-skill surfaces in place
   *  of the raw ledger description — why the governed skill beats the manual
   *  status quo. Derived from STEP_WHY with a generic fallback. */
  whyBetter?: string;
  /** True for the four mandate-intake steps that mirror Gate 0 (steps 1–4 on
   *  the MVP rail). */
  gate0?: boolean;
};

export type RailPhase = {
  id: string;
  /** Canonical phase number, 1..5. */
  index: number;
  name: string;
  /** The `deals.status` this phase maps to (src/lib/constants/deals.ts). */
  dealStatus: string;
  /** Who works the phase today (from the ledger whiteboard panels). */
  roles: string[];
  /** The tools the phase runs on today. */
  tools: string[];
  steps: RailStep[];
};

/** The in-process spine-wired step: Teaser (drafted by TeaserRunner). */
export const TEASER_STEP_SEQ = 36;

/** The live teaser step — the natural "in preparation" cursor for the demo. */
export const TEASER_STEP_ID = 'p2-s36';

/** Seq 9 — MD Briefing, run remotely on the Ignatious control plane. */
export const MD_BRIEFING_STEP_SEQ = 9;
export const MD_BRIEFING_STEP_ID = 'p1-s9';

/** Seq 8 — Relationship Pathing (first post–Gate 0 execution step). */
export const RELATIONSHIP_PATHING_STEP_ID = 'p1-s8';

/** The phase-1 steps that always fire regardless of skips — the mandate-
 *  formation spine from Codename through Engagement Negotiation (inclusive of
 *  the pitch arc: case studies, economics, deck, QC, rehearsal, follow-up).
 *  They stay on the execution (MVP) timeline even though they live in phase 1;
 *  everything else in phase 1 is New Business Development, a separate
 *  pre-mandate timeline. */
export const PERSISTENT_STEP_IDS: ReadonlySet<string> = new Set([
  'p1-s6',
  'p1-s7',
  'p1-s8',
  'p1-s9',
  'p1-s10',
  'p1-s11',
  'p1-s12',
  'p1-s13',
  'p1-s14',
  'p1-s15',
  'p1-s16',
  'p1-s17',
  'p1-s18',
  'p1-s19',
  'p1-s20',
  'p1-s21',
  'p1-s22',
  'p1-s23',
  'p1-s24',
  'p1-s25',
]);

export const BUILD_OWNER_LABEL: Record<GeneratedBuildOwner, string> = {
  rts: 'RTS',
  'futureproofing-os': 'Futureproofing OS',
};

export const LAYER_LABEL: Record<GeneratedLayer, string> = {
  vertical: 'Vertical',
  hybrid: 'Hybrid',
};

/** deals.status per canonical phase: the mandate is won at the end of phase 1
 *  (intake until then); the deal is active through marketing and diligence;
 *  phase 5 carries it from signing to the closed record. */
const PHASE_DEAL_STATUS: Record<number, string> = {
  1: 'intake',
  2: 'active',
  3: 'active',
  4: 'active',
  5: 'active → closed',
};

function actorForClass(cls: ExecutionClass): RailActor {
  if (cls === 'A') return 'agent';
  if (cls === 'H') return 'human';
  return 'both';
}

/**
 * Domain overrides layered onto the generated census: the mechanism notes
 * (what backs the step in THIS repo today) and the typed seam-skill links.
 * Everything else on a step comes straight from the ledger.
 */
const STEP_OVERRIDES: Record<
  string,
  Pick<RailStep, 'skill' | 'skillId' | 'note' | 'offPlatform'>
> = {
  // Phase 1 — origination, qualification & mandate
  'p1-s2': { skillId: 'deal-readiness' },
  'p1-s3': { skillId: 'culture-signal' },
  // Build status (engineers, never shown): screening rules real; intake boot not yet wired.
  'p1-s6': {
    skill: 'KYC→FINRA→MNPI cascade (compliance/screen.ts)',
  },
  'p1-s7': { skill: 'POST /api/v1/deals: auto-mint PREFIX-YEAR-NNN' },
  // Build status (engineers, never shown): remote skill. Conductia starts the
  // run; the agent pulls the lead from Conductia or the Ignatious mock.
  'p1-s9': {
    skill: 'POST /v1/agents/md-briefing/runs: Ignatious control plane',
    note: 'Conductia drafts the MD brief. You review it.',
  },
  'p1-s17': { skillId: 'acquirer-fit' },
  // Phase 2 — preparation & market readiness
  'p2-s26': { skill: 'POST /deals/{id}/members: roles md/deal_team/legal/cco/admin' },
  // Build status (engineers, never shown): schema real; secure storage vendor open (D31).
  'p2-s31': {
    skill: 'documents.classification + min_phase (phase-gate)',
  },
  'p2-s34': { skillId: 'financial-performance' },
  // No note: the step's plain line already says who drafts and who signs off.
  'p2-s36': {
    skill: 'Teaser workflow: research + draft + compliance',
  },
  // Phase 3 — marketing & first-round bids
  // Build status (engineers, never shown): gate real; comms send not wired.
  'p3-s39': {
    skill: 'compliance/supervisor.ts pre-send gate (clear/hold/block)',
  },
  'p3-s40': { skillId: 'synergy-engine' },
  'p3-s41': { skill: 'scoring/composite.ts re-run' },
  // Build status (engineers, never shown): audit real; storage not built.
  'p3-s43': {
    skill: 'min_phase + membership phase gate',
  },
  // Phase 5 — signing, closing & post-close
  'p5-s57': { skill: 'legal hold: place_legal_hold (blocks any purge)' },
  'p5-s59': { skill: 'audit_log: append-only, cannot be erased' },
};

/** The steps with an override above: tests check none shows build status. */
export const STEP_OVERRIDE_IDS: readonly string[] = Object.keys(STEP_OVERRIDES);

/**
 * Agent capabilities per canonical step, kept in a central map so the demo
 * shows an agent on the steps that have one. Illustrative fixtures,
 * re-keyed from the pre-census rail onto the nearest canonical step by
 * meaning. A step with an entry here renders as `schema` reality; the live
 * teaser step (seq 36) runs the real agent instead.
 */
const STEP_FEATURES: Record<string, AgentFeature[]> = {
  // Seq 2 — Exit Readiness (was seller-readiness)
  'p1-s2': [
    {
      id: 'score-readiness',
      label: 'Score readiness',
      title: 'Seller readiness score',
      description: 'A readiness score from the data room, with strengths and gaps.',
      loading: ['Reading the data room', 'Scoring readiness'],
      draft:
        'Readiness: 72 / 100.\nStrong: financials, tech.\nGaps: customer contracts not centralised; cap table needs a clean-up.',
    },
    {
      id: 'readiness-gaps',
      label: 'List the gaps to close',
      title: 'Gaps before go-to-market',
      description: 'The items to fix before taking the seller to market.',
      loading: ['Comparing to the checklist', 'Compiling gaps'],
      contacts: [
        { name: 'Customer contracts', role: 'Gap', note: 'Centralise the top 50 before go-to-market.' },
        { name: 'Cap table', role: 'Gap', note: 'Reconcile the options ledger.' },
        { name: 'KPI definitions', role: 'Gap', note: 'Lock the metric definitions.' },
      ],
    },
  ],
  // Seq 6 — Conflicts Checklist (was kyc-screen, inline)
  'p1-s6': [
    {
      id: 'screen-parties',
      label: 'Screen the parties',
      title: 'KYC / sanctions / adverse-media screen',
      description:
        'Verify the target and known counterparties: entity + beneficial owners, sanctions and PEP lists, and adverse media.',
      loading: [
        'Verifying the target entity',
        'Identifying beneficial owners',
        'Checking sanctions and PEP lists',
        'Scanning adverse media',
      ],
      draft:
        'Engagement screen: [Target]\n\nKYC: entity verified against registry; beneficial owners identified; no sanctions or PEP hits.\nAdverse media: no material findings in the last 24 months.\nCounterparties: known bidders screened; none sanctioned or restricted.\n\nResult: CLEAR to proceed, CCO sign-off requested before the mandate opens.',
    },
    {
      id: 'check-conflicts',
      label: 'Check conflicts & restricted list',
      title: 'Conflicts & restricted-list check',
      description:
        'Cross-reference the firm’s active mandates, restricted / watch list, and existing relationships for any conflict on the name.',
      loading: [
        'Cross-referencing active mandates',
        'Checking the restricted / watch list',
        'Reviewing existing relationships',
      ],
      draft:
        'Conflicts check: [Target]\n\nActive mandates: no live sell-side or buy-side conflict on the name.\nRestricted / watch list: [Target] not currently restricted.\nRelationships: research coverage on the name flagged. An information barrier is required between research and this deal team.\n\nResult: NO BLOCKING CONFLICT. One barrier to put in place (research).',
    },
    {
      id: 'wall-cross',
      label: 'Propose the wall-cross list',
      title: 'MNPI wall-cross & information barrier',
      description:
        'Who must be brought across the wall to work the deal, who must stay behind it, and who approves.',
      loading: [
        'Mapping who touches the deal',
        'Checking existing MNPI exposure',
        'Drafting the barrier',
      ],
      contacts: [
        {
          name: 'Deal team (5)',
          role: 'Wall-cross',
          note: 'Bring across under the deal code; log the cross and restrict personal trading.',
        },
        {
          name: 'Software research analyst',
          role: 'Barrier',
          note: 'Holds coverage on the name; must stay behind the wall.',
        },
        {
          name: 'Chief Compliance Officer',
          role: 'Approver',
          note: 'Approves the wall-cross list and the information barrier.',
        },
      ],
    },
  ],
  // Seq 7 — Codename / Deal Shell (was create-deal)
  'p1-s7': [
    {
      id: 'suggest-codenames',
      label: 'Suggest code names',
      title: 'Proposed code names',
      description: 'Neutral code names that mask the target across all external comms.',
      loading: ['Checking name collisions', 'Proposing options'],
      draft:
        'Proposed: Project Meridian, Project Vertex, Project Atlas.\nThe chosen name masks the target everywhere external.',
    },
  ],
  // Seq 8 — Relationship Pathing (was win-mandate, inline)
  'p1-s8': [
    {
      id: 'find-contacts',
      label: 'Find people to reach out to',
      title: 'Suggested contacts',
      description:
        'People at the target worth approaching first, ranked by public signal, with why each one matters.',
      loading: [
        'Scanning public sources',
        'Mapping the leadership team',
        'Ranking by relevance to a process',
        'Compiling the shortlist',
      ],
      contacts: [
        {
          name: 'Founder / CEO',
          role: 'Chief Executive',
          note: 'Sets strategic direction; the ultimate decision on running a process.',
        },
        {
          name: 'Chief Financial Officer',
          role: 'Finance',
          note: 'Owns the numbers and the valuation narrative; a key early ally.',
        },
        {
          name: 'Head of Corporate Development',
          role: 'Corp Dev',
          note: 'Handles inbound M&A; typically the fastest path to a first meeting.',
        },
        {
          name: 'Lead Independent Director',
          role: 'Board',
          note: 'Influential on any sale decision; best reached via a warm introduction.',
        },
      ],
    },
    {
      id: 'outreach-email',
      label: 'Draft outreach email',
      title: 'Outreach email to set up the pitch',
      description:
        'A first-contact email to the target’s leadership, drafted from public signal. The MD reviews and sends it.',
      loading: [
        'Reading public filings',
        'Identifying the decision-maker',
        'Drafting the outreach',
      ],
      draft:
        'To: [Founder / CFO, suggested from public filings]\nSubject: Introduction on strategic options for [Company]\n\nHi [Name],\n\nI lead the software franchise at the bank. We have followed [Company]’s trajectory closely and see a distinctive window for a strategic process. I would value 30 minutes to share how we would position the story and who we would take it to.\n\nWould early next week work for a brief call?\n\nBest,\nStorm Duncan\nManaging Director',
    },
  ],
  // Seq 9 — MD Briefing + Company Backgrounding
  'p1-s9': [
    {
      id: 'md-brief',
      label: 'Draft the MD brief',
      title: 'MD call brief',
      description:
        'Call objectives, questions to ask, relationship context, and the qualification score for the first conversation.',
      loading: [
        'Reading approved pathing',
        'Pulling referrer context',
        'Drafting objectives and questions',
      ],
      draft:
        'MD brief: first call\n\nObjectives: qualify timing and process appetite; confirm decision-makers; test fee tolerance.\nRelationship context: warm path via [referrer]; CFO flagged as early ally.\nQuestions: sale rationale now; board/investor alignment; competing banks in view.\nQualification score: 68. Pursue with confirmation on timing.',
    },
    {
      id: 'company-profile',
      label: 'Build the company profile',
      title: 'Source-cited company profile',
      description:
        'Product, model, ownership, financings, board, competitors, likely buyers, and transaction rationale: every claim cited.',
      loading: [
        'Pulling Capital IQ and PitchBook',
        'Mapping ownership and board',
        'Drafting the profile',
      ],
      draft:
        'Company profile: [Target]\n\nProduct: [category leader]; subscription model; [X] customers.\nOwnership: founder-led; last round [date]; lead investors listed.\nBoard: [names], independent chair influential on process.\nLikely buyers: strategics in [sub-sector] plus sponsor take-private.\nRationale: [timing catalyst]. Estimates flagged; sources in appendix.',
    },
    {
      id: 'case-studies',
      label: 'Surface relevant past deals',
      title: 'Ranked case studies',
      description:
        'Three to five precedents ranked by relevance, with an objection cross-reference for the first call.',
      loading: ['Searching the case study library', 'Ranking by sector fit', 'Pairing objections to precedents'],
      draft:
        'Relevant past deals\n\n1. [Same sub-sector]: dual-track process; closed above range; lesson: lead with certainty narrative.\n2. [Same sector]: founder retention critical; kept the team through close.\n\nIf they ask about X:\n• "Why now?" → [Deal 1] timing catalyst parallel.\n• "Who would buy us?" → [Deal 2] buyer set and rationale.',
    },
  ],
  // Seq 17 — Buyer Universe (was buyer-universe)
  'p1-s17': [
    {
      id: 'long-list',
      label: 'Build the buyer long list',
      title: 'Buyer long list',
      description: 'Candidate buyers ranked by fit.',
      loading: ['Scanning strategics + sponsors', 'Ranking by fit'],
      contacts: [
        { name: 'Anthropic', role: 'Strategic', note: 'Fit 87: product + culture aligned.' },
        { name: 'Salesforce', role: 'Strategic', note: 'Fit 67: overlap risk with Slack.' },
        { name: 'PE consortium', role: 'Financial', note: 'Take-private candidate.' },
      ],
    },
    {
      id: 'screen-buyers',
      label: 'Screen buyers for conflicts / antitrust',
      title: 'Buyer screen',
      description: 'Early conflict and antitrust read on the long list.',
      loading: ['Checking overlaps', 'Flagging antitrust risk'],
      draft:
        'Antitrust: one strategic overlaps in collaboration. Flag for early review.\nNo party currently restricted.',
    },
  ],
  // Seq 20 — Engagement Letter Strategy (was create-deal / engagement-letter)
  'p1-s20': [
    {
      id: 'engagement-letter',
      label: 'Draft the engagement letter',
      title: 'Engagement letter',
      description: 'A first draft of the sell-side engagement letter for MD + Legal review.',
      loading: ['Pulling the house template', 'Filling deal terms', 'Drafting'],
      draft:
        'Engagement letter: [Target]\nScope: sell-side advisory, exclusive.\nFee: retainer + success fee on close.\nTerm: 12 months.\n[For MD + Legal review]',
    },
  ],
  // Seq 26 — Mandate Activation Checklist (was stand-up-team / suggest-team)
  'p2-s26': [
    {
      id: 'suggest-team',
      label: 'Suggest the deal team',
      title: 'Recommended deal team',
      description: 'Team members by role and current load.',
      loading: ['Reading the staffing view', 'Matching skills to the mandate'],
      contacts: [
        { name: 'Analyst', role: 'Execution', note: 'Available; strong SaaS modelling.' },
        { name: 'Associate', role: 'Execution', note: 'Ran the last two software mandates.' },
        { name: 'VP', role: 'Coverage', note: 'Owns the client relationship.' },
      ],
    },
  ],
  // Seq 28 — Kickoff / Org Meeting (was stand-up-team / kickoff-invite)
  'p2-s28': [
    {
      id: 'kickoff-invite',
      label: 'Draft the kickoff invite',
      title: 'Kickoff invite',
      description: 'A kickoff meeting invite with an agenda.',
      loading: ['Assembling the agenda', 'Drafting the invite'],
      draft:
        'Kickoff: [Codename]\nAgenda: mandate, timeline, workstream owners, compliance.\nAttendees: deal team + CCO.\nWhen: this week.',
    },
  ],
  // Seq 30 — WGL (was assign-owners)
  'p2-s30': [
    {
      id: 'propose-owners',
      label: 'Propose owners per workstream',
      title: 'Workstream owners',
      description: 'A suggested owner for each workstream.',
      loading: ['Reading the team', 'Balancing load'],
      contacts: [
        { name: 'Valuation', role: 'Owner', note: 'Associate: models + football field.' },
        { name: 'Marketing', role: 'Owner', note: 'VP: teaser + CIM.' },
        { name: 'Compliance', role: 'Owner', note: 'CCO: screens every external item.' },
      ],
    },
    {
      id: 'raci',
      label: 'Draft the responsibility matrix',
      title: 'Responsibility matrix',
      description: 'A RACI-style matrix with limits.',
      loading: ['Mapping tasks to owners', 'Drafting'],
      draft:
        'RACI: [Codename]\nValuation: Associate (R), MD (A)\nMarketing: VP (R), MD (A)\nCompliance: CCO (R/A)\nLimit: nothing external without MD sign-off.',
    },
  ],
  // Seq 31 — VDR Setup (was data-room)
  'p2-s31': [
    {
      id: 'folder-structure',
      label: 'Propose the folder structure',
      title: 'Data room index',
      description: 'A standard index, classified and phase-gated.',
      loading: ['Reading the document set', 'Proposing the index'],
      draft:
        'Data room index:\n1. Corporate  2. Financials  3. Commercial\n4. Legal  5. Tech / IP  6. HR\nEach folder classified 1–4 and phase-gated.',
    },
    {
      id: 'classify',
      label: 'Classify + phase-gate documents',
      title: 'Classification plan',
      description: 'How each document is gated by sensitivity and buyer phase.',
      loading: ['Classifying documents', 'Setting phase gates'],
      draft:
        'Classification: public (1) → confidential (3) → MNPI (4).\nA buyer sees a folder only at or above their phase.',
    },
  ],
  // Seq 32 — Document Intake / Metadata (was connectors)
  'p2-s32': [
    {
      id: 'recommend-sources',
      label: 'Recommend sources to connect',
      title: 'Sources to connect',
      description: 'What to ingest and index for the downstream agents.',
      loading: ['Listing available sources', 'Mapping to the deal'],
      draft:
        'Connect: MD + team mailboxes, the deal drive, Salesforce (target + bidders), the VDR.\nEach is ingested, indexed, and permission-tagged to the deal code.',
    },
    {
      id: 'access-request',
      label: 'Draft the access request',
      title: 'Access request',
      description: 'A request to IT / the seller for scoped, logged access.',
      loading: ['Identifying owners', 'Drafting the request'],
      draft:
        'To: IT / Seller\nRequest read access to the deal drive and VDR for the deal team under [Codename].\nAccess is scoped and logged.',
    },
  ],
  // Seq 35 — Deal Pulse Checklist (was the always-on weekly update)
  'p2-s35': [
    {
      id: 'weekly-update',
      label: 'Weekly update',
      title: 'Weekly update',
      description: 'Draft the client and internal update from the live record.',
      loading: ['Reading the week’s activity', 'Drafting the update'],
      draft:
        'Client update: week of [date]\nTeaser out to 6 buyers; 4 IOIs expected Friday; management sessions next week.\nInternal: on timeline, no blockers.',
    },
  ],
  // Seq 37 — CIM / Management Presentation (was draft-cim)
  'p2-s37': [
    {
      id: 'cim-outline',
      label: 'Draft the CIM outline',
      title: 'CIM outline',
      description: 'A CIM outline against the house style.',
      loading: ['Pulling the house style', 'Structuring the CIM'],
      draft:
        'CIM outline:\n1. Executive summary  2. Market  3. Product\n4. Financials  5. Growth plan  6. Management\nMD reviews before it goes out.',
    },
    {
      id: 'mgmt-presentation',
      label: 'Draft the management presentation',
      title: 'Management presentation',
      description: 'A first-cut management deck.',
      loading: ['Assembling the story', 'Drafting slides'],
      draft: 'Management presentation: 18 slides covering story, moat, numbers and plan.\nFor MD + seller review.',
    },
  ],
  // Seq 39 — Outreach Sequencing (was send-teaser)
  'p3-s39': [
    {
      id: 'presend-qc',
      label: 'Pre-send compliance check',
      title: 'Pre-send QC',
      description: 'Every external item checked before it leaves the firm.',
      loading: ['Checking recipient + attachment', 'Screening figures + claims', 'Confirming approval'],
      draft:
        'Pre-send QC: recipient OK, attachment OK, code name OK, figures OK,\nno promissory language, MD approval present. CLEAR to send.',
    },
    {
      id: 'cover-note',
      label: 'Draft the buyer cover note',
      title: 'Buyer cover note',
      description: 'A short cover note for the teaser.',
      loading: ['Drafting the note'],
      draft:
        'Hi [Name], attached is a blind teaser for a category-leading SaaS business.\nHappy to discuss under NDA.',
    },
  ],
  // Seq 40 — Buyer Synergies Model + Valuation (was deep-dive)
  'p3-s40': [
    {
      id: 'generate-panels',
      label: 'Generate the analysis panels',
      title: 'Candidate deep-dive',
      description: 'The four analytical panels, summarised.',
      loading: ['Running valuation', 'Reading culture + synergy', 'Compiling'],
      draft:
        'Panels ready: valuation football field, culture matrix, synergy stress-test, founder read.\nHeadline: strong strategic fit; watch talent retention.',
    },
    {
      id: 'one-pager',
      label: 'Draft the one-pager',
      title: 'Candidate one-pager',
      description: 'A one-page read on the candidate.',
      loading: ['Pulling the key facts', 'Drafting'],
      draft:
        '[Target] one-pager\nCategory-defining SaaS; ~$6.2B revenue; 86% gross margin; 32% growth.\nStrategic + financial buyers both credible.',
    },
  ],
  // Seq 41 — Buyer Log / Feedback (was re-rank)
  'p3-s41': [
    {
      id: 're-rank-signal',
      label: 'Re-rank buyers on new signal',
      title: 'Updated ranking',
      description: 'Refresh fit scores with the new information.',
      loading: ['Ingesting new signal', 'Re-running the score'],
      draft:
        'Updated fit: Anthropic 89 (up), Salesforce 64 (down on overlap).\nNew signal: Buyer A raised its indicative range.',
    },
    {
      id: 'explain-change',
      label: 'Explain the ranking change',
      title: 'Why it moved',
      description: 'A short rationale for the change.',
      loading: ['Comparing to last run'],
      draft:
        'Revised price range + confirmed strategic rationale lifted A;\nantitrust overlap lowered B.',
    },
  ],
  // Seq 42 — Buyer NDA (was nda)
  'p3-s42': [
    {
      id: 'draft-nda',
      label: 'Draft the NDA',
      title: 'NDA draft',
      description: 'An NDA from the house template.',
      loading: ['Pulling the template', 'Filling terms'],
      draft:
        'NDA: [Codename]\nMutual, 2-year term, standard non-solicit, deal-code masking.\nFrom the house template.',
    },
    {
      id: 'compare-redlines',
      label: 'Compare buyer redlines',
      title: 'Redline comparison',
      description: 'What the buyer changed, and what to flag to Legal.',
      loading: ['Diffing the redlines', 'Flagging deviations'],
      draft:
        'Buyer redlines: term cut to 18m (accept), non-solicit carve-out (flag to Legal),\ndefinition of confidential info (standard).',
    },
  ],
  // Seq 43 — Buyer VDR Access (was distribute-cim + open-room-shortlist)
  'p3-s43': [
    {
      id: 'per-buyer-access',
      label: 'Set per-buyer access',
      title: 'Per-buyer access',
      description: 'What each NDA’d buyer can see, by phase.',
      loading: ['Reading NDA status', 'Setting access'],
      contacts: [
        { name: 'Buyer A', role: 'Phase 2', note: 'CIM + financials folder.' },
        { name: 'Buyer B', role: 'Phase 2', note: 'CIM only until financials cleared.' },
      ],
    },
    {
      id: 'notify-buyers',
      label: 'Notify NDA’d buyers',
      title: 'Buyer notification',
      description: 'Tell NDA’d buyers the CIM is available.',
      loading: ['Drafting the note'],
      draft:
        'To NDA’d buyers: the CIM is now available in your data room.\nManagement sessions open next week.',
    },
    {
      id: 'grant-access',
      label: 'Grant the shortlist access',
      title: 'Shortlist access',
      description: 'Open the full room to the diligence shortlist.',
      loading: ['Reading the shortlist', 'Granting access'],
      contacts: [
        { name: 'Buyer A', role: 'Phase 3', note: 'Full room + Q&A.' },
        { name: 'Buyer B', role: 'Phase 3', note: 'Full room + Q&A.' },
      ],
    },
    {
      id: 'confirm-audit',
      label: 'Confirm the audit trail',
      title: 'Audit trail',
      description: 'Every buyer view is recorded immutably.',
      loading: ['Checking the audit hooks'],
      draft:
        'Every document view by a buyer writes to the immutable audit log.\nTrail active for all shortlist access.',
    },
  ],
  // Seq 45 — Buyer Q&A (was diligence-qa)
  'p3-s45': [
    {
      id: 'draft-answers',
      label: 'Draft Q&A answers',
      title: 'Diligence answers',
      description: 'Answers drawn from the data room, with citations.',
      loading: ['Reading the questions', 'Retrieving with citations', 'Drafting'],
      draft:
        '3 buyer questions answered from the data room, with citations.\n1 routed to management (no source found).',
    },
    {
      id: 'flag-risks',
      label: 'Flag missing info / risks',
      title: 'Risk flags',
      description: 'Gaps and risks surfaced from diligence.',
      loading: ['Scanning for gaps', 'Ranking risks'],
      draft:
        'Risk flags: 2 customer contracts missing renewal terms;\none region’s revenue lacks a bridge.',
    },
  ],
  // Seq 46 — LOI / Process Letter (was iois / ioi-request)
  'p4-s46': [
    {
      id: 'ioi-request',
      label: 'Draft the IOI request',
      title: 'Process letter',
      description: 'The letter requesting non-binding indications.',
      loading: ['Drafting the process letter'],
      draft:
        'Process letter: submit a non-binding IOI by [date] with price range, structure, and conditions.',
    },
  ],
  // Seq 47 — Bid Comparison (was iois / summarize-iois)
  'p4-s47': [
    {
      id: 'summarize-iois',
      label: 'Summarize the IOIs',
      title: 'IOI summary',
      description: 'A read across the indications received.',
      loading: ['Reading the IOIs', 'Normalising terms'],
      draft:
        'IOIs: 4 received. Range $22B–$29B.\nTwo strategics, one PE, one pass. Detail per buyer attached.',
    },
  ],
  // Seq 48 — LOI Review (was lois)
  'p4-s48': [
    {
      id: 'compare-lois',
      label: 'Compare the LOIs',
      title: 'LOI comparison',
      description: 'A side-by-side of the binding offers.',
      loading: ['Normalising the LOIs', 'Comparing terms'],
      draft:
        'LOIs: 2 binding. A: $28B all-cash, 30-day exclusivity.\nB: $27B cash + stock. A is cleaner on conditions.',
    },
    {
      id: 'loi-request',
      label: 'Draft the LOI request',
      title: 'Final-round letter',
      description: 'The final-round request with the draft SPA.',
      loading: ['Drafting the letter'],
      draft: 'Final round: submit a binding LOI by [date] with a mark-up of the draft SPA.',
    },
  ],
  // Seq 50 — Definitive Agreement Support (was negotiate-spa)
  'p4-s50': [
    {
      id: 'spa-turn',
      label: 'Draft the next SPA turn',
      title: 'SPA turn',
      description: 'The next negotiation turn for Legal + MD.',
      loading: ['Reading the last turn', 'Drafting positions'],
      draft:
        'SPA turn 2: accept price, push escrow 12%→8%, tighten the MAC definition.\nFor Legal + MD.',
    },
    {
      id: 'redline-diff',
      label: 'Summarize the redline diff',
      title: 'Redline diff',
      description: 'What changed versus the last turn.',
      loading: ['Diffing the drafts'],
      draft: 'Changes vs last turn: escrow 8%, reps survival 18m, no financing condition.',
    },
  ],
  // Seq 51 — Signing / Announcement Prep (was sign)
  'p5-s51': [
    {
      id: 'final-checklist',
      label: 'Final terms checklist',
      title: 'Ready-to-sign checklist',
      description: 'Everything that must be true before signing.',
      loading: ['Verifying the conditions'],
      draft:
        'Ready to sign: price OK, escrow OK, reps OK, board approval OK,\nregulatory conditions listed.',
    },
    {
      id: 'signing-logistics',
      label: 'Draft signing logistics',
      title: 'Signing logistics',
      description: 'How signing and announcement run.',
      loading: ['Assembling logistics'],
      draft:
        'Signing: counterparts by e-sign; announcement embargoed to [date];\npress + client note prepared.',
    },
  ],
  // Seq 56 — Regulatory Approval Tracker (was complete-regulatory)
  'p5-s56': [
    {
      id: 'reg-checklist',
      label: 'Draft the regulatory checklist',
      title: 'Regulatory checklist',
      description: 'Filings and screens required to close.',
      loading: ['Identifying filings', 'Assigning owners'],
      draft:
        'Filings: antitrust notification; foreign-investment screen (if applicable).\nOwners + deadlines attached.',
    },
    {
      id: 'track-approvals',
      label: 'Track approvals',
      title: 'Approval tracker',
      description: 'Live status of each approval.',
      loading: ['Reading the tracker'],
      draft:
        'Approvals: antitrust filed (pending); FI screen not required.\nStatus auto-updates on the tracker.',
    },
  ],
  // Seq 57 — Closing Checklist (was freeze-record)
  'p5-s57': [
    {
      id: 'place-hold',
      label: 'Place the legal hold',
      title: 'Legal hold',
      description: 'Freeze the record so retention purge cannot remove it.',
      loading: ['Placing the hold', 'Writing to the audit log'],
      draft:
        'Legal hold placed on [Codename]. Retention purge blocked on the deal + documents.\nConfirmation written to the audit log.',
    },
    {
      id: 'frozen-artifacts',
      label: 'List the frozen artifacts',
      title: 'Frozen artifacts',
      description: 'What the hold covers.',
      loading: ['Enumerating the covered set'],
      contacts: [
        { name: 'Deal record', role: 'Frozen', note: 'Cannot be deleted.' },
        { name: 'Documents', role: 'Frozen', note: 'All classifications retained.' },
        { name: 'Audit log', role: 'Immutable', note: 'Append-only.' },
      ],
    },
  ],
  // Seq 59 — Closing Compliance Checklist / Binder (was retain-audit)
  'p5-s59': [
    {
      id: 'export-audit',
      label: 'Export the audit trail',
      title: 'Audit export',
      description: 'A regulator-ready export of every action.',
      loading: ['Collecting events', 'Building the export'],
      draft:
        'Audit export: every action (view, download, grant, revoke, hold)\nwith actor + timestamp. Ready for a regulator.',
    },
    {
      id: 'verify-immutability',
      label: 'Verify immutability',
      title: 'Immutability check',
      description: 'Confirm the log cannot be altered.',
      loading: ['Checking grants', 'Verifying append-only'],
      draft:
        'Immutability check: audit_log is append-only; no delete/update grants\nto the service role. Verified.',
    },
  ],
};

/**
 * "Why the governed skill beats the manual status quo" — a short, banker-legible
 * value line per step, shown on the skills library / detail surfaces IN PLACE OF
 * the raw ledger description (WS6: expose the value, not the mechanism). Curated
 * for the steps the demo dwells on; everything else falls back to a generic
 * line derived from the step title (whyBetterFor).
 */
const STEP_WHY: Record<string, string> = {
  // Phase 1 — origination, qualification & mandate
  'p1-s2': 'Scores a seller’s readiness from the data room in minutes, with the gaps to close before go-to-market.',
  'p1-s3': 'Reads the cultural fit signal from public sources, so the buyer conversation starts on evidence not instinct.',
  'p1-s6': 'Runs KYC, sanctions, conflicts and the wall-cross in one governed pass, with a CCO sign-off receipt.',
  'p1-s7': 'Mints the masked deal code and shell instantly, so every external artifact is compliant from the first draft.',
  'p1-s8': 'Maps who to approach at the target and drafts the first-contact note, ranked by public signal.',
  'p1-s9': 'One governed brief before the first call: objectives, source-cited profile, and ranked precedents with objection answers.',
  'p1-s12': 'Turns the client NDA around against the house template, redlines flagged for Legal, nothing missed.',
  'p1-s17': 'Builds and screens the buyer universe by fit, with an early antitrust and conflicts read baked in.',
  'p1-s20': 'Drafts the engagement letter from the house template with the deal terms filled, ready for MD and Legal.',
  'p1-s25': 'Frames the fee and scope negotiation with the comparable precedents already pulled.',
  // Phase 2 — preparation & market readiness
  'p2-s26': 'Recommends the deal team by skill and current load, so staffing takes a click not a scheduling thread.',
  'p2-s28': 'Drafts the kickoff invite and agenda from the mandate, compliance in the room by default.',
  'p2-s30': 'Keeps Team current for every party, with click-to-call and email on each contact.',
  'p2-s31': 'Proposes the data room index already classified and phase-gated, so buyers only ever see their tier.',
  'p2-s32': 'Ingests and permission-tags every source to the deal code, indexed for the downstream agents.',
  'p2-s34': 'Normalizes the financials and surfaces the adjustments, so the valuation narrative rests on clean numbers.',
  'p2-s35': 'Drafts the weekly client and internal update from the live record, ready to edit or send.',
  'p2-s36': 'Researches, drafts and compliance-screens the teaser end to end; the MD only signs off.',
  'p2-s37': 'Structures the CIM and management deck against the house style, first draft in minutes.',
  // Phase 3 — marketing & first-round bids
  'p3-s39': 'Screens every outbound item before it leaves the firm: recipient, attachment, figures, approval.',
  'p3-s40': 'Generates the four buyer deep-dive panels and a one-pager, valuation to founder read.',
  'p3-s41': 'Re-ranks buyers on new signal and explains what moved, so the shortlist stays defensible.',
  'p3-s42': 'Drafts the buyer NDA and compares their redlines, deviations flagged for Legal.',
  'p3-s43': 'Sets per-buyer, phase-gated room access and writes every view to the immutable audit trail.',
  'p3-s45': 'Answers diligence questions from the data room with citations, and flags what needs management.',
  // Phase 4 — diligence, LOI & definitive docs
  'p4-s46': 'Drafts the process letter requesting non-binding indications on your terms.',
  'p4-s47': 'Normalizes and compares the IOIs side by side, so the read across the field is instant.',
  'p4-s48': 'Compares the binding LOIs on price, structure and conditions, cleanest offer surfaced.',
  'p4-s50': 'Drafts the next SPA turn and the redline diff for Legal and the MD, position by position.',
  // Phase 5 — signing, closing & post-close
  'p5-s51': 'Runs the ready-to-sign checklist and drafts the signing and announcement logistics.',
  'p5-s56': 'Tracks every regulatory filing and approval to close, owners and deadlines assigned.',
  'p5-s57': 'Places the legal hold and freezes the record, so retention purge can never touch it.',
  'p5-s59': 'Exports a regulator-ready audit trail and verifies the log is append-only and immutable.',
};

/** whyBetter for a step: the curated line, else a generic value fallback. */
function whyBetterFor(g: GeneratedStep): string {
  return (
    STEP_WHY[g.id] ??
    `Runs ${g.name} as a governed, one-click draft Conductia prepares and you approve, logged and compliance-screened by default.`
  );
}

function toRailStep(g: GeneratedStep): RailStep {
  const live = g.seq === TEASER_STEP_SEQ || g.seq === MD_BRIEFING_STEP_SEQ;
  const reality: RailReality = live
    ? 'live'
    : STEP_FEATURES[g.id]
      ? 'schema'
      : 'planned';
  const persistent = PERSISTENT_STEP_IDS.has(g.id);
  const timeline: RailTimeline =
    g.phase === 1 && !persistent ? 'new-biz-dev' : 'execution';
  return {
    id: g.id,
    seq: g.seq,
    title: g.name,
    description: g.description,
    owner: BUILD_OWNER_LABEL[g.buildOwner],
    actor: actorForClass(g.executionClass),
    layer: g.layer,
    buildOwner: g.buildOwner,
    executionClass: g.executionClass,
    io: g.io,
    tools: g.tools,
    priorityBuild: g.priorityBuild,
    approvalBy: g.approvalBy,
    compliance: g.compliance,
    reality,
    timeline,
    whyBetter: whyBetterFor(g),
    ...(persistent ? { persistent: true } : {}),
    ...(live ? { live: true } : {}),
    ...STEP_OVERRIDES[g.id],
  };
}

/** The canonical rail: 5 phases / 65 steps, from the HV ledger. This stays the
 *  full census — the skills library and every census surface consume it. */
export const DEAL_RAIL: readonly RailPhase[] = GENERATED_PHASES.map((p) => ({
  id: `phase-${p.num}`,
  index: p.num,
  name: p.name,
  dealStatus: PHASE_DEAL_STATUS[p.num] ?? 'active',
  roles: p.roles,
  tools: p.tools,
  steps: GENERATED_STEPS.filter((s) => s.phase === p.num).map(toRailStep),
}));

/** How many phases the canonical rail has. Any meter, caption or "of N" label
 *  reads this rather than restating the number. */
export const DEAL_PHASE_COUNT = DEAL_RAIL.length;

/**
 * New Business Development — the phase-1 origination / pitch steps split out as
 * a separate pre-mandate timeline (the persistent mandate-formation steps stay
 * on the execution rail). Derived from DEAL_RAIL, never stored.
 */
export const NEW_BIZ_DEV_STEPS: readonly RailStep[] = DEAL_RAIL.flatMap(
  (p) => p.steps,
).filter((s) => s.timeline === 'new-biz-dev');

/**
 * The synthetic notify step — Gate 0 action with no ledger seq; lives as step 4
 * on the MVP rail only.
 */
function gate0NotifyStep(): RailStep {
  return {
    id: GATE0_NOTIFY_STEP_ID,
    seq: 0,
    title: 'Notify Compliance',
    description:
      'On create, a Gate 0 notice goes to compliance under the code name. The notice is screened for MNPI before it is logged. The recipients and notice text are recorded on the deal.',
    owner: BUILD_OWNER_LABEL.rts,
    actor: 'agent',
    layer: 'vertical',
    buildOwner: 'rts',
    executionClass: 'H',
    io: {
      inputs: [{ what: 'Code name and mandate context', format: '', source: 'Deal record' }],
      transformation:
        'Screens the Gate 0 notice for MNPI, then logs the compliance and management notification under the code name.',
      outputs: [
        {
          what: 'Screened Gate 0 notification receipt on the deal record',
          format: 'Audit log entry',
          source: 'Audit log',
        },
      ],
      constraints: ['MNPI screening before the notice is logged'],
    },
    tools: [],
    priorityBuild: false,
    approvalBy: 'Managing Director',
    compliance: ['MNPI screening before the notice is logged'],
    reality: 'planned',
    timeline: 'execution',
    gate0: true,
    offPlatform: true,
    whyBetter:
      'Compliance and management see the mandate under the code name with MNPI screened before anything is logged.',
  };
}

function buildGate0Steps(
  executionById: Map<string, RailStep>,
): RailStep[] {
  return GATE0_STEP_IDS.map((id) => {
    if (id === GATE0_NOTIFY_STEP_ID) return gate0NotifyStep();
    const step = executionById.get(id);
    if (!step) throw new Error(`Gate 0 step missing from execution rail: ${id}`);
    if (id === 'p1-s7') {
      return { ...step, gate0: true, title: 'Codename', offPlatform: true };
    }
    return { ...step, gate0: true };
  });
}

function buildMvpDealRail(): readonly RailPhase[] {
  const executionSteps = DEAL_RAIL.flatMap((p) => p.steps).filter(
    (s) => s.timeline === 'execution',
  );
  const executionById = new Map(executionSteps.map((s) => [s.id, s]));
  const gate0Steps = buildGate0Steps(executionById);

  return DEAL_RAIL.map((phase) => {
    let steps = phase.steps.filter(
      (s) => s.timeline === 'execution' && !GATE0_STEP_ID_SET.has(s.id),
    );
    if (phase.index === 1) {
      steps = [...gate0Steps, ...steps];
    }
    return steps.length > 0 ? { ...phase, steps } : null;
  }).filter((p): p is RailPhase => p !== null);
}

/**
 * The MVP rail: the execution timeline only — phases 2–5 plus the persistent
 * phase-1 mandate-formation spine (Relationship Pathing through Engagement
 * Negotiation). New Business Development is cut from it. The first three steps
 * are Gate 0 (code name, conflicts, notify). Mandate Activation (Seq 26) opens
 * Phase 2 after Engagement Negotiation. Same phase objects as DEAL_RAIL,
 * filtered to execution steps; empty phases are dropped. DEAL_RAIL remains the
 * default everywhere — rail surfaces opt in by passing this.
 */
export const MVP_DEAL_RAIL: readonly RailPhase[] = buildMvpDealRail();

/** The first execution step after the Gate 0 intake block (Relationship Pathing). */
export function firstStepAfterGate0(
  rail: readonly RailPhase[] = MVP_DEAL_RAIL,
): RailStep | undefined {
  return orderedSteps(rail)[GATE0_STEP_IDS.length];
}

/** 1-based position on a rail (MVP rail shows Gate 0 as steps 1–3). */
export function stepDisplayNumber(
  stepId: string,
  rail: readonly RailPhase[] = MVP_DEAL_RAIL,
): number {
  const idx = stepIndexById(stepId, rail);
  return idx >= 0 ? idx + 1 : 0;
}

/**
 * The step number of a canonical seq (1..65) on the rendered rail, or null
 * when that census step is not on it (New Business Development). Callers hold
 * canonical seqs (URLs, deals.current_step_seq); the MD only ever reads the
 * step scale.
 */
export function stepNumberForSeq(
  seq: number,
  rail: readonly RailPhase[] = MVP_DEAL_RAIL,
): number | null {
  const step = stepBySeq(seq, DEAL_RAIL);
  if (!step) return null;
  const idx = stepIndexById(step.id, rail);
  return idx >= 0 ? idx + 1 : null;
}

/** Zero-padded step number, the one identifier form the MD reads. */
export function stepNumber(
  stepId: string,
  rail: readonly RailPhase[] = MVP_DEAL_RAIL,
): string {
  return String(stepDisplayNumber(stepId, rail)).padStart(2, '0');
}

/**
 * The always-on capabilities that run ACROSS steps (Storm's v1 journeys that
 * are not sequential). They split by scope: deal-level ones live on the rail;
 * cross-deal / personal ones (the morning digest, the staffing view) live on
 * the projects portfolio. Illustrative. (The full 21-app always-on layer from
 * the ledger is exported separately as ALWAYS_ON_APPS.)
 */
const ALL_ALWAYS_ON: AgentFeature[] = [
  {
    id: 'ask-deal',
    label: 'Ask the deal',
    title: 'Where does this deal stand?',
    description: 'Answer any permissioned question about the deal, with citations from the live record.',
    loading: ['Reading the deal record', 'Retrieving with citations', 'Answering'],
    draft:
      '4 buyers engaged, CIM out, IOIs due Friday. Top fit Anthropic (87).\nNext gate: management sessions. [cited from the live record]',
  },
  {
    id: 'daily-digest',
    label: 'Daily digest',
    title: 'Your morning digest',
    description: 'A personalised morning brief and a printable to-do list.',
    loading: ['Gathering overnight activity', 'Building your to-do list'],
    draft:
      'Good morning. Today on [Codename]: 2 buyer questions to answer,\nteaser sign-off pending, IOI deadline in 2 days.\nTo-dos ready (printable).',
  },
  {
    id: 'pre-send-qc',
    label: 'Pre-send QC',
    title: 'Pre-send quality control',
    description: 'Every outgoing external item is checked before it leaves the firm.',
    loading: ['Loading the last item', 'Running the checklist'],
    draft:
      'Checked on any external item: recipient, attachment, code name,\nfigures, claims, metadata, approval. Last item: teaser (CLEAR).',
  },
  {
    id: 'staffing',
    label: 'Staffing',
    title: 'Staffing & deal intensity',
    description: 'Who is loaded, by deal and by banker.',
    loading: ['Reading live deals', 'Ranking intensity'],
    contacts: [
      { name: 'Storm Duncan', role: 'MD', note: '3 live deals: high load.' },
      { name: 'Associate', role: 'Execution', note: '2 deals: moderate.' },
      { name: 'VP', role: 'Coverage', note: '4 deals: high load.' },
    ],
  },
  {
    id: 'comms',
    label: 'Comms capture',
    title: 'Captured communications',
    description: 'Emails, calls, and meetings summarised and preserved under the deal code.',
    loading: ['Collecting communications', 'Summarising'],
    draft:
      'Captured under [Codename]: 12 emails, 3 calls, 2 meetings, summarised and preserved.\nLatest: Buyer A intro call (summary attached).',
  },
];

// Portfolio-level (cross-deal / personal): the morning digest + the staffing
// view. Everything else is deal-scoped and lives on the rail. (The weekly
// update moved onto the rail itself — seq 35, Deal Pulse Checklist.)
const PORTFOLIO_ALWAYS_ON_IDS = new Set(['daily-digest', 'staffing']);

/** Cross-deal capabilities — shown on the projects portfolio. */
export const PORTFOLIO_ALWAYS_ON_FEATURES: AgentFeature[] = ALL_ALWAYS_ON.filter(
  (f) => PORTFOLIO_ALWAYS_ON_IDS.has(f.id),
);

/** Deal-scoped capabilities — shown on the deal rail. */
export const DEAL_ALWAYS_ON_FEATURES: AgentFeature[] = ALL_ALWAYS_ON.filter(
  (f) => !PORTFOLIO_ALWAYS_ON_IDS.has(f.id),
);

/**
 * A deterministic token-consumption estimate for an agent action, so every
 * agent surface can report what it consumed (and allocate it to the deal).
 * Illustrative — a real run reports metered tokens from the orchestration spine.
 */
export function estimateTokens(feature: AgentFeature): number {
  const draftLen = feature.draft?.length ?? 0;
  const contacts = feature.contacts?.length ?? 0;
  const est =
    600 +
    feature.loading.length * 140 +
    Math.round(draftLen / 3.5) +
    contacts * 180 +
    feature.description.length;
  return Math.round(est / 10) * 10;
}

/** Resolve the agent features shown on a step's action bar. */
export function stepAgentFeatures(step: RailStep): AgentFeature[] {
  if (step.live) return [];
  if (step.agentFeatures?.length) return step.agentFeatures;
  if (STEP_FEATURES[step.id]) return STEP_FEATURES[step.id];
  const isAgent = step.actor === 'agent' || step.actor === 'both';
  if (isAgent && step.agentPreview) {
    return [
      {
        id: 'preview',
        label: 'Preview agent action',
        title: step.title,
        description: step.agentPreview,
        loading: ['Spinning up the agent', 'Gathering context', 'Preparing the draft'],
        draft: step.agentDraft,
      },
    ];
  }
  return [];
}

/** Every step, flattened in rail order. */
export function orderedSteps(rail: readonly RailPhase[] = DEAL_RAIL): RailStep[] {
  return rail.flatMap((p) => p.steps);
}

/** Total number of steps on the rail. */
export function totalSteps(rail: readonly RailPhase[] = DEAL_RAIL): number {
  return orderedSteps(rail).length;
}

/** Ordered index of a step id (−1 if not found). */
export function stepIndexById(
  id: string,
  rail: readonly RailPhase[] = DEAL_RAIL,
): number {
  return orderedSteps(rail).findIndex((s) => s.id === id);
}

/** The step at a canonical sequence number (1..65), if it exists. */
export function stepBySeq(
  seq: number,
  rail: readonly RailPhase[] = DEAL_RAIL,
): RailStep | undefined {
  return orderedSteps(rail).find((s) => s.seq === seq);
}

/** Canonical step id for a sequence number; falls back to the first step. */
export function stepIdForSeq(
  seq: number,
  rail: readonly RailPhase[] = DEAL_RAIL,
): string {
  return stepBySeq(seq, rail)?.id ?? orderedSteps(rail)[0].id;
}

/** The phase a step belongs to, if any. */
export function phaseForStep(
  stepId: string,
  rail: readonly RailPhase[] = DEAL_RAIL,
): RailPhase | undefined {
  return rail.find((p) => p.steps.some((s) => s.id === stepId));
}

export type RailSeedRow = { stepId: string; seq: number; phaseIndex: number; displayOrder: number };

export function railSeedRows(rail: readonly RailPhase[]): RailSeedRow[] {
  return rail
    .flatMap((phase) => phase.steps.map((step) => ({ stepId: step.id, seq: step.seq, phaseIndex: phase.index })))
    .map((row, index) => ({ ...row, displayOrder: index + 1 }));
}

/**
 * Derive a step's checklist state from the progress cursor:
 *   index < cursor  → done
 *   index === cursor → active (the step the deal is on now)
 *   index > cursor  → to-do
 * A cursor of 0 is "day one" — the whole rail ahead of you.
 */
export function stateForIndex(index: number, cursor: number): RailState {
  if (index < cursor) return 'done';
  if (index === cursor) return 'active';
  return 'todo';
}

export const REALITY_LABEL: Record<RailReality, string> = {
  live: 'Live',
  schema: 'Schema only',
  planned: 'Planned',
};

export const ACTOR_LABEL: Record<RailActor, string> = {
  human: 'Human',
  agent: 'Agent',
  both: 'Agent + sign-off',
};
