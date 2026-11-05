**CONDUCTIA**

**Compliance Build Plan — v2 (Revised)**

*July 7, 2026 \| Owner: Product/Eng \| Status: For sprint planning*

# **Guiding Principles**

- **Enable, don't be, the system of record.** Bank clients are the regulated entities (SEC 17a-4, FINRA). Conductia's job is exportable, immutable, complete records that plug into the bank's retention and surveillance rails.

- **Procurement gates before regulators do.** SOC 2 Type II, DDQ pack, and LLM-provider zero-retention terms block pilots earlier than any SEC rule. Evidence collection starts at MVP or Phase 2 slips ~12 months.

- **Defined log schema over “state capture.”** Audit defensibility = a finite, versioned inference record (Section: Inference Record Schema), not an attempt to freeze the full model environment.

- **Scope out risk before building integrations.** MVP blocks external send/share entirely (kills the off-channel problem); archive integrations ship in Phase 2 when pilots demand them.

# **Phase 1 — MVP (Foundation)**

*Goal: pass a bank InfoSec review and produce a defensible audit trail from the first inference.*

<table>
<colgroup>
<col style="width: 19%" />
<col style="width: 43%" />
<col style="width: 36%" />
</colgroup>
<thead>
<tr>
<th><strong>Workstream</strong></th>
<th><strong>Deliverable (Definition of Done)</strong></th>
<th><strong>Acceptance Criteria</strong></th>
</tr>
<tr>
<th><strong>Inference audit log</strong></th>
<th><p>Append-only store writing one record per inference using the schema below. No update/delete paths in app code.</p>
<p>Export API: JSON/CSV by date range, deal, or user.</p></th>
<th>Every LLM call produces a record; tamper-evidence via hash chaining; export of 10K records &lt; 60s.</th>
</tr>
<tr>
<th><strong>Access control &amp; information barriers</strong></th>
<th><p>Deal-scoped RBAC (need-to-know by deal team). SSO (SAML/OIDC) + SCIM provisioning.</p>
<p>Wall-crossing: adding a user to a deal is a logged, approver-gated event.</p></th>
<th>User outside deal team cannot retrieve deal docs, embeddings, or logs (verified by test suite). All access events logged.</th>
</tr>
<tr>
<th><strong>Data isolation</strong></th>
<th><p>Single-tenant DB + object storage per client as default. Documented isolation model (logical vs. physical) per tier.</p>
<p>Architecture supports dedicated VPC + CMEK (delivered Phase 2) with no re-platform.</p></th>
<th>Isolation whitepaper reviewed by security lead; no cross-tenant queries possible at the connection level.</th>
</tr>
<tr>
<th><strong>Egress control (off-channel scope-out)</strong></th>
<th>No send-to-external, no email/chat integration, no public share links at MVP. Copy/download events logged with content hash.</th>
<th>Zero outbound comms paths in threat model; copy/export events appear in audit log.</th>
</tr>
<tr>
<th><strong>Vendor &amp; trust posture</strong></th>
<th><p>Zero-retention / no-training agreements executed with LLM provider(s); subprocessor list published.</p>
<p>SOC 2 Type II: controls implemented, evidence collection running (target report in Phase 3).</p></th>
<th>Signed DPAs on file; monitoring agent live; DDQ draft answers exist for top-20 bank questions.</th>
</tr>
</thead>
<tbody>
</tbody>
</table>

# **Phase 2 — Pilot-Ready (Enterprise Gate)**

*Goal: clear a tier-1 or upper-mid-market bank pilot: procurement, compliance sign-off, deployment model.*

| **Workstream** | **Deliverable (Definition of Done)** | **Acceptance Criteria** |
|----|----|----|
| **Records & archive integration** | 17a-4-compatible export: WORM pass-through (S3 Object Lock or client rails) and/or 2022-amendment audit-trail method. Connectors: Smarsh, Global Relay (webhook + batch). | End-to-end test: inference record lands in client archive sandbox unmodified; D3P access supported. |
| **Supervision / approval workflow** | Principal review: draft → reviewer → approved states for client-facing outputs (teasers, CIM sections, emails). Attestation (who/when/what version) written to audit log. Optional auto-suggested disclosures by doc type (nice-to-have, not gate). | No client-facing artifact exportable without an approval record. |
| **Deployment options** | Dedicated VPC deployment + customer-managed keys (CMEK). Data-residency selection (US/EU). | One reference deployment live in isolated VPC; key rotation runbook tested. |
| **Model change management (MRM)** | Versioned system prompts (hash + changelog). Regression eval suite (accuracy, hallucination, leakage) run per model/prompt change; results archived. Client notification policy for material changes. | CI blocks prompt/model promotion on eval regression; change log exportable for bank model-risk teams (SR 11-7 lens). |
| **DORA (conditional)** | If any EU bank targeting: ICT risk register, incident reporting workflow, exit plan. DORA is in force now — this cannot sit in Phase 4 for EU deals. | Gap assessment complete; register + incident runbook exist. |

# **Phase 3 — Diligence-Grade**

| **Workstream** | **Deliverable (Definition of Done)** | **Acceptance Criteria** |
|----|----|----|
| **Lineage & reproducibility** | Source citations: every generated claim links to doc/page/chunk (e.g., CIM p. 214 → valuation input). Replay: pinned model version + logged context re-executes any historical inference. | Auditor can trace any output claim to its source in ≤ 3 clicks; replay reproduces logged output or flags drift. |
| **Agentic guardrails** | Action allowlist per client; human approval gate on any externally-visible action; global + per-deal kill switch; autonomous actions logged as first-class audit events. | No agent path can trigger an external event without an approval record; kill switch halts within 5s. |
| **Compliance console** | CCO-facing dashboard: exception reports, access reviews, wall-crossing history, approval backlog. | Pilot bank CCO signs off on supervisory adequacy. |
| **SOC 2 Type II** | Report issued (evidence window began at MVP). | Clean report or documented exceptions with remediation. |

# **Phase 4 — Scale & International**

- **ISO 42001** (AI management system) certification for global bank procurement.

- **On-prem / air-gapped option** for tier-1 banks that reject VPC.

- **MRM documentation pack** — standing model-risk dossier per model version for bank validation teams.

- **Full DORA program** (if not pulled forward in Phase 2) + local data-residency expansion.

# **Inference Record Schema (MVP)**

Every LLM call writes one immutable record:

- record_id, timestamp (UTC), user_id, client_id, deal_id

- model_id + version, params (temp, top_p, max_tokens)

- system_prompt_hash + version, tool/agent config hash

- user_prompt (verbatim), rag_context: \[doc_id, chunk_id, chunk_hash, page\]

- output (verbatim), output_hash, prev_record_hash (chain)

*This is the concrete answer to “capture the model environment state” — bounded, buildable, and audit-complete.*

# **Open Decisions (Blockers for Sprint 1)**

- **Target tier for Phase 2 pilots.** Boutique/MM advisory → single-tenant SaaS suffices. Bulge bracket → VPC + CMEK moves into MVP scope. Decide before infra sprint.

- **EU in the 24-month plan?** Yes → DORA moves to Phase 2 and EU residency to the deployment backlog now.

- **Archiving posture.** Pass-through to client rails (recommended) vs. Conductia-hosted WORM store (higher cost, higher liability).

- **LLM provider redundancy.** Single provider with zero-retention terms vs. dual-provider abstraction — affects eval suite and MRM scope.
