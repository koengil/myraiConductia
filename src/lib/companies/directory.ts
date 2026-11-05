// Company directory — the dataset behind the platform-level Company Search
// (/companies). This surface is NOT deal-scoped: an MD searches ANY company and
// reads a profile (financials, ownership, comps, signals). It is deliberately
// separate from the deal fixtures (src/lib/api/fixtures.ts), which model buyers
// for one live deal.
//
// Numbers are public-knowledge-scale APPROXIMATIONS for the demo — rounded,
// illustrative, not a data feed. A production build swaps this for the same
// premium sources a research desk uses (Capital IQ / PitchBook / EDGAR).

export type CompanyStatus = 'Public' | 'Private';

export type CompanyFinancials = {
  /** Latest valuation / market cap, USD. */
  valuationUsd: number;
  /** Trailing revenue, USD. */
  revenueUsd: number;
  /** Year-on-year revenue growth, %. */
  revenueGrowthPct: number;
  /** EBITDA margin, %. Null when not meaningfully disclosed (early-stage). */
  ebitdaMarginPct: number | null;
};

export type CompanySignal = {
  label: string;
  detail: string;
};

export type CompanyProfile = {
  /** URL-safe id / search slug. */
  id: string;
  name: string;
  sector: string;
  status: CompanyStatus;
  /** One-line what-they-do. */
  description: string;
  hq: string;
  founded: number;
  employees: number;
  financials: CompanyFinancials;
  /** How the company is owned (ticker for public, backers for private). */
  ownership: string;
  /** Comparable companies (names) — the comp set a banker reads it against. */
  peers: string[];
  /** Recent, decision-relevant signals. Illustrative. */
  signals: CompanySignal[];
};

export const COMPANY_DIRECTORY: readonly CompanyProfile[] = [
  {
    id: 'atlassian',
    name: 'Atlassian',
    sector: 'Collaboration software',
    status: 'Public',
    description: 'Team collaboration and software-development tools (Jira, Confluence, Trello).',
    hq: 'Sydney, Australia',
    founded: 2002,
    employees: 11000,
    financials: { valuationUsd: 48_000_000_000, revenueUsd: 4_400_000_000, revenueGrowthPct: 22, ebitdaMarginPct: 20 },
    ownership: 'Public · NASDAQ: TEAM',
    peers: ['Monday.com', 'Asana', 'Smartsheet', 'ServiceNow'],
    signals: [
      { label: 'Cloud migration', detail: 'Server end-of-life migration to Cloud largely complete; mix shifting to higher-margin subscriptions.' },
      { label: 'AI', detail: 'Rovo / Atlassian Intelligence rolling into the suite as a paid add-on.' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    sector: 'AI research & safety',
    status: 'Private',
    description: 'Frontier AI lab; builder of the Claude family of models and the Claude Developer Platform.',
    hq: 'San Francisco, USA',
    founded: 2021,
    employees: 2000,
    financials: { valuationUsd: 40_000_000_000, revenueUsd: 1_000_000_000, revenueGrowthPct: 300, ebitdaMarginPct: null },
    ownership: 'Private · backed by Google, Amazon, Spark, Lightspeed',
    peers: ['OpenAI', 'Google DeepMind', 'Mistral AI', 'Cohere'],
    signals: [
      { label: 'Funding', detail: 'Successive rounds at a rapidly rising valuation; heavy compute commitments from strategic backers.' },
      { label: 'Enterprise', detail: 'Fast enterprise revenue ramp led by coding and agentic use cases.' },
    ],
  },
  {
    id: 'salesforce',
    name: 'Salesforce',
    sector: 'CRM & enterprise cloud',
    status: 'Public',
    description: 'Customer-relationship-management and enterprise-cloud platform (Sales, Service, Data, Slack).',
    hq: 'San Francisco, USA',
    founded: 1999,
    employees: 72000,
    financials: { valuationUsd: 250_000_000_000, revenueUsd: 35_000_000_000, revenueGrowthPct: 11, ebitdaMarginPct: 31 },
    ownership: 'Public · NYSE: CRM',
    peers: ['Microsoft', 'Oracle', 'SAP', 'HubSpot'],
    signals: [
      { label: 'Margins', detail: 'Multi-year margin expansion under activist pressure; disciplined on M&A.' },
      { label: 'Agentforce', detail: 'Agentic AI layer positioned as the next growth vector across the clouds.' },
    ],
  },
  {
    id: 'microsoft',
    name: 'Microsoft',
    sector: 'Software & cloud infrastructure',
    status: 'Public',
    description: 'Cloud (Azure), productivity (Microsoft 365), developer tools (GitHub), and AI (Copilot).',
    hq: 'Redmond, USA',
    founded: 1975,
    employees: 221000,
    financials: { valuationUsd: 3_000_000_000_000, revenueUsd: 245_000_000_000, revenueGrowthPct: 16, ebitdaMarginPct: 49 },
    ownership: 'Public · NASDAQ: MSFT',
    peers: ['Alphabet', 'Amazon', 'Oracle', 'ServiceNow'],
    signals: [
      { label: 'Azure', detail: 'Cloud growth reaccelerating on AI workloads; capex stepping up sharply.' },
      { label: 'Copilot', detail: 'AI assistants attaching across M365, GitHub, and Azure.' },
    ],
  },
  {
    id: 'databricks',
    name: 'Databricks',
    sector: 'Data & AI platform',
    status: 'Private',
    description: 'Lakehouse platform for data engineering, analytics, and AI on one governed layer.',
    hq: 'San Francisco, USA',
    founded: 2013,
    employees: 7000,
    financials: { valuationUsd: 62_000_000_000, revenueUsd: 2_400_000_000, revenueGrowthPct: 50, ebitdaMarginPct: null },
    ownership: 'Private · backed by Thrive, a16z, NVIDIA, sovereign funds',
    peers: ['Snowflake', 'Confluent', 'MongoDB', 'Microsoft'],
    signals: [
      { label: 'Funding', detail: 'Large late-stage rounds; frequently cited as a marquee IPO candidate.' },
      { label: 'AI', detail: 'Mosaic acquisition anchoring a model-training and serving story.' },
    ],
  },
  {
    id: 'canva',
    name: 'Canva',
    sector: 'Visual design platform',
    status: 'Private',
    description: 'Web-based visual design and publishing for teams and non-designers.',
    hq: 'Sydney, Australia',
    founded: 2013,
    employees: 4500,
    financials: { valuationUsd: 26_000_000_000, revenueUsd: 2_300_000_000, revenueGrowthPct: 40, ebitdaMarginPct: 15 },
    ownership: 'Private · backed by Blackbird, Sequoia, Felicis',
    peers: ['Adobe', 'Figma', 'Atlassian'],
    signals: [
      { label: 'Profitability', detail: 'Cash-flow positive at scale: rare among design-software private companies.' },
      { label: 'Enterprise', detail: 'Moving up-market with an enterprise tier and AI generation tools.' },
    ],
  },
  {
    id: 'figma',
    name: 'Figma',
    sector: 'Design collaboration',
    status: 'Private',
    description: 'Browser-based interface design and whiteboarding with real-time collaboration.',
    hq: 'San Francisco, USA',
    founded: 2012,
    employees: 1500,
    financials: { valuationUsd: 12_500_000_000, revenueUsd: 700_000_000, revenueGrowthPct: 40, ebitdaMarginPct: null },
    ownership: 'Private · backed by Index, Greylock, Sequoia, Kleiner',
    peers: ['Adobe', 'Canva', 'Miro'],
    signals: [
      { label: 'Adobe deal', detail: 'The $20B Adobe acquisition was terminated on regulatory grounds; independent again.' },
      { label: 'Expansion', detail: 'Broadening beyond design into dev-mode, sites, and slides.' },
    ],
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    sector: 'DevOps platform',
    status: 'Public',
    description: 'A single application for the software-development lifecycle, from planning to security.',
    hq: 'All-remote',
    founded: 2014,
    employees: 2100,
    financials: { valuationUsd: 9_000_000_000, revenueUsd: 750_000_000, revenueGrowthPct: 31, ebitdaMarginPct: 12 },
    ownership: 'Public · NASDAQ: GTLB',
    peers: ['GitHub (Microsoft)', 'Atlassian', 'JFrog'],
    signals: [
      { label: 'Consolidation', detail: 'Recurrent take-private and strategic-interest speculation given scale and margins.' },
      { label: 'AI', detail: 'GitLab Duo positioning across the DevSecOps workflow.' },
    ],
  },
  {
    id: 'snowflake',
    name: 'Snowflake',
    sector: 'Data cloud',
    status: 'Public',
    description: 'Cloud data platform for storage, analytics, sharing, and AI across clouds.',
    hq: 'Bozeman, USA',
    founded: 2012,
    employees: 7500,
    financials: { valuationUsd: 55_000_000_000, revenueUsd: 3_500_000_000, revenueGrowthPct: 29, ebitdaMarginPct: null },
    ownership: 'Public · NYSE: SNOW',
    peers: ['Databricks', 'Microsoft', 'Google', 'Amazon'],
    signals: [
      { label: 'Consumption', detail: 'Usage-based model tied closely to enterprise data and AI workloads.' },
      { label: 'Cortex', detail: 'Native AI functions positioned to lift consumption.' },
    ],
  },
  {
    id: 'notion',
    name: 'Notion',
    sector: 'Productivity software',
    status: 'Private',
    description: 'A connected workspace for docs, wikis, projects, and lightweight databases.',
    hq: 'San Francisco, USA',
    founded: 2013,
    employees: 800,
    financials: { valuationUsd: 10_000_000_000, revenueUsd: 500_000_000, revenueGrowthPct: 35, ebitdaMarginPct: null },
    ownership: 'Private · backed by Index, Sequoia, Coatue',
    peers: ['Atlassian', 'Coda', 'Airtable'],
    signals: [
      { label: 'AI', detail: 'Notion AI attach and an enterprise push driving up-market expansion.' },
      { label: 'Efficiency', detail: 'Lean headcount relative to revenue: a capital-efficient profile.' },
    ],
  },
];

/** Search the directory by name, sector, or description. Empty query returns all. */
export function searchCompanies(query: string): CompanyProfile[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...COMPANY_DIRECTORY];
  return COMPANY_DIRECTORY.filter((c) =>
    [c.name, c.sector, c.description, c.hq].some((f) => f.toLowerCase().includes(q)),
  );
}

/** Resolve one company profile by id (slug). */
export function resolveCompanyProfile(id: string): CompanyProfile | undefined {
  return COMPANY_DIRECTORY.find((c) => c.id === id);
}

/** Compact USD formatter: $48.0B, $700.0M, $500K. Illustrative display only. */
export function formatUsd(value: number): string {
  if (value >= 1_000_000_000_000) return `$${(value / 1_000_000_000_000).toFixed(1)}T`;
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(0)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value}`;
}
