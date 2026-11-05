# Conductia System Description

SOC 2 Type I, Section III. Conductia, Inc. Prepared 2026-10-25; reviewed and approved by Martin Casado. As-of date: end of January 2027.

Conductia is a compliance-first M&A workflow platform for investment bank managing directors running sell-side processes. Customers use it to run a deal: a project-scoped rail of workflow steps, AI-drafted work product, a data room, and compliance-screened communications with deal parties.

## Services provided

- **Deal workspace.** A rail of workflow steps per project, with skills that draft work product (briefings, teasers) for the banker to review.
- **Data room and documents.** Upload, view and analysis of deal documents, with Box as an optional source.
- **Compliant communications.** Every outbound message passes a compliance screen and is recorded; mail leaves from the banker's connected Gmail or Microsoft 365 mailbox, or from the platform address through Resend.
- **Onboarding and access.** Invitations, per-deal membership and roles across the bank, seller and buyer parties.

## Components in scope

| Component | Runs on | Role |
|----|----|----|
| Conductia web app (Next.js) | Vercel | UI, versioned REST API at `/api/v1`, compliance screen, audit logging |
| Database, auth, file storage | Supabase (AWS us-east-1) | Postgres with row-level security, Supabase Auth with MFA, storage buckets |
| Agents backend and Ignatious control plane | AWS (ECS, RDS) | Runs skills and agents; Postgres on RDS with `sslmode=verify-full` |
| Discovery worker | AWS ECS (`infra/discovery-worker`) | Background discovery jobs from a pg-boss queue |
| AI models | Anthropic, via Vercel AI Gateway | Drafting and analysis |

## Data

Customer data is deal content, which includes material non-public information: documents, messages, workflow outputs, and the names and contact details of deal participants. Each firm is its own tenant, isolated by row-level security (ADR-0016) and deal-scoped policies. Every deal creation, membership grant and document view is written to an append-only `audit_log`, hash-chained since 2026-09-25.

## Security controls

- Supabase Auth with TOTP MFA at AAL2; production enforcement for all accounts is tracked in \#472.
- TLS for all traffic; SSL enforced on every Supabase database since 2026-10-25.
- Encryption at rest by Supabase and AWS.
- Change management through GitHub rulesets: a reviewed pull request with 1 approval and required checks, no admin bypass.
- Dependabot alerts, secret scanning with push protection, gitleaks and Semgrep in CI.

## Subservice organizations (carved out)

Vercel, Supabase, AWS, Anthropic, Vercel AI Gateway, Box, Microsoft, Google, Resend, GitHub and Vanta. Conductia relies on each one's SOC 2 report and operates the complementary user entity controls.

## Boundaries

Out of scope: the customer's own mailboxes and Box tenants, end-user devices, and any bank-hosted data plane (ADR-0017 mode 2) unless one exists before the as-of date, end of January 2027.
