# Co-pilot Surface and Action Map — "Prepare the teaser"

Status: draft for team discussion (2026-06-18). Author: Marcelo.

## Why this doc exists

At the 2026-06-17 sync Lance named the week's discovery goal:

"what information is surfaced to the user vs what actions a user needs to take, and when."

This doc answers that question for one workflow, grounded in the orchestrator that is
already merged (PR #42, `src/lib/orchestration/`). It is information architecture, not
UI. No screens are proposed here. The point is to settle WHAT the co-pilot surfaces and
WHEN the human is interrupted, so that whoever builds the surface later builds the right
thing.

We use "Prepare the teaser" because it is the one workflow proven end to end in the
spine (`workflows/teaser.ts`), so every state below is real, not invented.

This doc is the experience/IA side of Martín's engineering walkthrough of the spine (the
"Spine Presentation" deck and `orchestration-spine.md`): his deck is the engine, this is
what the human sees and when, across the same states. Same vocabulary, two halves.

## The core finding: surfacing is continuous, action is rare

The orchestrator runs ten states. The human is asked to act in only three of them.
Everything else is ambient progress the MD can glance at or ignore.

```
                  AMBIENT (watch)                 ACTION (act)
INTERPRET   ───────────●
PLAN        ───────────●
AWAIT_PLAN_CONFIRM ─────────────────────────────────◆  (high-stakes only)
RESEARCH    ───────────●
DRAFT       ───────────●
COMPLIANCE_SCREEN ─────●
AWAIT_SIGNOFF ───────────────────────────────────────◆  (anything leaving the firm)
COMPLETE    ───────────●
BLOCKED     ─────────────────────────────────────────◆  (compliance recovery)
HALTED      ───────────●  (security alert, eng/CCO not MD)
FAILED      ───────────●

●  surfaces, no interruption          ◆  the MD must do something
```

That asymmetry IS the co-pilot thesis. This is not a chat where the user drives every
turn. The agents drive; the MD reviews a glanceable stream and is pulled in only at the
three gates that carry firm risk. A good surface makes the ● stream skimmable and the
three ◆ moments impossible to miss.

## State-by-state map (teaser workflow)

| State | What the conductor/agent does autonomously | What surfaces to the MD (ambient) | Action the MD must take | When it happens |
|---|---|---|---|---|
| INTERPRET | Matches the goal to a pre-built skeleton; if none, fails fast | "New job: Prepare teaser for [deal]" | none | Job created (the co-pilot produces it via the planned `/api/v1/jobs` route; the async sweep agent later) |
| PLAN | Picks a model tier per step (research, draft) by stakes | The plan: the steps and model tier each will use | none if low-stakes | Immediately after interpret |
| AWAIT_PLAN_CONFIRM | Pauses | "Plan ready for approval" + the plan | Approve the plan (one tap) | High-stakes jobs only |
| RESEARCH | Research agent runs inside a sealed envelope; monitor watches scope | "Researching comps and market read…" | none | After plan (or after confirm) |
| DRAFT | Draft agent writes the teaser from research findings | "Drafting teaser…", then a draft preview | none (review is held to sign-off) | After research |
| COMPLIANCE_SCREEN | Supervisor screens the draft: clear / hold / block | The verdict: clear, hold with reasons, or block with reasons + a suggested rewrite | none yet (unless blocked) | After draft |
| AWAIT_SIGNOFF | Pauses | The draft + the compliance verdict (and the caution, if "hold") | Sign off to release, or reject | Anything leaving the firm (teaser always; `externalFacing: true`) |
| COMPLETE | Sets the final artifact, logs completion | "Teaser ready / sent" + a one-line audit summary | none | After sign-off |

### Terminal outcomes the surface must handle

| Terminal | What it means | What surfaces | Who acts |
|---|---|---|---|
| BLOCKED | Compliance hard stop | "Blocked: [reasons]" + suggested rewrite | MD revises and re-runs |
| HALTED | The monitor killed an agent that reached past its envelope | "Halted: agent reached outside its scope" | Eng / CCO, not the MD. This is the security signal |
| FAILED | No skeleton matched, or an agent did not complete | "Couldn't complete: [reason]" | MD retries or adjusts the request |

## The three action moments (the only interruptions)

1. Plan confirm. Only for high-stakes jobs. A one-tap approval before any agent runs.
2. Sign-off. For anything that leaves the firm (the teaser always qualifies). The MD
   reviews the draft plus the compliance verdict and releases it.
3. Block recovery. When compliance blocks, the MD sees the reasons and a rewrite and
   decides what to do.

If the surface gets these three moments right, the rest is a readable activity feed.

## The autonomy dial = stakes

The same spine behaves very differently by the job's `stakes`, and this is exactly the
"what does the agent do alone vs what needs a human" question Lance raised:

```
LOW stakes,  internal  →  INTERPRET → PLAN → RESEARCH → DRAFT → COMPLIANCE_SCREEN → COMPLETE
                          (zero human gates: fully autonomous)

HIGH stakes / external  →  ... PLAN → [CONFIRM] → ... → COMPLIANCE_SCREEN → [SIGN-OFF] → COMPLETE
                          (two human gates: confirm the plan, sign off the output)
```

So "how proactive can the agent be" is not a vibe, it is a property of the job. The
co-pilot can run low-stakes internal work to completion on its own and reserve the MD's
attention for the high-stakes, outward-facing moments.

## Model routing and cost are surfaced per step (from the live demo)

Running `npm run demo:spine` makes the model-tier decision visible per agent, which is
Storm's "spend on the critical 10%, save on the rest" made concrete:

```
ResearchAgent [economy, 1200 tok]   ← routine step, cheap tier
DraftAgent    [frontier, 3400 tok]  ← outward-facing draft, top tier
tokens: 4600 (meter: 4600)
```

So the co-pilot can surface, per job, both what tier each step used and what it cost. This
is the seed of the per-deal token view flagged as a later priority. One more detail worth
keeping for the compliance-cost story: a halted rogue agent is metered 0 tokens
(containment is free, the killed agent is never billed).

## What this implies for the future surface (not to build yet)

- The dashboard is an activity feed of jobs by state, with the three action moments
  promoted to a clear "needs you" lane. This matches what Martin described as the "job
  explorer" and what Lance demoed (a queue of cases needing attention vs. in-progress).
- Every surfaced line is already in the audit log (`AuditEvent`), so the feed is not new
  data, it is a render of events the spine already emits. Surface follows the spine. Per
  Martín's deck ("Next seams"), the planned Supabase-backed JobStore mirrors these events
  into `audit_log` and the co-pilot produces Jobs via `/api/v1/jobs`, so the dashboard
  reads the mirrored log rather than inventing a new data source.
- The token meter (`model-router.ts`) already records spend per agent/deal/actor, which
  is the seed of the per-deal cost view flagged as a later priority.

## Open questions for the team

1. A compliance "hold" routes the draft to the human sign-off gate with the caution
   attached (Martín's deck: "hold routes to a human"). Open: is "hold" overridable by the
   MD at sign-off like a clean draft, or should a held draft demand a stricter action
   (e.g. apply the suggested rewrite first)? Worth a decision.
2. BLOCKED recovery: does the MD edit the draft directly, or only re-run with a tighter
   brief? This shapes whether the surface needs an editor.
3. For the asynchronous sweep agent (the 12 to 24h proactive sweep), which job types are
   allowed to run to COMPLETE unattended, and which must always wait at a gate even when
   low-stakes?

## Source grounding

- States and order: `src/lib/orchestration/types.ts` (`WorkflowState`), `orchestrator.ts`.
- Gates: `orchestrator.ts` (`AWAIT_PLAN_CONFIRM` for high-stakes; `AWAIT_SIGNOFF` for
  `externalFacing` or high-stakes).
- Teaser skeleton: `workflows/teaser.ts` (`externalFacing: true`).
- Compliance verdict (clear/hold/block + rewrite): `compliance/supervisor.ts`,
  `orchestrator.ts` COMPLIANCE_SCREEN.
- Surfacing feed = `AuditEvent` stream in `types.ts` / `audit.ts`.
- Discovery goal: Lance, #external-intelibank, 2026-06-18; 2026-06-17 internal sync notes.
- Engine-side companion: Martín's "Spine Presentation" deck (diagram 2 = this state map;
  "Next seams" = the `/api/v1/jobs` producer + Supabase JobStore) and `orchestration-spine.md`.
