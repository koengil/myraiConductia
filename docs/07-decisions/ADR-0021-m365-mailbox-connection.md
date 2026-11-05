# ADR-0021: Microsoft 365 mailbox connection

Status: Draft for discussion, 2026-10-06, after audit round 2 (against `develop` @ 63a4464b); status lines rechecked against `develop` @ 3c95bf19 on 2026-10-07, and updated for the allowlist mirror on the #275 stack on 2026-10-17 (D100, number to confirm at merge).
Read [ADR-0020](./ADR-0020-mailbox-connection-deployment-and-shared-seam.md) first. It defines the deployment modes, the shared guard, the tiers, egress, cost by deployment and the regulatory mapping. This ADR covers only what is specific to Microsoft 365.

## Bottom line

- **Microsoft is the easier provider to contain.** The bank limits our reader to a named group of mailboxes, and Microsoft enforces that limit. A compromised worker reaches the group, not the whole bank.
- **The design is proposed, and no Microsoft bank can go live yet.** The federated credential still needs a live test. One build blocks it: a production credential for the hosted worker (the federated credential, or the approved KMS exception). The allowlist mirror is built (#275).
- **No Microsoft bank is planned before Oct 30,** so neither blocker is on the Pilot critical path.

## In plain terms

- **What we do.** The worker reads deal-related mail from a bank's Microsoft 365 mailboxes.
- **The worst case.** A compromised worker reads mail it should not, or sends it elsewhere.
- **Why the damage is bounded.** Microsoft enforces the bank's group, so the reach of a compromised worker ends at that group.
- **What this ADR decides.** How the worker proves its identity to Microsoft, what it may read and keep, and what is still missing before a Microsoft bank can go live.

## Blast radius, and how it is contained

| Layer | Control | Status |
|---|---|---|
| Prevent | No copyable credential: a federated credential, or a non-exportable key as the approved exception | Designed; new code on every cloud (decision 2) |
| Limit | The bank's group, enforced by Microsoft; Conductia's guard on every page; read-only permission | Group, guard and allowlist mirror built (#275) |
| Detect | Sign-in and audit logs for the app in the bank's tenant; CloudTrail and GuardDuty in the hosted account | Hosted alerts designed in #344 |
| Accept | Proposed: the bank's CCO signs the remaining risk before go-live | Pending |

## Terms

- **App registration:** the bank's Entra (Microsoft identity) record for our reader. Not to be confused with the *registration*, which is our database row.
- **App-only access:** the app reads under its own identity, not a banker's sign-in.
- **RBAC for Applications:** an Exchange setting that restricts an app's `Mail.Read` to one mail-enabled security group.
- **Federated credential:** Entra accepts a token from another platform (the worker's AWS, Azure or Google Cloud identity) in place of a stored secret or certificate.
- **Delta query:** a Graph request that returns only what changed since the last read.

## Decision

1. **A dedicated, read-only app registration in the bank's own tenant.**
   - Reading has its own app registration, never the one that sends mail.
   - It is single-tenant: bound to the bank's tenant id, never to the multi-tenant `common` endpoint.
   - Its permission is `Mail.Read`, granted **only through RBAC for Applications, to the bank's group**. The tenant-wide `Mail.Read` grant is never used.
   - It never holds `Mail.Send`, `Mail.ReadWrite` or tenant-wide site access.
2. **How the worker proves its identity, by deployment.**

   | Deployment | Credential | Can a credential be copied out and reused later? |
   |---|---|---|
   | **Hosted by Conductia on AWS** (a bank with no cloud contract) | An Entra federated credential that trusts a token from AWS outbound identity federation (`sts:GetWebIdentityToken`, RS256, audience `api://AzureADTokenExchange`, subject the task role). Approved exception (Guillermo, 2026-10-06): a non-exportable AWS KMS key that signs the certificate assertion | No. There is no certificate or secret; the exception's key cannot leave KMS |
   | **BYOC on Azure** | Preferred: a **user-assigned** managed identity as the app's federated credential. Microsoft requires it to be in the same Entra tenant as the app. Approved exception, for a split-tenant bank: a certificate whose private key is a non-exportable key in Azure Key Vault, used through the worker's managed identity, built today. A Standard key is enough; HSM-backed is optional on request | No. The managed identity has no key, and the exception's key never leaves the vault |
   | **BYOC on AWS** | The same as hosted, in the bank's own AWS account | No, as hosted |
   | **BYOC on Google Cloud** | An Entra federated credential that trusts the worker service account's Google ID token (issuer `accounts.google.com`, subject the account's numeric id). Approved exception: a Cloud KMS key that signs the certificate assertion | No. There is no key, and the exception's key cannot leave Cloud KMS |
   | **Dev** | A developer key in an environment variable (`env:`) | Not applicable. The code refuses it in production |

   Every federated option and each KMS exception is new code. Today the worker can sign only with an Azure Key Vault certificate or a developer key. A KMS exception also needs a certificate built around the KMS public key and uploaded to the app. None of these stops an attacker who controls the running worker from getting short-lived tokens while in control; they stop a credential being taken away and used later. The hosted path relies on AWS documentation (outbound identity federation, announced 2025-11-19); Microsoft documents the generic issuer path but names no AWS example, so a live test is a gate before the first Microsoft bank.
3. **Two independent limits on which mailboxes are read, plus a check that they agree.**
   - **Limit 1, the bank's group,** enforced by Microsoft. Only direct members count (nested groups are not), and a change can take up to two hours to apply. RBAC for Applications works with any credential type. Grants add up, though: a tenant-wide `Mail.Read` consent on the same app would let it read every mailbox regardless of the group, so the setup script must confirm none exists.
   - **Limit 2, Conductia's guard,** run before every page (ADR-0020): the invite is accepted, the seat is active, the mailbox domain is on the registration, and the banker has opted in.
   - **The allowlist mirror** confirms the two lists match, on every pass (#275). The worker lists the group's direct members through Graph, under the reader app's own credential, and binds each allowlisted address to exactly one member: one member has it as mail and no other has it as UPN (design R4). It reads only bound mailboxes, by the member's UPN, after a check that the UPN and the object id reach the same inbox; it records the rest as drift. Shared mailboxes (team inboxes) are members like any other (design R12). The registration names the group (`graph_reader_registrations.scope_group_id`); with none recorded, the mirror fails closed and no Microsoft mailbox is read. The group read needs a tenant-wide membership permission: `GroupMember.ReadBasic.All` is the proposed default (design R1), pending the 2026-10-19 probe on the test tenant. The admin's steps are in [the runbook](../../scripts/m365/README.md#the-scope-group-mirrors-conductia).
4. **What is read and what is kept.**
   - **Folders read:** all except Deleted Items, Junk, Drafts, Outbox and Recoverable Items. Message ids survive folder moves.
   - **Attachments:** not downloaded. Only the fact that a message has attachments is recorded.
   - **Stored:** only messages routed to a deal, and only the top of each message, with quoted history removed.
   - **Who can see stored text:** its owner only.
   - **Ledger:** every message the reader passes on leaves a content-free ledger entry. Messages the reader drops earlier (for example, those with no message id) leave none. #370 adds a record of each pass with counts; it does not name individual dropped messages, a limit Guillermo accepted (2026-10-06).
   - **Out of scope:** SharePoint reading (`Sites.Selected`, file extraction) is built, but it is not part of this email decision. It belongs in a separate ADR.
5. **Sync.**
   - **Order:** one full read, then changes only (delta query).
   - **Checkpoints:** saved after each stored page, so a restart re-reads at most one page.
   - **Throttling:** honors `Retry-After`, with backoff.
   - **Date window:** none yet. #353 adds one, starting at 90 days and extendable.

## Status

| Tier and gate | Microsoft 365 |
|---|---|
| Dev | Works: synthetic fixtures and a recorded replay. On the Conductia test tenant (expires 2026-10-24), from an Azure Container Apps test worker that is Dev only and never reads a bank's mail: connectivity, the scoped probe, and, since #275, a live end-to-end sync once the registration records its scope group and the group probe passes (runbook, "Prove the group read") |
| Production | **Blocked** on a production credential (decision 2). Also needs #272, #370 (PR #388, open), the setup-script checks (see "Not built"), the revoke timing measured on a test tenant (token expiry and the up-to-two-hour RBAC for Applications cache), the ADR-0020 gates and the isolated data plane (#264). No Microsoft bank is planned before Oct 30 |

## Not built, by impact

| Gap | Why it matters | Blocks go-live? |
|---|---|---|
| Allowlist mirror (#275) | **Built** (D100, number to confirm at merge; design R1, R4, R12). Live reading needs the registration's scope group recorded, and the group permission confirmed by the 2026-10-19 probe | No longer |
| Exclusion policy before download (#272) | Microsoft mail refuses any non-empty exclusion policy until the two-step read exists; #338 wires the shared policy for Google only | Yes |
| Hosted credential (federated credential, or the KMS exception) | Hosted Microsoft has no production credential | Yes, for hosted |
| Record of every reader pass (#370) | After an incident, we could not say exactly which mailboxes were read, or when | Yes |
| Setup-script checks | `register-reader.ps1` can reuse an existing app and checks only for tenant-wide `Mail.Read`. It must reject every other disallowed permission and verify the final grants before activation | Yes |
| One bank per registration | Nothing yet ensures a Microsoft tenant id is registered to only one Conductia tenant | Before scale-out |
| Delegation health | Microsoft has no recorded "grant still in place" check, so a revoked grant looks healthy until the next read fails | Can follow |
| Separate directory identity | The reader app also reads every group's memberships (and, if granted, users' basic profiles) for the mirror. Google keeps that on a separate identity, and a bank's security review may ask for the same | Can follow |
| Date window (#353) | First reads cover the whole mailbox | Can follow |

## Alternatives considered

| Option | Why not |
|---|---|
| Reuse the app registration that sends mail | One credential could both read and send |
| Tenant-wide `Mail.Read` | Every mailbox in the bank becomes readable |
| A client secret | It can be copied. A federated credential or a non-exportable key cannot |
| Delegated access (each banker signs in) | Conductia would hold a token per person, and the bank would lose its single place to scope and revoke access |
| Conductia hosting on Azure | A bank with an Azure contract runs BYOC on Azure; Conductia hosts only on AWS, for a bank with no cloud contract (Guillermo, 2026-10-07). One hosted cloud keeps one runbook and one set of controls |

## Microsoft-specific costs

Deployment costs are in ADR-0020. Microsoft adds close to nothing:

| Control | Monthly cost | What it protects against | If we drop it | Required or our choice |
|---|---|---|---|---|
| RBAC for Applications scoping | $0 (bank admin time) | Reading every mailbox in the bank | Not an option: the design depends on it | Our choice (least privilege) |
| Non-exportable Key Vault key (BYOC Azure, split-tenant exception only) | About $1 | A stolen worker yielding a reusable credential | Not an option: the code refuses key files in production | Our choice |
| Federated credential (every cloud) | $0 | The same, with no key at all | Use the approved KMS or Key Vault exception, about $1 | Our choice |
| Graph API mail reads | $0 | n/a | n/a | n/a |

## References

`src/lib/graph/reader/` (token, certificateSource, mail, groupMirror), `src/lib/graph/http.ts`, `src/lib/graph/registration.ts`, `src/lib/mailboxAccess/mirror.ts` (binding), `src/lib/mailboxAccess/readers.ts` (the check before each read), `scripts/m365/register-reader.ps1`, `scripts/m365/write-registration.ts`, `scripts/m365/probe-out-of-scope.ts`, `scripts/m365/probe-group-mirror.ts`, `scripts/m365/README.md`, `worker/classify.ts` (the mirror per reader mode). Migrations: `20260925120000_discovery_core.sql`, `20261001130000_mailbox_allowlist.sql`, `20261018120000_graph_reader_scope_group.sql`. Issues: #243, #262, #271, #275, #277, #278, #353, #370.
