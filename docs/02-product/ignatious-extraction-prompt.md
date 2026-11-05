# Ignatious Workflow & Skill Extraction — Prompt to Run in Claude

**What this is:** a single prompt every Ignatious banker runs inside Claude (Desktop app or Claude Code) to extract the workflows, processes, and "skills" they already run through Claude on live deals. The output is a structured bundle we feed straight into the platform build — so the skills our agents build match how *you actually work*, not a generic template.

**Who should run it:** everyone, but **junior/execution bankers are the highest-value source** (they run the repeatable, step-level tasks). Seniors: focus on judgment/decision steps and review standards.

**How to run it (2 minutes):**
1. Open Claude (the Desktop app is best — it can see your recent chats and write files directly to your computer).
2. Paste the prompt below.
3. Claude writes one Markdown file per workflow plus a `PROCESS-OVERVIEW.md` into a new folder on your Desktop named `IGNATIOUS-EXTRACT-[YOURNAME]`.
4. Zip that folder and send it back to the team.
5. Don't over-edit. Raw and complete beats polished and thin.

---

## THE PROMPT (copy everything below this line)

You are helping extract, in structured form, the real M&A investment-banking workflows and repeatable tasks I run through you, so an engineering team can turn them into automated, compliant "skills" on a new banking-AI platform. Be exhaustive and specific. Favor how I *actually* work over textbook process.

**Context — the platform we're building for.** It executes a sell-side M&A deal as a sequence of ~65 steps across five phases (Origination/Mandate → Preparation & Market Readiness → Marketing & First-Round Bids → Diligence/LOI/Definitive Docs → Signing/Closing/Post-Close), with an always-on compliance and audit layer. Each repeatable task at a step is a "skill." Some tasks run in parallel; some are always-required (e.g. the engagement letter); some can be skipped when a deal enters mid-process. The guiding principle is "banking in the front, AI in the back": the banker never picks a model or configures anything — the skill just runs and produces banker-grade work product.

**Step 1 — Inventory.** List every distinct workflow, process, document, analysis, or task you have used me (Claude) for on deals — and also ones you do manually that you'd want automated. Group them by the deal phase above where you can. Include the unglamorous, repeatable ones (buyer logs, diligence trackers, NDA redlines, weekly updates, meeting-note follow-ups, teaser/CIM drafting, comps, process letters, etc.).

**Step 2 — For EACH item, produce one Markdown file** named `SKILL-[short-name].md` with these sections:
- **Name** and the **deal step/phase** it maps to (best guess is fine).
- **What it produces** (the deliverable) and **who it's for** (client, buyer, internal, MD review).
- **Inputs** — exactly what you feed in: documents, data, formats, sources (CapIQ, PitchBook, the data room, prior decks, call notes).
- **Process** — the actual steps you take, in order, including the prompts/instructions you give me and any back-and-forth. Paste real prompt text where you have it.
- **The "secret sauce"** — what makes YOUR version better than a naive "build me a CIM": the judgment, the checks, the formatting conventions, the firm-specific rules, the things a junior gets wrong. Be candid; this is the most valuable part.
- **Edge cases & guardrails** — where it goes wrong, what must never happen, what needs a human sign-off, any compliance/MNPI/code-name considerations.
- **Tools/systems touched** and whether any step is external-facing (leaves the firm).
- **Human vs automated** — which parts you'd let run fully automatically, which need your approval, which are pure judgment.

**Step 3 — Produce `PROCESS-OVERVIEW.md`** capturing: how you sequence a deal end-to-end; which tasks you run in parallel; which are always required vs skippable; how you handle a deal that enters mid-process (e.g. a term sheet already on the table); your document naming/organization/meta-tagging habits (so search works later); and any firm-specific conventions, templates, or "house style" that cut across skills.

**Step 4 — Be concrete.** Where you reference a template, deck, or file, name it. Where you have a real prompt you reuse, paste it verbatim. Where a number/format matters (a specific comp set, a bridge, a slide layout), say so. Don't summarize away the detail — the detail is the point.

**Step 5 — Save the output.** Create a new folder on my Desktop named `IGNATIOUS-EXTRACT-[MYNAME]` and write every `SKILL-*.md` file and the `PROCESS-OVERVIEW.md` into it, then zip that folder. Do not include any real client names or MNPI — use "the client" / "the target" / a code name.
