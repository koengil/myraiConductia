# ADR-0017: Hybrid data residency (bank data plane, Conductia control plane)

Status: Accepted, September 29, 2026 (epic #261; owner decisions 2026-09-29).
Amended October 4, 2026 (#343, D75): a single-tenant pilot exception to decision 2 for
Ignatious. See [Amendment 1](#amendment-1-single-tenant-pilot-exception-to-decision-2).
Issues: #270; epic #261; binds #262, #264, #266, #268, #269. Decision: D66.
Extends ADR-0016 (per-firm tenancy) and D62 (audit hash chain). Reverses none.
Evidence: `develop` at `64aad26d`; vendor sources under References, retrieved 2026-09-29.
Amendment 1 evidence: `develop` at `89bf8fc0`.

## Context

Every bank runs inside one Conductia-operated stack. One Vercel project serves the app,
`/api/v1/*` and the `/v1/*` agent seam. One production Supabase project holds Postgres and
Auth. Document bytes go to one Conductia Box enterprise through two clients: the rail-step
Box client whenever Box credentials are set (`src/lib/box/index.ts`), and the storage seam
when `STORAGE_PROVIDER=box` (`src/lib/storage/index.ts:10-13`). The seam's default is the
Supabase `dataroom` Storage bucket (`src/lib/storage/local.ts:7`). The production
`STORAGE_PROVIDER` value is not recorded (O1). Nothing is deployed per bank. The isolation
boundary is the `tenant_id` a bank receives at onboarding (D54), with RLS as the backstop
(ADR-0016: "Conductia runs every firm in one shared Postgres").

Bank content already rests on our side. `outbound_messages` holds full sent mail and the
model's `rewrite`. `inbound_messages` holds webhook mail. `source_items` and
`source_item_texts` hold deal-routed discovery text. Screen and outbox rows in
`audit_log.detail` carry `reasons`, which are model-written sentences about the screened
message (`src/app/api/v1/screen/route.ts`). Lead research memos, extracted lead-document
text, manual rail-step notes, skill run inputs and outputs, and skill-authoring chat hold
content too; decision 7 lists every store. No purge job exists for any of them.
(Update, #461, Proposed in D93: the discovery stores now have one. Ending a banker's mailbox
consent deletes the mail stored from that mailbox and what was derived from it, and an
operator script purges a tenant's stored mail at pilot end. A message index that holds no
content (identifiers, dates, a content digest keyed per tenant, category tags and versions) is kept only as the tenant's
retention policy states; under the pilot policy it goes with the mailbox, and at pilot end
it is exported to the bank, then deleted (owner, 2026-10-14). See
[Deleting stored mail](../04-operations/discovery-worker-aws-runbook.md#deleting-stored-mail).
Every other store listed here still has none.)

Content also leaves for model providers. Two direct Anthropic Messages API calls run in
Vercel functions: screening sends the full outbound message (`src/lib/compliance/llm.ts`),
and code-name suggestion sends the real target company name and sector, which is MNPI
(control metadata, decision 7) (`src/lib/gate0/codenameLlm.ts`). Five more paths send run
inputs and chat text to the Conductia agents backend
(`Conductia/conductia-agents-backend`), which Conductia operates in its AWS accounts in
us-east-1 and which calls Anthropic with its own keys (`src/lib/ignatious/`,
`src/lib/skillAuthoring/ignatiousAuthoring.ts`). Neither repo records zero-retention or
no-training terms.

The audit log is append-only and hash-chained per tenant in the same Postgres it protects
(D62). The chain migration names an external per-tenant anchor as an open decision
(`supabase/migrations/20260925100000_audit_hash_chain.sql`).

A control plane and data plane split appears only in the July 2026 research,
[`isolation-and-storage-architecture.md`](../03-engineering/isolation-and-storage-architecture.md),
whose own banner demotes it to "the enterprise / generalization target, NOT the MVP". No
ADR or decision-log entry records residency, the plane split, provider retention terms or
SOC 2. Epic #261 now records hybrid residency as decided, and its mailbox readers (#259,
#271) are about to bring bank mail into the platform. This ADR fixes where that data may
live before they do.

## Decision

1. **Two planes, and a store's plane is set by the data it holds.** Each bank has its own
   data plane. Conductia runs one control plane. The service that writes a store does not
   decide its plane; the data class does:

   ```text
   placement(store)
     holds bank content        -> DATA PLANE of that bank
     holds control metadata    -> CONTROL PLANE (Conductia)
     content may TRANSIT the control plane for one action; it may not REST there
   ```

   - **Bank content** is message headers (subject, participants), bodies, raw MIME,
     document bytes, extracted text, embeddings, and model outputs about content
     (screening reasons, rewrites, briefs). Headers count because #264 places headers in
     the bank's hot tier. Model outputs count because they restate the content they
     describe.
   - **A bank-owned Box enterprise** is a component of that bank's data plane. Document
     bytes stored there rest in the data plane.
   - **Filenames are bank content.** `documents.name` can disclose what a document says,
     so it moves with the document, as do its folder paths (E5). `legal_holds.reason` is
     control metadata: a hold is a compliance control the control plane enforces, and its
     reason names the matter without quoting content; reviewers hold new writers to that.
   - **Control metadata** is identity, tenancy, roles, invites, feature flags, deal ids
     and state, hashes, routing decisions, audit chain fields and usage counts.

   The control plane stays as ADR-0016 built it: one shared Postgres, `tenant_id` as the
   isolation boundary, RLS as the backstop. The #262 allowlist (`invites` and the audited
   mailbox opt-in) is control metadata and lives there. Each data plane pulls it and
   refuses to read a mailbox without it.

2. **Each bank's data plane runs in one of two supported modes, and both meet the same
   isolation properties.**

   - **Mode 1: bank-hosted (BYOC).** The default, and the target for any bank with a cloud
     account. The bank owns the account and the keys. Conductia operates the data plane
     through a scoped role over outbound-only connections, as
     [Zilliz](https://docs.zilliz.com/docs/byoc/byoc-intro) documents for its BYOC data
     plane. [Redpanda](https://docs.redpanda.com/cloud-data-platform/get-started/byoc-arch/)
     and [Databricks](https://docs.databricks.com/aws/en/getting-started/overview) document
     the same control and data plane split.
   - **Mode 2: Conductia-hosted, isolated.** A dedicated single-bank data plane in
     Conductia's cloud, with its own account or project, database, storage and keys, never
     co-mingled with another bank, under the same placement rule and the same WORM copies.
     Mode 2 is a permanent option for very small banks. It is also the interim for a bank
     headed for mode 1 until that bank's own instance is live; interim use is disclosed to
     the bank in writing and ends when the bank's mode-1 instance passes I1 to I7. The
     simulated bank always runs on mode 2.

   The isolation properties are testable statements, and #264 builds and tests to them.
   They apply in full to mode 2, and to mode 1 wherever Conductia provisions anything.

   - **I1. Separate account or project.** Each bank's data plane lives in its own cloud
     account, subscription or project (for Supabase, its own project). A schema, a
     `tenant_id`, or a namespace inside a shared one does not qualify.
   - **I2. Own keys and credentials.** Each bank has its own encryption keys (its own KMS
     key or key ring) and its own service identities. No key or credential is valid in two
     banks' data planes.
   - **I3. No shared stores.** Hot tier, warm tier, vector store, worker queue and WORM
     target are separate instances per bank. No database, bucket or queue is shared.
   - **I4. No cross-bank network path.** No peering, route, private endpoint or firewall
     rule connects two banks' data planes. The only paths are data plane to control plane,
     data plane to its own provider API (reads and outbound send through Graph or Gmail),
     data plane to the bank's own Box enterprise and other systems, and data plane to
     permitted model processors.
   - **I5. Per-bank WORM target.** Each bank's audit batches go to that bank's own
     immutable bucket or container, with its own locked retention policy.
   - **I6. Same contract in both modes.** Both modes expose the same per-action,
     guard-checked API, and in both the data plane opens every connection: it holds an
     outbound connection to the control plane, pulls the allowlist and the audit batches,
     and answers per-action requests over that connection. No inbound path into the data
     plane is required in either mode; only the endpoint configuration differs. The #262
     guard and the placement rule apply unchanged.
   - **I7. Independent teardown.** Offboarding one bank destroys its account or project and
     its keys without touching any other bank. WORM copies are the one exception and
     persist until their retention lock expires.

   **Gate.** A real bank's mailbox connects only after that bank has accepted mode 2 in
   writing, or its mode-1 instance passes I1 to I7. In both cases the instance that
   receives the mail passes I1 to I7, except under the pilot exception below. For
   Ignatious this was O4; Amendment 1 moves O4 to the exit.

   **Exception: the Ignatious pilot.** Amendment 1 (#343, D75) lets real Ignatious mail
   be read, and its content rest in the current shared stack, before any instance passes
   I1 to I7, under the conditions the amendment lists. It ends before a second bank is
   onboarded: that requires #264's pilot gate first, a mode-2 instance per bank passing
   I1 to I7. It is not extended by default. Every other bank meets this gate unchanged.

   **Mode 2 to mode 1 migration is deferred.** Trigger: the first mode-2 bank whose own
   cloud instance is ready, or a mode-2 bank that asks to move. When built, it copies the
   hot and warm tiers, verifies them against the SHA-256 hashes taken at ingest, carries
   the WORM chain head across so the chain continues unbroken, and then tears down the
   mode-2 instance under I7, auditing each step.

   ```mermaid
   flowchart LR
     subgraph DP["Data plane, one per bank (mode 1: bank's cloud; mode 2: isolated in Conductia's cloud)"]
       Worker["Readers and classify worker (#259, #271)"]
       Hot[("Hot tier: Postgres (#264)")]
       Warm[("Warm tier: object storage (#264)")]
       Vec[("Vector store, when hosted here (#269)")]
       WORM[("Immutable storage: audit batches and chain head (#266)")]
       DPAPI["Data-plane API: opens every connection outbound, per action, guard-checked, audited"]
     end
     Cold["Cold tier: provider API (Gmail, Microsoft Graph)"]
     subgraph CP["Control plane: Conductia, shared, tenant-isolated (ADR-0016)"]
       Vercel["Vercel: UI and /api/v1, pass-through"]
       PG[("Control Postgres: identity, invites, #262 allowlist, deals, audit_log, ai_usage")]
     end
     Models["Model processors"]
     Cold -->|read-only scopes| Worker
     Worker --> Hot
     Worker --> Warm
     Worker -->|hashes, decisions, counts| PG
     Worker -->|pulls the #262 allowlist| PG
     DPAPI -->|pulls audit batches and chain head every N minutes| PG
     DPAPI --> WORM
     DPAPI <-->|"outbound connection held by the data plane: thread for a reply, rows for a view"| Vercel
     DPAPI --- Hot
     DPAPI --- Warm
     DPAPI --- Vec
     Vercel -->|per-action content only| Models
     Vercel --> PG
   ```

3. **Mailbox data, the code that reads it, and the audit copies stay in the bank's data
   plane.**

   - **Hot tier:** Postgres holding headers, snippet, thread shape, deal links and
     deal-linked text (#264).
   - **Warm tier:** object storage holding raw MIME and full text of deal-linked items
     (#264).
   - **Cold tier:** everything else stays in the provider API (Gmail, Microsoft Graph),
     which the bank already owns. Non-deal mail is never stored beyond the routing ledger's
     hash and decision (#264).
   - **Readers and worker:** the Gmail and Microsoft 365 readers (#259, #271) and the
     classification worker (`worker/classify.ts`) run beside the hot and warm tiers and
     report only hashes, decisions and counts to the control plane. They never send raw
     mail to the shared control plane; content reaches it only through decision 4's
     per-action fetches.
   - **WORM copies** of the audit log (#266).
   - **The vector store, when hosted there** (#269). Milvus has no row-level security;
     partitioning by tenant and deal is acceptable because each data plane serves one bank
     (I3).

   A reader that writes into Conductia's shared Supabase, as PR #243's worker does, is
   correct for local development only. The simulated bank's reader writes to its mode-2
   instance, and a real bank's to that bank's data plane. D74 (#344) records the interim
   exception to this rule for the Ignatious pilot: the discovery worker runs in a dedicated
   AWS account and writes to the hosted project. Amendment 1 is the matching exception to
   decision 2 for the data that worker writes.

4. **Only what an action needs reaches Conductia.** The control plane fetches content from
   the data-plane API one action at a time: the thread for a reply (#268), the rows for a
   view. Each fetch passes the #262 guard, enforces for the requesting user the visibility
   the rows carry today (for discovery,
   `supabase/migrations/20260925120000_discovery_core.sql`: item text to its owners only;
   metadata to owners, the control room and candidate viewers; tentative links to owners
   and the control room), and writes an audit row. #264 proves parity by porting
   `tests/db/discovery-rls.test.ts` and `tests/integration/discovery-tracer.test.ts` to a
   data-plane instance. The API is the same in both modes (I6). The data plane holds the
   connection: it opens every connection outbound, in mode 1 and, so that the contract is
   identical, in mode 2. How a request from a Vercel function reaches that connection is
   left to #264 (O2).

5. **Vercel serves the UI and passes content through; it must persist none.** Persisted on
   Vercel means written to any Vercel-managed store: runtime logs, including each
   request's path and search params, traces, log drains, the Next.js Data Cache or ISR
   output, Blob, KV or Edge Config. Content that reaches a function must land in none of
   them, so content never travels in a URL path or query string; it goes in a POST body or
   behind an opaque id. Today this does not hold: upstream error text carrying content
   reaches runtime logs, and search queries and chat prompts travel in URLs (O3). The #264
   canary will prove it once O3 is fixed: it plants a canary string in a deal message, in a
   non-deal message and in a query parameter, and asserts the string is absent from Vercel
   function logs, including request paths and search params, error traces and Conductia's
   database (other than the bank-instance tiers), in CI against the preview deployment.
   The database check covers the tables that have moved when it runs; it covers E1 to E9
   only after their follow-ups land, E3's and E4's included (#266, #268, #279).

   Vercel's [runtime logs](https://vercel.com/docs/logs/runtime) hold function console
   output plus request metadata, including the request path and search params, and the
   documented fields include no request or response body. That bodies stay out of logs is
   an inference from the field list, not a Vercel guarantee: content reaches a log when
   code writes it to the console. Runtime log retention is 1 day on Pro, 3 days on
   Enterprise and 30 days with Observability Plus.
   [Log drains](https://vercel.com/docs/drains) forward the same logs and traces elsewhere.

   Option (b), serving the data routes from inside the bank so content never transits
   Vercel, remains possible and is not built. Trigger: a bank that refuses content transit
   through a third-party edge. Vercel's
   [Secure Compute](https://vercel.com/docs/networking/secure-compute) and Bring Your Own
   Cloud [networking options](https://vercel.com/docs/networking) are the likely paths.

6. **Model providers are processors of bank content and MNPI control metadata, and
   mailbox-derived content goes only to processors with verified terms.** Every processor
   that receives bank content or MNPI control metadata has a row in this table. A row
   reads Verified: Yes only when its retention and no-training terms are confirmed in
   writing and recorded here.

   | Processor | Called from (plane) | Content sent | Retention terms required | No-training basis | Verified |
   |---|---|---|---|---|---|
   | Anthropic Messages API, direct | Vercel functions (control plane) | Full outbound mail for screening (`src/lib/compliance/llm.ts`); real target company name and sector for code names, MNPI (control metadata, decision 7) (`src/lib/gate0/codenameLlm.ts`) | ZDR on the organization; no Covered Model; no 30-day workspace override | [Commercial Terms](https://www.anthropic.com/legal/commercial-terms): "Anthropic may not train models on Customer Content from Services" | No: O5 |
   | Conductia agents backend (Conductia-operated, AWS us-east-1); processor behind it: Anthropic Messages API, called with the backend's own keys | Vercel functions, five paths (`src/lib/ignatious/`, `src/lib/skillAuthoring/ignatiousAuthoring.ts`) | Run inputs, twin chat messages and history, bench and authoring text; it reads more back through the scoped trigger token | As the Anthropic row, for the backend's own organization | As the Anthropic row | No: O5 |
   | Voyage embeddings and reranking, routed through the Vercel AI Gateway (conditional on #269) | Set by #269 | Embeddings and reranking of mailbox-derived text (future) | A direct ZDR agreement with Voyage, or another processor; the Gateway's [ZDR](https://vercel.com/docs/ai-gateway/security-and-compliance/zdr) page does not list Voyage | Gateway [`disallowPromptTraining`](https://vercel.com/docs/ai-gateway/security-and-compliance/disallow-prompt-training), plus Voyage's own opt-out ([terms](https://www.voyageai.com/tos)) | No: O6 |
   | Vercel AI Gateway to Anthropic (`vercel-ai-gateway:anthropic`), every call through `postGatewayMessages` (`src/lib/modelGateway/gatewayClient.ts`) | Vercel functions (control plane): screening (`src/lib/compliance/llm.ts`) and code names (`src/lib/gate0/codenameLlm.ts`); the discovery worker's extract (`src/lib/discovery/extract/run.ts`), synthetic corpus only until ADR-0019's gate opens | Full outbound mail for screening; target company name and sector for code names, MNPI (control metadata, decision 7); milestone extraction of mail (synthetic today) | [ZDR](https://vercel.com/docs/ai-gateway/security-and-compliance/zdr) on the team behind the key (Pro or Enterprise plan), requested on every call (`zeroDataRetention: true`, `only: ['anthropic']`); a refusal stops the call | As the Anthropic row | No: until `npm run ai:zdr-probe` exits 0 with the production key; O5's written terms still apply |

   **Gateway route (#462, 2026-10-15).** Screening and code names moved from the direct
   Anthropic row to the gateway row. Evidence that the gateway fails closed, gathered live
   by the owner on 2026-10-15 with a dummy prompt: with a key on a Vercel Hobby plan, every
   request carrying `zeroDataRetention: true` was refused with HTTP 403 `permission_denied`
   ("Zero Data Retention (ZDR) is only available for Pro and Enterprise plans"), including
   `anthropic/claude-sonnet-5` with `only: ['anthropic']`; the same request with
   `zeroDataRetention: false` to a non-ZDR model returned 200. Vercel documents HTTP 400
   `no_providers_available` when the plan allows ZDR but no ZDR provider serves the model.
   The client names both refusals `zdr_unavailable`. Each caller logs it once and sends
   nothing further: the screen runs rules only, code names use the fallback sets, the
   extract run stops its batch, and nothing retries on another path or a direct provider.
   The row stays unverified until `npm run ai:zdr-probe` exits 0 with the production key
   (run by the owner; CI has no key).

   **Gateway row: what reads Yes.** For extraction of real mail the row covers the Ignatious
   tenant only (`VERIFIED_MODEL_TENANT_IDS`) and `anthropic/claude-sonnet-5` only, from the
   deal-zone extract worker on AWS (#344). The owner records Vercel's ZDR terms and the
   team-wide setting in a D-entry. The flip PR then changes `VERIFIED_MODEL_PROCESSORS`,
   `DISCOVERY_OUTPUT_PLACEMENT_APPROVED`, `VERIFIED_MODEL_TENANT_IDS`, this cell and the
   decision log, and nothing else. Prerequisites, in order: #346 merged (its fold keeps
   the tenant check), with every #345 path gated or withheld for Ignatious; #374 merged
   with Amendment 1 Accepted; #344's worker and role live (the role also needs
   `discovery_extract_stats`, `discovery_extract_budget_open`,
   `discovery_extract_budget_state`, the five-argument `discovery_extract_batch`, and
   `discovery_extract_reserve` and `discovery_extract_settle` for the per-call reservation;
   it holds no direct update on `discovery_extract_budget_items`).
   Spend on this path is bounded by the run's own estimate over a fixed cohort
   (`extract --estimate`), checked before every call, not by a fixed amount.

   **Gate.** Mailbox-derived content goes only to a processor whose row reads Verified:
   Yes. Mailbox-derived content is anything a #259 or #271 reader fetched, text derived
   from it, embeddings of it, and threads assembled for a reply (#268). The check sits where
   the model call is made; #262's agent-tool enumeration test, #268 and #269 carry it into
   code.

   **Existing flows keep running.** Screening, code-name suggestion and the five
   agents-backend paths predate the gate. Owner: Guillermo. Deadline: before the first real
   bank's mailbox connects under decision 2's gate (O9). If the terms are not verified by
   then, each flow falls back for real banks: screening to deterministic `fast` mode, code
   names to manual entry, the agents-backend paths off. For Ignatious the deadline is the
   first real pass under Amendment 1, and the fallbacks apply from that moment until the
   processor's row reads Verified: Yes.

   **Disclosure.** Screening (`src/lib/compliance/llm.ts:412`) sends bank content to
   Anthropic today, before ZDR is verified (O5). Code-name suggestion
   (`src/lib/gate0/codenameLlm.ts:103`) sends the target name, MNPI (control metadata,
   decision 7), the same way. The agents-backend paths send bank content to Anthropic
   through that backend.
   Each bank is told this in writing before it goes live: which processors receive its
   content, what each receives, and that retention and no-training terms stay unverified
   until O5 closes. The disclosure informs; it authorises nothing. It does not authorise a
   model call on real Ignatious content (Amendment 1, condition 4).

   **Anthropic rules.** From Anthropic's
   [API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention)
   page:

   - "Claude Fable 5.1, Claude Mythos 5.1, Claude Fable 5, and Claude Mythos 5 are
     designated Covered Models … and require 30-day data retention; ZDR is therefore not
     available for any of them unless expressly authorized by Anthropic." A ZDR
     organization can enable 30-day retention per workspace. Covered Models are barred for
     bank content, and a workspace that serves bank content never enables the 30-day
     override.
   - ZDR does not cover agent skills, batch processing, Claude Managed Agents, code
     execution, the Files API, the MCP connector, MCP tunnels or programmatic tool calling,
     so a flow that sends bank content through them cannot rely on ZDR. Structured outputs
     and cache diagnostics are listed as "Yes (qualified)": structured outputs cache the
     JSON schema, and cache diagnostics keep a hash fingerprint and token estimates, not
     prompts or outputs (O8).
   - "If a chat or session is flagged, Anthropic may retain inputs and outputs for up to 2
     years," even under ZDR.
   - Today's direct calls use the Messages API. The code default (`claude-sonnet-5`) is not
     a Covered Model; the production `SCREEN_LLM_MODEL` and `CODENAME_LLM_MODEL` values are
     unverified (O5).

   Claude on Bedrock and per-firm models of Conductia's own are later options, not designed
   here.

7. **No new bank content rests in the control plane, and the existing content stores are
   frozen, each with a named way out.** From acceptance, no migration adds a table or
   column to the control plane that holds bank content (decision 1), and reviewers check
   new migrations against decision 1. Frozen means no expansion. Existing flows keep
   writing until their follow-up lands, so shipped features keep working. Follow-up issues
   are filed under epic #261, and targets use its order: step 1, #262 and #270; step 2, the
   readers with #263 and #264; step 3, #265, #266 and #267; step 4, #268; step 5, #269.
   E1 to E9 is a reviewed inventory as of `develop` at `64aad26d`, not a proof; two review
   rounds each found columns the previous one missed. #264 therefore adds a column-level
   classification test that extends #262's table-classification test: every column of a
   string-bearing, array or json type (for example `text`, `varchar`, `text[]` such as
   `outbound_messages.to_emails` and `documents.folder_subpath`, `json` and `jsonb`) is
   classified as control metadata or bank content, and a new unclassified column fails
   CI.

   | # | Store (shared control Postgres unless noted) | Content it holds | Follow-up | Target |
   |---|---|---|---|---|
   | E1 | `source_items`, `source_item_sources`, `source_item_texts`, `routing_ledger`, `deal_candidates`, `evidence_links`, `candidate_visibility` | Subjects, participants, deal-linked body text; `deal_candidates.proposed_name` and `parties` (`supabase/migrations/20260925120000_discovery_core.sql:142,144`). `routing_ledger`, `source_item_sources` and `candidate_visibility` themselves hold only hashes, ids, decisions and counts and move with the set. | None new: moving these into the data plane is #264's scope | Epic step 2 (#264) |
   | E2 | `inbound_messages` | Full inbound webhook mail: subject, body, HTML, addresses | Move to the data plane, or retire it behind the readers | Epic step 2 (#259, #271) |
   | E3 | `audit_log.detail`: `reasons` on screen and outbox rows; filenames and folder paths on document audit rows, written by data-room upload (`src/app/api/v1/deals/[dealId]/steps/[stepId]/dataroom/upload/route.ts:143`), document view (`src/app/api/v1/deals/[dealId]/documents/[documentId]/view/route.ts:52`) and document download (`src/app/api/v1/deals/[dealId]/documents/[documentId]/download/route.ts:57`); free-text supervisory notes on outbox reject rows (`src/app/api/v1/outbox/[messageId]/route.ts:111`) | Model-written sentences about each screened message, filenames and paths, reviewer notes | New writes stop retaining content: the text goes to the data plane with its message or document, and `detail` keeps only its SHA-256 and an id, which the chain covers. Historical rows are an explicit exception: the log is append-only, so they stay. #266 removes filenames and folder paths from every document audit event, not only upload | Epic step 3 (#266) |
   | E4 | `outbound_messages` | Full sent mail, `rewrite`, recipients | #268 writes new sent originals to the data plane from day one. #279 migrates existing rows, keeps the 17a-4 / FINRA 4511 retention posture ([`compliance-rules.md`](../03-engineering/compliance-rules.md)) and follows the email policy of storing no `rewrite` ([`email-decisions-2026-09-19.md`](../project-memory/email-decisions-2026-09-19.md)) | Epic step 4 (#268 new rows, #279 existing rows) |
   | E5 | Conductia's Box enterprise (the rail-step Box client whenever Box credentials are set, `src/lib/box/index.ts`; the storage seam when `STORAGE_PROVIDER=box`) and the Supabase `dataroom` bucket (the seam's default); document metadata that discloses content: `documents.name`, `documents.folder_subpath` and related folder paths | Document bytes, filenames and folder paths | Move to the bank's own Box enterprise, which is a component of that bank's data plane (decision 1): the July 2026 syncs chose Box as the bank-facing room with its own certifications (#280). The same follow-up moves the content-disclosing metadata with the bytes; the control plane then keeps only opaque ids and non-content metadata (classification, room, phase, uploader, timestamps) | After #261 |
   | E6 | Conductia agents backend RDS (Conductia AWS, us-east-1) | Not verified; likely run outputs, briefs and twin chat | Inventory first (O10), then place each table under decision 1 | Epic step 2, revisable after O10 |
   | E7 | `lead_documents.text_content` (`supabase/migrations/20260818193000_lead_intelligence.sql:13`), `lead_research.memo_md` (`supabase/migrations/20260818180000_lead_research.sql:8`), `lead_intel.notes`, `fields`, `relationship_map` and `stakeholder_map`, `lead_personas.body`, `crm_people`, `lead_stakeholders`, `lead_relationships` | Extracted text of lead documents, model-written research memos, banker notes and CRM fields about a prospective client, relationship and stakeholder maps, agent-written person briefs, CRM people and titles | #281: move to the data plane's hot and warm tiers | Epic step 2, after #264 builds the tiers |
   | E8 | `deal_step_skill_runs.input`, `inputs` (the `jsonb` that replaced `input`) and `result_text`; `skill_publication_operations.capability_contract`, `result` and `duplicate_matches`; `skill_authoring_messages.text`, `skill_authoring_drafts.composer_text`, `skill_authoring_attempts.response_text` and `skill_authoring_candidates.preview`; the `error_message` columns are assessed with them | Skill run inputs and model outputs; authoring chat and drafts, which the skill builder seeds from a run's input and output | #282: move to the data plane's hot tier | Epic step 2, after #264 builds the tiers |
   | E9 | `deal_steps.work` (`jsonb`), `completion_note` and `skip_reason` | Manual step forms write meeting notes, sensitivities and a confidential pursue/pass rationale (`src/lib/rail/manualStepDefs.ts:43-85`) | #283: move to the data plane's hot tier | Epic step 2, after #264 |

   Identifying metadata the control plane keeps, classified under decision 1:

   - **`deal_candidates.proposed_name` and `parties`** are bank content. The classifier
     derives them from mail, so they move to the data plane with E1 (#264).
   - **Deal identity the banker enters is control metadata** (owner decision,
     2026-09-29): party `companies.name` (linked through `deal_parties`), `deals.code`,
     `deals.codename`, and roster names and emails. The banker enters them at intake
     rather than deriving them from bank content. The shell, the rail and routing depend on
     them, as do Gate 0's KYC and conflicts screen and the roster, across the firm's
     deals. They stay tenant-isolated under ADR-0016. They are MNPI: the target name of a
     sell-side deal is confidential, and Conductia holds it in the shared control plane. A
     code name exists to identify a deal without revealing its target. Sending any of them
     to a model is governed by decision 6. Mail-derived identity is bank content and moves
     with E1, as above.

8. **WORM copies are Conductia's tamper evidence, not the bank's books and records.** Every
   N minutes, the bank's data plane pulls audit log batches with the latest chain head from
   the control plane and writes them to immutable storage in that data plane (I6), and a
   verifier recomputes the chain from the copies (#266).
   This is the external per-tenant anchor the D62 migration names as an open decision. The
   storage options are
   [S3 Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html)
   in compliance mode,
   [Azure immutable blob storage](https://learn.microsoft.com/en-us/azure/storage/blobs/immutable-storage-overview)
   with a locked time-based retention policy, and
   [GCS Bucket Lock](https://docs.cloud.google.com/storage/docs/bucket-lock). This ADR
   chooses none of them; #266 chooses per bank and sets N. Cohasset has assessed the first
   two for SEC 17a-4
   ([2025 S3 assessment](https://d1.awsstatic.com/onedam/marketing-channels/website/aws/en_US/whitepapers/compliance/Amazon-S3-Compliance-Assessment-2025.pdf);
   Azure's 17a-4(f) assessment is cited on the
   [immutable storage page](https://learn.microsoft.com/en-us/azure/storage/blobs/immutable-storage-overview));
   no assessment for GCS Bucket Lock was verified (O13). The bank's own archive stays the
   record of truth (#261, "Index, not archive"). Whether the copies must meet strict 17a-4
   WORM or the audit-trail alternative added by the
   [2022 amendments](https://www.sec.gov/investment/amendments-electronic-recordkeeping-requirements-broker-dealers)
   ([rule text](https://www.law.cornell.edu/cfr/text/17/240.17a-4); see also
   [FINRA 4511](https://www.finra.org/rules-guidance/rulebooks/finra-rules/4511)) belongs
   to #266 and the bank's compliance function (O11). In mode 2 the target is a per-bank
   bucket or container in Conductia's cloud (I5).

9. **SOC 2 Type II is a sales dependency with an owner and a start trigger; it has not
   started.** Owner: Guillermo. No date. Readiness work and an auditor engagement begin
   when a named prospect asks for a SOC 2 report (O12). A Type II report covers an
   observation period typically 3 to 12 months long
   ([Drata](https://drata.com/learn/soc-2/type-1-vs-type-2)). Schneider Downs states that
   the AICPA sets no minimum, suggests six months, and allows a shorter period for a first
   report
   ([Schneider Downs](https://schneiderdowns.com/our-thoughts-on/what-should-you-consider-when-determining-soc-report-testing-period/));
   [Linford & Co](https://linfordco.com/blog/period-covered-type-ii-soc-examination/) also
   discusses how the period is chosen. The
   system boundary will include Vercel and Supabase, which hold their own SOC 2 Type 2
   attestations ([Vercel](https://vercel.com/docs/security/compliance),
   [Supabase](https://supabase.com/docs/guides/security/soc-2-compliance)), and, under
   mode 2, the Conductia cloud accounts that host bank data. The WORM copies of decision 8
   are part of that design.

   > **Superseded by D89 (2026-10-13), pending confirmation:** SOC 2 starts as Type I with
   > Vanta. D89 is proposed until Storm confirms the Type I-first sequencing
   > ([program](../08-security/soc2-type1-program.md)).

10. **Later, not designed here.**

    - Option (b), data routes served from inside the bank (decision 5). Trigger: a bank
      refuses content transit through a third-party edge.
    - The mode 2 to mode 1 migration (decision 2). Trigger: the first mode-2 bank whose own
      instance is ready, or one that asks to move.
    - Per-firm models of Conductia's own, and Claude on Bedrock as an alternative
      processor; Bedrock offers a per-region `none` retention mode
      ([Bedrock data retention](https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html)).

## Amendment 1: single-tenant pilot exception to decision 2

Proposed, October 4, 2026 (PR #374). Issue #343; decision D75. It records Guillermo's decision of
2026-10-03 that the Ignatious pilot runs on real Ignatious mail, and makes none of its
own. Its companion is D74 (#344), the interim exception to decision 3 that runs the
pilot's discovery worker in a dedicated AWS account writing to the hosted project. D74
governs where the worker runs and what it holds; this amendment governs where the data it
writes rests.

**The exception.** Decision 2's gate requires the instance that receives a real bank's
mail to pass I1 to I7. For Ignatious alone, real mail is read before any instance passes
them, and Ignatious's bank content rests in the current shared stack: the hosted Supabase
project and Conductia's Box enterprise. It rests only in stores decision 7 already lists:
discovery rows and stored text (E1), content in `audit_log.detail` (E3), sent mail (E4),
and document bytes, filenames and folder paths of filed documents (E5), whose bytes sit
in Conductia's Box enterprise or the Supabase `dataroom` bucket depending on the
production `STORAGE_PROVIDER` (O1). One addition goes beyond decision 7's list, and only
once an Ignatious user connects a send-as mailbox (#339 phase 2b): that user's send
credentials rest in `mailbox_connections` under the platform-wide `MAILBOX_TOKEN_KEY`.
Read access needs no stored token: the worker reads Gmail keylessly (#344). For
Ignatious, I1 to I3 do not hold while the exception runs, and nothing here claims they
do.

**Stores not admitted.** No content derived from real Ignatious mail is written to
`inbound_messages` (E2), the agents backend's RDS (E6), the lead intelligence stores
(E7), the skill run, publication and authoring stores (E8), `deal_steps.work` and its
notes (E9), or the vector store (#269). Any path that would write it there is disabled for
Ignatious before the first real pass; for model-call paths, that is #345's inventory gated
by #346 (condition 4). Banker-entered content the existing flows already write to E7 to
E9 stays under decision 7's freeze, as for every bank.

The exception covers decision 2: no isolated instance receives the mail. Of decision 4 it
covers only the requirement that a data-plane API stand between bank content and the
control plane. Decision 4's other duties still apply to Ignatious content: only what an
action needs is read, each read enforces the visibility the rows carry, passes the #262
guard and writes an audit row. D74 (#344) covers decision 3 for the worker. Decision 1
still classifies the content as bank content, so it leaves the shared stack, or for E3
meets its completion test, before the exception ends (the exit list below). Decision 5
holds from the first real pass, because #331 is a precondition (condition 3). Decisions 6
to 9 stay in force. Decision 7's freeze still applies: the exception admits Ignatious
content into existing stores only and adds no content table or column.

**Decision 6 for Ignatious.** The deadline for decision 6's existing flows is the first
real pass, not a later connection. From that moment until the processor's row reads
Verified: Yes, decision 6's fallbacks apply to Ignatious: screening runs in deterministic
`fast` mode, code names are entered manually, and the agents-backend paths are off.
Decision 6's written disclosure to Ignatious still goes out before it goes live. Its
statement that terms "stay unverified until O5 closes" does not authorise a model call on
real Ignatious content.

**Conditions in force.** Each holds for the life of the exception. Conditions 1 to 6 come
from #343; condition 7 is carried from #344 gate G0. Real reading starts only after the
#344 kill switch is merged. If condition 1, 2, 3, 4, 5 or 7 stops holding, reading real
Ignatious mail stops through the #344 kill switch until it holds again. The owner enforces
condition 6; the kill switch does not. Conditions 2, 3 and 7 are preconditions met before
the first real pass and then maintained.

1. **The #262 guard on every read.** Every mailbox read passes the #262 guard (D68). No
   read path bypasses it. Evidence: #262 merged (D68).
2. **The #263 policy before any body (precondition, then maintained).** Ignatious's
   exclusion policy is written before the first pass, and the policy runs before any
   message body is read or stored. An excluded message gets no row and is never shown.
   Evidence: #263 merged, and the owner's written record of Ignatious's policy.
3. **#331 merged before the first real pass (precondition, then maintained).** Content
   stays out of URLs and logs (decision 5, O3). Evidence: #331 merged.
4. **Model calls on real Ignatious content only after R4, per processor and per path.** ZDR and
   no-training terms are required for all real content (Guillermo, 2026-10-07); which processor,
   and its verification, are still under discussion. R4 is #301's
   gate for a processor's ZDR and no-training terms verified in writing, recorded as that
   processor's row in decision 6 reading Verified: Yes (O5). A model call on real
   Ignatious content goes only to a processor whose own row reads Verified: Yes, only for
   the content that row lists, and only through a gated path. Until then the worker runs
   on recorded replies only, and a real item gets no model reply. #345 is the inventory of
   every path that calls a model; #346 is the tenant model gate, which refuses a model
   call for a tenant unless its processor is verified. Before the first real pass, #346
   is merged and every path #345 lists is gated or disabled for Ignatious. Today the
   processor gate (`src/lib/modelGateway/processorGate.ts`) is a global constant, so
   verifying a processor there for Ignatious would open it for every tenant. No
   processor row reads Verified: Yes, and the constant is not flipped, before #346
   merges. Evidence: #346 merged; the #345 inventory with each path marked gated or
   disabled for Ignatious; for any live call, the processor's Verified: Yes row merged in
   a reviewed PR after #346.
5. **The worker as #344 builds it, with a narrow database credential.** It runs in the
   dedicated AWS account and reads Gmail keylessly. A dedicated account is not a narrow
   credential: as #387 merged it, the worker holds a long-lived `sb_secret_` key with
   full read and write on the hosted project, bypassing RLS for every tenant. Decision
   (Guillermo, 2026-10-08): the narrower credential is a dedicated Postgres role limited
   to the discovery tables and RPCs, under RLS, with no service role. If it is not in
   place by then, the `sb_secret_` key is accepted for the Demo and Trial tiers only;
   the narrower credential is a Pilot gate, so no real Ignatious mail is read under the
   `sb_secret_` key. The cost-and-risk record is in ADR-0020 decision 1. D74 (#344)
   records the worker's posture. Evidence: #344 merged (PR #387); the worker's secret
   holding the narrower credential, with G0, G4 and G10 signed again for it; its go-live
   gates recorded in the runbook.
6. **No agent accesses the hosted database.** Coding agents and automated assistants do
   not connect to the hosted project or query its rows. Changes to hosted state go through
   the owner, who enforces this condition. Evidence: the owner's written record of who
   holds hosted-database credentials.
7. **The blast radius accepted in writing (carried from #344 gate G0; precondition, then
   maintained).** Before any domain-wide delegation exists, the owner and Ignatious's CCO
   both accept in writing the domain-wide-delegation blast radius. Evidence: the signed
   G0 record.

**When it ends.** The exception ends when the exit list below is complete, and conditions
1 to 7 bind until then. The exit is due at the first of these events:

- **Before a second bank is onboarded.** Onboarding a second bank requires #264's pilot
  gate first: a mode-2 instance per bank passing I1 to I7, Ignatious's included, with
  Ignatious's exit from the shared stack complete. A second bank never connects to the
  shared stack. Before the worker goes live, #344 gate G4 confirms that the hosted project
  holds no other bank's real mailbox content.
- **Tightening (proposed): Ignatious's own instance goes live first.** If Ignatious's data plane
  passes I1 to I7, in mode 2 or mode 1, before a second bank is onboarded, the exit runs
  then. #343 does not require this; this amendment adds it.

The exception is not extended by default. Any extension, or any second tenant, needs a
new amendment accepted by the owner. Proposed: the owner reviews the exception at the Ignatious
pilot demo and every quarter after it while it runs. A review can end the exception early
or record that the conditions hold; it grants no extension.

**The exit list.** The exception is declared ended only when every content class it admits
has left the shared stack, or, for E3, met its completion test, each by its named
migration or follow-up. E3 is complete when #266 has stopped new content writes; rows
already written stay in `audit_log` as decision 7's explicit exception.

| Content class written under the exception | Where it rests now | Moved by |
|---|---|---|
| Discovery rows and stored text (E1) | Hosted Supabase project | #264: Ignatious's hot and warm tiers |
| Screening reasons, filenames and folder paths in `audit_log.detail` (E3) | Hosted Supabase project | Completion test, not a move: #266 stops new content writes; rows already written stay in `audit_log`, because the log is append-only (decision 7's explicit exception) |
| Sent mail (E4) | `outbound_messages` | #268 writes new sent originals to the data plane; #279 moves rows already written |
| Document bytes, filenames and folder paths of filed documents (E5) | Conductia's Box enterprise or the Supabase `dataroom` bucket, per the production `STORAGE_PROVIDER` (O1); `documents.name`, `documents.folder_subpath` | Decision 7's E5 follow-up: Ignatious's own Box enterprise, with the content-disclosing metadata (#280) |
| Send credentials (beyond decision 7's list; only once an Ignatious user connects a send-as mailbox, #339 phase 2b; read access is keyless, #344, and stores no token) | `mailbox_connections.tokens_encrypted` under `MAILBOX_TOKEN_KEY` | #268, which places the reply path's send credentials under a per-bank key |

**What changes in #264.**

- The #264 design stands. Its connection gate moves from before the first real mailbox to
  before the second bank.
- #264 owns the exit. It moves the E1 rows, verifies them against the SHA-256 hashes taken
  at ingest, removes them from the shared stack, and audits each step. It tracks the other
  rows of the exit list, and the exception ends only when every row is done, E3 by its
  completion test. Backups of
  the shared project keep removed rows until they age out under the provider's retention,
  and Ignatious is told so in writing.
- #264 moves the worker into Ignatious's data plane with no credential for the shared
  project. That is the sunset of D74 (#344).
- The #264 canary and the ported parity tests (decisions 4 and 5) run against Ignatious's
  instance before the shared-stack copies are removed.
- O4 no longer gates the pilot. It gates the exit: Ignatious accepts mode 2 in writing,
  or its mode-1 instance is ready, before #264 moves its content.

## Consequences and limits

- Today's system does not conform. E1 to E9 hold bank content in Conductia's control plane
  or Conductia-operated services. "Never leaves the bank" is the target until their
  follow-ups land, and nothing in this ADR claims it holds today.
- The simulated bank does not yet run on mode 2. Its discovery data (`source_items`,
  `source_item_texts` and the related tables), written by the tracer and by PR #243's
  worker, sits in the shared dev Supabase project. That fails I1 and I3. No real bank is
  affected; #264 moves it.
- Under Amendment 1, real Ignatious mail content rests in the shared hosted stack. That
  fails I1 to I3 for Ignatious until #264 moves it.
- Search queries and chat prompts travel in URLs today, and Vercel's runtime logs keep
  request paths and search params. O3 lists the call sites.
- Upstream error text reaches Vercel runtime logs today, so decision 5 does not hold yet:
  Box response bodies and deal folder names, agents-backend error messages, Anthropic
  error responses from the code-name call (which may carry content), Resend body text,
  PostgREST `details`, and Next.js's default logging of uncaught errors, which carries the
  same `Error.message` text. O3 lists each site. The #264 canary fails on these paths
  until they log codes and ids only.
- The regions of the production Supabase project and the production Vercel functions are
  not recorded (O1). `vercel.json` has no `regions` key, which implies Vercel's documented
  `iad1` default
  ([regions](https://vercel.com/docs/functions/configuring-functions/region)). In mode 2,
  each bank's region becomes a disclosure item.
- The screening and code-name model is set by environment variables (`SCREEN_LLM_MODEL`,
  `CODENAME_LLM_MODEL`). Setting a Covered Model would breach decision 6 silently; no code
  refuses it.
- ZDR narrows retention; it does not remove it. Flagged content may be kept up to 2 years
  even under ZDR.
- The agents backend's own plans rule out an AI gateway because a gateway adds a data
  processor (`platform/plans/MASTRA_CHAT_CACHE_PLAN.md` in
  `Conductia/conductia-agents-backend`), while #269 routes Voyage through the Vercel AI
  Gateway. This ADR does not settle that (O6).
- Historical content in `audit_log.detail` (screening reasons, filenames and folder paths,
  supervisory notes) stays. The log is append-only and cannot be rewritten (E3).
- WORM copies written in mode 2 sit under a compliance-mode retention lock in Conductia's
  cloud and cannot be deleted on migration or offboarding until the lock expires. I7's
  teardown excludes them, and the mode-2 disclosure says so (O4).
- Mode 2 brings the Conductia cloud accounts that host bank data inside the SOC 2 system
  boundary (decision 9).
- What the agents backend's RDS holds is not verified (E6, O10).
- The freeze in decision 7 is enforced by review, not by an automated check.
- Every table that moves to a data plane (E1, E2, E4, E7, E8, E9) loses its foreign keys to
  control-plane rows (for example `evidence_links.deal_id`, `inbound_messages.deal_id` and
  `outbound_messages.deal_id` to `deals`; `candidate_visibility.person_id` and
  `outbound_messages.sender_id` to `users`). A foreign key cannot span two databases, and
  I3 forbids sharing one. Moved tables keep control-plane ids as plain references. The
  data-plane API checks that each id exists and belongs to the bank's tenant, and handles
  the cascades and set-nulls that run today (#264 for E1; the other follow-ups inherit
  it).
- Reader registration (`graph_reader_registrations`, `content_sources`) holds no bank
  content and stays in the control plane beside the #262 allowlist. The data plane pulls
  it, and E1 tables reference it by plain id. `cert_secret_ref` is a reference, never key
  material; in mode 1 the certificate lives in a secret store in the bank's account (I2).
- `discovery_upsert_candidates` writes `discovery.*` audit rows in the same transaction as
  the candidate rows (`supabase/migrations/20260925120000_discovery_core.sql`). Once E1
  moves, the data plane reports those audit events to the control plane's `audit_log`
  through the API instead, and #264 sets the ordering and failure semantics. The routing
  ledger stays in the data plane; only audit events and counts go upward.
- Delegated Microsoft Graph send tokens for every bank sit in the shared control Postgres
  (`mailbox_connections.tokens_encrypted`), encrypted under one platform-wide
  `MAILBOX_TOKEN_KEY`. That falls short of I2's intent that no key serves two banks.
  Credentials to a bank's systems use a per-bank key, and in mode 1 they live where the
  component that uses them runs; #268 decides where the reply path's send credentials
  live.

## Open questions

- **O1. Where do the production Supabase project and the production Vercel functions
  run?** Owner: Lance (dashboard access). Record the region of the production and dev
  Supabase projects and of the production Vercel functions, and the production
  `STORAGE_PROVIDER` value.
- **O2. How does a control-plane request reach a data plane that opens every connection
  itself, and which Conductia cloud hosts mode 2?** Owner: #264. The data plane opens
  every connection outbound (I6); Vercel calling a data-plane endpoint inbound is not an
  option in mode 1. Candidates are a queue or long-poll the data plane pulls from, or a
  control-plane relay that holds the data plane's outbound connection. Mode 2 hosting is
  either a per-bank account in Conductia's AWS organization or a per-bank Supabase project
  with its own bucket and key. Both answers must satisfy I1 to I7 and be the same in both
  modes (I6). #264 chooses the mechanism: a relay or tunnel the data plane opens, or a
  pull model. Any inbound exception needs that bank's written sign-off and an amendment
  to this ADR.
- **O3. Which issue removes content from server logs and URLs?** Owner: whoever picks
  up #264. The #264 canary depends on it. The canary also needs read access from CI to
  the preview deployment's runtime logs (a Vercel API token or a drain), which CI does not
  have today; a drain added for the test is itself a store under decision 5. A follow-up
  issue moves content out of URLs into POST bodies or behind opaque ids (URL sites), and
  makes log sites log codes and ids only (log sites):
  - URL: `src/app/api/v1/crm-people/route.ts:22`, `src/app/api/v1/people/route.ts:17` and
    `src/app/api/v1/companies/route.ts:32`: `?query=` carries person and company names,
    and company names are MNPI;
  - URL: `src/components/workspace/AskComposer.tsx:24` and
    `src/components/workspace/SuggestionChips.tsx:31`: `/projects/[id]/chat?q=` carries
    free text;
  - Log: `src/lib/box/client.ts`: Box response bodies thrown at `:33-34`, `:94-95`,
    `:114-115`, `:143-144` and `:165-166`, logged with deal folder names from the deal,
    template-creation and dataroom-upload routes;
  - Log: `src/lib/ignatious/routeContext.ts:156`: agents-backend error messages;
  - Log: `src/lib/gate0/codenameLlm.ts:120`: the Anthropic error response from the
    code-name call, which may carry content;
  - Log: `src/lib/api/v1/inviteDelivery.ts`: Resend body text;
  - Log: `src/lib/api/v1/http.ts` (`auditFailed`): PostgREST `details`;
  - Log: Next.js's default logging of uncaught errors, which carries the same
    `Error.message` text.

  Status (#331): the URL and log sites above are closed. Person search is `POST
  /api/v1/people/search`, `?query=` on `crm-people` and `companies` is refused with a 400,
  and the chat prompt and the `/leads` person focus ride in the URL fragment. Box, Resend,
  Graph, the code-name call, `auditFailed` and the agents-backend relay log a status and a
  code. Thrown messages carry `<step> failed (<code>)` instead of a PostgREST or provider
  message, so Next.js's default print of an uncaught error has no content to show. The
  guard is `tests/content-egress-guard.test.ts` (rules U1, U2, L1, L2, T1, T2, R1), and the
  canaries are `tests/content-egress-canary.test.ts` and
  `tests/content-egress-canary-throws.test.ts`. The response guarantee covers provider
  bodies only. Direct PostgREST `jsonError(error.message)` responses go to the caller who
  made the request, and stay out of scope. The one thrown-message exception is the
  Ignatious 4xx validation copy (`control-plane.ts`), and R1 allows the three Ignatious
  relays that return that copy; both are first-party copy shown to the requesting user.
- **O4. Has Ignatious accepted mode 2 in writing?** Owner: to be assigned by epic #261 to
  whoever holds the Ignatious commercial relationship. This was the gate on real Ignatious
  mail (decision 2); Amendment 1 moves it to the exit. The written disclosure states that
  mode 2 hosts their data in a dedicated, isolated instance in Conductia's cloud, names
  the exit trigger if they are headed for mode 1, and says WORM copies stay under
  retention lock after any migration or offboarding.
- **O5. Do the Anthropic organizations have ZDR and no-training terms?** Owner: Guillermo.
  For the organization behind Conductia's `ANTHROPIC_API_KEY` and for the agents backend's
  prod and demo keys: is ZDR executed, are they the same organization, which workspace ids
  serve bank content, and is the 30-day Covered Model override enabled on any of them (it
  must not be). Which model ids run in production: `SCREEN_LLM_MODEL` and
  `CODENAME_LLM_MODEL` here, and in the agents backend `claude-opus-5` (extraction),
  `claude-sonnet-5` (structuring, gate critic, skill runs, skill bench default) and
  `claude-haiku-4-5` (eval judge) per its `.env.example`, plus the bench's per-turn
  aliases; none may be a Covered Model. The agents backend lists the same item as open
  (`platform/plans/OPEN_ITEMS.md`).
- **O6. How does #269 get ZDR for Voyage, and does a gateway belong in the path at all?**
  Owner: #269. The Vercel AI Gateway's
  [ZDR page](https://vercel.com/docs/ai-gateway/security-and-compliance/zdr) does not list
  Voyage among its ZDR providers and treats a provider with an unknown retention stance
  as not ZDR-compliant, so the Gateway's ZDR does not cover Voyage. #269 gets a direct ZDR
  agreement with Voyage or chooses another processor. Voyage's own terms default to
  training on customer content unless the customer opts out. Embeddings of mail are
  mailbox-derived, so decision 6's gate applies. Settle before #269 is scoped.
- **O7. What is Anthropic's default API retention?** Owner: Guillermo, with O5. The
  [Privacy Center](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)
  says inputs and outputs are deleted within 30 days by default; the API and data
  retention page says content is not retained by default apart from Covered Models. The
  two are unreconciled.
- **O8. Do the contractual ZDR terms cover the "Yes (qualified)" features?** Owner:
  Guillermo, with O5. The API and data retention page explains the qualification:
  structured outputs cache the JSON schema, and cache diagnostics keep a hash fingerprint
  and token estimates, not prompts or outputs. What remains is whether the executed ZDR
  agreement treats that retention as covered.
- **O9. Is "before the first real bank's mailbox connects" the right deadline for the
  existing flows?** Owner: Guillermo, the flows' owner, to confirm with epic #261 or
  replace with a calendar date. Until then the flows run under decision 6's disclosure. An
  event tied to the decision 2 gate cannot pass unnoticed; a
  date can be substituted here and in decision 6. For Ignatious this is settled:
  Amendment 1 sets the deadline at the first real pass, the fallbacks apply from then
  until the processor's row reads Verified: Yes, and the disclosure authorises no model
  call on real Ignatious content.
- **O10. Which tables in the agents backend's RDS hold bank content?** Owner: the
  agents-backend owner. List run outputs, briefs and twin chat history, if present. This
  inventory is the first step of E6.
- **O11. Must the WORM copies meet strict 17a-4 WORM, or does the 2022 audit-trail
  alternative apply?** Owner: #266, with the bank's compliance function. The answer also
  sets how long mode-2 copies stay locked in Conductia's cloud.
- **O12. Has a named prospect asked for a SOC 2 report?** Owner: Guillermo. This is the
  start trigger in decision 9; watch it. **Superseded by D89 (2026-10-13), pending
  confirmation:** SOC 2 starts as Type I with Vanta, not on a prospect trigger.
- **O13. Is there a Cohasset (or equivalent) 17a-4 assessment for GCS Bucket Lock?** Owner:
  #266. None was verified; Google markets Bucket Lock for FINRA, SEC and CFTC use.

## References

- ADR-0016,
  [`ADR-0016-per-firm-tenancy-and-rls-backstop.md`](./ADR-0016-per-firm-tenancy-and-rls-backstop.md):
  the shared control-plane Postgres this ADR extends.
- D62 and `supabase/migrations/20260925100000_audit_hash_chain.sql`: the per-tenant audit
  chain and its open external anchor.
- [`isolation-and-storage-architecture.md`](../03-engineering/isolation-and-storage-architecture.md):
  July 2026 BYOC research, now pointing here.
- [`email-decisions-2026-09-19.md`](../project-memory/email-decisions-2026-09-19.md): the
  email policy of storing no `rewrite` (E4).
- Epic #261 and issues #262, #264, #266, #268, #269, #270.
- Amendment 1: issue #343 (D75), with #263, #266, #268, #269, #279, #280, #331, D74 (#344),
  #345 (inventory of model-call paths) and #346 (the tenant model gate); #301, the
  mailbox-ingestion roadmap whose gate R4 condition 4 uses.
- Zilliz, BYOC overview:
  https://docs.zilliz.com/docs/byoc/byoc-intro (retrieved 2026-09-29).
- Redpanda, BYOC architecture:
  https://docs.redpanda.com/cloud-data-platform/get-started/byoc-arch/ (retrieved 2026-09-29).
- Databricks, architecture overview:
  https://docs.databricks.com/aws/en/getting-started/overview (retrieved 2026-09-29).
- Vercel, Runtime Logs (fields, limits, retention):
  https://vercel.com/docs/logs/runtime (retrieved 2026-09-29).
- Vercel, Drains: https://vercel.com/docs/drains (retrieved 2026-09-29).
- Vercel, Configuring regions:
  https://vercel.com/docs/functions/configuring-functions/region (retrieved 2026-09-29).
- Vercel, Networking: https://vercel.com/docs/networking (retrieved 2026-09-29).
- Vercel, Secure Compute:
  https://vercel.com/docs/networking/secure-compute (retrieved 2026-09-29).
- Anthropic, API and data retention:
  https://platform.claude.com/docs/en/manage-claude/api-and-data-retention (retrieved 2026-09-29).
- Anthropic, Privacy Center, organization data retention:
  https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data (retrieved 2026-09-29).
- Anthropic, Commercial Terms: https://www.anthropic.com/legal/commercial-terms (retrieved 2026-09-29).
- Vercel AI Gateway, zero data retention:
  https://vercel.com/docs/ai-gateway/security-and-compliance/zdr (retrieved 2026-09-29).
- Vercel AI Gateway, disallow prompt training:
  https://vercel.com/docs/ai-gateway/security-and-compliance/disallow-prompt-training (retrieved 2026-09-29).
- Voyage AI, Terms of Service: https://www.voyageai.com/tos (retrieved 2026-09-29).
- AWS, S3 Object Lock:
  https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html (retrieved 2026-09-29).
- Cohasset, Amazon S3 compliance assessment (2025):
  https://d1.awsstatic.com/onedam/marketing-channels/website/aws/en_US/whitepapers/compliance/Amazon-S3-Compliance-Assessment-2025.pdf (retrieved 2026-09-29).
- Microsoft, Azure immutable blob storage (cites Cohasset's SEC 17a-4(f) assessment):
  https://learn.microsoft.com/en-us/azure/storage/blobs/immutable-storage-overview (retrieved 2026-09-29).
- Google Cloud, Bucket Lock:
  https://docs.cloud.google.com/storage/docs/bucket-lock (retrieved 2026-09-29).
- SEC, electronic recordkeeping amendments (Release 34-96034):
  https://www.sec.gov/investment/amendments-electronic-recordkeeping-requirements-broker-dealers (retrieved 2026-09-29).
- 17 CFR 240.17a-4: https://www.law.cornell.edu/cfr/text/17/240.17a-4 (retrieved 2026-09-29).
- FINRA Rule 4511:
  https://www.finra.org/rules-guidance/rulebooks/finra-rules/4511 (retrieved 2026-09-29).
- Drata, SOC 2 Type 1 vs Type 2:
  https://drata.com/learn/soc-2/type-1-vs-type-2 (retrieved 2026-09-29).
- Schneider Downs, SOC report testing period:
  https://schneiderdowns.com/our-thoughts-on/what-should-you-consider-when-determining-soc-report-testing-period/ (retrieved 2026-09-29).
- Linford & Co, period covered by a Type II examination:
  https://linfordco.com/blog/period-covered-type-ii-soc-examination/ (retrieved 2026-09-29).
- Vercel, Compliance: https://vercel.com/docs/security/compliance (retrieved 2026-09-29).
- Supabase, SOC 2 compliance:
  https://supabase.com/docs/guides/security/soc-2-compliance (retrieved 2026-09-29).
- AWS, Bedrock data retention:
  https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html (retrieved 2026-09-29).
