> **Superseded / historical.** Executed: the beta shipped as `v0.5.6` on 2026-09-07. Followed by an MVP 2 scope proposal (PR #146), which closed unmerged on 2026-09-30, so that document is not on `develop`; the MVP 2 scope is to be recorded as its own decision.

# ADR-0013 — Labor Day MVP scope lock (Ignatious beta)

- **Status:** Accepted
- **Date:** 2026-08-03
- **Source:** Conductia Labor Day MVP Alignment deck (Aug 3, 2026). Extends D5
  (guided live walkthrough), D29/D30 (unified UI; data room + permissions first),
  D38 (Gate 0), D41 (pre-send comms). Reverses none.

## Context

Earlier artifacts (founders planning session, engineering handbook Step 0/1 epics,
Phase 1–7 roadmap on the GitHub project) described a broader v1 than is
achievable by Labor Day with current capacity. On Aug 3 the delivery team locked
a narrower **Ignatious-only beta** for Monday, September 7, 2026.

## Decision

1. **Beta date:** Monday, September 7, 2026. Date moves only for launch
   blockers after this scope lock.

2. **Completion bar:** Work is **done when merged to `develop`**. `main` is a
   release snapshot promoted at beta cut; it is not the integration branch.

3. **Launch blockers (four priorities):**
   - Workflows in action — human workflow, owners, evidence, audit
   - Onboarding + rooms — Ignatious users, permissions, Box data room
   - Compliant communication — pre-screen messages sent inside Conductia
   - Digital twin (narrow) — person brief for tailored outreach and meeting prep

4. **Explicit deferrals (not launch blockers):** full step automation; buyer/seller
   onboarding; Outlook/SMS channels; automated twin research; presentation
   generation; bank-level setup after invite (#125).

5. **Weekly gates W1–W5** (Aug 3 – Sep 4) govern delivery review; see
   `docs/02-product/labor-day-mvp-2026-08-03.md`.

6. **Ownership:** Lance accountable for delivery plan and weekly review; Rob
   product lead for core workflow; Martin onboarding/Box; Marcelo compliant
   comms; RTS/Charles prioritized skills; Storm approves scope changes.

7. **GitHub tracking:** project board Conductia #3 reframed around Delivery Gate
   (W1–W5), workstreams, and `beta-blocker` / `post-beta` labels. Handbook
   Step 0/1 epics (#46, #52) are retired in favor of Labor Day epics.

## Consequences

- Gate 0 and platform spine work on `develop` counts as shipped for workflow
  and controls; remaining W1 work is primarily PR #124 (onboarding) plus E2E
  integration.
- Open issues from pre-Aug planning (#5–#19, step-0/1 epics) are triaged to
  closed (done on develop), `post-beta`, or remapped under Labor Day epics.
- README and `delivery-model.md` document the `develop`-first workflow so
  clones of default `main` do not mislead contributors.

## References

- Product scope: `docs/02-product/labor-day-mvp-2026-08-03.md`
- Delivery model: `docs/03-engineering/delivery-model.md`
- Decision log: D45
