# skills-library

Incoming **vertical skill libraries** from partner firms — the reference/build
input that RTS and Futureproofing map onto the platform's rail steps and run
through the orchestration spine.

**This is reference material, not application code.** Nothing here is imported by
or wired into the Next.js app; it cannot affect the running product. Skills are
`SKILL.md`-defined units of capability (prompts + references + occasional helper
scripts) that the platform *executes* via the orchestration spine
(`docs/03-engineering/orchestration-spine.md`), governed by the skill contract
(`docs/02-product/skill-authoring-rules.md`).

## Contents

| Folder | Source | Start here |
|---|---|---|
| `ignatious/` | Ignatious skills handoff for RTS (Dan Dima-ala, 2026-07-09) | `ignatious/INTEGRATION.md` (our map) → `ignatious/WALKTHROUGH.md` (their verbatim doc) |

## Conventions

- **Text only.** `SKILL.md`, reference `.md`, helper scripts, manifests. Large
  binaries (branded templates, sample decks, logos) stay in the partner's shared
  asset store — referenced by path, never committed (they bloat the repo and
  aren't version-controllable).
- **Verbatim preservation.** Partner skill files are kept as-received; our
  analysis lives in a separate `INTEGRATION.md` per source, never edited into
  their files.
- **Provenance labelled.** Each source's `INTEGRATION.md` flags what is the
  partner's proprietary IP vs. forked/third-party, and its maturity.
