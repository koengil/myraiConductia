# Deal Isolation & Storage Architecture — Research

Status: research for the 2026-07-06 architecture sync. Author: Marcelo.
Task: Marcelo's action item #1 from the 2026-07-02 Storm founders'-sprint call ("research AWS EC2 isolation and VPS architecture options"). Feeds the "Storage" question the Vision on Two Pages marks as deliberately open.

Not legal advice. Every load-bearing claim is sourced inline; the recordkeeping conclusions must be validated with securities counsel, and the AWS specifics confirmed with an AWS account team at deploy time. Uncertainties are flagged.

---

**Update — 2026-07-06 (post RTS + Ignatius syncs): this is the enterprise / generalization target, NOT the MVP.** The two Jul 6 syncs chose an **Ignatius-first MVP on a Box + Global Relay stack**: Box is the secure data room (its own GDPR/FINRA/HIPAA/SOC certifications, AI-native APIs, per-file deal-ID tagging, permissions, e-sign), Global Relay is the compliant comms archive, and Intelibank is the **orchestration layer in the middle** — not the storage owner. Per-deal isolation in the MVP is therefore **deal-ID tagging + permissions in Box**, not per-deal KMS keys. Two constraints also reframe this document: the platform must be **cloud-provider agnostic** (a bank may hold compliance contracts only with Azure, not AWS), so the AWS/BYOC model below is one instantiation, not the universal answer; and for banks that will not upload into a third-party data room and demand data-residency in their own cloud, this BYOC + per-deal-crypto + Object-Lock model remains the target. Keep this doc for the Phase-2 "make it generic across clouds" work and for the 17a-4 / D3P reasoning (§4), which still governs when a big bank self-hosts its archive. The Azure-side equivalent of "retrieve without storing" raised in the sync is **Azure AI Search** (SharePoint connector, semantic search, client-side index).

> **2026-09-29:** the decision of record for residency is [ADR-0017](../07-decisions/ADR-0017-hybrid-data-residency.md). Where this doc disagrees, for example the last line of §6 ("Production is Postgres + Bedrock + S3 Object Lock inside each firm's AWS account"), ADR-0017 wins.

---

## Executive recommendation

Adopt a three-layer model, and make the operator boundary BYOC (the bank's own AWS account):

```
PER FIRM  → BYOC: our data plane runs INSIDE the bank's own AWS account.
            Claude via Amazon Bedrock (in-region, ZDR/ZOA), customer-managed KMS.
            This is the only model that satisfies "deal data never sits on a vendor system"
            — and it collapses the SEC 17a-4 designated-third-party problem (see §4).
PER DEAL  → cryptographic isolation, NOT a VM per deal: one KMS key + storage
            partition + append-only audit ledger per deal. Shared compute, scoped by
            IAM + app-layer predicates. Crypto-shred on offboarding.
ON CLOSE  → freeze to S3 Object Lock (Compliance mode): the immutable 17a-4 archive.
COMPUTE   → shared-tenancy-on-Nitro (AWS operators cannot read instance memory —
            independently affirmed); Nitro Enclaves around the key/governance core;
            dedicated EC2 only on a written external mandate. (§2b)
```

The single most consequential decision is the operator boundary: putting the archive and data plane in the bank's own account is what makes the compliance story ("data never leaves the bank") true and what lets the bank satisfy its recordkeeping undertakings in-house. Everything else follows.

Two internal claims are corrected by this research (details below): a KMS key per deal is not "free" (~$12/key/yr, and crypto-destruction takes 7–30 days, not instant), and a VM per deal is both weaker on the compliance story and ~4–7× more expensive than per-deal crypto isolation.

---

## The question and the three proposals

What isolation/storage model do we adopt, and what is stored where — on Intelibank, on a per-deal machine, or on the bank's own system? Three proposals surfaced this week; they are pitched at three different layers and can be reconciled:

| Proposal | Source | Boundary | Verdict from this research |
|---|---|---|---|
| Per-project VM / VPS (~$80/yr each) | 2026-07-02 Granola | a VM per deal | Reject as the isolation primitive: weakest compliance story, ~4–7× costlier, weak crypto-shred |
| Per-deal cryptographic isolation | Jess, post-call | KMS key + partition + ledger per deal | Adopt for data-at-rest + crypto-shred + audit; pair with IAM/app-layer scoping on shared compute |
| Client-resident (bank's own cloud) | Vision on Two Pages | the bank's AWS account (BYOC) | Adopt as the per-firm boundary; it is also the 17a-4 clincher |

---

## §1 — Operator model: BYOC vs vendor-managed single-tenant

| Dimension | BYOC (data plane in the bank's own AWS account) | Vendor-managed single-tenant (a dedicated account per bank, we operate) |
|---|---|---|
| Where data lives | The bank's cloud; data never crosses a boundary the bank doesn't own | The vendor's infrastructure, even if physically isolated per tenant |
| Keys | Can sit entirely with the bank (customer-managed KMS in their account) | Held in the vendor's account by default; vendor operators retain data-plane access |
| Updates / CD | Split control-plane / data-plane: our control plane orchestrates deploys into the bank's account via IAM roles; some upgrades need bank-side coordination | Standard vendor CD across N isolated accounts (Organizations + Control Tower) |
| Ops burden | Highest, and split (IAM negotiation, VPC peering, harder debugging) | Vendor bears nearly all ops, but runs/patches N stacks — "the most expensive, operationally heavy isolation model" |
| Compliance optics | Strongest — the literal "data never leaves the bank"; the tenant boundary is an account the bank controls | Good, but the vendor is still in the data path; does not satisfy a hard "never on a vendor system" rule |
| Examples | Databricks, Confluent, Snowflake, Cohere, Pinecone, ClickHouse | The "enterprise tier" of tiered SaaS; Snowflake's Account-Per-Tenant |

Conclusion: for a bank with a hard data-residency requirement, BYOC is the model auditors increasingly demand, because the boundary sits in an account the bank controls and the vendor has no root over the data plane. What we give up by choosing it: shared-infra economics and simple uniform CD; we run a split control/data plane, negotiate per-bank IAM/network access, and lose direct debugging visibility — higher per-customer engineering and ops cost in exchange for the only "never leaves the bank" story.

Sources: [BYOC developer guide](https://blog.railway.com/p/what-is-byoc-developer-guide-2026) · [Confluent: control/data plane](https://www.confluent.io/learn/bring-your-own-cloud/) · [AWS: account-per-tenant lifecycle](https://aws.amazon.com/blogs/mt/managing-the-account-lifecycle-in-account-per-tenant-saas-environments-on-aws/).

### Bedrock inside that boundary (the model runtime)

- ZDR + ZOA by default: "by default, Amazon Bedrock does not store model inputs or outputs," no operators can access input/output, and AWS/providers "will not use any inputs or outputs to train" models. Content is encrypted at rest in-region; supports customer-managed KMS.
- Private path: Bedrock supports interface VPC endpoints via PrivateLink, so requests never traverse the public internet. Nuance to state honestly to the bank: Bedrock is a managed service — inference executes in an AWS-operated Bedrock service account, not literally inside the bank's VPC. PrivateLink keeps the path private and ZDR/ZOA keep the data un-retained and un-viewable, but the invocation is still processed by the AWS-managed service.
- Claude is first-class on Bedrock (`anthropic.claude-*`), with Regional endpoints for data-residency guarantees. Some models carry a 30-day abuse-retention exception (currently named: Claude Fable 5); eligible customers can request full ZDR via their AWS account team. Verify the exact model + retention posture at deploy time.
- Bedrock Guardrails = content + PII filters (block / anonymize / detect). A leakage-mitigation layer, not a residency control.

Sources: [Bedrock FAQs](https://aws.amazon.com/bedrock/faqs/) · [Bedrock data protection](https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html) · [Bedrock abuse detection / ZDR](https://docs.aws.amazon.com/bedrock/latest/userguide/abuse-detection.html) · [Bedrock PrivateLink](https://docs.aws.amazon.com/bedrock/latest/userguide/vpc-interface-endpoints.html) · [Claude on Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-claude.html).

---

## §2 — Per-deal isolation: crypto keys vs VMs (with real numbers)

AWS documents one KMS key per tenant (in a central account) as a tenant-isolation pattern: a cryptographic per-tenant boundary, per-tenant rotation, a per-tenant CloudTrail signal, and crypto-shred on offboarding. Mapped to key-per-deal:

- Cost: a customer-managed KMS key is $1/key/month = $12/yr (up to ~$36/yr with rotation). Data keys are free; with envelope encryption + data-key caching (or S3 Bucket Keys) request cost is a rounding error. So key count is not the cost driver; caching is.
- Limits: default 100,000 keys per account per region (raiseable). Not the binding constraint.
- Crypto-shred: deleting a key renders all data under it unrecoverable — textbook crypto-shredding — but AWS enforces a 7–30 day (default 30) deletion window; for an instant, reversible lockout you disable the key.
- Honest limit: KMS isolates data at rest, not compute/memory. A compromised shared process can unwrap many deals' keys; the boundary is only as strong as the IAM/app-layer scoping around each key.

Cost comparison (us-east-1 list, July 2026):

| Model | Per deal/yr | 100 deals/yr | 1,000 deals/yr | Isolates |
|---|---|---|---|---|
| KMS key-per-deal + shared compute | ~$12 (keys) + negligible requests | ~$1,200 | ~$12,000 | data-at-rest (crypto), + audit + crypto-shred |
| VM/VPS-per-deal (~$42–80/yr) | ~$42–80 | ~$4,200–8,000 | ~$42,000–80,000 | compute + memory + network |

Reconciliation: they are not substitutes. The mature pattern is KMS key-per-deal for the data-at-rest + crypto-shred + audit boundary, combined with IAM + app-layer tenant scoping on shared compute — reserving VM/account-level compute isolation only for the highest-sensitivity deals where isolating the running process is a hard requirement.

Corrections to internal claims:
- "Minting a key is instant and free" → near-instant to create, but ~$12/key/yr, and crypto-destruction takes 7+ days (disable for instant lockout).
- "$80/yr VM per project" is a plausible small-VPS figure, but VM-per-deal is ~4–7× the per-deal crypto cost and gives a weaker compliance/crypto-shred story.

Sources: [KMS pricing](https://aws.amazon.com/kms/pricing/) · [KMS quotas](https://docs.aws.amazon.com/kms/latest/developerguide/resource-limits.html) · [Deleting keys / crypto-shred](https://docs.aws.amazon.com/kms/latest/developerguide/deleting-keys.html) · [One-key-per-tenant strategy](https://aws.amazon.com/blogs/architecture/simplify-multi-tenant-encryption-with-a-cost-conscious-aws-kms-key-strategy/) · [Lightsail pricing](https://aws.amazon.com/lightsail/pricing/).

---

## §2b — EC2 compute isolation: tenancy and Nitro

This is the literal "AWS EC2 isolation" layer. The short version: on Nitro, the compute boundary is already strong by default, so the meaningful lever is Nitro Enclaves around the governance/key core, not dedicated tenancy.

### Tenancy models

| | Default (shared) | Dedicated Instances | Dedicated Hosts |
|---|---|---|---|
| Isolates | Logical only; may share a host with other AWS accounts (Nitro enforces CPU/memory separation) | Host hardware isolated from other accounts' instances | An entire physical server exclusive to your account |
| Placement control | none | none | full (host affinity, socket/core visibility) |
| When actually required | Nearly all compliance needs — AWS positions shared-on-Nitro as "highly secure, logically isolated" | A contract mandating no shared hardware with other tenants | Server-bound BYOL licensing, or the strictest sovereignty/host-control regimes |
| Cost premium | baseline | +$2/hr per region (once, not per instance) + a per-instance premium (verify per type/region) | priced per whole host — large unless you pack it |

AWS's own statement: "there are little to no performance, security, or physical differences between Dedicated Instances and instances deployed on Dedicated Hosts." The difference is placement control, not isolation strength.

### Nitro System (every modern instance gets this)

- Hardware root of trust (Nitro Security Chip verifies firmware each boot) + a minimal KVM hypervisor enforcing CPU/memory isolation. No interactive shell / no SSH to the host, no operator "root".
- "There is no mechanism for any system or person to log in to Amazon EC2 servers, read the memory of EC2 instances, or access any data on encrypted EBS volumes."
- Independently affirmed: NCC Group (architecture review 2022, report 2023) validated seven claims — no AWS-employee login to the host, no admin API can access customer content, no access to instance storage / encrypted EBS / encrypted network data — and "found no gaps that would compromise" them. Point-in-time review, not continuous certification.

So "AWS operators cannot read customer data" is a design property of every instance, shared tenancy included.

### Nitro Enclaves (confidential compute — the real step-up)

- An isolated, hardened VM carved from a parent instance's own vCPU/memory. No persistent storage, no interactive access, no external network; the only channel is a local vsock to the parent. The parent (even root) cannot read the enclave's memory.
- Cryptographic attestation → KMS: the enclave emits a signed attestation document (image/PCR measurements); a KMS key policy can require `kms:RecipientAttestation:ImageSha384`/PCR conditions, so the key operation runs only for a verified enclave and plaintext is decryptable only inside that specific enclave.
- No additional AWS charge (you pay the underlying instance; size the parent larger to donate vCPU/memory). Up to 4 enclaves per parent; enclaves can't talk to each other.

### Synthesis for our case (MNPI, already BYOC + per-deal KMS)

- Per-deal Dedicated Instances/Hosts add little real isolation for MNPI: in BYOC you are the only AWS account on your instances anyway, and Nitro's affirmed guarantee means shared-on-Nitro is not the weak link. A dedicated host does nothing to stop one deal's process from reading another's if the software boundary is wrong.
- The real MNPI boundary is cross-deal leakage inside our own account — enforced by per-deal IAM/KMS scoping, not by which physical box an instance lands on.
- Where a genuine step-up exists: Nitro Enclaves around the deterministic governance / key-handling core. Run per-deal key unwrap and the most sensitive MNPI transforms inside an attested enclave, and bind the per-deal KMS key release to the enclave's measurements — turning "cross-deal leak-proof" from a policy assertion into a cryptographically enforced one, at no extra AWS charge.
- Recommendation: default to shared-tenancy-on-Nitro + strict per-deal IAM/KMS for the platform; add Nitro Enclaves selectively around the crypto/governance core; treat Dedicated Instances/Hosts as compliance-checkbox-only, invoked per deal only when a written external requirement forces it.

Sources: [AWS logical-separation whitepaper](https://docs.aws.amazon.com/whitepapers/latest/logical-separation/host-and-instance-features.html) · [Dedicated Instances pricing](https://aws.amazon.com/ec2/pricing/dedicated-instances/) · [NCC Group Nitro report](https://www.nccgroup.com/research/public-report-aws-nitro-system-api-security-claims/) · [AWS Nitro affirmation blog](https://aws.amazon.com/blogs/compute/aws-nitro-system-gets-independent-affirmation-of-its-confidential-compute-capabilities/) · [Nitro Enclaves](https://docs.aws.amazon.com/enclaves/latest/user/nitro-enclave.html) · [KMS cryptographic attestation](https://docs.aws.amazon.com/kms/latest/developerguide/cryptographic-attestation.html).

---

## §3 — On close: the immutable 17a-4 archive

- S3 Object Lock in Compliance mode is Cohasset-assessed against SEC 17a-4(f), FINRA 4511(c), and CFTC 1.31(c): a locked object version cannot be overwritten or deleted by any user, including the AWS account root; the retention mode cannot be changed and the Retain Until Date cannot be shortened. Requires Versioning + Object Lock enabled, mode = Compliance. It also supports legal holds (retain until the hold is lifted).
- This is the cloud-native counterpart of what we already built in the DB: audit-log immutability (#49) and legal hold (#60).

Sources: [S3 Object Lock](https://aws.amazon.com/s3/features/object-lock/) · [Object Lock docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html) · [Cohasset S3 assessment](https://d1.awsstatic.com/r2018/b/S3-Object-Lock/Amazon-S3-Compliance-Assessment.pdf).

---

## §4 — The recordkeeping clincher: why the account boundary is decisive

The 2022 amendments to SEC 17a-4 (effective Jan 2023) reshaped two things that bear directly on our architecture:

1. WORM is no longer the only option. Firms may use the audit-trail alternative: an electronic system that permits recreation of an original record if modified or deleted, with a complete, time-stamped audit trail of every modification/deletion, the date/time, and the identity of the actor. This is exactly the shape of our append-only `audit_log` (#49) — the design already matches the accepted alternative, and it lets the firm reuse the system it runs for business, rather than a separate WORM store.

2. A separate external Designated Third Party (D3P) is no longer mandatory. The 17a-4(f)(3)(v) access/furnishing undertaking (promise to promptly furnish records to the SEC/SROs/state regulators) can be given by the firm's own designated executive officer, provided that officer has independent access to and download capability over the records. This is distinct from the 17a-4(i) third-party recordkeeping-service undertaking, which attaches when a third party holds records on the BD's behalf.

AWS's role, precisely: when you accept the AWS 17a-4 addendum in AWS Artifact, AWS files a Letter of Undertaking with the SEC under 17a-4(i)(1)(ii)(A) (the "won't impede access" undertaking). AWS states explicitly that it does not act as a D3P and does not provide the 17a-4(f)(3)(v) undertaking. That undertaking always stays with the firm.

The architectural consequence (this is the clincher for BYOC):

- Archive in the bank's own AWS account (bank = the broker-dealer): the bank's own designated executive officer can give the (f)(3)(v) undertaking, because they genuinely have independent access + download over the bucket. No external D3P vendor needed. AWS's Artifact addendum covers the (i) undertaking.
- Archive in a vendor's account (we hold records on the BD's behalf): the vendor becomes a 17a-4(i) recordkeeping service in its own right, and the bank's officer may lack the required independent access — pushing toward either the vendor giving undertakings or engaging a formal external D3P.

So account ownership is the single most consequential choice: BYOC collapses the D3P problem; a vendor-held archive re-introduces it.

Retention to configure: business communications 3 years (first 2 easily accessible); FINRA 4511 default 6 years where no period is specified; some records life-of-firm. Confirm the record-type table against 17 CFR 240.17a-4(b)/240.17a-3 with counsel.

Sources: [SEC amendments](https://www.sec.gov/investment/amendments-electronic-recordkeeping-requirements-broker-dealers) · [SEC 17a-4 FAQ](https://www.sec.gov/rules-regulations/staff-guidance/trading-markets-frequently-asked-questions/rule-amendments-broker) · [Goodwin](https://www.goodwinlaw.com/en/insights/publications/2022/11/11_03-sec-revamps-broker-deal-recordkeeping) · [Dechert](https://www.dechert.com/knowledge/onpoint/2022/11/-sec-adopts-amendments-to-rule-17a-4-electronic-recordkeeping-re.html) · [FINRA 4511](https://www.finra.org/rules-guidance/rulebooks/finra-rules/4511) · [AWS 17a-4 (D3P + Letter of Undertaking)](https://aws.amazon.com/compliance/secrule17a-4f/).

---

## §5 — What is stored where

| Data | Where it lives |
|---|---|
| Source documents (contracts, emails, files) | the bank's own store (SharePoint / Drive / Box / their S3), via connectors — left in place |
| Index / routing & intelligence table | inside the firm's BYOC environment — we store the index, never copies |
| Prompts, model-call logs, audit log, policy registry | the append-only audit layer (our schema today; the firm's account in production) |
| Closed-deal record | S3 Object Lock (Compliance mode), per-deal key, in the bank's account |

---

## §6 — How this maps onto what we have already built

The work already on `develop` is the logical prototype of this model; production is the same shapes deployed inside each firm's AWS account:

- `audit_log` append-only (#49) → the per-deal ledger AND the 17a-4 audit-trail-alternative record; mirrored to S3 Object Lock on close.
- Legal hold (#60, merged) → S3 Object Lock legal hold (retain until lifted); same authority (CCO/admin).
- Per-deal access predicates (`access.ts`) + RLS follow-up (#22) → the IAM + app-layer scoping around each per-deal KMS key.
- Sealed `ContextEnvelope` (spine #42) → governed retrieval: the agent sees only a permission-filtered, code-name-redacted envelope, never raw firm data.
- Connectors recommendation (deal-lifecycle-rails, files first) → "connectors, not replacements; store only the index."

The Supabase dev instance is our reference implementation of the rails, not the deployment target. Production is Postgres + Bedrock + S3 Object Lock inside each firm's AWS account.

---

## §7 — Open sub-questions for Monday

1. Operator model detail: BYOC into the bank's own account (strongest optics, hardest ops) is the recommendation, but confirm feasibility with RTS Labs, who own the deployment reality. A vendor-managed single-tenant fallback exists for banks that won't host, at the cost of the D3P/optics story.
2. Compute isolation tier (researched in §2b — recommendation to ratify): shared-tenancy-on-Nitro + per-deal IAM/KMS as the default; Nitro Enclaves around the governance/key core for cryptographically-enforced cross-deal isolation; Dedicated Instances/Hosts only when a written external requirement forces it. Confirm whether any counterparty/regulator contract actually mandates dedicated hardware.
3. Index location: inside the firm's environment (recommended) vs our side — the audit model must survive the answer (the Vision's caution).
4. Model-of-record for QC: if v1 builds no model and bans LLM math, what authority does Pre-Send QC verify figures against?
5. Cost/billing per firm: per-token attribution is the instrument; pricing is a business call.

---

## §8 — Suggested next step

Bring this as the basis for the storage decision Monday. If the three-layer BYOC model is accepted, the first concrete build task is the connector + index path (Marcelo + Rob's action item #2), since it is invariant across every remaining open question. Validate the deployment specifics with RTS Labs and the 17a-4 / D3P reading with the incoming FINRA advisory hire before committing.

---

Verification caveats: KMS/Bedrock/Object Lock prices and postures are us-east-1 list values as of July 2026 and shift (GovCloud/China differ) — confirm at deploy time. The 2025 Cohasset PDF returned as binary and could not be quoted directly; conclusions are corroborated by AWS's Object Lock pages. The exact Claude-on-Bedrock model roster and per-model retention exceptions change — confirm with the AWS account team. Recordkeeping conclusions are research, not legal advice — validate the D3P/undertaking topology with securities counsel.
