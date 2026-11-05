# Building a Skill for Conductia — the Rules (v1)

> The "app-store rules" for our platform. If you want to build a skill that runs
> on Conductia — whether you are on the RTS team or a future third party — this
> is the contract your skill must meet to be accepted, governed, and safe to run
> on a live M&A deal. One page. Read it before you build.

**A skill** is the unit of work at a single step of the deal rail: it takes
defined inputs, does one job, and produces a banker-grade deliverable
(a teaser, an NDA redline, a buyer screen, a diligence answer). The platform
runs 65 steps across five phases; a skill powers one of them.

## The prime directive

**Banking in the front, AI in the back.** The banker never picks a model,
configures a prompt, or sees your plumbing. Your skill just runs and produces
work the MD would sign. And: **agents draft and propose; humans and deterministic
code decide, gate, approve, and release.** A skill never has the final word on
anything that leaves the firm.

## The seven rules

**1 — Implement the agent contract.** A skill is a `CapabilityAgent`. It receives
`{ goal, envelope, completionCondition, model, report }` and returns
`{ result, auditRecord, status, completionAssertion }`. Conform to this exactly
and your skill drops into the orchestration spine with zero platform changes.
(Reference: `docs/03-engineering/orchestration-spine.md`.)

**2 — Declare your io contract up front.** Every skill states its
`inputs → transformation → outputs`, plus `constraints` (what must never happen).
This is the same shape every rail step already carries (`RailStep.io`). No hidden
inputs, no undeclared outputs. If it is not in your contract, you do not touch it.

**3 — See only what you are given.** Context is *pushed*, never pulled. The
platform hands your skill a sealed envelope, already filtered by deal scope,
phase, and document sensitivity (MNPI is withheld unless the actor is cleared).
Your skill must not reach for anything outside the envelope. A skill whose
reported `saw` exceeds its envelope is halted automatically.

**4 — Every external artifact passes compliance.** Anything that could leave the
firm is screened by the rule pack (ADR-0003), which returns one of three
verdicts: **clear** (proceed), **hold** (MNPI or a valuation figure → routed to a
human supervisor, not sent), **blocked** (promissory / forward-looking commitment
→ stopped, with a suggested rewrite). Your skill must accept a `hold`/`blocked`
verdict and never attempt to route around it.

**5 — Human sign-off for anything that leaves the firm.** High-stakes steps pause
for an explicit approval before the artifact is produced *and* before it is
released. Your skill produces the draft; a human presses approve. Declare your
step's `approvalBy` (who gates it). Low-stakes, internal-only work can run fully
automatically — say so, and say why.

**6 — Emit a complete audit record.** Every run returns
`auditRecord: { saw, did, why, modelUsed, tokens }`. The audit trail covers
agents, not just users — a regulator (FINRA) cares about what a rogue agent did.
No silent work: if it happened, it is in the record, attributable and replayable.

**7 — Expose value, not mechanism.** The banker sees *why your skill beats the
manual status quo* (one plain "why it's better" line), never your prompts, tools,
or internal steps. Skills are governed and distributed, not reverse-engineerable
(Storm's rule). Keep the secret sauce in the skill; keep it out of the UI.

## What you submit

One skill folder with: the **contract** (io + constraints), the **step** it maps
to (phase + seq), **who it's for** (client / buyer / internal / MD review),
**human-vs-agent** split, **edge cases & guardrails** (incl. MNPI / code-name
handling), and the **"why it's better"** line. Use the extraction template in
`docs/02-product/ignatious-extraction-prompt.md` as the intake shape.

## Review and acceptance

Submitted skills are governed, not self-serve. Each carries an **approval state**:
`draft` → `in review` → `approved`. Only an approved skill runs on a live deal,
and approval is a human decision, logged. A skill that breaks any rule above is
held at review until it conforms.

---

*v1 · 2026-07-10. This is the platform contract for skill authors; the runtime it
targets is the shipped orchestration spine (`src/lib/orchestration/`). Related:
`docs/02-product/skills-catalog.md` (what exists), `docs/03-engineering/orchestration-spine.md`
(the runtime), ADR-0003 (the compliance verdict shape).*
