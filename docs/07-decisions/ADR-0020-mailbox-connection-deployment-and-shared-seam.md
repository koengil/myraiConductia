# ADR-0020: Mailbox connection, deployment modes and the shared reader seam

Status: Draft for discussion, 2026-10-06, after audit round 2 (against `develop` @ 63a4464b); status lines rechecked against `develop` @ 3c95bf19 on 2026-10-07, @ a6f6e30f on 2026-10-08 (review response: the database credential, egress and kill switches) and @ 3a527442 on 2026-10-09 (review response: decision numbers, the pass bound).
Related: ADR-0017 (hybrid data residency) and its Amendment 1 (#343), ADR-0018 (deal discovery), ADR-0023 (send-path enforcement, outside MVP 2), D68 (#262, the mailbox guard).
Companions: [ADR-0021](./ADR-0021-m365-mailbox-connection.md) (Microsoft 365) and [ADR-0022](./ADR-0022-google-workspace-mailbox-connection.md) (Google Workspace). **Read this one first.** The companions add only what is specific to each provider.

## Bottom line

- **One reader design for every bank.** Microsoft 365, Google Workspace or both, hosted by Conductia (AWS) or run by the bank on AWS, Azure or Google Cloud (BYOC), all go through the same guard and the same reader seam. Toward the mail providers the target in every combination is no stored key: the worker proves who it is with its own cloud identity. That holds for the mail providers only. Toward the database, the hosted worker as merged in #387 stores a long-lived Supabase `sb_secret_` key (`infra/discovery-worker/secrets.tf`) with full read and write on the shared hosted project, bypassing RLS for every tenant. A narrower credential replaces it before Pilot (decision 1, "The database credential"). Only identity, scopes and read details differ by provider.
- **Pilot is Google, hosted, for Ignatious.** It goes live once the Pilot gates in decision 5 pass. Microsoft's allowlist mirror is built (#275); a Microsoft bank still waits for a production credential (ADR-0021).
- **A network firewall is required from Pilot on** (Guillermo, 2026-10-08). The lean stack is about $65 to $75 a month per hosted bank; AWS Network Firewall adds about $290 a month per zone. It closes the raw-IP path. It still cannot stop a compromised worker from sending data to an attacker's account on an allowed service such as Google or Supabase.

## In plain terms

- **What we do.** A background worker reads a bank's mail to find deal-related messages.
- **The worst case.** The worker, or one of its libraries, is compromised. It then reads mail it should not, or sends what it read somewhere else.
- **Our four controls.**
  1. The bank decides which mailboxes can be read, in its own Microsoft or Google admin console.
  2. Each banker opts in for their own mailbox.
  3. Our guard re-checks each mailbox before every page it reads.
  4. The bank and Conductia can each switch reading off.
- **What this ADR decides.** How the connection works the same way across providers (Microsoft, Google or both) and across deployment modes (hosted or BYOC).

## Terms

- **BYOC (bring your own cloud):** the worker runs in the bank's own cloud account. The bank owns the account and its keys; Conductia operates the worker there through a scoped role (ADR-0017 mode 1).
- **Hosted:** Conductia runs the worker in an AWS account that Conductia owns and dedicates to one bank, for a bank with no cloud contract of its own. No other bank's workload or data is in it.
- **Worker:** the background process that reads mail.
- **Reader:** the identity the worker uses to read.
- **Registration:** the database row that names a bank's reader for one provider.
- **Guard:** Conductia's check, run before every page, that a mailbox may be read (#262).
- **Allowlist mirror:** the comparison between Conductia's list of readable mailboxes and the group the bank controls in its own admin console.
- **Pass:** one run of the worker over a mailbox. A pass reads many pages.
- **Workload identity:** a program proving who it is through the platform it runs on, with no stored password or key.
- **Egress control:** limiting where the worker can send network traffic.
- **Demo and Trial:** the owner's names (Guillermo, 2026-10-08) for runs of the hosted worker on synthetic or trial-domain mail, before any real Ignatious mail. Proposed reading: in the tier table (decision 5) they sit inside Dev.

## Tradeoffs we accept

| We accept | Instead of | Why |
|---|---|---|
| No network firewall in Demo and Trial | About $290 a month per zone | No real bank mail flows there. From Pilot on the firewall is required (Guillermo, 2026-10-08; decision 6) |
| One worker task at Pilot | Two tasks, about $20 a month more | Auto-replace, a stall alarm and a short job expiry cover Pilot. Production runs two (decision 7) |
| Removal from the bank's group takes effect at the next pass that starts (not hard-bounded: see the terms table) | Effect at the next page | The group is read once per pass. Pause and consent withdrawal still act at the next page (decision 8) |
| Google's reach is the whole domain | Provider-enforced group scoping, as on Microsoft | Google offers no group scoping. ADR-0022 contains it in four layers |
| Raw-IP connections are not blocked in Demo and Trial | A firewall there too | Accepted for Demo and Trial only (Guillermo, 2026-10-08). AWS Network Firewall blocks them from Pilot on (decision 6) |
| The worker's `sb_secret_` key in Demo and Trial | The narrower database credential from the start | Accepted for Demo and Trial only (Guillermo, 2026-10-08). The narrower credential is a Pilot gate (decision 1) |
| A non-exportable key where federation is unavailable | No reading for that bank on that cloud | Approved per bank (Guillermo, 2026-10-06). The key still cannot be copied out (decision 1) |

## Decision

1. **Any mail provider, on any of the three clouds** (Guillermo, 2026-10-06). A bank may use Microsoft 365, Google Workspace or both, and the worker may run hosted by Conductia (an AWS account dedicated to the bank) or in the bank's own AWS, Azure or Google Cloud (BYOC). Every cell below is a target. Each is *built* (code exists; live once its gates pass), *planned* (designed, not built) or *not designed*. No cell is left implicit. One cell is built: hosted Google. The Google reader is built, and the hosted worker that runs it, #344, merged in PR #387 on 2026-10-07; it reads live once the Pilot gates pass.

   **Which mode a bank gets follows its cloud contract** (Guillermo, 2026-10-07): BYOC on the bank's own cloud, or hosted by Conductia on AWS for a bank with no cloud contract. Conductia hosts only on AWS. A BYOC worker never receives credentials for the shared hosted project: it writes only to the bank's own data plane (#264), never to Conductia's hosted Supabase project.

   | Where the worker runs | Microsoft 365 | Google Workspace | Both |
   |---|---|---|---|
   | **Hosted, Conductia AWS account** | Planned (ADR-0021). Live reading also needs a production credential; the allowlist mirror is built (#275) | **Built, first:** Ignatious. The reader and the hosted worker (#344, PR #387, merged 2026-10-07) are built; live reading waits for the Pilot gates (ADR-0022) | Planned. One worker reads both |
   | **BYOC, bank's AWS** | Planned (as hosted, in the bank's account) | Planned (as hosted, in the bank's account) | Planned. One worker reads both |
   | **BYOC, bank's Azure** | Planned (a user-assigned managed identity as federated credential, when the Azure subscription and the Microsoft 365 tenant share one Entra tenant; otherwise the Key Vault certificate, built today) | Planned (Google trusts the Azure managed identity through workload identity federation; on Container Apps this needs a token supplier in code) | Planned. One worker reads both |
   | **BYOC, bank's Google Cloud** | Planned (Entra trusts the Google Cloud service account through a federated credential) | Planned (the attached service account calls `signJwt`; new code, since the worker today requires a credential file) | Planned. One worker reads both |

   One principle covers every cell: **no stored key. The worker proves who it is with its own cloud identity, federated into Microsoft or Google.**
   - **Google side:** the credential loader accepts federated credential files and refuses key files. No cloud works from a file alone, so Fargate (#344), Azure Container Apps and the attached Google Cloud identity each need a small token supplier in code.
   - **Microsoft side:** every cell needs one new piece, an Entra federated credential that trusts the worker's cloud identity (Open points).
   - **Exception, never the default:** a non-exportable key in KMS or Key Vault, approved (Guillermo, 2026-10-06) only where federation is unavailable for that deployment, and recorded per bank.
   - **What this does not stop:** an attacker who controls the running worker can still obtain short-lived tokens while in control. What they cannot do is take away a credential that keeps working later.
   - **The database credential is the stored key.** The principle above covers the mail providers only. The hosted worker as #387 merged it holds a long-lived Supabase `sb_secret_` key (`infra/discovery-worker/secrets.tf`, runbook P1 = A). It has full read and write on the shared hosted project and bypasses RLS for every tenant, so it is in G0 and in the blast radius (section "Provider differences"). Decision (Guillermo, 2026-10-08): the target is a narrower credential, a dedicated Postgres role limited to the discovery tables and RPCs, under RLS, with no service role. If that role is not in place by then, the `sb_secret_` key is accepted for the Demo and Trial tiers only (section "Terms"); the narrower credential is a Pilot gate (decision 5).

     | | The database credential (Guillermo, 2026-10-08) | Egress to a raw IP (Guillermo, 2026-10-08; decision 6) |
     |---|---|---|
     | Control | A dedicated Postgres role limited to the discovery tables and RPCs, under RLS, no service role | AWS Network Firewall in front of the hosted worker; on BYOC, the cloud's equivalent (proposed) |
     | Cost | Engineering time for the role, its grants and RLS policies, and the worker's switch to it; no monthly charge | About $290 a month per zone, plus $0.065 per GB |
     | Risk while absent | A compromised task, or anyone holding `deploy`, reads and writes every tenant's rows, Auth and Storage on the shared project | A compromised task sends what it read to any IP address on 443 or 5432; the DNS allowlist does not see it |
     | Driver | Least privilege on a shared multi-tenant project (SOC 2 CC6.1 to CC6.3); the bank's vendor oversight (FINRA 21-29, Reg S-P) | Boundary and transmission (SOC 2 CC6.6, CC6.7); the same vendor oversight |
     | Alternatives | Keep the `sb_secret_` key with written acceptance at G0; #264's pull-only data-plane API (runbook option D) | A tested flow-log alert on raw-IP connections; written acceptance at G0 |
     | Tier | `sb_secret_` key accepted for Demo and Trial only; the narrower credential is a Pilot gate and holds in Production | Gap accepted for Demo and Trial only; the firewall is required at Pilot and Production |
     | Reversal | Swap the secret the worker reads (runbook "Switching later"); G0, G4 and G10 are signed again before the new credential meets real mail | Remove the firewall from the deployment template; needs a new owner decision |

2. **One shared reader seam, with provider code behind it.**
   - Every read goes through `src/lib/mailboxAccess/`, which holds the reader interfaces, the per-page guard and the allowlist mirror interface, shared by both providers. The live mirror exists for Google (#259) and Microsoft (#275). Source health is recorded in the database (the discovery health migrations), with delegation health for Google only.
   - Provider code (Graph, Gmail) sits behind that seam.
   - Before a new provider can be enabled, it must answer every row of the provider table (section "Provider differences").
3. **One runtime seam per cloud, with five ports.** Everything cloud-specific sits behind one of these ports:

   | Port | What it does | AWS (hosted or BYOC) | Azure (BYOC) | Google Cloud (BYOC) | Development |
   |---|---|---|---|---|---|
   | Identity to Google | Proves the worker to Google, then `signJwt` for the delegated reader | Workload identity federation from the task role (a Fargate supplier in code, #344) | Workload identity federation from the managed identity (a supplier in code on Container Apps) | Attached service account, through a separate caller account (loader change) | Developer login |
   | Identity to Microsoft | Proves the worker to Entra for the bank's app registration | Entra federated credential trusting a token from AWS outbound identity federation (`sts:GetWebIdentityToken`, RS256, subject the task role). Exception: AWS KMS key signing a certificate | User-assigned managed identity as the app's federated credential, same Entra tenant only. Exception: Key Vault certificate (built) | Entra federated credential trusting the service account's Google ID token. Exception: Cloud KMS key | Developer key file, refused in production by code |
   | Secret source | Database credential and configuration | Secrets Manager. Hosted today it holds the `sb_secret_` key: full read and write on the shared project, RLS bypassed (decision 1) | Key Vault secrets | Secret Manager | Local file |
   | Egress policy | One declared allowlist, rendered per cloud | DNS allowlist (names) plus security-group port rules | NSG port and service-tag rules plus NAT | VPC firewall rules plus Cloud NAT and a DNS response policy | None |
   | Detection | Control-plane audit and threat findings | CloudTrail, GuardDuty | Activity Log, Defender for Cloud | Cloud Audit Logs, Security Command Center | None |

   Built today: the Google credential loader (it accepts federated files and refuses keys) and the Azure Key Vault certificate for Microsoft. The Azure Container Apps test worker that signs with that certificate is Dev only: it reads the Conductia test tenant, never a bank's mail. New work: a token supplier per cloud for Google (Fargate in #344, Container Apps, the Google Cloud attached identity); the Microsoft federated assertion on every cloud; any KMS exception, which also needs a certificate built around the KMS public key and uploaded to the app; and the egress and detection templates for Azure and Google Cloud (#344 provides AWS).

4. **Banks on both providers.**
   - **Registrations and sources.** One bank (one Conductia tenant) may hold one Microsoft registration and one Google registration. Each mailbox source carries its provider, and only that provider's reader reads it. A read through the other provider is refused and audited (`provider_mismatch`). Merging a person's mailboxes joins only sources of the same provider.
   - **Mirror and health.** Both are per provider, so a provider that is down or blocked never hides the other.
   - **Worker.** One worker holds both credential paths and the union of both egress allowlists.
   - **Revocation.** The bank has two paths, one per admin console. The runbook documents both.
5. **Tiers: Dev, Pilot and Production** (Guillermo, 2026-10-07).

   | Tier | What it is |
   |---|---|
   | **Dev** | Development and testing: local, Vercel previews, synthetic mail, recorded replays and provider test tenants |
   | **Pilot** | Ignatious, the first customer, under ADR-0017 Amendment 1 (#343, D75), with the gates below |
   | **Production** | Every other bank, hosted or BYOC, with every control from day one. Deployment is scripted: installable container images and Terraform-compatible infrastructure code (#344 uses OpenTofu), with the network firewall required from day one (decision 6). It needs the isolated data plane (#264). **Scale-out**, from the second bank on, also needs one bank per registration and updates coordinated across every bank's instance, hosted or BYOC: staged rollout with a canary bank first, a pinned version per bank, rollback, and drift detection for infrastructure, migrations, worker version and policies (#333, deferred research) |

   Pilot gates, for any provider:
   - the exclusion policy is applied before any message body is read (#338, merged, for Google; #272 for Microsoft, which refuses a non-empty policy until then);
   - no message content in URLs or logs (#331; fixed in PR #376, follow-up #375);
   - a content-free record of every reader pass (#370, PR #388 open), with counts of fetched, excluded and stored messages. It does not identify individual messages the reader drops; Guillermo accepted that limit (2026-10-06);
   - the narrower database credential in place of the `sb_secret_` key (decision 1; Guillermo, 2026-10-08);
   - AWS Network Firewall in front of the hosted worker, blocking raw-IP connections (decision 6; Guillermo, 2026-10-08);
   - proposed: a heartbeat and per-source state, so a stopped or halted source never looks healthy (Open points);
   - proposed: the bank's compliance team decides whether Conductia's copy is a regulated record (section "Regulation and SOC 2");
   - the bank accepts the remaining risks in writing (#344 gate G0), including, for as long as it is in use, the `sb_secret_` key's read and write on every tenant's rows in the shared project.

   Each provider ADR adds its own gates.
6. **Egress: filter names, block raw IPs from Pilot on, and state the gaps plainly.**
   - The worker may reach only its provider APIs, the provider login, the identity-federation endpoints (the regional AWS STS host, Google `sts` and `iamcredentials`, and the local task or managed-identity endpoint), its secret store and the database (the Supabase API, and Postgres on port 5432).
   - **Demo and Trial posture (cheap), in two separate layers:**
     - **Names:** a DNS allowlist (AWS Route 53 DNS Firewall, the Google Cloud DNS response policy) and the worker's own host allowlist, already in code. These filter which names resolve. They do not filter HTTPS traffic or block a connection to a raw IP address.
     - **Network:** port rules on AWS security groups, Azure NSGs and Google Cloud VPC firewall rules. These filter by port and IP range or service tag, not by name, so outbound HTTPS on port 443 stays open to any address.
     - **Logs:** flow logs on every cloud.
   - **The raw-IP gap.** On every cloud, a worker that connects to an IP address directly bypasses the name layer. As #387 deploys it, the DNS allowlist sits beside security-group rules that allow `0.0.0.0/0` on 443 and 5432, so egress straight to an IP is not stopped. Decision (Guillermo, 2026-10-08): this is accepted for Demo and Trial only.
   - **Required from Pilot on:** AWS Network Firewall in front of the hosted worker, about $290 a month per zone, filtering by name and blocking connections to raw IP addresses (Guillermo, 2026-10-08; the cost-and-risk record is in decision 1). This supersedes "only on a bank's written request" (Guillermo, 2026-10-06) for Pilot and above. Proposed: a BYOC bank on Azure or Google Cloud runs that cloud's equivalent (Azure Firewall; a Google Cloud firewall policy with FQDN rules). The deployment templates carry it from day one (Guillermo, 2026-10-07).
   - **Why this is defensible:** every allowed destination is a multi-tenant service (Google APIs, Microsoft login, Supabase). A compromised worker could send data to the attacker's own account on that same service. A standard firewall does not close that path. A TLS-inspecting proxy that pins traffic to the bank's own Google or Microsoft tenant could narrow it, but it adds cost, latency and a component that sees all traffic, so it is out of scope for Pilot. The firewall closes the raw-IP path, not this one. What protects us is keeping the worker uncompromised (signed images, least privilege, no copyable key) and detecting misuse.
7. **Reliability floor.**
   - **Pilot:** one worker task, run as a service that replaces itself on failure; a stall alarm; and a job expiry short enough that a crashed job frees its mailbox in minutes, not an hour.
   - **Production (proposed):** two tasks. The job queue already allows only one active job per mailbox, so a second task is safe.
   - **Both tiers:** after any restart, reading resumes from the last checkpoint.
8. **Kill switches, and how fast each one stops reading.**

   | Switch | Held by | Stops reads within |
   |---|---|---|
   | `discovery_worker_enabled` flag | Conductia | About 30 seconds, plus the page in progress |
   | Delete the worker's Supabase secret key (`discovery-worker-aws`, hosted dashboard › Project Settings › API Keys) | The Conductia owner, in the hosted Supabase dashboard (#344 runbook, section 14, lever 3) | Seconds. Every REST call fails, the guard included, so no page is read or written. It also cuts the worker's write path to every tenant's rows |
   | Scale the worker service to 0 and stop every running task | The Conductia owner, as `deploy` and then admin (#344 runbook, section 14, lever 2) | `SIGTERM` and a 30-second graceful stop. In BYOC the bank does the same in its own console (below) |
   | Pause one mailbox, or withdraw consent | Bank admin, or the banker | The next page |
   | Remove the mailbox from the bank's group | Bank admin | **The next pass** (the mirror snapshot is reused within a pass). No hard bound holds a pass: the sync job expires after 3,600 seconds (pg-boss `expireInSeconds` in `worker/boss.ts`), which marks it failed and schedules a retry, but nothing in `worker/` aborts the running handler. What does bound a pass today is per call: each Google token and read call has its own timeout (#412). On Microsoft, Exchange also enforces the group, within up to two hours |
   | Revoke the delegation or app permission | Bank admin, in its own console | **Google:** when already-issued tokens expire, up to about one hour (to be measured at #344 gate G10). **Microsoft:** when already-issued tokens expire; a change to the RBAC for Applications group can take up to two hours to apply (to be measured before a Microsoft Pilot) |

   - In BYOC the bank cannot reach Conductia's flag, but it owns the compute: scaling the worker to zero in its own cloud console stops reads within seconds, with no dependency on Conductia. The runbook documents this alongside the console revoke and the group.
   - Today, a flag that cannot be read is silently treated as "off". It will instead show as a visible "stopped: flag unreadable" state.

## Email-borne exfiltration and the send path

This ADR covers one exfiltration path: **the worker** sending what it read over the network (decision 6). The other path is **a banker** sending confidential information by email. The send-path work on `develop` (D59, D60, D67, built by Marcelo) covers mail sent through Conductia, and ADR-0023 extends it to mail sent from Gmail and Outlook directly. The two designs meet in three places.

| Where they meet | What exists (on `develop`) | What this design requires |
|---|---|---|
| Sending through Conductia | Every send is screened by the rules and, where allowed, AI (`fullScreenFields`); the AI layer can only escalate, never clear. The recipient boundary from verified domains warns and never blocks. Recipient review by deal relationship asks for confirmation, with an approval token, only for counterparties, unverified relationships, and outsiders in Cc or Bcc; an outsider addressed directly in To is logged (D59, D60, D67; PRs #227, #304, #313, #326) | Works the same for Microsoft and Gmail sends (#339 adds Gmail send) |
| Screening incoming mail | **Planned, not built.** An incoming pipeline is to group the reader's messages into threads and run the same screen on each. No reader or worker code screens incoming mail today | It should consume the provider-neutral `MailMessage` from the shared seam. `GraphMessage` is an alias of it, so the message shape is shared; the incoming pipeline itself is new integration work |
| AI on mail content | `fullScreenFields` on incoming mail waits for the zero-data-retention decision (R4, #345) | Every model call on bank mail goes through the tenant model gate (PR #346) and the control-plane inventory (#345) |

**The bypass.** A banker can still send directly from Gmail or Outlook, around Conductia. **ADR-0023 decides this, as long-term design outside MVP 2 (Oct 30).** The same screen runs after the send, on the copy in the banker's Sent mail, and flags only what it would have warned about. Nothing is rejected or held by default. In-client add-ins and bank-side holds are follow-ups there. When that work starts, the reader must expose Bcc and message headers, and record coverage per mailbox. It is not a Pilot gate here.

## Provider differences (detail in ADR-0021 and ADR-0022)

| Capability | Microsoft 365 | Google Workspace |
|---|---|---|
| What the bank's own scoping limits | A named group, enforced by Microsoft (RBAC for Applications) | Every user in the domain (domain-wide delegation). The group is enforced by Conductia's mirror |
| Blast radius if the worker is compromised | The scoped group | The whole domain |
| Database reach if the hosted worker is compromised | Every tenant's rows on the shared hosted project, read and write, with RLS bypassed, plus Auth and Storage, through the `sb_secret_` key, until the narrower credential replaces it (decision 1). None in BYOC | Same |
| Allowlist mirror | Built (#275): the Exchange scope group the registration records, read through Graph | Built |
| Delegation health | Not recorded | Recorded each time a token is issued |
| Time for a revoke to take effect | Until issued tokens expire; a group change under RBAC for Applications can take up to two hours (to be measured) | Up to about one hour (to be measured at G10) |

## Cost by deployment

Monthly figures for one bank's worker reading about 50 mailboxes, worker side only, at US list prices read on 2026-10-05. Sources and assumptions: [ADR-0024, sources](./ADR-0024-sources-cost-and-regulation.md). "est." marks an estimate.

**Summary**

| Stack | Pilot | Production | Network firewall |
|---|---|---|---|
| **Hosted AWS** (Google, Microsoft or both, one worker) | **About $65 to $75**, plus the firewall: **about $355 to $365** in one zone | **About $85 to $100**, plus the firewall: **about $375 to $390** in one zone | AWS Network Firewall, about $290 per zone, required from Pilot on (decision 6) |
| **BYOC Azure** (Microsoft) | **About $75 to $115** (est.), before a firewall | Similar, plus a second replica and the firewall | Proposed: Azure Firewall Basic, about $290 plus a management IP |
| **Provider APIs** | Gmail and Graph mail reads: no per-call charge. Google plans charges above quota later in 2026, with at least 90 days' notice | Same | |

**Hosted AWS, Pilot line items**

| Item | Monthly |
|---|---|
| Fargate, one task (ARM) | About $17 |
| NAT gateway, one zone, plus public IPv4 | About $34 plus about $4 (est.) |
| DNS allowlist | About $1 |
| Flow and DNS query logs | About $2 |
| GuardDuty, base | About $3 (est.) |
| GuardDuty runtime monitoring (about $1.50 per vCPU; PR #387 enables it at Pilot) | About $1 to $3 |
| CloudTrail and alerts | $0 to $2 |
| One secret and one key | About $3 |
| Logs, 90 days | About $2 |
| CloudTrail kept one year in S3 | About $1 (est.) |
| Image registry | Under $1 |
| Alarms | About $1 |

The items sum to about $69 to $74; the range allows for traffic and alert volume. Production adds a second task (about $17 to $21), for about $85 to $100. AWS Network Firewall, required from Pilot on, adds about $290 per zone.

**What Production excludes.** These are the worker's costs only. Production also needs #264's isolated data plane (decision 5), which this ADR does not cost; #264 does.

**BYOC Azure, Pilot line items:** Container Apps about $34 to $73; Key Vault non-exportable key about $1; NSG $0; NAT about $35 (price unverified); flow logs and Log Analytics a few dollars. The design uses no private endpoints, so the possible $73 plan fee does not apply.

A hosted bank on both providers runs one worker. The second provider adds credentials and egress names, not a second stack (about $0 to $5, est.).

## Regulation and SOC 2

No rule cited here requires a specific network product, key technology or monitoring tool. Each control is a risk-based choice that supports the bank's duty to oversee its vendors.

| Area | What applies | How this design answers it |
|---|---|---|
| Vendor oversight | FINRA Regulatory Notice 21-29 (guidance: the bank stays responsible for outsourced functions). Regulation S-P, as amended in 2024: the bank's written oversight of service providers must require the provider to notify the bank as soon as possible, and **no later than 72 hours after becoming aware of a breach resulting in unauthorized access to a customer information system it maintains** (SEC final rule 34-100155). This is separate from the bank's own notice to customers, due within 30 days | Hosted: Conductia notifies the bank under the contract, and the notice path goes into the runbook. BYOC: the bank operates the system and handles its own notices; Conductia still notifies the bank of any breach in its own systems (for example, the database it hosts) |
| Access and least privilege | Risk-based. SOC 2 CC6.1 to CC6.3 (logical access, provisioning, least privilege) | Bank-scoped grants, member opt-in, the guard on every page |
| Network boundary and transmission | Risk-based. SOC 2 CC6.6 (network boundary) and CC6.7 (data transmission) | Decision 6 |
| Monitoring and incident response | Regulation S-P incident response program. SOC 2 CC7.1 to CC7.4 (detect, evaluate, respond) | Refusals are audited; health per source; CloudTrail and GuardDuty (hosted). **Pilot gates:** a record of every reader pass (#370), heartbeat and alerts |
| Change management | SOC 2 CC8.1 | Reviewed code and infrastructure changes |
| Records and retention | SEC 17a-4 (an audit trail or write-once storage) and FINRA 4511 apply to the bank's books and records | **The bank's compliance team decides** (proposed: before Pilot) whether Conductia's copy is part of its record system. Retention and deletion follow that decision and ADR-0017 |
| Subservice providers | SOC 2 CC9.2 (vendors). The carve-out method is realistic for large clouds | When SOC 2 work starts (D66: when a named prospect asks), collect the SOC 2 reports of AWS, Google Cloud, Microsoft and Supabase, and map the controls we rely on them for |
| New York banks | NYDFS 23 NYCRR 500, only if the bank holds a New York license | Check per bank |

## Open points

| Item | What changes if wrong | Owner |
|---|---|---|
| Azure managed identity as Microsoft federated credential needs the Azure workload and the Microsoft 365 app in one Entra tenant. When they differ, a bank-approved path (the Key Vault certificate) applies | Whether BYOC Azure is keyless for that bank | Conductia engineering, gated on a live federation test |
| Microsoft federated credential on each cloud. The mechanisms are documented (AWS outbound identity federation since 2025-11-19; Azure managed identity; Google ID token), but Microsoft names no AWS example and the Fargate path is untested | Whether Microsoft is keyless on every cloud, or needs the KMS exception | Conductia engineering (issue to file), gated on a live federation test per cloud. Enabling outbound federation joins the hosted account bootstrap |
| Egress and detection templates for Azure and Google Cloud, and their costs | BYOC Azure and Google Cloud totals are not yet costed | Before the first BYOC bank on those clouds |
| Heartbeat, per-source state, halted-source handling, short job expiry, request timeouts | Whether a stopped worker can look healthy | Conductia engineering (issues to file) |
| Exact Azure prices (NAT, Firewall Basic extras) | Azure totals move by tens of dollars | Before a Microsoft BYOC bank |
| Regulation S-P thresholds by bank size; NYDFS applicability | Which bank-side duties apply | The bank's compliance team |

## References

Code: `src/lib/mailboxAccess/` (readers, guard, mirror, principal), `worker/classify.ts`, `worker/sync.ts`, `worker/boss.ts`. Migrations: `20261001130000_mailbox_allowlist.sql` (guard, allowlist, consents). ADR-0017, ADR-0018, ADR-0021, ADR-0022, ADR-0023. Issues and PRs: #262, #264, #270, #275, #331, #338, #339, #343, #344, #345, PR #346, #353, #370. Research: [ADR-0024, sources](./ADR-0024-sources-cost-and-regulation.md).
