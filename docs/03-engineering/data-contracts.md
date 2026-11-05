# Data Contracts — Conductia

The `ConductiaAPI` interface is the future backend **content** contract: the M&A
intelligence surface (companies, acquirers, scoring, skills, compliance screening).
Every UI component depends on this interface and nothing else. The sandbox wires
`MockConductiaAPI` behind it. A real backend replaces the mock; the UI rewrites
nothing.

**This IS the future backend content contract; it must stay byte-for-byte in sync
with `src/lib/api/types.ts` (Plan Task 1.2).**

> **Scope (D35).** This seam is the *content* contract — one of **three** layers,
> none inside another. The *platform* contract (identity, deals, memberships,
> documents, audit) lives beside it as the migrated permissions schema + `/api/v1`
> (ADR-0008; see [`permissions_schema_v3-full.md`](./permissions_schema_v3-full.md),
> [`api-v1.md`](./api-v1.md)). The *agent-governance* layer is `src/lib/orchestration/`
> (#42; see [`orchestration-spine.md`](./orchestration-spine.md)) — the shipped
> realization of the handbook's `Job` / sealed-envelope / pre-send-gate model. The
> engineering handbook ([`intelibank-handbook.html`](./intelibank-handbook.html)) is that layer's design
> narrative; its `Deal → Phase → Task → Run` lifecycle remains a *domain* model, not
> a persisted backend schema.

---

## Type contract

Defined once in `src/lib/api/types.ts`. Names are exact and final — every other
file in the codebase references these identifiers verbatim.

```typescript
type CompanyKind = 'seller' | 'acquirer' | 'peer'

type Financials = { valuationUsd:number; revenueUsd:number; revenueGrowthPct:number; ebitdaUsd:number; ebitdaMarginPct:number; cashUsd:number; headcount:number }

type FinancialFactors = { valuationCoverage:number; cashCapacity:number; growth:number; margin:number } // each 0–100

type CultureFactors = { vision:number; mission:number; founder:number; headcount:number; industry:number; product:number; culture:number } // each 0–100

type FitInputs = { financial: FinancialFactors; culture: CultureFactors }

type CompositeScore = { total:number; financialSub:number; cultureSub:number; breakdown: { label:string; value:number }[]; compliancePassed:boolean }

type Company = { id:string; name:string; kind:CompanyKind; tagline:string; financials:Financials }

type Acquirer = Company & { kind:'acquirer'; fitInputs:FitInputs }

type Skill = { id:string; name:string; description:string; category:string; premium:boolean; panel:'financialMatrix'|'cultureRadar'|'scoreBreakdown' }

type TeamMember = { id:string; name:string; role:'MD'|'CFO'|'M&A Advisor'; initials:string }

type ComplianceStatus = 'idle' | 'scanning' | 'clear' | 'blocked'

type ComplianceCheckResult = { status:'clear'|'blocked'; reasons:string[]; ruleIds:string[] }

// The Stage discriminated union below encoded the retired linear demo spine
// (coldOpen → intent → landscape → deepDive → complianceTheatre → pitchCta).
// Phase F of the front-end overhaul (commit fbf10a0, 2026-05-20) replaced
// the spine with Next.js App Router segments; the UI stage components and
// the spine chrome were deleted. The Stage type, STAGE_ORDER, and the
// NEXT / BACK reducer actions were NOT deleted in F5 — they survive as
// residue, no longer load-bearing for navigation, exercised only by
// tests/session.test.ts. Awaiting a dedicated cleanup phase.
type Stage = 'coldOpen' | 'intent' | 'landscape' | 'deepDive' | 'complianceTheatre' | 'pitchCta'

type PanelData = { kind:'financialMatrix'; company:Company } | { kind:'cultureRadar'; factors:CultureFactors } | { kind:'scoreBreakdown'; score:CompositeScore }

interface ConductiaAPI {
  // Deal-scoped CONTENT methods take the deal id (the /projects/[projectId]
  // slug). The mock resolves each deal's dataset (src/lib/api/datasets.ts —
  // DEAL_DATASETS keyed by deal, sandbox fallback); a real backend keyed by
  // deal_id returns the same shape. Adding a deal/company is one dataset entry.
  // Global methods (getSkills / compliance) are deal-agnostic. (2026-07-10.)
  getSeller(dealId: string): Promise<Company>;
  getAcquirers(dealId: string): Promise<Acquirer[]>;
  getPeers(dealId: string): Promise<Company[]>;
  getSkills(): Promise<Skill[]>;
  getTeam(dealId: string): Promise<TeamMember[]>;
  getAcquirerScore(dealId: string, id: string): Promise<CompositeScore>;
  runSkill(dealId: string, skillId: string, acquirerId: string): Promise<{ locked: true } | { locked: false; data: SkillRunData }>;
  checkMessageCompliance(body: string): Promise<ComplianceCheckResult>;
  sendMessage(input: { fromId: string; toId: string; body: string }): Promise<{ delivered: boolean; compliance: ComplianceCheckResult }>;
  // Analytical panels (deal-scoped).
  getValuation(dealId: string): Promise<Valuation>;
  getSynergyStressTest(dealId: string, acquirerId: string): Promise<SynergyStressTest>;
  getFounderRead(dealId: string, acquirerId: string): Promise<FounderRead>;
  getCultureMatrix(dealId: string, acquirerId: string): Promise<CultureMatrix>;
}
```

> **Per-deal content (2026-07-10).** The content seam is deal-scoped: the sandbox
> deal (Project Summit = the Atlassian dataset, imported byte-for-byte from
> `fixtures.ts`, so the locked 87/67 composite floor is preserved) and Project
> Harbor (GitLab) each resolve their own dataset; unknown/created deals fall back
> to the sandbox for market content and to an honestly-empty room for documents.
> The registry is `src/lib/api/datasets.ts`; per-deal Working Group + Data Room
> manifests follow the same keyed-lookup pattern.

---

## Scoring factors

The `FinancialFactors` and `CultureFactors` fields feed the composite score. For
factor definitions, weights, and the formula, see
[`../02-product/matrices.md`](../02-product/matrices.md).

---

## Panel kinds

The three `PanelData` discriminants map directly to the three skill panel types:

| `kind` | Panel component | Primary input |
|---|---|---|
| `financialMatrix` | `FinancialMatrixPanel` | `Company.financials` |
| `cultureRadar` | `CultureRadarPanel` | `CultureFactors` |
| `scoreBreakdown` | `ScoreBreakdownPanel` | `CompositeScore` |

---

## Compliance status states

`ComplianceStatus` governs the `ComplianceRibbon` display. For the full state
descriptions and transition model, see [`../02-product/matrices.md § 1`](../02-product/matrices.md).

---

Source: design spec § 9; plan File structure "Type contract" block + Task 1.2

---

## Governed entity contract (S0.2)

One authoritative mapping from the handbook's domain entities to what actually
ships — the persisted platform schema (`supabase/migrations/`, ADR-0008 lineage)
and the in-spine orchestration types (`src/lib/orchestration/types.ts`, #42).
Nothing here invents a contract: where an entity is not persisted, that is a
recorded decision (D35), not an omission.

| Handbook entity | Persisted schema (platform layer) | Orchestration type (spine layer) | Status |
|---|---|---|---|
| **Deal** | `deals` (+ `deal_parties`, `deal_memberships`, conflicts attestation columns) | `DealBrief` (the envelope's deal view) | Persisted |
| **Phase** | Derived, not stored: the rail census maps `deals.current_step_seq` → step id → phase (`stepIdForSeq` → `phaseForStep`); `deal_memberships.phase` gates member access per phase | — | Derived by design |
| **Task** | `deal_steps` + step assignment/progress (the manual execution rail, #150) — the HUMAN task census | `Job` / `JobRecord` — the AGENT task, in-spine only | Split: human tasks persisted, agent jobs in-spine |
| **Approval** | Evidence persisted in `audit_log` (`attest`, `advance`, `release`, `reject`) + `deals.conflicts_approved_by/on` | `Gate` (`plan`/`signoff`) + `GateDecision` (`clear`/`hold`/`block`) | Evidence persisted; gate model in-spine |
| **Communication** | `outbound_messages` / `inbound_messages` + audit rows (`screen`, `send`, `release`, `reject`) — the compliant mail channel (#126) | `ComplianceMonitorEntry` + the pre-send gate | Persisted |
| **Artifact** | `documents` (+ storage reconcile, Box dataroom) | `DealDocument` / `EnvelopeDocument` (envelope projections) | Persisted |
| **Run** | — | `JobRecord`, `WorkflowState`, `AuditEvent` | In-spine only |

**Called-out gaps (deliberate, per D35 — revisit when agents go live):**

- `Phase`, `Run`, and the agent-side `Task` (`Job`) have no tables. The
  handbook's `Deal → Phase → Task → Run` lifecycle stays a domain model; the
  human workflow persists through the rail (`deal_steps`), and agent execution
  records will need persistence only when the isolated agent service (RTS
  integration, #167) starts writing through the platform.
- `Approval` persists as audit evidence, not as a first-class table — a gate
  decision is reconstructable from `audit_log`, which is WORM by design.
- The three layers stay side by side, none inside another: content seam
  (`ConductiaAPI`), platform contract (`/api/v1` + schema), governed spine
  (`src/lib/orchestration/`).

### Outbound recipient boundary (#171)

`outbound_messages.recipient_boundary` is nullable text constrained to `internal`,
`external`, or `unverified`. It records the server's send-time classification of
all To/CC/BCC domains against the sender company's verified-domain policy.
Historical NULL is not recorded; no backfill or inference from current domains.
The outbox API exposes it as `recipientBoundary`. It is independent of risk band,
working-group membership and send authorization. See the API recipient policy
section and migration `20260921160000_outbound_recipient_boundary.sql`.


## Platform recipient affiliation register (D60)

`deal_recipient_affiliations` is platform persistence, outside ConductiaAPI.
Unique `(deal_id, normalized_email)` rows record tenant, company, one member or
invitation reference, explicit four-value affiliation, optional represented party,
revision and administrative actor/timestamps. Only service-role RPCs are exposed;
public and authenticated direct access is revoked. Assignment and audit are atomic.
Current membership/company/invitation lifecycle is rechecked at send time, so an
old assignment alone cannot authorize confirmation-free sending.

`outbound_messages.recipient_review` is nullable JSON evidence of the decisions
on the normal committed outgoing message. Historical rows remain NULL. No extra
abandoned-message or recipient-preflight record is created. Signed tokens contain
a message digest and policy fingerprint, no plaintext message or numeric risk.
Migration: `20260922100000_deal_recipient_affiliations.sql`; Rob applies it before
deploying the recipient routes. See [API contracts](./api-v1.md#deal-recipient-relationships-d58--172).
