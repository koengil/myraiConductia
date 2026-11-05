---
name: ignatious-skill-calibrator
description: >
  Calibration skill for the Ignatious Partner Review Skill. Accepts new SP
  feedback threads and identifies gaps against the current skill — proposing
  only targeted additions, never wholesale dumps. Activate when a new SP
  feedback thread arrives and you want to know if it should update the partner
  review skill. Paste the thread and the relevant SP section of the current
  skill; the calibrator classifies each finding as already covered, a new
  principle, or a new exemplar, and drafts addition language only for confirmed
  gaps. Prevents bloat by enforcing a strict test: a principle is only added if
  it cannot be inferred from existing content. Also activate when asked to add
  a new feedback episode to the SP repository, assess signal quality, or review
  whether recent SP feedback changes the current skill.
---

# Ignatious Skill Calibrator

This skill calibrates the Ignatious Partner Review Skill using real SP feedback
threads. Its purpose is to make the partner review skill sharper with each
update — without making it longer.

The design principle: AI skills operate with a fixed attention budget. As
instructions grow, each instruction receives less weight. Adding all SP feedback
verbatim degrades output quality. Only gaps — principles genuinely absent from
the current skill — are worth adding.

---

## How to Use This Skill

Provide two inputs:

**Input 1 — The feedback thread.**
Paste the raw email thread (or forwarded email) where an SP gave feedback on a
deck. Include all messages, not just the SP's. Context from junior team
responses often clarifies what was changed and why.

**Input 2 — The current skill section.**
Paste the relevant SP section from the Ignatious Partner Review Skill:
- Storm Duncan feedback → paste the Storm section (Tier 2B)
- Kevin Finn feedback → paste the Kevin section (Tier 2B)
- Chris Hayes feedback → paste the Chris section (Tier 2B)
- Universal standards → paste Tier 2A

If you do not paste the current skill section, the calibrator will rely on
its trained knowledge of the standard skill structure — but accuracy improves
when the current version is provided directly.

---

## Step 1 — Signal Assessment

Before analyzing the thread, assess its signal quality:

**High signal** — Extended SP markup with multiple distinct principles,
  page-level specifics, or inline-authored content (riders, KIH rewrites).
  Worth a full calibration pass.

**Medium signal** — A few targeted comments covering 1–3 themes. Worth
  extracting but unlikely to produce more than 1–2 additions.

**Low signal** — Scheduling, logistics, brief acknowledgments, or single-word
  approvals. Log to the repository index but do not calibrate.

**Noise** — No deck feedback content. Exclude entirely.

State the signal level before proceeding.

---

## Step 2 — Extraction

Read the full thread. Extract every distinct principle, preference, or standard
the SP expresses — explicitly or implicitly. Include:

- Explicit instructions ("Change X to Y")
- Named principles ("This violates the cardinal sin of...")
- Framing preferences ("The tone should feel like...")
- Structural requirements ("Every deck needs a page that...")
- Visual or formatting standards
- Process expectations ("I expect to see this before the call")
- Inline-authored content (riders, rewrites) — flag these separately

Do not interpret or expand at this stage. Extract what was actually said.

---

## Step 3 — Gap Classification

For each extracted finding, classify it against the current skill:

**Already covered** — The principle is captured in the current skill, even if
  the wording differs. Do not add. State which existing rule covers it.

**Gap — Principle** — The finding is a genuine rule or standard not present in
  the current skill. Recommend adding to SKILL.md in the relevant SP section.

**Gap — Exemplar** — The finding is a specific example, verbatim quote, or
  visual technique too detailed for SKILL.md. Recommend adding to a reference
  file (e.g., `exemplar-reviews.md` or `storm-quotes-by-theme.md`).

**Emerging** — The finding appears only once in the repository and may be
  situational rather than a standing preference. Flag for monitoring but do not
  add until confirmed in a second episode.

**Noise** — The finding is too specific to this deal to generalize. Exclude.

Present the full classification table before drafting any additions.

---

## Step 4 — Draft Additions

For confirmed gaps only (Principle or Exemplar), draft the addition language.

**For Principle gaps:**
- Match the writing style of the existing SP section
- Lead with a bolded principle statement
- Follow with one or two sentences of context — enough to apply it, not more
- Tag with `[Both]`, `[Ignatious Pitch]`, `[Mgmt Pres]`, or `[Buy-Side Only]`
  where the rule is not universal
- Do not add more than one sentence of explanation unless the principle is
  genuinely non-obvious

**For Exemplar gaps:**
- Write the verbatim SP quote and its source (project, date)
- Add one line on what theme it illustrates
- Format for addition to the relevant reference file

---

## Step 5 — Output Format

Return a structured report in this format:

```
SIGNAL: [High / Medium / Low / Noise]
SOURCE: [SP name, project, date]

CLASSIFICATION TABLE
| Finding | Classification | Notes |
|---------|---------------|-------|
| ...     | ...           | ...   |

PROPOSED ADDITIONS ([n] principles, [n] exemplars)

[SP Section — e.g., Storm / Narrative and Story]
- [Drafted addition 1]
- [Drafted addition 2]

ALREADY COVERED ([n] findings)
- [Finding] → covered by: [existing rule]

EMERGING / MONITOR ([n] findings)
- [Finding] — needs confirmation in a second episode

NOT ADDED ([n] findings)
- [Finding] — reason: too deal-specific / noise
```

---

## What This Skill Does Not Do

- It does not rewrite or restructure existing skill content.
- It does not add findings that are already covered, even if the SP's wording
  differs from the skill's wording.
- It does not produce additions for low-signal or noise threads.
- It does not create new SP sections. If a pattern from a new SP emerges, flag
  it for human review rather than adding autonomously.
- It does not act on "emerging" findings without confirmation.

---

## Repository Maintenance

When a new thread is calibrated, also note:

- Whether the thread should be added to the SP feedback repository as a new
  episode subfolder
- Suggested subfolder name: `[Project Name] - [Deck Type] ([MM-DD-YYYY])`
- Suggested signal tag for the INDEX.md entry

This keeps the repository and the skill in sync.
