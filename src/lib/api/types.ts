export type CompanyKind = 'seller' | 'acquirer' | 'peer'

export type Financials = { valuationUsd:number; revenueUsd:number; revenueGrowthPct:number; ebitdaUsd:number; ebitdaMarginPct:number; cashUsd:number; headcount:number }

export type FinancialFactors = { valuationCoverage:number; cashCapacity:number; growth:number; margin:number } // each 0–100

export type CultureFactors = { vision:number; mission:number; founder:number; headcount:number; industry:number; product:number; culture:number } // each 0–100

export type FitInputs = { financial: FinancialFactors; culture: CultureFactors }

export type CompositeScore = { total:number; financialSub:number; cultureSub:number; breakdown: { label:string; value:number }[]; compliancePassed:boolean }

export type Company = { id:string; name:string; kind:CompanyKind; tagline:string; financials:Financials; /** Optional editorial brief question for sellers — surfaced on the Mandate page. Added Phase E sandbox merge (2026-05-20). */ openQuestion?: string }

export type Acquirer = Company & { kind:'acquirer'; fitInputs:FitInputs }

// `dataShape` was renamed from `panel` in Phase F of the sandbox merge
// (2026-05-20) per ADR-0005's engineering-review carry. The field is the
// DOMAIN data shape a skill produces ('company' / 'cultureFactors' /
// 'compositeScore') — not the UI panel component name. The client maps
// dataShape → panel component (Canvas.tsx); the wire stays domain-pure.
export type Skill = { id:string; name:string; description:string; category:string; premium:boolean; dataShape:'company'|'cultureFactors'|'compositeScore' }

export type TeamMember = { id:string; name:string; role:'MD'|'CFO'|'M&A Advisor'|'VP'|'Associate'|'Analyst'; initials:string }

// Widened by Phase B of the sandbox merge (2026-05-20) per ADR-0003.
// 'hold' added as a fifth UI state — visually distinct from both 'clear'
// (compliant, terminal positive) and 'blocked' (terminal negative).
export type ComplianceStatus = 'idle' | 'scanning' | 'clear' | 'hold' | 'blocked'

// Widened by Phase B of the sandbox merge (2026-05-20) per ADR-0003.
// Old shape was { status:'clear'|'blocked'; reasons:string[]; ruleIds:string[] }.
// New shape: discriminated verdict (compliant | hold | blocked) plus an
// optional rewrite suggestion that the UI surfaces inline when present.
// ruleIds dropped (was unused outside the type).
export type ComplianceCheckResult = { verdict: 'compliant' | 'hold' | 'blocked'; reasons: string[]; rewrite?: string }

export type Stage = 'coldOpen' | 'intent' | 'landscape' | 'deepDive' | 'complianceTheatre' | 'pitchCta'

// Skill-run data — the domain shape a skill produces when it runs against
// an acquirer. Phase F of the sandbox merge (2026-05-20) replaced the
// prior `PanelData` discriminated union; the old `kind` values were
// UI-panel-component names ('financialMatrix' / 'cultureRadar' /
// 'scoreBreakdown') that leaked presentation concerns into the wire
// contract. The new shape uses domain-data discriminators ('company',
// 'cultureFactors', 'compositeScore'); the Canvas consumer maps each
// dataKind to the panel component that renders it (`renderPanel` in
// `src/components/skills/Canvas.tsx`). Per ADR-0005's engineering-review
// carry: a future real backend will return this domain shape, not the
// UI-presentation shape.
export type SkillRunData =
  | { dataKind: 'company'; company: Company }
  | { dataKind: 'cultureFactors'; factors: CultureFactors }
  | { dataKind: 'compositeScore'; score: CompositeScore };

// ─── Phase D of the sandbox merge (2026-05-20) — analytical-panel types.
// Four new seam methods added below: getValuation, getSynergyStressTest,
// getFounderRead, getCultureMatrix(acquirerId). The new panels are standalone
// surfaces in /acquirers/[id]; they are NOT added to SkillRunData (the
// Canvas drop discriminated union) per ADR-0005's "panel rendering belongs
// on the client, not in the wire contract" carry. Ports from
// intelibank-sandbox/components/scenes/ + intelibank-sandbox/lib/llm/fixtures.

/** A single Football Field row — either a real range or a NEEDS-DATA placeholder. */
export type FootballFieldRow = {
  name: string;
  value: string;
  note: string;
  /** Range start position 0–1 (left edge). Omit for needs-data / point-estimate rows. */
  rangeStart?: number;
  /** Range end position 0–1 (right edge). Omit for needs-data / point-estimate rows. */
  rangeEnd?: number;
  /** Optional tone hint for the range bar (renderer maps to brand tokens). */
  tone?: 'positive' | 'neutral' | 'accent';
  /** When true, the row renders as NEEDS-DATA rather than a range bar. */
  needsData?: boolean;
};

export type ValuationTrace = {
  revenueLabel: string;
  grossMarginPct: number;
  lastQtrGrowthPct: number;
};

export type Valuation = {
  rows: FootballFieldRow[];
  trace: ValuationTrace;
};

export type SynergyVerdict = 'framework' | 'stress' | 'ok';

export type SynergyRow = {
  label: string;
  baseRate: string;
  baseRateNote: string;
  managementClaim: string;
  verdict: SynergyVerdict;
};

export type SynergyStressTest = {
  rows: SynergyRow[];
  riskNote: string;
};

export type FounderLikelihood = 'Most likely' | 'Plausible' | 'Tail risk';
export type FounderRetentionRisk = 'Low' | 'Moderate' | 'High';

export type FounderScenario = {
  title: string;
  likelihood: FounderLikelihood;
  desc: string;
  retentionRisk: FounderRetentionRisk;
  signal: string;
};

export type FounderRead = {
  founderName: string;
  scenarios: FounderScenario[];
};

export type CultureFaultlineClass = 'strong' | 'watch' | 'risk';

export type CultureFaultline = {
  name: string;
  verdict: string;
  vClass: CultureFaultlineClass;
  desc: string;
  signal: string;
};

export type CultureMatrix = {
  acquirerName: string;
  faultlines: CultureFaultline[];
};

export interface ConductiaAPI {
  // Deal-scoped content methods take the deal id (the /projects/[projectId]
  // slug). The mock resolves each deal's dataset (src/lib/api/datasets.ts); a
  // real backend keyed by deal_id returns the same shape. Global methods
  // (getSkills / compliance) are deal-agnostic.
  getSeller(dealId: string): Promise<Company>;
  getAcquirers(dealId: string): Promise<Acquirer[]>;
  getPeers(dealId: string): Promise<Company[]>;
  getSkills(): Promise<Skill[]>;
  getTeam(dealId: string): Promise<TeamMember[]>;
  getAcquirerScore(dealId: string, id: string): Promise<CompositeScore>;
  runSkill(dealId: string, skillId: string, acquirerId: string): Promise<{ locked: true } | { locked: false; data: SkillRunData }>;
  checkMessageCompliance(body: string): Promise<ComplianceCheckResult>;
  sendMessage(input: { fromId: string; toId: string; body: string }): Promise<{ delivered: boolean; compliance: ComplianceCheckResult }>;
  // Analytical panels — Phase D sandbox merge (2026-05-20). Each panel has
  // its own seam method; not folded into SkillRunData per ADR-0005.
  getValuation(dealId: string): Promise<Valuation>;
  getSynergyStressTest(dealId: string, acquirerId: string): Promise<SynergyStressTest>;
  getFounderRead(dealId: string, acquirerId: string): Promise<FounderRead>;
  getCultureMatrix(dealId: string, acquirerId: string): Promise<CultureMatrix>;
}
