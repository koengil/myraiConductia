# ADR-0022: Google Workspace mailbox connection

Status: Draft for discussion, 2026-10-06, after audit round 2 (against `develop` @ 63a4464b); status lines rechecked against `develop` @ 3c95bf19 on 2026-10-07.
Read [ADR-0020](./ADR-0020-mailbox-connection-deployment-and-shared-seam.md) first. It defines the deployment modes, the shared guard, the tiers, egress, cost by deployment and the regulatory mapping. This ADR covers only what is specific to Google Workspace.
Related: [ADR-0025](./ADR-0025-gmail-send-as-banker.md) (number to confirm at merge) adds sending as the banker's own Gmail through a separate per-user OAuth client with `gmail.send`. Decision 3 below is unchanged: the reader still has no send path, and the sending code in `src/lib/email/` imports nothing from `src/lib/google`.

## Bottom line

- **Google is the harder provider to contain.** The only setting that lets an app read many mailboxes, domain-wide delegation, lets our reader act as **any user in the bank's domain**. Google cannot narrow it to a group.
- **We accept that reach and contain it in four layers:** no key to steal, our guard and the bank's group decide what is read, an alert on any off-list access (to be built before Pilot), and the bank's CCO signs off on what remains.
- **Ignatious, the first pilot bank, goes live only after its Pilot gates pass.** The largest open items are the hosted worker and its gates (#344) and the Google-side alert. The exclusion policy before download is merged (PR #338); Ignatious's own policy must be written before the first pass.

## In plain terms

- **What we do.** The worker reads deal-related mail from a bank's Gmail mailboxes. Ignatious is on Google Workspace and hosted by Conductia.
- **The worst case.** A compromised worker could reach every mailbox in the domain, not just the opted-in ones.
- **How we contain it.**
  - **Prevent:** there is no key to steal, and the cloud trust will accept only the worker itself (proven at the #344 gates).
  - **Limit:** Conductia's guard and the bank's group decide which mailboxes are read.
  - **Detect:** an alert will fire whenever a token is issued for a mailbox outside the list. It is not built yet and is a Pilot gate.
  - **Accept:** the bank's CCO signs that they understand the remaining risk.
- **What this ADR decides.** How the worker proves its identity to Google, what it may read and keep, and what must be true before Ignatious's real mail is read.

## Terms

- **Domain-wide delegation (DWD):** a Google admin setting that lets one service account act as any user in the domain, for named scopes only. It is the closest thing Google has to a master key, so most of the controls here exist to narrow it.
- **Service account:** a Google identity for a program, not a person.
- **`signJwt`:** a Google call that signs our login request for us, so we never hold a private key.
- **Workload identity federation (WIF):** lets the worker prove its identity to Google through the platform it runs on (in the hosted case, AWS), with no stored key.
- **Token mint:** Google issuing a short-lived access token to act as one mailbox.
- **History id:** Gmail's bookmark for "changes since this point".

## Decision

1. **One Google registration per bank, separate from Microsoft.** It names the Workspace domain, the delegated reader account, a separate directory account and the allowlist group. Each mailbox is a source with provider Google. For banks on both providers, see ADR-0020.
2. **Two Google identities, so the reader never produces its own audit evidence.**
   - The **reader account** reads mail.
   - The **directory account** has no delegation and no mail access. It only reads the bank's allowlist group.
   - The registration rejects the same account in both roles.
3. **Read-only, with no send path.**
   - The delegation grant authorizes exactly two scopes: `gmail.readonly` and `gmail.metadata`. The reader uses `gmail.readonly`.
   - A test fails the build if any send path or other scope appears in the reader.
   - The bank's admin guide forbids adding modify, send or Drive scopes.
4. **No keys.**
   - The worker first proves its own identity, then asks Google to sign the delegated login (`signJwt`).
   - The code refuses any credential file that contains a key, and refuses personal developer credentials in production.

   | Deployment | How it runs |
   |---|---|
   | **Hosted (Ignatious)** | The worker runs in **a Conductia-owned AWS account dedicated to the bank** (#344). It federates into Google Cloud through WIF, restricted by a condition on the worker's task role. The Google auth library cannot read Fargate task credentials from a file, so #344 (PR #387, merged 2026-10-07) adds a small supplier in code |
   | **BYOC on AWS** | The same design in the bank's own AWS account |
   | **BYOC on Azure** | Google trusts the worker's Azure managed identity through workload identity federation, then `signJwt` as above. On Container Apps the identity endpoint needs a rotating header, so this also needs a supplier in code (planned, ADR-0020) |
   | **BYOC on Google Cloud** | The worker's attached caller service account calls `signJwt` on the separate reader account; no federation needed. The loader today requires a credential file, so it needs a change to accept the attached identity (planned, ADR-0020) |
   | **Dev** | A developer credential against Conductia's paid dev Workspace (approved 2026-10-20, not yet created; [setup checklist](../04-operations/dev-google-workspace-setup.md)). The `emailmask.uk` trial it replaces expired (owner, 2026-10-20) |

   Two hosted facts are proven at deployment, not in code, and are Pilot gates in #344: that WIF trusts only the worker's task role (once the Fargate supplier exists), and that Google refuses key creation for the reader account.
5. **Which mailboxes are read.**
   - Conductia's guard runs before every page (ADR-0020).
   - The allowlist mirror compares Conductia's list with the bank's group. If the group cannot be read, reading stops (fail closed).
   - How fast a change takes effect:

     | Change | Takes effect at | Why |
     |---|---|---|
     | Banker withdraws consent, or the mailbox is paused | The next page | The guard checks before every page |
     | Bank removes the mailbox from its group | **The next pass** | The group is read once per pass |

   - The group controls what is read from Gmail. It does not, by itself, hide text already stored. Stored text stays visible to its owner only.
6. **What is read and what is kept.**
   - **Read:** the reader lists threads (excluding spam and trash), reads their metadata, then downloads each remaining message in full.
   - **Bank exclusions run before any download** (PR #338, merged 2026-10-06). The bank's policy is checked on metadata, and only a message that passes is downloaded, so excluded mail is never stored. A missing or invalid policy refuses the read. Limits: a label added between the metadata read and the download is caught only after the fetch (the body is discarded unparsed), and until #337 participant rules see From, To and Cc only.
   - **Attachments** arrive inside the downloaded message and are discarded after parsing. They pass through the worker's memory, are never stored, and their text is not extracted.
   - **Stored:** only messages routed to a deal, and only the top of each message. Conversations are matched by the email's own reference headers, not by Gmail's thread id (which differs per mailbox), so a conversation among colleagues is not split.
   - **Ledger:** every message the reader passes on leaves a content-free ledger entry. Messages filtered out earlier leave none. #370 adds a record of each pass with counts (fetched, excluded, stored); it does not name individual dropped messages, a limit Guillermo accepted (2026-10-06).
7. **Sync.**
   - **Checkpoints:** saved after each stored page.
   - **Page size:** at most 25 Gmail calls per page, so a consent withdrawal stops reading within one page.
   - **Rate limits:** retried.
   - **Expired history id:** if Gmail's change marker for a mailbox expires, the worker records it and starts a fresh full read. It halts the mailbox instead, for an operator to act, in two cases: the previous full read itself took longer than five days, so a new one could not finish before Gmail's change history lapses again; or the marker expired straight after a full read twice in a row (a successful change-only pass resets that count) (`handleExpiry` in `worker/sync.ts`).
   - **Date window:** none yet. #353 adds one, starting at 90 days.
   - **Known gap:** a halted mailbox is re-queued every five minutes, with no alert. The ADR-0020 heartbeat and state work fixes this.
8. **No model in the reader.** Neither the reader nor the classification worker calls a model. A lint rule enforces it for the worker, the Graph reader and the Google reader (`src/lib/google/reader/`, PR #391, merged 2026-10-08). Model use on stored text is governed by ADR-0017 decision 6 and the tenant model gate (PR #346).

## The domain-wide blast radius, and how it is contained

| Layer | Control | Status |
|---|---|---|
| Prevent | No key exists for the reader account; WIF trusts only the worker's task role | The code refuses key files. The AWS-to-Google trust is proven at the #344 gates |
| Limit | Conductia's guard on every page; the bank's group; read-only scopes | Built |
| Detect | An alert on any token minted for a mailbox outside the allowlist; CloudTrail, GuardDuty and tamper alerts in the hosted account | Specified in the #344 runbook (PR #387, merged 2026-10-07; gates G0, G3, G8), not built. The worker records delegation outcomes at mint but does not check the subject against the list. The Google-side alert is a Pilot gate, which must name the audit signal that shows the delegated mailbox, the alert owner and the response time |
| Accept | The owner and Ignatious's CCO sign the remaining risk at #344 gate G0, including the worker's database reach (ADR-0020 decision 1) | Pending |

**Egress: what is blocked and what is not** (ADR-0020 decision 6)

- **Allowed:** Google APIs, the identity-federation endpoints (AWS STS, Google `sts` and `iamcredentials`, the local task endpoint), AWS secrets and the database. ADR-0020 decision 6 has the full list.
- **Blocked:** every other host name, through a DNS allowlist.
- **Not blocked in Demo and Trial:** a connection to a raw IP address. It is recorded in flow logs; the gap is accepted for Demo and Trial only (Guillermo, 2026-10-08). From Pilot on, AWS Network Firewall blocks it (ADR-0020 decision 6).
- **Not closed by a standard firewall or DNS allowlist:** every allowed destination is multi-tenant, so a compromised worker could send data to an attacker's own Google account through an allowed API. A TLS-inspecting proxy pinned to the bank's tenant could narrow this; it is out of scope (ADR-0020).

## Status

| Tier and gate | Google Workspace |
|---|---|
| Dev | Works: synthetic fixtures and a recorded Gmail replay in CI. Live runs worked against the `emailmask.uk` trial domain until it expired (owner, 2026-10-20); the next live runs use the paid dev Workspace ([setup checklist](../04-operations/dev-google-workspace-setup.md)) |
| Pilot (Ignatious) | **Not yet.** Needs every item in the list below |
| Production | Each further bank, after the isolated data plane (#264) |

Pilot gates for Ignatious:
- Ignatious's exclusion policy written before the first pass (the policy itself merged in PR #338);
- #344 (merged in PR #387, 2026-10-07) with its gates passed: G0 written acceptance, the WIF trust, Google refusing key creation for the reader account, the Google-side mint alert;
- #331 (no content in URLs or logs; fixed in PR #376, follow-up #375) and #343 (ADR-0017 Amendment 1, D75);
- Ignatious's own setup (#342);
- #370 (record of every reader pass; PR #388, open);
- AWS Network Firewall in front of the hosted worker (ADR-0020 decision 6; Guillermo, 2026-10-08);
- the narrower database credential in place of the `sb_secret_` key (ADR-0020 decision 1; Guillermo, 2026-10-08);
- proposed: the ADR-0020 heartbeat and state work;
- proposed: the bank's records determination;
- any owner decisions still open in the owner queue.

## Not built, by impact

| Gap | Why it matters | Blocks Pilot? |
|---|---|---|
| Hosted worker's go-live gates (#344; the worker merged in PR #387) | No production runtime for real mail | Yes |
| Narrower database credential (ADR-0020 decision 1) | The worker's `sb_secret_` key reads and writes every tenant's rows on the shared project | Yes |
| AWS Network Firewall (ADR-0020 decision 6) | A compromised worker can send to any IP address on 443 or 5432 | Yes |
| Record of every reader pass (#370) | After an incident, we could not say exactly which mailboxes were read, or when | Yes |
| Google-side alert on off-list token mints | The main way to detect misuse of domain-wide delegation | Yes |
| Heartbeat, halted-source alert, short job expiry | A stopped or halted worker looks healthy | Yes |
| One bank per registration | Nothing yet ensures a Workspace domain or reader account is registered to only one bank | Before scale-out |
| Scheduled delegation check and reconciliation | Delegation status refreshes only when a token is minted | Can follow |
| Attachment text | Deals discussed only in attachments are missed | Can follow |
| Date window (#353) | First reads cover the whole mailbox | Can follow |

## Alternatives considered

| Option | Why not |
|---|---|
| Each banker signs in (per-user OAuth) | Conductia would hold a refresh token per person, and the bank would lose its single place to scope and revoke access |
| A service-account key | A copyable, long-lived credential to every mailbox in the domain |
| One account for both mail and the group | The reader would produce its own audit evidence |
| Gmail thread ids as conversation ids | They differ per mailbox, so one conversation splits across colleagues |
| No network firewall at Pilot | Leaves the raw-IP path open on real mail. Accepted for Demo and Trial only; AWS Network Firewall is required from Pilot on (Guillermo, 2026-10-08; ADR-0020 decision 6). It still cannot stop exfiltration through allowed multi-tenant APIs |

## Google-specific costs

Deployment costs are in ADR-0020 (the hosted AWS stack is about $65 to $75 a month, about $355 to $365 with the AWS Network Firewall that Pilot requires in one zone). Google adds:

| Control | Monthly cost | What it protects against | If we drop it | Required or our choice |
|---|---|---|---|---|
| Keyless signing (`signJwt`) | $0 | A stolen key reading every mailbox in the domain | Not an option: the code refuses key files | Our choice |
| Read-only scopes and the no-send test | $0 | Changing or sending mail as the bank | Not an option: the build fails | Our choice |
| Google-side mint alert | About $0 to $5 (est.) | Undetected use of domain-wide delegation | Misuse goes unseen | Our choice, and a Pilot gate |
| Gmail API reads | $0 within quota | n/a | n/a | n/a. Google plans charges above quota later in 2026, with at least 90 days' notice |

## References

`src/lib/google/reader/` (credentials, token, mail, mime, thread, http, groupMirror, registration), `src/lib/constants/googleReader.ts`, `tests/google/no-send-path.test.ts`, `scripts/google/write-registration.ts`, `scripts/google/lib/probe.ts`, `docs/03-engineering/google-workspace-reader-admin-guide.md`. Migrations: `20261002175000_google_reader_registrations.sql` to `20261002183000_discovery_google_health.sql`. Issues and PRs: #259 (PR #322), #262, #263 (PR #338), #331 (PR #376), #342, #343, #344, #346, #353, #370.

## Addendum: team inboxes (#581)

A shared Gmail inbox such as `deals@<firm domain>` has no person to opt in, so decision 5's allowlist cannot admit it. [ADR-0026](./ADR-0026-team-inbox.md) adds a firm-admin registration beside the personal allowlist, verifies the address in the Google Directory, and shows the inbox's findings only to members the admin names. It changes two things here: the directory identity's custom role also needs **Users: Read**, and its token carries both Directory scopes (`admin.directory.group.member.readonly` and `admin.directory.user.readonly`). The delegation grant, the reader's scopes and the guard on every page are unchanged. The owner's live check is in [team-inbox-guide.md](../03-engineering/team-inbox-guide.md#the-live-check-t1).
