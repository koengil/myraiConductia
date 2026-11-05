> **Superseded / historical.** Frozen at 2026-05-19 for the `build/intellibank-sandbox` era (no remote, no push, no squash). The branch, PR, squash-merge and CI rules that apply today are in `delivery-model.md`; the code-style sections below still hold.

# Conventions — Conductia Sandbox

Coding standards, commit discipline, and project-level rules every contributor
(human or agent) must follow. Non-negotiable; each item has a concrete reason.

---

## TypeScript

**Strict mode.** `tsconfig.json` sets `"strict": true`. No exceptions, no `any`
escape hatches. The type contract in `src/lib/api/types.ts` is the source of truth;
every file references those identifiers exactly as defined.

Source: plan Task 1.1

---

## File size and responsibility

One responsibility per file. Small and focused. Examples:

- `src/lib/api/types.ts` — domain types only; no logic.
- `src/lib/api/fixtures.ts` — fixture data only; no behaviour.
- `src/lib/scoring/composite.ts` — the pure scoring function only.
- `src/lib/compliance/screen.ts` — the pure compliance rule screen only.

If a file is doing two things, split it. This is not style preference — it keeps
subagent work integrable without merge conflicts and keeps each module independently
testable.

Source: plan Rigor convention

---

## Testing strategy

**Phase 1 logic — strict TDD.** Full failing test first, then run to confirm failure,
then minimal implementation, then run to confirm pass, then commit. No skipping steps.
Logic tasks are the contract; correctness is non-negotiable.

**Phases 2–6 UI — contract + smoke.** Each component is built to a stated prop
interface and a stated `ConductiaAPI` call. Render tests assert key visual states
and data presence. No vague acceptance criteria.

Source: plan Rigor convention

---

## Commits

Conventional commits. One commit per task. Format:

```
<type>(<scope>): <subject>
```

Common types: `feat`, `fix`, `chore`, `polish`, `docs`, `test`. Examples from the
plan: `feat: domain type contract`, `feat: deterministic composite scoring`,
`chore: scaffold next.js + vitest`.

Every commit includes the Co-Authored-By trailer:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

No squashing, no amending after push (there is no push — see below).

Source: plan Rigor convention; spec § 12

---

## Branch

Active branch: `build/intellibank-sandbox`

All implementation work lands here. No other branch is created unprompted.

---

## Remote and collaborators — Lance's checkpoint (D3)

**Do not create a GitHub remote. Do not push. Do not add collaborators.**

The GitHub remote creation and collaborator invite (Martín, username pending via
WhatsApp) are explicitly Lance's checkpoint. The agent stays local until Lance runs
the commands himself. The exact commands for Lance are documented in
`docs/superpowers/plans/2026-05-19-intellibank-sandbox/master.md` (Task 7.3).

Source: decision-log D3; plan Rigor convention + Task 7.3

---

## DRY / YAGNI

Build only what the golden path (spec § 5) needs. Any non-golden-path control that
has not been built renders as a captioned "Not in this demo" stub — never a crash,
never an empty white box. Scope creep beyond the active phase is a plan violation.

Source: plan Rigor convention; design spec § 12

---

Source: plan Rigor convention; decision-log D3; design spec § 12
