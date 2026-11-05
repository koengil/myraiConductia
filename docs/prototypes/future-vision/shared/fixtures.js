/*
 * Conductia future-vision prototypes — shared fixtures.
 * Single source of truth for all 4 prototypes so the Atlassian story and every
 * number stays consistent and TRUTHFUL (mirrors src/lib/api/fixtures.ts and the
 * deterministic scores from src/lib/scoring/composite.ts: 55% financial / 45%
 * culture). Lifecycle/governance fixtures mirror the new /api/v1 surface +
 * supabase/migrations/20260604100000_permissions_schema.sql.
 *
 * Usage:  <script src="../shared/fixtures.js"></script>  -> window.IB
 */
window.IB = (function () {
  // ── Seller ────────────────────────────────────────────────────────────────
  const seller = {
    id: 'atlassian',
    name: 'Atlassian',
    tagline: "The teamwork platform behind the world's best software teams.",
    openQuestion: 'Who actually buys this, and does the value survive the integration?',
    financials: {
      valuationUsd: 48e9, revenueUsd: 4.4e9, revenueGrowthPct: 22,
      ebitdaUsd: 880e6, ebitdaMarginPct: 20, cashUsd: 2e9, headcount: 11000,
    },
  };

  // ── Acquirers (composite = round(fin*0.55 + culture*0.45)) ──────────────────
  const acquirers = [
    { id: 'anthropic',  name: 'Anthropic',  composite: 87, financial: 84, culture: 91, aiNative: true,
      tagline: 'Responsible AI for enterprise, safety and capability unified.',
      rationale: 'Closest purpose and decision-making fit in the buyer universe. Founder-led, research-led, flat.' },
    { id: 'microsoft',  name: 'Microsoft',  composite: 77, financial: 79, culture: 74, aiNative: false,
      tagline: 'Empowering every person and organisation on the planet to achieve more.',
      rationale: 'Deepest capacity to close. Cultural fit moderate under a consensus-heavy platform.' },
    { id: 'adobe',      name: 'Adobe',      composite: 75, financial: 73, culture: 77, aiNative: false,
      tagline: 'Creativity, marketing, and document solutions, unified.',
      rationale: 'Strong product overlap. Headcount fit moderate.' },
    { id: 'salesforce', name: 'Salesforce', composite: 67, financial: 71, culture: 62, aiNative: false,
      tagline: "The world's number-one CRM, connecting every customer and team.",
      rationale: 'Credible capacity, lower strategic fit. Sales-led norms clash with founder-led Atlassian.' },
    { id: 'servicenow', name: 'ServiceNow', composite: 67, financial: 67, culture: 68, aiNative: false,
      tagline: 'AI-powered enterprise workflow automation for every industry.',
      rationale: 'Workflow synergies, lower valuation capacity.' },
  ];

  const peers = [
    { id: 'figma', name: 'Figma', valuationUsd: 12e9, revenueGrowthPct: 35 },
    { id: 'canva', name: 'Canva', valuationUsd: 32e9, revenueGrowthPct: 40 },
  ];

  // ── Skills catalogue (premium flag = the tier signal) ───────────────────────
  const skills = [
    { id: 'financial-performance', name: 'Financial Performance', category: 'Financial', premium: false,
      description: "Revenue, growth, EBITDA, and cash capacity over time." },
    { id: 'acquirer-fit', name: 'Acquirer Fit', category: 'Strategic', premium: false,
      description: 'Composite fit: financial capacity times cultural and strategic alignment.' },
    { id: 'culture-signal', name: 'Culture Signal', category: 'Cultural', premium: false,
      description: '7-axis culture and strategic fit between seller and acquirer.' },
    { id: 'deal-readiness', name: 'Deal Readiness', category: 'Strategic', premium: false,
      description: 'Cash vs equity capacity, headcount alignment, FINRA posture.' },
    { id: 'synergy-engine', name: 'Synergy & Deal-Structuring Engine', category: 'Strategic', premium: true,
      description: 'Model deal structures and quantify synergies across product, revenue, headcount.' },
  ];

  // ── Analytical panels ───────────────────────────────────────────────────────
  const valuation = {
    trace: { revenueLabel: '$6.2B', grossMarginPct: 86.5, lastQtrGrowthPct: 32 },
    rows: [
      { name: 'Trading (today)', value: '~$23B', start: 0.46, end: 0.58, tone: 'accent', note: 'Point estimate, market cap' },
      { name: '52-week range', value: '~$10.4B - ~$30B', start: 0.20, end: 0.78, tone: 'neutral', note: 'Down 55% over the year, then 30% in a single session' },
      { name: 'Comp set', value: 'Figma, Canva', tone: 'neutral', note: 'Public-comp read-throughs. Multiples pending.', needsData: true },
      { name: 'DCF', value: 'pending', tone: 'neutral', note: 'WACC / terminal not yet wired', needsData: true },
      { name: 'Precedent transactions', value: 'pending', tone: 'neutral', note: 'Recent enterprise SaaS take-privates', needsData: true },
    ],
  };

  const synergyStressTest = {
    rows: [
      { label: 'Cost synergies', baseRate: '~80% of plan', note: 'McKinsey average for SaaS / platform M&A', claim: 'NEEDS-DATA', verdict: 'framework' },
      { label: 'Revenue synergies', baseRate: '~50% of plan', note: 'Revenue synergies miss more than cost.', claim: 'NEEDS-DATA', verdict: 'framework' },
      { label: 'Announced to captured', baseRate: '30-50% within 2 yrs', note: 'Bain integration research', claim: 'NEEDS-DATA', verdict: 'framework' },
    ],
    riskNote: "Atlassian's remote-first culture and engineering-led decisions amplify talent-retention risk under a sales-led acquirer. Customer overlap with Slack and Service Cloud creates a churn lane a naive synergy model under-prices.",
  };

  const founderRead = {
    founderName: 'Mike Cannon-Brookes',
    scenarios: [
      { title: 'Stay on as exec, 18-24mo earn-out', likelihood: 'Most likely', risk: 'Moderate',
        desc: 'Retains a defined role tied to revenue and integration milestones. Autonomy dominates whether he stays.' },
      { title: 'Board / advisor, lighter operating role', likelihood: 'Plausible', risk: 'Low',
        desc: 'Hands off operating to a new CEO, keeps board influence. Fits a product-led acquirer best.' },
      { title: 'Exit at close, short earn-out', likelihood: 'Tail risk', risk: 'High',
        desc: 'Walks within 12 months. Engineering org watches the founder for cues. Most likely under a sales-led acquirer.' },
    ],
  };

  // 4 Bain fault lines: reading per acquirer.
  const cultureMatrix = {
    faultlines: ['Differences in purpose', 'Differences in decision-making', 'Differences in engagement', 'Founder compatibility'],
    byAcquirer: {
      anthropic:  [{ v: 'Strong', c: 'strong' }, { v: 'Strong', c: 'strong' }, { v: 'Strong', c: 'strong' }, { v: 'Watch', c: 'watch' }],
      salesforce: [{ v: 'Watch', c: 'watch' }, { v: 'Risk', c: 'risk' }, { v: 'Watch', c: 'watch' }, { v: 'Watch', c: 'watch' }],
    },
  };

  // ── NEW lifecycle + governance (the /api/v1 powers on this branch) ───────────

  // GET /api/v1/me — real identity in the chrome.
  const currentUser = {
    name: 'Storm Duncan', role: 'Managing Director', dealRole: 'md',
    department: 'Investment Banking', initials: 'SD',
    mandate: { code: 'ATLAS-2026-001', codename: 'Project Atlas', status: 'active', target: 'Atlassian' },
  };

  // GET /api/v1/deals — mandate switcher (an MD runs several).
  const deals = [
    { code: 'ATLAS-2026-001', codename: 'Project Atlas', target: 'Atlassian', status: 'active', stage: 'Buyer outreach' },
    { code: 'NIMBU-2026-014', codename: 'Project Nimbus', target: 'Confidential', status: 'active', stage: 'Data room' },
    { code: 'HELIO-2026-022', codename: 'Project Helios', target: 'Confidential', status: 'paused', stage: 'Intake' },
  ];

  // roles.permissions jsonb — the permission matrix made visible.
  const roles = [
    { slug: 'md',        label: 'Managing Director',        external: false, permissions: ['deal:full', 'acquirer:full', 'scoring:edit', 'team:manage', 'compliance:verdicts'] },
    { slug: 'deal_team', label: 'Deal Team',                external: false, permissions: ['deal:read', 'acquirer:scores', 'document:read:class1-3', 'thread:own'] },
    { slug: 'legal',     label: 'Legal Counsel',            external: false, permissions: ['nda:manage', 'engagement_letter:manage', 'document:read:class1-3', 'thread:own'] },
    { slug: 'cco',       label: 'Chief Compliance Officer', external: false, permissions: ['deal:read:all', 'compliance:full', 'audit:full', 'nda:read'] },
    { slug: 'admin',     label: 'Administrator',            external: false, permissions: ['user:manage', 'tenant:manage'] },
    { slug: 'seller',    label: 'Seller',                   external: true,  permissions: ['document:upload:class1-3'] },
    { slug: 'buyer',     label: 'Buyer',                    external: true,  permissions: ['document:read:phase_gated'] },
    { slug: 'read_only', label: 'Observer',                 external: false, permissions: ['deal:read', 'document:read:class1-2'] },
  ];

  // deal_memberships on Project Atlas (seed-data.ts personas).
  const dealTeam = [
    { name: 'Storm Duncan',        role: 'md',        initials: 'SD', sees: 'Everything on the deal' },
    { name: 'Alex Chen',           role: 'deal_team', initials: 'AC', sees: 'Deal + documents class 1-3' },
    { name: 'Jordan Blake',        role: 'legal',     initials: 'JB', sees: 'NDAs, engagement letters, class 1-3' },
    { name: 'Pat Rivera',          role: 'cco',       initials: 'PR', sees: 'All deals, full audit (oversight)' },
    { name: 'Mike Cannon-Brookes', role: 'seller',   initials: 'MC', sees: 'Uploads class 1-3 (external)' },
    { name: 'Acquirer Contact',    role: 'buyer',     initials: 'BC', sees: 'Phase-gated documents only (external)' },
    { name: 'Observer One',        role: 'read_only', initials: 'O1', sees: 'Deal + documents class 1-2' },
  ];

  // Data room: classification 1-4, min_phase gates staged buyer access.
  const documents = [
    { name: 'Teaser (anonymised).pdf',        classification: 1, minPhase: 0, label: 'Public' },
    { name: 'Management Presentation v1.pdf',  classification: 2, minPhase: 0, label: 'Internal' },
    { name: 'Financial Model 2026.xlsx',       classification: 3, minPhase: 1, label: 'Confidential' },
    { name: 'Customer Contracts (top 20).zip', classification: 3, minPhase: 2, label: 'Confidential' },
    { name: 'Board Minutes 2024-2026.pdf',     classification: 4, minPhase: 3, label: 'Restricted' },
  ];

  // audit_log — who opened / was granted what, and when.
  const auditLog = [
    { ts: '09:14', actor: 'Storm Duncan', action: 'grant',  detail: 'Created deal ATLAS-2026-001' },
    { ts: '09:21', actor: 'Storm Duncan', action: 'grant',  detail: 'Added Alex Chen as Deal Team' },
    { ts: '10:02', actor: 'Alex Chen',    action: 'view',   detail: 'Management Presentation v1.pdf' },
    { ts: '11:37', actor: 'Storm Duncan', action: 'grant',  detail: 'Added Acquirer Contact as Buyer (phase 1)' },
    { ts: '11:40', actor: 'Acquirer Contact', action: 'view', detail: 'Teaser (anonymised).pdf' },
    { ts: '14:05', actor: 'Mike Cannon-Brookes', action: 'upload', detail: 'Financial Model 2026.xlsx' },
  ];

  // Compliance cascade screened on every intent / message.
  const complianceCascade = [
    { id: 'KYC',   label: 'KYC',   desc: 'Counterparty identity verified' },
    { id: 'FINRA', label: 'FINRA', desc: 'Communication rules screened' },
    { id: 'MNPI',  label: 'MNPI',  desc: 'Material non-public information contained' },
  ];

  // Message screening examples (compliant / hold / blocked + rewrite).
  const screeningExamples = [
    { body: 'Sharing the anonymised teaser with the shortlisted buyer.', verdict: 'clear' },
    { body: 'They mentioned unannounced earnings on the call, looping you in.', verdict: 'blocked',
      reason: 'MNPI: references material non-public information.',
      rewrite: 'Following up on our call, I will send the cleared materials shortly.' },
    { body: 'Forwarding price guidance ahead of the announcement.', verdict: 'hold',
      reason: 'FINRA: forward-looking guidance needs review.' },
  ];

  // The guided deal journey (Martin's beats), mapped to capabilities + APIs.
  const journey = [
    { beat: 1, key: 'intake',   title: 'Intake',         line: 'Name the company. Compliance clock starts, deal code minted.', api: 'POST /deals' },
    { beat: 2, key: 'conflicts',title: 'Conflicts',      line: 'Cross-check active mandates for competing engagements.' },
    { beat: 3, key: 'notice',   title: 'Compliance notice', line: 'CCO notified automatically, regulatory basis logged.', api: 'audit_log' },
    { beat: 4, key: 'team',     title: 'Team assembly',  line: 'Invite the deal team by role. Access walls go up.', api: 'POST /deals/{id}/members' },
    { beat: 5, key: 'ndas',     title: 'NDAs',           line: 'Mutual NDAs executed and tracked (Phase 2 vision).' },
    { beat: 6, key: 'dataroom', title: 'Data room',      line: 'Staged access by classification and phase. Buyers gated.', api: 'documents + min_phase' },
    { beat: 7, key: 'brief',    title: 'Deal brief',     line: 'Ranked buyers, scored fit, valuation envelope.', api: 'scoring + panels' },
    { beat: 8, key: 'outreach', title: 'Buyer outreach', line: 'Every message screened before it leaves the room.', api: 'compliance' },
    { beat: 9, key: 'pitch',    title: 'Pitch',          line: 'AI-assisted teaser, compliance pre-cleared (vision).' },
  ];

  // Helpers
  function fmtUsd(n) {
    if (n >= 1e12) return '$' + (n / 1e12).toFixed(1).replace(/\.0$/, '') + 'T';
    if (n >= 1e9)  return '$' + (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1e6)  return '$' + (n / 1e6).toFixed(0) + 'M';
    return '$' + n.toLocaleString();
  }

  return {
    seller, acquirers, peers, skills, valuation, synergyStressTest, founderRead,
    cultureMatrix, currentUser, deals, roles, dealTeam, documents, auditLog,
    complianceCascade, screeningExamples, journey, fmtUsd,
    scoringWeights: { financial: 0.55, culture: 0.45 },
  };
})();
