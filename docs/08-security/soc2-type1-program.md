# SOC 2 Type I program

Status: Started 2026-10-13. Contract signed with Vanta. Epic [#484](https://github.com/Conductia/Conductia/issues/484), milestone **SOC 2 Type I** on the [delivery board](https://github.com/orgs/Conductia/projects/1). The control-by-control state lives in [`soc2-control-register.md`](./soc2-control-register.md).

## What we are getting

A **SOC 2 Type I** report is a CPA firm's opinion that our controls are *suitably designed and in place on one date* (the as-of date). It does not test whether they operated over time; that is **Type II**, which covers an observation window (3 to 12 months is the common planning range) and is this program's intended next step. Banks will ask for Type II eventually; Type I is the credible first step. Until the report is issued (target Q1 2027), sales answers security reviews from the program and Vanta's trust materials.

This proposes to supersede the sequencing in [ADR-0017](../07-decisions/ADR-0017-hybrid-data-residency.md) decision 9, which framed SOC 2 as Type II-first, unstarted and triggered by a prospect's request (O12). The decision is recorded as D89 in the decision log, proposed until Storm confirms the Type I-first sequencing.

## Scope (proposed, decided in #464)

| Dimension | Proposal | Why |
|---|---|---|
| Trust services criteria | **Security** (common criteria CC1 to CC9, mandatory) plus **Confidentiality** | MNPI is the product's core data; Confidentiality is what bank reviewers look for. Availability and Privacy wait for Type II |
| System | Conductia web app (Vercel), Supabase (DB, auth, storage), `conductia-agents-backend`, Ignatious control plane, the discovery worker in AWS (`infra/discovery-worker`) | The boundary that stores or processes customer data |
| Subservice organisations (carved out) | Vercel, Supabase, AWS, Anthropic, Vercel AI Gateway, Box, Microsoft, Google, Resend, GitHub, Vanta | We rely on their own SOC 2 reports and operate their complementary user entity controls (CUECs) |
| People | Every employee and contractor with production, code or customer-data access | |
| Repos | `Conductia/Conductia`, `Conductia/conductia-agents-backend` | |
| ADR-0017 bank-hosted data plane (mode 2) | Open: in only if a bank-hosted deployment exists before the as-of date. The Conductia-operated AWS worker is in scope either way | |
| As-of date | End of January 2027 | Vanta's 90-day audit-ready plan from mid-October, plus fieldwork |

## Timeline

Follows Vanta's GRC implementation guide (30-60-90 days, audit by month 6). Dates are targets, not commitments, until the auditor is booked (#466).

| Phase | Weeks (from Oct 13) | Outcome | Issues |
|---|---|---|---|
| 1. Onboarding and scope | 1 to 4 | Scope decided, Vanta configured securely, auditor selected, integrations connected and the first test run triaged | #464 #465 #466 #467 |
| 2. Program build | 3 to 10 | Policies approved and accepted, personnel tasks assigned, devices monitored, risk register and vendor inventory complete, incident response plan written | #468 #469 #470 #477 #478 #476 |
| 3. Engineering hardening | 3 to 10 | Access least-privileged and reviewed, MFA for every account, SAST and secret scanning, monitoring and alerting, restore tested, change and encryption evidence, pentest done | #471 #472 #473 #474 #475 #479 #480 #481 |
| 4. Audit | 10 to 16 | System description reviewed, tests passing, evidence mapped to the auditor's request list, fieldwork, report | #482 #483 |

## Roles

| Role | Who | Responsibility |
|---|---|---|
| Executive sponsor and policy approver | Storm | Approves scope, policies and risk acceptances |
| Program owner | To confirm in #464 (ADR-0017 named Guillermo) | Owns the Vanta workspace, the timeline and the auditor relationship |
| Engineering control owner | To confirm | Integrations, failing tests, hardening issues |
| People and HR owner | To confirm | Roster, background checks, training, onboarding and offboarding |
| Every staff member | All | Training, policy acceptance, device agent |

Every Vanta control, test, policy, risk and vendor gets a named owner before Phase 4. Owners are notified of failing tests through Slack and GitHub issues.

## Where we start

Strong today, mostly needing documentation as evidence:

- **Authentication.** Supabase Auth with MFA at `aal2` in `src/middleware.ts` and the v1 API for work identities and invited accounts; enforcement for every account depends on `MFA_ENFORCEMENT` (#472).
- **Tenant isolation.** Per-firm tenancy with an RLS backstop (ADR-0016) and deal-scoped RLS policies.
- **Audit trail.** An immutable `audit_log` (ADR-0008), hash-chained for every row written since `20260925100000`; earlier rows stay unchained.
- **Change management.** GitHub rulesets: a PR, one approval and four required checks into `develop`, and fast-forward-only promotion to `staging` and `main`. `main` and `staging` do not require a PR, so a direct push by anyone with write access is still possible (#479). CODEOWNERS guards the mailbox-reader paths ([delivery model](../03-engineering/delivery-model.md)).
- **Dependency audit.** `npm audit` runs in CI as a required check.
- **Security headers and legal hold.** Legal hold is in place. Baseline security headers are set in `next.config.ts`; there is no Content-Security-Policy on `develop` yet (#551 proposes one), and HSTS relies on the platform default (to verify, #480).

Missing, and where most of the work is:

- **Written policies.** We have none.
- **People and devices.** No personnel program and no device monitoring.
- **Risk and vendors.** No formal risk assessment and no vendor management.
- **Operations.** No app-side error monitoring or alerting (the AWS worker has its own), no documented backup restore test, no BC/DR plan and no incident response plan.
- **Application security tooling.** Partly closed by #473: Dependabot version updates, a required secret scan (gitleaks) and an advisory static analysis (Semgrep CE, in place of CodeQL). Still open: Dependabot alerts and the other owner settings in the [GitHub security runbook](../04-operations/github-security-runbook.md), and `SECURITY.md`.
- **Pentest.** None has been done.

One item an auditor will ask about first: production must enforce MFA for every account, not only invited ones (`MFA_ENFORCEMENT=invite_only` allows AAL1 for established accounts), and the `DISABLE_MFA` switch must stay dev-only (#472).

## Working rules

- **Policies describe what we actually do.** If practice and policy disagree, fix one of them before the as-of date. A template adopted unedited is a finding waiting to happen.
- **Engineering work follows the normal delivery model.** That means a PR to `develop` with the `compliance: soc2` label, and the PR or issue number is the evidence. Hardening items take the weekly milestone they are scheduled in only if they ship product code. Otherwise they stay on the SOC 2 Type I milestone.
- **Evidence goes in Vanta, not in this repo.** That covers screenshots, signed documents and exports. The repo holds policies only if we choose to version them here (decided in #468), plus engineering docs and this program record.
- **Upload the minimum.** Do not upload customer data or MNPI to Vanta. Redact anything an auditor does not need (Vanta secure-implementation guidance).
- **Vanta itself is in scope.** Sign in with SSO and MFA, disable the magic link, keep Admin to two people and include Vanta in access reviews.

## Open questions

1. Is Google Workspace our identity provider for every staff account, and do we have an HRIS? This determines the integrations in #467.
2. How many people and contractors are in scope? This sizes the background-check and training cost.
3. Are any ADR-0017 bank deployments (mode 2) expected before the end of January 2027?
4. Is there any customer contract with security commitments (notification windows, data residency)? These become our "service commitments" in the system description (#482).

## Sources

- The Vanta Getting Started Hub: <https://help.vanta.com/en/collections/12575233-getting-started-hub>. In particular:
  - the [GRC implementation guide](https://help.vanta.com/en/articles/11488007-vanta-grc-implementation-guide)
  - [Getting started with policies](https://help.vanta.com/en/articles/11345363-getting-started-with-policies)
  - the [Personnel hub](https://help.vanta.com/en/articles/11345364-getting-started-personnel-hub)
  - [Adaptive framework scoping](https://help.vanta.com/en/articles/11345359-adaptive-framework-scoping)
  - [Secure implementation guidelines](https://help.vanta.com/en/articles/12069112-using-vanta-secure-implementation-guidelines)
- [ADR-0017](../07-decisions/ADR-0017-hybrid-data-residency.md), decision 9 and O12.
