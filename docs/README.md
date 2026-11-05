# Conductia Docs — The Map

This `docs/` tree is co-equal with the code. It exists so that any product,
engineering, brand, or growth contributor — human or agent — can orient in
~60 seconds and build on a traceable foundation rather than tribal memory.

## Folders

| Folder | For | Contains | Status |
|---|---|---|---|
| `00-vision/` | Leadership, all teams | The 5–10yr north star, compliance-first thesis, moat vs. competitors | Distilled |
| `01-business/` | Business, GTM | Market & opportunity, competitive landscape (Rogo, SLM player), monetization & skills economy, stakeholders | Distilled |
| `02-product/` | Product, design, eng | Product principles, personas & jobs, the experience spine, skills catalog, the three matrices, [Labor Day MVP scope](./02-product/labor-day-mvp-2026-08-03.md) | Distilled |
| `03-engineering/` | Engineering | Architecture, data contracts, [delivery model](./03-engineering/delivery-model.md), [GitHub project triage log](./03-engineering/github-project-triage-2026-08-04.md), [Phase 1 API](./03-engineering/api-v1.md), [orchestration spine](./03-engineering/orchestration-spine.md), [browser E2E](./03-engineering/e2e-testing.md), [AI review](./03-engineering/ai-review.md), [handbook](./03-engineering/intelibank-handbook.html), [#173 demo rehearsal write-up](./03-engineering/demo-rehearsal-173.md) (Oct 30 go/no-go, Proposed) | Distilled |
| `04-operations/` | Engineering, ops | [Production bootstrap](./04-operations/production-bootstrap.md) (env, migrations, first org), [setup readiness](./04-operations/setup-readiness.md), [discovery worker on AWS](./04-operations/discovery-worker-aws-runbook.md) (Ignatious account, #344), [dev Google Workspace setup](./04-operations/dev-google-workspace-setup.md) (synthetic-mail Workspace; first-day T1, Gmail send and seeded dry-run checks), [GitHub security runbook](./04-operations/github-security-runbook.md) (owner steps for alerts, secret scan and SLAs, #473), [demo-day switch checklist](./04-operations/demo-day-switch-checklist.md) (Oct 30 switches, order and rollback, #173) | Current |
| `04-brand/` | Brand, design | Brand foundations, visual language, motion language | Distilled |
| `05-growth/` | Growth, sales | Positioning narrative, the demo script (golden path) | Distilled |
| `06-research/` | All teams | M&A research substrate underpinning the analytical panels: synergy base rates, Bain culture fault lines, May-2026 Atlassian financials | Populated 2026-05-20 (Phase D sandbox merge); figures NEEDS-VERIFICATION before external use |
| `07-decisions/` | All teams | ADRs + decision log — why we chose what we chose | Seeded |
| `08-security/` | Leadership, engineering, sales | [SOC 2 Type I program](./08-security/soc2-type1-program.md) (Vanta; scope, timeline, owners) and the [control register](./08-security/soc2-control-register.md) (current state, evidence, gaps), plus the [SOC 2 documents](./08-security/soc2-documents/README.md) uploaded to Vanta | Started 2026-10-13 |
| `99-source/` | All teams | Raw, verbatim founder/team inputs — **never edited** | Seeded |
| `design/workbench/` | Design + frontend | The Workbench register of record: handover, kit, component map, brand spirit, icon mapping (D48) | Seeded |
| `superpowers/specs/` | All teams | The approved design of record | Seeded |
| `superpowers/plans/` | Execution | The durable implementation ledger — **read FIRST on resume** | Created at planning step |

## Provenance principle

We do **not** dump transcripts into team docs. Raw inputs are preserved
verbatim under `99-source/`. Team docs (`00`–`06`) are *distilled*: accurate,
concise, structured — and every non-obvious claim is traceable back to a
`99-source/` file. "Why compliance-first?" → `00-vision/` → cites the founder
call. This traceability is what makes this repo a *foundation*, not just code.

## Engineering handbook (`03-engineering/intelibank-handbook.html`)

The **engineering team handbook**: the onboarding + domain + governance reference.
It names *the invariant* (agents draft/propose; humans + deterministic code
decide/gate/approve/release), the five-stage deal lifecycle, the FINRA/SEC rulebook,
the governed-backend model, and build-vs-plug-in. Post-#42 that governance model is
the **shipped** orchestration spine (`src/lib/orchestration/`,
`03-engineering/orchestration-spine.md`); the handbook is that layer's design
narrative, which is why it lives in `03-engineering/` (moved out of the repo root on
2026-06-25). The full reconciliation with this sandbox-shaped doc tree (surfaces, the
9-role hierarchy, the 2026-06-07 data-room pivot) is in
`07-decisions/decision-log.md` **D35**. Its internal `→ Reference` pointers cite a
"blueprint-engineering pack (files 00–08)" that does **not** live in this repo;
`/docs` is the canonical doc tree.

## Reading order

1. `/README.md` + `/AGENTS.md` (repo root) — current state, the thesis, engineering invariants and working rules. Start here.
2. `07-decisions/decision-log.md` + ADRs — the locked decisions and why (incl. ADR-0013 Labor Day MVP scope lock).
3. MVP 2 (ships Oct 30, 2026): the written scope is not on `develop` yet (PR #146 closed unmerged) and is to be recorded as a decision; weekly gates are the repo milestones. `02-product/labor-day-mvp-2026-08-03.md` is the delivered predecessor.
4. `03-engineering/delivery-model.md` — `develop` = done, GitHub project fields.
5. `99-source/` — what was actually said (ground truth, verbatim, never edited).
6. `00`–`05` team docs — distilled, role-specific (vision, business, product, engineering, brand, growth).
7. `06-research/` — the M&A research substrate behind the analytical panels (figures `NEEDS-VERIFICATION` before external use).
8. `superpowers/specs/` + `superpowers/plans/` — the original design of record + execution ledgers. Note: the *aesthetic* design of record (Editorial Institutional) is superseded by ADR-0006 (navy register), the 2026-05-24 AI-native shell redesign, and then D48 (`design/workbench/`, the current register); read it for product/IA history, not current visuals.

## Historical, point-in-time (each bannered at the top)

Kept for traceability (the ADRs and ledgers cite them); they record past states, not the current one:

- `archive/FINAL-VERIFICATION.md` — pre-merge front-end overhaul close-out.
- `archive/MERGE-FINAL-VERIFICATION.md` — sandbox-merge close-out.
- `archive/MERGE-REVIEW.md` — the A-vs-B repo review that scoped the merge.
- `archive/VISUAL-REVIEW.md` — the visual critique that drove the navy register pivot (ADR-0006).
- `archive/README.md` — index of the above.
- `superpowers/archive/` — the original sandbox build's plan + spec.

## Oct 22, 2026 product walkthrough

What the walkthrough asked for, what the `feat/walkthrough-refinements` branch built, and what it left for engineers, Storm and Marco:

- [What changed](./02-product/walkthrough-changes-2026-10-22.md): one plain-language page for the whole team.
- [Engineer handoff](./03-engineering/walkthrough-handoff-2026-10-22.md): every database, permission and server item, with the questions for Storm, Marco and counsel. The branch made no database or permission changes.
- [Principles and lessons](./02-product/walkthrough-principles-2026-10-22.md): the rules the walkthrough set, with the meeting quote, how to apply each, and an example.
- [Rail multiplayer and dependencies proposal](./02-product/rail-multiplayer-and-dependencies-proposal.md), with its [interactive prototype](./prototypes/rail-multiplayer/index.html).
- [Designer pack for Marco](./design/walkthrough-designer-pack-2026-10-22.md) and the [user flow map](./design/user-flows/index.html), As-is and To-be.

## Status legend

- **Distilled / Seeded** — exists now, foundation laid.
- **Populated** — filled from a contributor's input (e.g., 06-research).
