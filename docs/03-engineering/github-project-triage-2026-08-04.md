> **Superseded / historical.** One-time triage log of the FutureProofingDev board and repo, both archived after the 2026-09-03 move to `Conductia/Conductia`. Numbers below are legacy `intelibank#N`; the surviving items were re-filed (see #74). Links are kept for provenance.

# GitHub project triage — Labor Day MVP (2026-08-04)

One-time reconciliation after ADR-0013 / D45. **`develop` = done.**

## New epics

| Issue | Epic | Workstream |
|-------|------|------------|
| [#129](https://github.com/FutureProofingDev/intelibank/issues/129) | Workflow + evidence | Rob |
| [#130](https://github.com/FutureProofingDev/intelibank/issues/130) | Ignatious onboarding + Box | Martin |
| [#131](https://github.com/FutureProofingDev/intelibank/issues/131) | Compliant communication | Marcelo |
| [#132](https://github.com/FutureProofingDev/intelibank/issues/132) | Digital twin — person brief | RTS / Charles |
| [#133](https://github.com/FutureProofingDev/intelibank/issues/133) | Integrated beta path & launch readiness | Lance / Rob |

## Project board fields

| Field | Use |
|-------|-----|
| **Gate** (new) | W1–W5, Post-beta |
| **Owner stream** (new) | Rob / Martin / Marcelo / RTS+Charles / Cross-cutting |
| **Delivery Gate** (renamed from Phase) | Legacy Phase 1–7 options — migrate items to **Gate**, then ignore |
| **Status** | Add **At risk** / **Blocked** manually in GitHub UI if not present |

## Open issues — disposition

| Issue | Action | Gate | Labels |
|-------|--------|------|--------|
| PR [#124](https://github.com/FutureProofingDev/intelibank/pull/124) | **Merged** — epic #130 | W1 | enable flag + E2E |
| [#116](https://github.com/FutureProofingDev/intelibank/issues/116) | Open — security | W3 | `beta-blocker` |
| [#117](https://github.com/FutureProofingDev/intelibank/issues/117) | Open — audit | W3 | `beta-blocker` |
| [#125](https://github.com/FutureProofingDev/intelibank/issues/125) | Open — post-beta | Post-beta | `post-beta` |
| [#27](https://github.com/FutureProofingDev/intelibank/issues/27) | Open — integration test | W3 | `beta-blocker` |
| [#22](https://github.com/FutureProofingDev/intelibank/issues/22) | Open — RLS follow-up | W3+ | `post-beta` |
| [#33](https://github.com/FutureProofingDev/intelibank/issues/33) | Open — partial on develop | W3 | under #130 / #129 |
| [#54](https://github.com/FutureProofingDev/intelibank/issues/54) S1.2 | Close — shipped Gate 0 | — | superseded |
| [#55](https://github.com/FutureProofingDev/intelibank/issues/55) S1.3 | Defer — post-beta task plan | Post-beta | `post-beta` |
| [#46](https://github.com/FutureProofingDev/intelibank/issues/46) Step 0 epic | Close — reconciled | — | superseded |
| [#52](https://github.com/FutureProofingDev/intelibank/issues/52) Step 1 epic | Close — reconciled | — | superseded |
| [#32](https://github.com/FutureProofingDev/intelibank/issues/32) | Close — superseded by #124 | — | |
| [#51](https://github.com/FutureProofingDev/intelibank/issues/51) S0.5 | Defer — not Labor Day blocker | Post-beta | `post-beta` |
| [#48](https://github.com/FutureProofingDev/intelibank/issues/48) S0.2 | Keep open — docs | Post-beta | |
| [#5](https://github.com/FutureProofingDev/intelibank/issues/5)–[#19](https://github.com/FutureProofingDev/intelibank/issues/19) | Close — done or post-beta | — | see comments |

## Pre-Aug issues #5–#19 mapping

| Issue | Disposition |
|-------|-------------|
| #5 Database + sign-in | **Done** on develop (#30) |
| #6 Role model | **Done** — schema + seeds |
| #7 Unique deal IDs | **Done** — deal codes (G14) |
| #8 Activity log | **Partial** — audit_log; close, track #117 |
| #9 Deal creation UI | **Done** — Gate 0 |
| #10 Per-role walkthrough | **Post-beta** — buyer gating |
| #13 Deal team wall | **Partial** — wall trigger G5; RLS #22 post-beta |
| #14 Three-level protection | **Post-beta** |
| #15 Staged buyer data room | **Post-beta** — Ignatious-only beta |
| #16 NDAs | **Post-beta** |
| #17 Engagement letters | **Post-beta** |
| #18 Real analysis data | **Post-beta** — seam stays mock (D8) |
| #19 Per-file permissions | **Partial** — onboarding PR #124; full rules post-beta |

## Manual follow-up

1. Pin epics #129–#133 on project board; set **Gate** and **Owner stream**.
2. Move closed Gate 0 issues to **Done**.
3. Add **At risk** / **Blocked** to Status field in GitHub UI (GraphQL option API unavailable via CLI).
4. Merge doc PR to `develop` (ADR-0013 + delivery-model + README updates).
