# Skill execution transport — spike results

> Status: spike on `feat/skill-execution-spike` (off `develop`). Backend + tests
> only, no UI. Owners: Marcelo (orchestration) + Roberto (platform). Input to
> the in-platform vs. separate-service architecture decision from the
> 2026-07-13 FP/RTS sync.

## The question

Skills (RTS) and the platform (FP) must communicate end to end: create a deal,
run the Target Universe skill, get a populated page back. Two candidate
architectures were on the table at the sync:

- **In-platform** — agents run inside the Next.js app (e.g. via Mastra),
  suggested by Svetozar.
- **Separate service** — the API calls out to a skill service and gets a
  structured response back, proposed by Roberto.

## What the spike proves

The choice is not an either/or platform decision — it is a per-skill deployment
detail behind the existing `CapabilityAgent` contract (orchestration spine,
`skill-authoring-rules.md` rule 1). Evidence, all test-backed:

| Piece | File | Proves |
|---|---|---|
| Fake skill | `src/lib/orchestration/agents/target-universe-agent.ts` | The first RTS-shaped skill (fixed fields: sector / geography / ownership / growth) conforms to the contract with zero spine changes |
| Paired reviewer | `src/lib/orchestration/agents/target-universe-review-agent.ts` | Deterministic reviewer gates output before a human sees it (rules 5–6) |
| Single-skill runner | `src/lib/orchestration/skill-runner.ts` | One-step execution with the full governance set: sealed envelope, out-of-envelope halt, reviewer gate, structured audit events |
| HTTP adapter | `src/lib/orchestration/transport/http-skill-agent.ts` | The same contract over HTTP — the spine cannot tell a remote skill from a local one |
| Wire format | `src/lib/orchestration/transport/wire.ts` | The report side-channel survives transport: remote entries are replayed locally, so the monitor halts a rogue *remote* skill identically (proven in `tests/orchestration/http-skill-agent.test.ts`) |
| Service stub | `src/app/api/skill-service/route.ts` | The remote side is two types (`SkillWireRequest`/`SkillWireResponse`); dev-only, 404 in production |

## The recommendation

**Adopt the contract as the boundary, defer the topology.** Because
`HttpSkillAgent` makes the deployment choice reversible per skill:

1. Start in-process (cheapest; the MVP needs no AI, so no new infra for a
   bonus), running skills through `runSkillOnce`.
2. If/when Storm's client-side-deployment question resolves toward isolation,
   move skills behind the wire format — the spine, envelope, reviewer, and
   audit are unchanged by construction.
3. Mastra remains an implementation option *inside* a `CapabilityAgent`, not
   an architecture: evaluate it when a skill needs real LLM plumbing.

## Security note

The envelope is serialized onto the wire already permission-filtered (MNPI
withheld upstream), and the monitor governs remote skills through report
replay. The prompt-injection concern raised in #resources-intelibank
(2026-07-14, Rogo executing AI commands from email) is structurally excluded:
a skill can only see pushed context and cannot route around the halt.

## Open items

- The `/api/v1` producer endpoint (auth'd platform entry: deal → `runSkillOnce`
  → JSON for the UI) — coordinate with Roberto's G2 lifecycle columns
  (`entry_step_seq`/`current_step_seq`) for the envelope's step info.
- Report replay is post-hoc over HTTP (entries arrive after the run, not
  streamed); acceptable for single-shot skills, revisit for long-running ones.
- Skill registry is a hardcoded map in the stub; a real service needs the
  approval states from `skill-authoring-rules.md` (`draft → in review →
  approved`).
