# Agent orchestrator spine

> Status: shipped on `feat/agent-orchestrator-spine` (off `develop`). Backend + tests only, no UI.
> The runtime that turns a banker request into a governed sequence of sub-agent
> steps, with compliance supervision, scoped context, and explicit sign-off.
> One workflow ("Prepare the teaser") is proven end to end; real capability
> agents plug in behind the contract with zero spine changes.

## Where it sits

A new third layer, beside the two existing contracts, not inside either:

- `ConductiaAPI` seam (`src/lib/api/`) — M&A product content. Untouched.
- `/api/v1` REST spine (`src/app/api/v1/`) — platform identity, deals, audit. Untouched.
- **`src/lib/orchestration/`** — the agent governance runtime. New.

It reuses, never forks, what already exists: the compliance rule pack
(`src/lib/compliance/screen.ts`, ADR-0003) and the permission + document
sensitivity model (`src/lib/api/v1/access.ts`, `src/lib/constants/documents.ts`).

## The eight decisions, mapped to code

1. **The Job is the universal primitive.** `Job` (`types.ts`) carries `goal`,
   `dealId`, `requestingActorId`, `completionCondition`, `stakes`. The copilot is
   just the first producer; the sweep agent is a later one. The spine consumes Jobs.
2. **Deterministic orchestrator, agentic nodes.** `Orchestrator` (`orchestrator.ts`)
   is an inspectable state machine that selects a pre-built skeleton
   (`workflows/teaser.ts`). Intelligence lives in the nodes, not the conductor.
3. **Durable, resumable.** Every transition calls `recordEvent` and persists via
   `JobStore` (`audit.ts`). `resume(jobId)` continues from the store; a fresh
   `Orchestrator` instance picks up a paused job (proven in `plan-confirm.test.ts`).
4. **Leashed actors.** Each agent gets a sealed envelope, a goal, a completion
   condition, and a mandatory `report` channel to the supervisor (`contract.ts`).
5. **Context pushed, never pulled.** `assembleEnvelope` (`envelope.ts`) filters
   candidate documents by deal scope, phase, and classification (MNPI hidden from
   non-MD/CCO) before handing them over. An agent can only see what it was given.
6. **Compliance is a supervisor over the graph.** `ComplianceSupervisor`
   (`compliance/supervisor.ts`): a hard pre-send `gate()` wrapping `screenMessage`
   (clear/hold/block), and an `inspect()` monitor that halts any agent whose
   reported `saw` exceeds its envelope.
7. **Model routing by importance.** `selectModel` (`model-router.ts`) routes the
   external-facing draft to the frontier tier and internal research to a cheap
   tier; `TokenMeter` records spend per agent/deal/actor as a first-class metric.
8. **Stakes split drives autonomy.** High-stakes jobs pause at `AWAIT_PLAN_CONFIRM`
   before running and at `AWAIT_SIGNOFF` before the artifact leaves; both advance
   only on an explicit `approve()`.

## The state machine

```
INTERPRET -> PLAN -> [AWAIT_PLAN_CONFIRM] -> RESEARCH -> DRAFT
          -> COMPLIANCE_SCREEN -> [AWAIT_SIGNOFF] -> COMPLETE
```

Terminals: `BLOCKED` (compliance hard stop, artifact never set), `HALTED` (monitor
killed a rogue agent), `FAILED`. The compliance verdict maps as the kickoff
specifies: `compliant -> clear -> advance`, `hold -> route to human`,
`blocked -> BLOCKED`. Note: the `hold`/MNPI path carries no rewrite by design
(human judgment); only `blocked` carries one. We surface whatever rewrite the rule
pack returns rather than fabricate one.

## The agent contract (the swap seam)

```
input:  { goal, envelope, completionCondition, model, report }
output: { result, auditRecord: { saw, did, why, modelUsed, tokens },
          status, completionAssertion }
side:   every agent emits to report() — the compliance channel
```

`ResearchAgent` and `DraftAgent` (`agents/`) are deterministic mocks implementing
this. A real PowerPoint or modeling agent (in-house or third-party) implements the
same `CapabilityAgent` and drops in with no spine change. The draft agent is
deterministic so the spine's tests stay hermetic; a real model call slots in behind
the same contract and envelope.

## Audit + replay

The whole run is reconstructable from the structured event log alone. `reconstruct`
(`audit.ts`) rebuilds the ordered states, every agent's saw/did/why/model/tokens,
the compliance decision, the approved gates, total token spend, and the terminal
state. The audit trail covers agents, not just users (FINRA cares about rogue
agents).

## Tests (10 files, all under `tests/orchestration/`)

| File | Proves |
|---|---|
| `envelope-scope.test.ts` | push-not-pull floor: scope + phase + MNPI gating |
| `compliance-supervisor.test.ts` | clear/hold/block + monitor halt |
| `model-router.test.ts` | tier-by-importance + token metering |
| `agents.test.ts` | mock agents conform to the contract |
| `audit.test.ts` | store durability + event replay |
| `teaser-happy.test.ts` | Job -> COMPLETE, scoped to one deal + actor |
| `teaser-blocked.test.ts` | promissory draft -> BLOCKED, never leaves |
| `plan-confirm.test.ts` | high-stakes halt + cross-instance resume |
| `monitor-halt.test.ts` | rogue agent -> HALTED, no artifact |
| `audit-replay.test.ts` | full run reconstructable from the log |

## Deliberately out of scope (this branch)

The sweep agent / scheduling; real PPT or modeling agents; auth, the data room,
any new UI surface; a `/api/v1/jobs` producer route; a real FINRA rule engine;
multi-workflow orchestration. The point is a provable governance spine, not breadth.
The obvious next seams: a `/api/v1/jobs` Job producer, and a Supabase-backed
`JobStore` mirroring events into `audit_log`.

## Open proposals (from the team — NOT yet accepted)

> **Status.** Captured from a Slack thread (Marcelo Gumiero, orchestration side).
> These are **proposals to validate, not decisions.** They touch the `RailStep`
> type and the step census (which is a locked invariant: DEAL_RAIL = 65 /
> GATE0 = 4 / ALWAYS_ON = 21). **Do not implement without Storm/Lance sign-off and
> an explicit re-census** — Marcelo's own note is that this "can turn into a small
> PR once Lance's plan lands." Recorded here so the thinking isn't lost.

### Proposal 1 — a step *kind* orthogonal to *actor*

Today `RailStep.actor` answers *who acts* (human / agent / both). The proposal adds
`RailStep.kind` to answer *what kind of step* it is, mapping to Lance's pre-deal
model (skip / assign to human or agent / deadline + priority):

- **`draft`** (AGENT-DRAFT) — a skill produces the artifact, a paired reviewer agent
  checks, a human approves. Reuses the teaser spine as-is.
- **`receive`** (UPLOAD + CONFIRM) — an external system produces the artifact; the
  agent only verifies it landed (presence / metadata) and files it. **Distinct from
  `offPlatform`** (a no-artifact checkbox): an invoice is a real artifact that must
  land *and* be retained. This is the one genuinely new primitive.
- **`action`** (HUMAN / OFF-PLATFORM) — no agent; the orchestrator tracks status +
  deadline only.

Marcelo's read of the repo: `RailStep` already carries `owner`/`actor`/`skill`/
`reality`/`offPlatform` and the spine already runs the stakes rule, so this is
"almost no build" — one orthogonal field plus a handful of steps.

### Proposal 2 — close the fee / lifecycle gaps

Fee items, classified (to validate): fee negotiation → `action` (MD judgment,
off-platform); retainer invoice at mandate → `receive`; **fee letter → `draft`**
(on-brand doc, same shape as the NDA); transaction invoice at close → `receive`.

Lifecycle gap flagged: **mandate win (off-platform) and payment at close should
still exist as tracked steps** even with no agent behind them — otherwise the spine
is incomplete and fee / audit tracking never closes.

Proposed DEAL_RAIL additions (⚠️ would change the 65-step census — re-census first):
Phase 0 — fee letter (`draft`), retainer invoice (`receive`); closing phase —
transaction invoice (`receive`) + four "marketing at closing" drafts (Press
Release, LinkedIn Post, Email to Outlets, Case Study) — content generation with
human approval, new skills outside the core 16, add to the map as later-phase.

### Already resolved (not open)

- **WGL → `deal_memberships`** mapping (seller-side ~2 records; buyer-side fills per
  deal): agreed, and implemented in WS3 as `SEED_WGL` (`src/lib/wgl/workingGroup.ts`),
  later removed when Team was unified on `deal_memberships` (#137).
- **"00. Received from Client" empty** on the sample: for Dan / Ignatius to confirm —
  likely the intake hadn't happened for that sample, not a schema issue.

## See also

The engineering handbook ([`intelibank-handbook.html`](./intelibank-handbook.html)) is the domain + governance
narrative this spine implements (the invariant, the `Job`/sealed-envelope/Pre-Send-QC
model, the FINRA/SEC rulebook). The handbook↔code vocabulary mapping and the
three-layer architecture (content seam · `/api/v1` platform · this spine) are
reconciled in `docs/07-decisions/decision-log.md` **D35**.
