# Data Inventory Map

Conductia, Inc. Prepared 2026-10-25; reviewed and approved by Martin Casado.

Customer data lives in one Postgres database per environment on Supabase (AWS us-east-1) and in one storage bucket, `dataroom`. Each customer firm is a separate tenant isolated by row-level security. The table groups the database tables by data category and shows which subservice organizations receive each category.

| Category | Main tables | Classification | Leaves Conductia to |
|----|----|----|----|
| Identity and access | users, companies, roles, invites, access_requests, company member tables, firm_identity_providers, mailbox_connections | Confidential (names, work emails) | Resend (invitation emails) |
| Deal content | deals, deal_steps, deal_parties, deal_memberships, deal_candidates, crm_people, lead tables, stage_assessments | Restricted (MNPI) | Vercel AI Gateway to Anthropic, for drafting |
| Communications | outbound_messages, inbound_messages, team_mailboxes, notifications | Restricted (MNPI) | Resend (platform address) or the user's own Gmail or Microsoft 365 mailbox |
| Documents and files | documents, datarooms, lead_documents, source_items; `dataroom` bucket | Restricted (MNPI) | Box (optional source); AI Gateway for analysis |
| AI outputs and usage | deal_step_skill_runs, model_calls, ai_usage, ai_budgets, corrections | Restricted (outputs); internal (usage) | Agents backend on AWS for skill runs |
| Audit | audit_log (append-only, hash-chained), legal_holds, routing_ledger | Confidential | None |
| Product analytics | Pseudonymous user and tenant ids, step id, time on step; client IP discarded | Internal | PostHog (US) |

## Retention and disposal

Retention follows the approved Data Management Policy (v1.0, approved by Martin Casado), Appendix B: customer data is deleted within 60 days of contract termination; security and system logs in the cloud provider are kept 1 year; data under legal hold (`legal_holds`) is kept until the hold is lifted. Within a contract, each customer firm's retention is set in `tenant_retention_policies`, changed only through `tenant_retention_policy_set()`. Deleting stored mail is documented in the discovery worker runbook.

## Maintenance

Engineering updates this map when a migration adds a table that stores customer data or when a new subservice organization receives data, and it is reviewed with the annual policy review.
