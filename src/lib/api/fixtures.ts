import type {
  Acquirer,
  Company,
  CultureFaultline,
  CultureMatrix,
  FounderRead,
  Skill,
  SynergyStressTest,
  TeamMember,
  Valuation,
} from './types';

// ---------------------------------------------------------------------------
// Seller — Atlassian
// Financials: public-knowledge-scale approximations (demo use; rounded).
// Atlassian FY2024 ~: revenue $4.4B, EBITDA ~$880M (≈20% margin),
// market cap ~$48B (~11× revenue), cash ~$2B, headcount ~11,000.
// ---------------------------------------------------------------------------
export const seller: Company = {
  id: 'atlassian',
  name: 'Atlassian',
  kind: 'seller',
  tagline: "The teamwork platform behind the world's best software teams.",
  financials: {
    valuationUsd: 48_000_000_000,
    revenueUsd:    4_400_000_000,
    revenueGrowthPct: 22,
    ebitdaUsd:       880_000_000,  // ≈ 20% of revenue
    ebitdaMarginPct: 20,
    cashUsd:       2_000_000_000,
    headcount:    11_000,
  },
  // Editorial brief moment, surfaced on the Mandate page (Phase E sandbox
  // merge, 2026-05-20). Sandbox source had an em-dash; replaced with a
  // comma per §4 of the front-end overhaul ledger.
  openQuestion: 'Who actually buys this, and does the value survive the integration?',
};

// ---------------------------------------------------------------------------
// Acquirers
// ---------------------------------------------------------------------------
export const acquirers: Acquirer[] = [
  // ── Anthropic ──────────────────────────────────────────────────────────────
  // FY2024 estimated: $3B ARR, $18B valuation; cash-rich (Series E); ~3,500 headcount.
  // fitInputs: fin 84, culture 91 — highest strategic fit.
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'acquirer',
    tagline: 'Responsible AI for enterprise, with safety and capability unified.',
    financials: {
      valuationUsd:  18_000_000_000,
      revenueUsd:     3_000_000_000,
      revenueGrowthPct: 200,
      ebitdaUsd:       -900_000_000, // pre-profit; investing phase
      ebitdaMarginPct: -30,
      cashUsd:        5_000_000_000,
      headcount:      3_500,
    },
    fitInputs: {
      financial: { valuationCoverage: 88, cashCapacity: 80, growth: 86, margin: 82 },
      // mean = (88+80+86+82)/4 = 336/4 = 84 ✓
      culture:   { vision: 95, mission: 94, founder: 92, headcount: 90, industry: 88, product: 90, culture: 88 },
      // mean = (95+94+92+90+88+90+88)/7 = 637/7 = 91 ✓
    },
  },

  // ── Salesforce ─────────────────────────────────────────────────────────────
  // FY2024: revenue $34.9B, EBITDA ~$9B (≈25% margin), market cap ~$220B,
  // cash ~$8B, headcount ~72,000.
  // fitInputs: fin 71, culture 62 — credible but lower strategic fit.
  {
    id: 'salesforce',
    name: 'Salesforce',
    kind: 'acquirer',
    tagline: "The world's #1 CRM: connecting every customer, every team.",
    financials: {
      valuationUsd:  220_000_000_000,
      revenueUsd:     34_900_000_000,
      revenueGrowthPct: 11,
      ebitdaUsd:       8_725_000_000, // ≈ 25% of revenue
      ebitdaMarginPct: 25,
      cashUsd:        8_000_000_000,
      headcount:     72_000,
    },
    fitInputs: {
      financial: { valuationCoverage: 74, cashCapacity: 68, growth: 70, margin: 72 },
      // mean = (74+68+70+72)/4 = 284/4 = 71 ✓
      culture:   { vision: 60, mission: 58, founder: 64, headcount: 66, industry: 62, product: 61, culture: 63 },
      // mean = (60+58+64+66+62+61+63)/7 = 434/7 = 62 ✓
    },
  },

  // ── Microsoft ──────────────────────────────────────────────────────────────
  // FY2024: revenue $245B, EBITDA ~$105B (≈43% margin), market cap ~$3.3T,
  // cash ~$80B, headcount ~220,000.
  // fitInputs: fin 78, culture 74 — strong capacity; cultural fit moderate.
  {
    id: 'microsoft',
    name: 'Microsoft',
    kind: 'acquirer',
    tagline: 'Empowering every person and organisation on the planet to achieve more.',
    financials: {
      valuationUsd:  3_300_000_000_000,
      revenueUsd:      245_000_000_000,
      revenueGrowthPct: 16,
      ebitdaUsd:       105_350_000_000, // ≈ 43% of revenue
      ebitdaMarginPct: 43,
      cashUsd:         80_000_000_000,
      headcount:      220_000,
    },
    fitInputs: {
      financial: { valuationCoverage: 82, cashCapacity: 88, growth: 68, margin: 76 },
      // mean = (82+88+68+76)/4 = 314/4 = 78.5 → 79
      culture:   { vision: 78, mission: 75, founder: 70, headcount: 72, industry: 76, product: 74, culture: 73 },
      // mean = (78+75+70+72+76+74+73)/7 = 518/7 = 74
    },
  },

  // ── Adobe ──────────────────────────────────────────────────────────────────
  // FY2024: revenue $21.5B, EBITDA ~$8.8B (≈41% margin), market cap ~$160B,
  // cash ~$7.5B, headcount ~30,000.
  // fitInputs: fin 73, culture 76 — product overlap strong; headcount fit moderate.
  {
    id: 'adobe',
    name: 'Adobe',
    kind: 'acquirer',
    tagline: 'Creativity, marketing, and document solutions, all unified.',
    financials: {
      valuationUsd:  160_000_000_000,
      revenueUsd:     21_500_000_000,
      revenueGrowthPct: 10,
      ebitdaUsd:       8_815_000_000, // ≈ 41% of revenue
      ebitdaMarginPct: 41,
      cashUsd:         7_500_000_000,
      headcount:      30_000,
    },
    fitInputs: {
      financial: { valuationCoverage: 70, cashCapacity: 72, growth: 68, margin: 82 },
      // mean = (70+72+68+82)/4 = 292/4 = 73
      culture:   { vision: 80, mission: 76, founder: 72, headcount: 74, industry: 78, product: 82, culture: 74 },
      // mean = (80+76+72+74+78+82+74)/7 = 536/7 = 76.6 → 77
    },
  },

  // ── ServiceNow ─────────────────────────────────────────────────────────────
  // FY2024: revenue $10.97B, EBITDA ~$3.3B (≈30% margin), market cap ~$185B,
  // cash ~$4.5B, headcount ~24,000.
  // fitInputs: fin 67, culture 68 — workflow synergies; lower valuation capacity.
  {
    id: 'servicenow',
    name: 'ServiceNow',
    kind: 'acquirer',
    tagline: 'AI-powered enterprise workflow automation for every industry.',
    financials: {
      valuationUsd:  185_000_000_000,
      revenueUsd:     10_970_000_000,
      revenueGrowthPct: 22,
      ebitdaUsd:       3_291_000_000, // ≈ 30% of revenue
      ebitdaMarginPct: 30,
      cashUsd:         4_500_000_000,
      headcount:      24_000,
    },
    fitInputs: {
      financial: { valuationCoverage: 62, cashCapacity: 65, growth: 72, margin: 68 },
      // mean = (62+65+72+68)/4 = 267/4 = 66.75 → 67
      culture:   { vision: 70, mission: 68, founder: 65, headcount: 66, industry: 68, product: 72, culture: 68 },
      // mean = (70+68+65+66+68+72+68)/7 = 477/7 = 68.1 → 68
    },
  },
];

// ---------------------------------------------------------------------------
// Peers — comparable publicly traded SaaS companies
// ---------------------------------------------------------------------------
export const peers: Company[] = [
  // Figma — acquired by Adobe (blocked) then reIPO'd; ~$12B valuation estimate,
  // revenue ~$700M, EBITDA breakeven-ish, headcount ~1,800.
  {
    id: 'figma',
    name: 'Figma',
    kind: 'peer',
    tagline: 'Where products are designed: collaborative design, in the browser.',
    financials: {
      valuationUsd:  12_000_000_000,
      revenueUsd:       700_000_000,
      revenueGrowthPct: 35,
      ebitdaUsd:          28_000_000, // ≈ 4% margin; early profitability
      ebitdaMarginPct: 4,
      cashUsd:          800_000_000,
      headcount:        1_800,
    },
  },
  // Canva — private; estimated $32B valuation (2023 round), revenue ~$2.3B,
  // headcount ~4,500; profit positive in recent years.
  {
    id: 'canva',
    name: 'Canva',
    kind: 'peer',
    tagline: 'Empowering the world to design: visual communication for everyone.',
    financials: {
      valuationUsd:  32_000_000_000,
      revenueUsd:     2_300_000_000,
      revenueGrowthPct: 40,
      ebitdaUsd:        345_000_000, // ≈ 15% margin
      ebitdaMarginPct: 15,
      cashUsd:        1_200_000_000,
      headcount:       4_500,
    },
  },
];

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------
export const team: TeamMember[] = [
  {
    // The logged-in user: the bank MD running the sell-side Atlassian mandate.
    // NOT Atlassian's founder (Mike Cannon-Brookes) — he is the SUBJECT of the
    // Founder Read below, the person being evaluated, never the evaluator.
    id: 'sd',
    name: 'Storm Duncan',
    role: 'MD',
    initials: 'SD',
  },
  {
    id: 'jw',
    name: 'James Watt',
    role: 'CFO',
    initials: 'JW',
  },
  {
    id: 'sr',
    name: 'Sarah Reid',
    role: 'M&A Advisor',
    initials: 'SR',
  },
];

// ---------------------------------------------------------------------------
// Skills — exact ids, premium flags, and panels are a hard contract with
// docs/02-product/skills-catalog.md and any consuming component.
// ---------------------------------------------------------------------------
export const skills: Skill[] = [
  {
    id: 'financial-performance',
    name: 'Financial Performance',
    description: "Analyse the seller's revenue, growth, EBITDA, and cash capacity over time.",
    category: 'Financial',
    premium: false,
    dataShape: 'company',
  },
  {
    id: 'acquirer-fit',
    name: 'Acquirer Fit',
    description: "Score an acquirer's composite fit: financial capacity \xd7 cultural/strategic alignment.",
    category: 'Strategic',
    premium: false,
    dataShape: 'compositeScore',
  },
  {
    id: 'culture-signal',
    name: 'Culture Signal',
    description: 'Visualise the 7-axis culture and strategic fit between seller and acquirer.',
    category: 'Cultural',
    premium: false,
    dataShape: 'cultureFactors',
  },
  {
    id: 'deal-readiness',
    name: 'Deal Readiness',
    description: "Assess the acquirer's readiness to close: cash vs. equity capacity, headcount alignment, FINRA compliance posture.",
    category: 'Strategic',
    premium: false,
    dataShape: 'compositeScore',
  },
  {
    id: 'synergy-engine',
    name: 'Synergy & Deal-Structuring Engine',
    description: 'Model deal structures and quantify synergies across product, revenue, and headcount.',
    category: 'Strategic',
    premium: true,
    dataShape: 'compositeScore',
  },
];

// ---------------------------------------------------------------------------
// Phase D of the sandbox merge (2026-05-20) — analytical-panel fixtures.
// Ported from intelibank-sandbox/components/scenes/*.tsx +
// intelibank-sandbox/lib/llm/fixtures.ts. Em-dashes in prose stripped per
// §4 of the front-end overhaul ledger (en-dashes for numerical ranges
// preserved). Real-world research substrate cited in
// docs/06-research/.
// ---------------------------------------------------------------------------

// Football Field — Atlassian valuation envelope, May-2026 grounded.
export const valuation: Valuation = {
  rows: [
    {
      name: 'Trading (today)',
      rangeStart: 0.46,
      rangeEnd: 0.58,
      tone: 'accent',
      value: '~$23B',
      note: 'Point estimate · market cap',
    },
    {
      name: '52-week range',
      rangeStart: 0.2,
      rangeEnd: 0.78,
      tone: 'neutral',
      value: '~$10.4B – ~$30B',
      note: 'Trading band: 55% drop over the year, then 30% in a single session',
    },
    {
      name: 'Comp set',
      tone: 'neutral',
      value: 'Figma, Canva',
      note: 'Public-comp read-throughs. Multiples pending.',
      needsData: true,
    },
    {
      name: 'DCF',
      tone: 'neutral',
      value: 'pending',
      note: 'WACC / terminal not yet wired',
      needsData: true,
    },
    {
      name: 'Precedent transactions',
      tone: 'neutral',
      value: 'pending',
      note: 'Recent enterprise SaaS take-privates',
      needsData: true,
    },
  ],
  trace: {
    revenueLabel: '$6.2B',
    grossMarginPct: 86.5,
    lastQtrGrowthPct: 32,
  },
};

// Synergy Stress-Test — shared across acquirers for now. Management claim
// is NEEDS-DATA until an acquirer files synergy projections; the
// base-rate framework is universal (McKinsey + Bain research).
export const synergyStressTest: SynergyStressTest = {
  rows: [
    {
      label: 'Cost synergies',
      baseRate: '~80% of plan',
      baseRateNote: 'McKinsey average for SaaS / platform M&A',
      managementClaim: '~$180M · 88% of plan',
      verdict: 'ok',
    },
    {
      label: 'Revenue synergies',
      baseRate: '~50% of plan',
      baseRateNote: 'McKinsey. Revenue synergies miss more than cost.',
      managementClaim: '~$240M · 75% of plan',
      verdict: 'stress',
    },
    {
      label: 'Total announced to captured',
      baseRate: '30–50% within 2 yrs',
      baseRateNote: 'Bain integration research',
      managementClaim: '~$420M · 60% within 2 yrs',
      verdict: 'stress',
    },
  ],
  riskNote:
    "Risk drivers for this rail: Atlassian's remote-first culture and engineering-led decision-making amplify talent-retention risk under a sales-led acquirer. Customer overlap with Salesforce's Slack and Service Cloud creates a real customer-churn lane that a naive synergy model under-prices.",
};

// Founder Read — three post-deal scenarios for Mike Cannon-Brookes.
// Shared across acquirers for now; later phases may specialize the
// likelihoods per acquirer (sales-led vs product-led).
export const founderRead: FounderRead = {
  founderName: 'Mike Cannon-Brookes',
  scenarios: [
    {
      title: 'Stay on as exec, 18–24mo earn-out',
      likelihood: 'Most likely',
      desc: 'Cannon-Brookes retains a defined role tied to revenue and integration milestones. Common shape for founder-led SaaS take-privates. Aligns short-term incentives. The autonomy question (decision-making fit) dominates whether he actually stays.',
      retentionRisk: 'Moderate',
      signal:
        'Public posture: high conviction, vocal on direction. Suggests he wants the role only if autonomy is preserved.',
    },
    {
      title: 'Stay as board / advisor, lighter operating role',
      likelihood: 'Plausible',
      desc: 'Hands off operating to a new CEO, keeps influence through board seat and equity. Fits a culturally-resonant acquirer (Anthropic-shaped) better than a platform consolidator. Lower talent-retention drag.',
      retentionRisk: 'Low',
      signal:
        'Founder-compatibility read flags this as the cleanest cultural fit if the acquirer is product-led.',
    },
    {
      title: 'Exit at close, earn-out structured short',
      likelihood: 'Tail risk',
      desc: "Founder walks within 12 months. High talent-retention risk; the engineering org watches the founder for cues. Most likely under a sales-led acquirer whose decision-making norms clash with Atlassian's.",
      retentionRisk: 'High',
      signal:
        "Bain fault line: differences in decision-making is the most disruptive in practice. Cannon-Brookes has publicly defended Atlassian's autonomy norms.",
    },
  ],
};

// Bain four fault lines — definition + signal source. The reading per
// acquirer (verdict + desc) lives in cultureReadingsByAcquirer.
const FAULTLINE_DEFS: ReadonlyArray<{ name: string; signal: string }> = [
  {
    name: 'Differences in purpose',
    signal:
      "Signal source: 10-K language, founder letters, public talks. Surface drift, don't assert intent.",
  },
  {
    name: 'Differences in decision-making',
    signal:
      'Signal source: org structure, exec interviews, Glassdoor decision-velocity themes.',
  },
  {
    name: 'Differences in engagement',
    signal:
      'Signal source: public engagement data, attrition trend, employer-brand corpus.',
  },
  {
    name: 'Founder compatibility',
    signal:
      'Signal source: public statements, prior deal behaviour, governance posture. Editable per deal.',
  },
];

type AcquirerCultureReading = Pick<
  CultureFaultline,
  'verdict' | 'vClass' | 'desc'
>;

const cultureReadingsByAcquirer: Record<string, AcquirerCultureReading[]> = {
  anthropic: [
    {
      verdict: 'Strong',
      vClass: 'strong',
      desc: "Anthropic's mission (responsible AI development) and Atlassian's framing (unleash the potential of every team) both centre on impact-with-restraint. Closest purpose alignment in the buyer universe; the rhetoric in both 10-K narratives and exec talks holds up to scrutiny.",
    },
    {
      verdict: 'Strong',
      vClass: 'strong',
      desc: 'Anthropic is research-led, comparatively flat, with founder-and-engineering decision-making. Close shape to Atlassian. Decision-velocity drop post-integration is materially lower than under a consensus-heavy strategic.',
    },
    {
      verdict: 'Strong',
      vClass: 'strong',
      desc: 'Async-first, distributed, autonomy-prizing norms on both sides. Engagement style is a non-issue here, one of the rare dimensions where this combination is genuinely lower-risk than the median deal.',
    },
    {
      verdict: 'Watch',
      vClass: 'watch',
      desc: "Amodei founders are mission-aligned and lower-key on press than typical platform CEOs. Cannon-Brookes' conviction reads as a partnership signal rather than a clash. Watch, not Strong, because two founder-led orgs always negotiate who calls product direction.",
    },
  ],
  salesforce: [
    {
      verdict: 'Watch',
      vClass: 'watch',
      desc: "Atlassian's purpose centres on unleashing the potential of every team. Salesforce's purpose is platform consolidation and CRM monetisation. Not opposed, but the missions read as orthogonal, which surfaces during integration when priorities diverge.",
    },
    {
      verdict: 'Risk',
      vClass: 'risk',
      desc: 'Atlassian runs founder-led, bottoms-up, engineering-driven decisions. Salesforce is consensus-heavy and sales-led, the exact fault line Bain flags as the most disruptive in practice. Decision velocity in the integrated org will drop, and the engineering org will read it.',
    },
    {
      verdict: 'Watch',
      vClass: 'watch',
      desc: 'Atlassian is remote-first, async, high-autonomy. Salesforce has steadily pulled back to office-centric, sync norms post-2023. The day-to-day rhythm divide is real and shows up in retention within twelve months.',
    },
    {
      verdict: 'Watch',
      vClass: 'watch',
      desc: 'Cannon-Brookes is a high-conviction, publicly outspoken founder. Benioff is too. Two strong public personas in one org tends to crowd airtime; post-deal role and autonomy guardrails matter more here than in the median deal.',
    },
  ],
};

/**
 * Build the culture matrix for the given acquirer. Acquirers without an
 * authored reading (Microsoft, Adobe, ServiceNow) fall back to the
 * Anthropic reading with the correct display name. The fallback is
 * obviously placeholder; future phases author per-acquirer readings.
 */
export function cultureMatrixFor(
  acquirerId: string,
  acquirerName: string,
): CultureMatrix {
  const readings =
    cultureReadingsByAcquirer[acquirerId] ??
    cultureReadingsByAcquirer.anthropic;
  return {
    acquirerName,
    faultlines: FAULTLINE_DEFS.map((def, i) => ({
      name: def.name,
      signal: def.signal,
      ...readings[i]!,
    })),
  };
}
