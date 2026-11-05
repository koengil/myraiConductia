// Per-deal content datasets — the multi-deal shape of the ConductiaAPI *content*
// seam. The seam is deal-agnostic no longer: each deal resolves to its own
// dataset (seller, acquirers, peers, team, valuation, panels, culture readings).
//
// This mirrors how the platform schema already models the world (deal_id-keyed
// deals / deal_parties / documents, per docs/03-engineering/permissions_schema_v3-full.md
// and api-v1.md). Adding a company/deal is ONE entry in DEAL_DATASETS — the code
// does not grow. A real backend keyed by deal_id returns exactly this shape.
//
// INVARIANT: the sandbox deal (Project Summit = the Atlassian dataset) is
// imported byte-for-byte from fixtures.ts, so the locked composite scores
// (Anthropic 87 / Salesforce 67, ADR-0002) are preserved. fixtures.ts is
// untouched; new deals live here.

import type {
  Acquirer,
  Company,
  CultureFaultline,
  CultureMatrix,
  FounderRead,
  SynergyStressTest,
  TeamMember,
  Valuation,
} from './types';
import {
  seller as summitSeller,
  acquirers as summitAcquirers,
  peers as summitPeers,
  team as summitTeam,
  valuation as summitValuation,
  synergyStressTest as summitSynergy,
  founderRead as summitFounderRead,
  cultureMatrixFor as summitCultureMatrixFor,
} from './fixtures';
import { resolveDeal } from '../rail/deals';

/** Everything the content seam serves for ONE deal. A real backend keyed by
 *  deal_id returns this shape; the mock resolves it from DEAL_DATASETS. */
export type DealDataset = {
  seller: Company;
  acquirers: Acquirer[];
  peers: Company[];
  team: TeamMember[];
  valuation: Valuation;
  synergyStressTest: SynergyStressTest;
  founderRead: FounderRead;
  /** Build the culture matrix for one acquirer within this deal. */
  cultureMatrixFor: (acquirerId: string, acquirerName: string) => CultureMatrix;
};

// --- Project Summit — the Atlassian sandbox (from fixtures.ts, unchanged) -----

const summitDataset: DealDataset = {
  seller: summitSeller,
  acquirers: summitAcquirers,
  peers: summitPeers,
  team: summitTeam,
  valuation: summitValuation,
  synergyStressTest: summitSynergy,
  founderRead: summitFounderRead,
  cultureMatrixFor: summitCultureMatrixFor,
};

// --- Project Harbor — GitLab (DevOps platform) --------------------------------
// A second, genuinely distinct deal so switching deals changes the data, not
// just the label. Public-knowledge-scale approximations, demo use.

const harborSeller: Company = {
  id: 'gitlab',
  name: 'GitLab',
  kind: 'seller',
  tagline: 'The most comprehensive AI-powered DevSecOps platform.',
  financials: {
    valuationUsd: 9_000_000_000,
    revenueUsd: 750_000_000,
    revenueGrowthPct: 31,
    ebitdaUsd: 90_000_000, // ~12% margin, recently profitable
    ebitdaMarginPct: 12,
    cashUsd: 1_000_000_000,
    headcount: 2_100,
  },
  openQuestion:
    'Is GitLab worth more inside a cloud or platform owner, or on its own? And who can clear antitrust?',
};

const harborAcquirers: Acquirer[] = [
  {
    id: 'google-cloud',
    name: 'Google Cloud',
    kind: 'acquirer',
    tagline: 'Build, deploy, and scale on the cloud built for the AI era.',
    financials: {
      valuationUsd: 2_100_000_000_000,
      revenueUsd: 43_000_000_000, // Cloud segment
      revenueGrowthPct: 30,
      ebitdaUsd: 6_000_000_000,
      ebitdaMarginPct: 14,
      cashUsd: 100_000_000_000,
      headcount: 40_000,
    },
    fitInputs: {
      financial: { valuationCoverage: 90, cashCapacity: 92, growth: 84, margin: 70 },
      culture: { vision: 84, mission: 82, founder: 78, headcount: 80, industry: 88, product: 86, culture: 80 },
    },
  },
  {
    id: 'microsoft-github',
    name: 'Microsoft (GitHub)',
    kind: 'acquirer',
    tagline: 'The home for all developers, from GitHub to Azure.',
    financials: {
      valuationUsd: 3_300_000_000_000,
      revenueUsd: 245_000_000_000,
      revenueGrowthPct: 16,
      ebitdaUsd: 105_000_000_000,
      ebitdaMarginPct: 43,
      cashUsd: 80_000_000_000,
      headcount: 220_000,
    },
    fitInputs: {
      // Highest product overlap (GitHub) but that overlap is the antitrust risk.
      financial: { valuationCoverage: 88, cashCapacity: 90, growth: 66, margin: 84 },
      culture: { vision: 72, mission: 70, founder: 66, headcount: 62, industry: 80, product: 78, culture: 68 },
    },
  },
  {
    id: 'atlassian-buyer',
    name: 'Atlassian',
    kind: 'acquirer',
    tagline: 'Software that unleashes the potential of every team.',
    financials: {
      valuationUsd: 48_000_000_000,
      revenueUsd: 4_400_000_000,
      revenueGrowthPct: 22,
      ebitdaUsd: 880_000_000,
      ebitdaMarginPct: 20,
      cashUsd: 2_000_000_000,
      headcount: 11_000,
    },
    fitInputs: {
      financial: { valuationCoverage: 68, cashCapacity: 58, growth: 74, margin: 66 },
      culture: { vision: 86, mission: 84, founder: 80, headcount: 82, industry: 88, product: 84, culture: 86 },
    },
  },
  {
    id: 'datadog',
    name: 'Datadog',
    kind: 'acquirer',
    tagline: 'Observability and security for the modern cloud.',
    financials: {
      valuationUsd: 45_000_000_000,
      revenueUsd: 2_600_000_000,
      revenueGrowthPct: 27,
      ebitdaUsd: 520_000_000,
      ebitdaMarginPct: 20,
      cashUsd: 3_000_000_000,
      headcount: 7_000,
    },
    fitInputs: {
      financial: { valuationCoverage: 60, cashCapacity: 62, growth: 78, margin: 70 },
      culture: { vision: 74, mission: 72, founder: 76, headcount: 74, industry: 78, product: 72, culture: 74 },
    },
  },
  {
    id: 'pe-consortium',
    name: 'PE Consortium',
    kind: 'acquirer',
    tagline: 'Take-private capital with a software-platform thesis.',
    financials: {
      valuationUsd: 60_000_000_000, // dry powder
      revenueUsd: 0,
      revenueGrowthPct: 0,
      ebitdaUsd: 0,
      ebitdaMarginPct: 0,
      cashUsd: 20_000_000_000,
      headcount: 200,
    },
    fitInputs: {
      financial: { valuationCoverage: 72, cashCapacity: 78, growth: 40, margin: 55 },
      culture: { vision: 55, mission: 52, founder: 60, headcount: 58, industry: 62, product: 50, culture: 56 },
    },
  },
];

const harborPeers: Company[] = [
  {
    id: 'github',
    name: 'GitHub',
    kind: 'peer',
    tagline: 'Where the world builds software.',
    financials: {
      valuationUsd: 20_000_000_000,
      revenueUsd: 2_000_000_000,
      revenueGrowthPct: 40,
      ebitdaUsd: 300_000_000,
      ebitdaMarginPct: 15,
      cashUsd: 0,
      headcount: 3_000,
    },
  },
  {
    id: 'jfrog',
    name: 'JFrog',
    kind: 'peer',
    tagline: 'The software supply chain platform.',
    financials: {
      valuationUsd: 3_500_000_000,
      revenueUsd: 420_000_000,
      revenueGrowthPct: 22,
      ebitdaUsd: 50_000_000,
      ebitdaMarginPct: 12,
      cashUsd: 500_000_000,
      headcount: 1_500,
    },
  },
];

const harborTeam: TeamMember[] = [
  { id: 'sd', name: 'Storm Duncan', role: 'MD', initials: 'SD' },
  { id: 'pm', name: 'Priya Mehta', role: 'VP', initials: 'PM' },
  { id: 'tc', name: 'Tom Clarke', role: 'Associate', initials: 'TC' },
  { id: 'sr', name: 'Sarah Reid', role: 'M&A Advisor', initials: 'SR' },
];

const harborValuation: Valuation = {
  rows: [
    { name: 'Trading (today)', rangeStart: 0.42, rangeEnd: 0.5, tone: 'accent', value: '~$9B', note: 'Point estimate · market cap' },
    { name: '52-week range', rangeStart: 0.28, rangeEnd: 0.62, tone: 'neutral', value: '~$6B – ~$13B', note: 'Trading band over the year' },
    { name: 'Comp set', tone: 'neutral', value: 'GitHub, JFrog', note: 'Dev-tools read-throughs. Multiples pending.', needsData: true },
    { name: 'DCF', tone: 'neutral', value: 'pending', note: 'WACC / terminal not yet wired', needsData: true },
    { name: 'Precedent transactions', tone: 'neutral', value: 'pending', note: 'Recent DevOps / dev-tools deals', needsData: true },
  ],
  trace: { revenueLabel: '$750M', grossMarginPct: 89, lastQtrGrowthPct: 31 },
};

const harborSynergy: SynergyStressTest = {
  rows: [
    { label: 'Cost synergies', baseRate: '~80% of plan', baseRateNote: 'McKinsey average for SaaS / platform M&A', managementClaim: '~$60M · 85% of plan', verdict: 'ok' },
    { label: 'Revenue synergies', baseRate: '~50% of plan', baseRateNote: 'McKinsey. Revenue synergies miss more than cost.', managementClaim: '~$120M · 70% of plan', verdict: 'stress' },
    { label: 'Total announced to captured', baseRate: '30–50% within 2 yrs', baseRateNote: 'Bain integration research', managementClaim: '~$180M · 55% within 2 yrs', verdict: 'stress' },
  ],
  riskNote:
    "Risk drivers for this rail: GitLab's all-remote, transparency-by-default culture is unusually specific and hard to preserve inside a large acquirer. The GitHub product overlap is both the strongest synergy case and the sharpest antitrust and customer-churn risk.",
};

const harborFounderRead: FounderRead = {
  founderName: 'Sid Sijbrandij (co-founder)',
  scenarios: [
    { title: 'Transition out over 12mo, hand to a platform owner', likelihood: 'Most likely', desc: 'GitLab has already professionalised its executive bench, so a clean founder transition is credible. The all-remote operating model is the real integration question, not the founder seat.', retentionRisk: 'Moderate', signal: 'Public posture: mission-driven, values-explicit; wants the operating model preserved more than a title.' },
    { title: 'Stay as advisor / board, values steward', likelihood: 'Plausible', desc: 'Keeps influence over the transparency and all-remote norms that define GitLab, fits a culturally-compatible acquirer better than a consolidator.', retentionRisk: 'Low', signal: 'Founder-compatibility read favors this if the acquirer commits to the handbook culture.' },
    { title: 'Exit at close', likelihood: 'Tail risk', desc: 'Founder departs quickly; the distributed engineering org watches for whether the culture survives. Highest risk under a heavyweight platform acquirer.', retentionRisk: 'High', signal: "Bain fault line: engagement-model clash is acute for an all-remote target inside an office-centric acquirer." },
  ],
};

// Culture readings per Harbor acquirer (Bain four fault lines: purpose,
// decision-making, engagement, founder compatibility).
const harborFaultlineDefs: ReadonlyArray<{ name: string; signal: string }> = [
  { name: 'Differences in purpose', signal: "Signal source: 10-K language, founder letters, public talks. Surface drift, don't assert intent." },
  { name: 'Differences in decision-making', signal: 'Signal source: org structure, exec interviews, decision-velocity themes.' },
  { name: 'Differences in engagement', signal: 'Signal source: public engagement data, attrition trend, employer-brand corpus.' },
  { name: 'Founder compatibility', signal: 'Signal source: public statements, prior deal behaviour, governance posture.' },
];

type Reading = Pick<CultureFaultline, 'verdict' | 'vClass' | 'desc'>;

const harborReadingsByAcquirer: Record<string, Reading[]> = {
  'atlassian-buyer': [
    { verdict: 'Strong', vClass: 'strong', desc: "Atlassian and GitLab both frame purpose around unleashing developer and team potential. Closest purpose alignment in this buyer set." },
    { verdict: 'Strong', vClass: 'strong', desc: 'Both run bottoms-up, engineering-led decisions; decision-velocity drop post-integration is comparatively low.' },
    { verdict: 'Watch', vClass: 'watch', desc: 'GitLab is all-remote and transparency-by-default; Atlassian is remote-friendly but not handbook-radical. Manageable, but a real adjustment.' },
    { verdict: 'Watch', vClass: 'watch', desc: 'Two founder-shaped software cultures negotiating product direction; watch, not strong, on who owns the roadmap.' },
  ],
  'microsoft-github': [
    { verdict: 'Watch', vClass: 'watch', desc: "GitLab's single-application, all-in-one purpose sits in tension with GitHub's ecosystem model. Not opposed, but strategically distinct." },
    { verdict: 'Risk', vClass: 'risk', desc: 'A large, consensus-heavy acquirer running an all-remote, high-autonomy target is the exact decision-velocity fault line Bain flags.' },
    { verdict: 'Risk', vClass: 'risk', desc: "GitLab's handbook-first, async, all-remote norms clash with a big-company engagement model; retention risk is real within twelve months." },
    { verdict: 'Watch', vClass: 'watch', desc: 'The GitHub overlap makes founder alignment secondary to the antitrust and product-rationalisation questions.' },
  ],
};

function harborCultureMatrixFor(acquirerId: string, acquirerName: string): CultureMatrix {
  const readings =
    harborReadingsByAcquirer[acquirerId] ??
    harborReadingsByAcquirer['atlassian-buyer'];
  return {
    acquirerName,
    faultlines: harborFaultlineDefs.map((def, i) => ({
      name: def.name,
      signal: def.signal,
      ...readings[i]!,
    })),
  };
}

const harborDataset: DealDataset = {
  seller: harborSeller,
  acquirers: harborAcquirers,
  peers: harborPeers,
  team: harborTeam,
  valuation: harborValuation,
  synergyStressTest: harborSynergy,
  founderRead: harborFounderRead,
  cultureMatrixFor: harborCultureMatrixFor,
};

// --- Empty dataset — a new/created deal with no analysis yet -------------------
// COMPLIANCE: an unknown/created deal must NEVER show another named deal's
// confidential data (its buyers, valuation, roster). That would surface one
// company's analysis under a different deal's code name. Instead it resolves to
// this honestly-empty dataset — no buyers, valuation pending — coherent with the
// empty Data Room (manifestFor) and empty Team roster. Static and
// localStorage-free, so it is SSR-safe (no hydration mismatch).

const EMPTY_DATASET: DealDataset = {
  seller: {
    id: 'pending',
    name: 'New mandate',
    kind: 'seller',
    tagline: 'Analysis is populated as the deal progresses.',
    financials: {
      valuationUsd: 0,
      revenueUsd: 0,
      revenueGrowthPct: 0,
      ebitdaUsd: 0,
      ebitdaMarginPct: 0,
      cashUsd: 0,
      headcount: 0,
    },
  },
  acquirers: [],
  peers: [],
  team: [],
  valuation: {
    rows: [
      { name: 'Trading (today)', tone: 'neutral', value: 'pending', note: 'No valuation for this deal yet', needsData: true },
    ],
    trace: { revenueLabel: 'Not reported', grossMarginPct: 0, lastQtrGrowthPct: 0 },
  },
  synergyStressTest: { rows: [], riskNote: '' },
  founderRead: { founderName: '', scenarios: [] },
  cultureMatrixFor: (_acquirerId, acquirerName) => ({ acquirerName, faultlines: [] }),
};

// --- The registry + resolver --------------------------------------------------
// Keyed by the deal's code-name slug (the /projects/[projectId] segment). Adding
// a deal/company is one entry here — no code change elsewhere.

export const DEAL_DATASETS: Record<string, DealDataset> = {
  'project-summit': summitDataset,
  atlassian: summitDataset, // legacy sandbox slug → same dataset
  'project-harbor': harborDataset,
};

/** Resolve a deal's content dataset. A deal with an authored dataset (the two
 *  seeded demo deals) returns it; every OTHER deal (created / unknown) returns
 *  the empty dataset — never another deal's data. */
export function datasetFor(dealId: string | undefined): DealDataset {
  if (!dealId) return EMPTY_DATASET;
  const slug = resolveDeal(dealId)?.id ?? dealId;
  return DEAL_DATASETS[slug] || EMPTY_DATASET;
}
