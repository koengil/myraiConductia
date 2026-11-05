# Onboarding live-demo runbook

This is the operator checklist and presenter script for the shipped onboarding
arc. It demonstrates a controlled transition from account readiness to company
authority, invitation, scoped deal access, and durable audit evidence.

The preferred route takes 10 minutes. The short route takes 6 minutes by
skipping the live company-role edit and the phase raise.

## Demo promise

The audience should leave with four ideas:

1. Readiness is visible without exposing credentials.
2. Company authority and deal access are separate systems.
3. Every invitation has an explicit, previewed perimeter.
4. Every effective change leaves durable evidence.

Use this opening line:

> Onboarding is not a form. It is a controlled transition into access.

## Claims to avoid

- Do not describe the walkthrough as certified legal, FINRA, or employer
  training. It is versioned Conductia product guidance.
- Do not say that company permissions grant deal seats, document access,
  workflow authority, or mail-review authority. They do not.
- Do not claim that Box webhooks synchronize permissions. Conductia mediates
  access and enforces the room, classification, and phase checks.
- Do not describe calendar, CRM, Slack, Teams, SharePoint, or general email
  ingestion as shipped connectors.
- Do not characterize the current `/terms` copy as counsel-approved unless
  counsel has approved the deployed version.

## Cast and browser layout

Prepare two browser profiles and one inbox before the call:

| Window | Identity | Purpose |
| --- | --- | --- |
| A | Same-tenant firm admin | Setup, company access, external-director bootstrap, invite, phase change, audit |
| B | Fresh external seller email | Verification, acceptance, scoped shell, Data Room |
| C | Mail inbox for the external address | Invite and separate verification-code emails |

Window A needs access to the demo deal and authority to manage the internal
company. Window B must not already have a live Conductia account. Use a
dedicated demo address because completed walkthrough attestations are immutable.

For Project Summit, use `admin.intelibank@dev.com` in Window A. FutureProofing
starts as an unclaimed external company, so its first active user must be a
Company Director and only a same-tenant firm admin may create that root. The
seeded `deal-team.intelibank@dev.com` seat has no delegated member-management
right and the MD cannot appoint another company's first director.

## One-time environment setup

1. Apply all migrations through
   `20260814230000_setup_walkthroughs.sql`.
2. Run `npm run seed:flags`, then enable these flags in the demo environment:
   `platform_onboarding`, `company_access_management`, and
   `setup_walkthroughs`. Enable `mail_channel` only when Microsoft 365 is
   configured and part of the presentation.
3. Configure invitation delivery with `RESEND_API_KEY` and a verified
   `RESEND_FROM`. The Resend sandbox sender delivers only to the account
   owner's inbox.
4. For Box, configure `BOX_CLIENT_ID`, `BOX_SECRET`, and `BOX_ENTERPRISE_ID`,
   then set `STORAGE_PROVIDER=box`. Run `npm run smoke:box` against the deployed
   environment.
5. For Microsoft 365, follow
   [`../04-operations/setup-readiness.md`](../04-operations/setup-readiness.md).
   Pre-connect the presenter mailbox. Do not depend on a live OAuth consent
   flow unless OAuth itself is the subject of the demo.

Feature flags are a kill switch. If a required check fails, keep the relevant
flag off until the migration and configuration are ready.

## Before every demo

Use the real demo deal code and the fresh external address throughout all three
commands:

```bash
DEAL_CODE=SUMMIT-2026-003 npm run seed:onboarding-demo
INVITEE_EMAIL=martin.casado@futureproofing.dev npm run demo:reset-invitee
DEAL_CODE=SUMMIT-2026-003 \
PRESENTER_EMAIL=admin.intelibank@dev.com \
INVITEE_EMAIL=martin.casado@futureproofing.dev \
npm run demo:check-onboarding
```

The seed is idempotent. It prepares FutureProofing as a seller party,
`futureproofing.dev` as an operations-verified domain, Vista Equity Partners as
a buyer shortlist party, and two synthetic Deal Room documents at phases 0 and
2.

The reset command is intentionally destructive only for the exact invitee
email. It removes that email's pending invitations and deal seats, then
tombstones an existing identity so audit references remain intact. Never run it
without checking `INVITEE_EMAIL`.

The preflight is read-only. All required checks must pass. Warnings are allowed
only when the matching optional beat is deliberately omitted. Never paste
environment values, OAuth codes, or tokens into the call chat.

### Five-minute operator check

- Open Window A on `/setup`; verify the expected readiness badges.
- Open the company People and Roles & permissions tabs.
- Open the demo deal's Team and Audit pages.
- Open Window C and confirm the invitee inbox can receive mail.
- Put Window B on the sign-in page or a blank private tab.
- Turn off desktop notifications and close any screen containing real client
  data.
- Keep this document open on a second screen.

## Presenter script, 10 minutes

### Beat 1: readiness without secrets, 60 seconds

**Action:** In Window A, select **Setup** from the desktop sidebar. On mobile,
use the setup icon in the top bar.

**Say:**

> This is the readiness layer. It tells an administrator whether Microsoft 365
> and the Box data room are ready, but it never displays a credential. Box is
> active for document storage. Microsoft 365 sends screened mail as the user's
> real work identity.

Point to the readiness badges. If Microsoft 365 is not part of this demo, say
that its honest status is visible and move on. Do not connect or disconnect a
production mailbox live.

**Proof:** Configuration posture is status-only. External accounts receive
`Not required`, not the internal deployment posture.

### Beat 2: role-aware guidance and attestation, 60 seconds

**Action:** Scroll to **Required guidance**. Show that the internal root sees
both User and Administrator walkthroughs. Select the last incomplete checkbox
on a dedicated demo identity, or show the Completed badge if the identity has
already attested.

**Say:**

> The guidance changes with responsibility. Every user sees the information
> wall and communications controls. Administrators also see access governance,
> invitation controls, and audit accountability. Completion is versioned,
> immutable, and recorded atomically with the audit event.

Point to the product-guidance notice.

> This is evidence that the user completed Conductia guidance. It does not
> replace the employer's approved legal or regulatory training.

**Proof:** The Completed state cannot be unchecked. A stale concurrent update
reloads the authoritative server state.

### Beat 3: least-authority company administration, 90 seconds

**Action:** Open **Company**, then **Roles & permissions**. Show an existing
role or select **Create role** and create `Demo invitation coordinator` with
**View full employee directory** and **Send company invitations**. Move to the
**People** tab, filter for the prepared internal colleague, select **Manage
access**, assign the role, and save.

If the demo environment already contains the role, reuse it. Do not create a
duplicate.

**Say:**

> Company authority is composable and enforced. This role can view the full
> directory and send company invitations. It cannot create a deal seat, see a
> document, change a workflow, or review mail. The administrator can grant only
> authority already inside their own envelope.

Point to the access-source labels in the drawer.

> The source matters. Removing a direct grant does not remove authority that is
> still inherited from a role.

**Proof:** Protected directors and firm administrators remain roots. Assigned
roles cannot be archived until their assignments are removed.

**Short route:** Show the role and its permission labels without editing it.

### Beat 4: preview before disclosure, 90 seconds

**Action:** Open the demo deal and select **Team**. Invite
`martin.casado@futureproofing.dev`, or the prepared override. The verified
domain lookup should identify FutureProofing and recommend Seller, Member,
phase 0. Because this fixture begins unclaimed, select **Company Director**
manually before opening **What they'll see**, then send.

**Say:**

> The inviter does not type an email and hope. Conductia resolves the known
> company, proposes a role, and previews the perimeter before disclosure. The
> administrator still confirms the company, seat, and phase. Recommendations
> never grant access.

Point to the two permanent denials in the preview.

> External users never see the Internal room or MNPI. Phase controls how much of
> the Deal Room is released.

**Proof:** The phase-0 process letter is reachable. The phase-2 financial
overview is not yet reachable.

### Beat 5: identity, verification, and scoped landing, 2 minutes

**Action:** In Window C, open the invitation email and the separate verification
code email. In Window B, follow the invitation, enter the code, set credentials,
complete the deployed terms step, and finish MFA if the environment requires
enrollment.

**Say:**

> The link alone is not enough. The recipient proves control of the mailbox with
> a separately delivered code. Until acceptance is complete, every protected
> API contains the identity. Existing users join without re-registering.

After acceptance, show the welcome brief and the reduced external navigation.

> The landing page explains the company, seat, phase, and actions available to
> this user. The shell is generated from authority, not hidden with CSS.

**Proof:** The external shell exposes only Deal, Data Room, and Team. It does
not expose internal company or bank surfaces.

### Beat 6: information wall and monotonic release, 90 seconds

**Action:** In Window B, open **Data Room**. Show the phase-0 process letter and
the absence of the phase-2 financial overview. In Window A, return to Team and
raise the external member to phase 2. Refresh Window B and open the newly
available financial overview.

**Say:**

> A hidden document does not leak through an error message. The server returns
> an opaque not-found response across list, view, and download. Raising the
> phase is an explicit release decision. Disclosure is monotonic, so an attempt
> to lower the phase is rejected.

**Proof:** The phase-2 document appears only after the committed phase raise.
Internal-room content remains absent at every phase.

**Short route:** Keep the member at phase 0 and explain the prepared phase-2
proof without changing it.

### Beat 7: delegation and audit close, 90 seconds

**Action:** If the external user is a Company Director, show that they can
invite a teammate only into their own company. Then return to Window A and open
the deal **Audit** view.

**Say:**

> Delegation is bounded. An external director can invite their own teammate,
> but cannot cross companies or widen the deal perimeter.

In Audit, point to the relevant rows and timestamps.

> The invitation, acceptance, seat and phase grant, document access, and any
> upload or download are durable evidence. The control and its proof are part of
> the same workflow.

Finish with:

> That is controlled onboarding: readiness, least authority, previewed
> disclosure, server-enforced walls, and an audit trail from the first invite.

## What the audience should see

| Beat | Visible evidence |
| --- | --- |
| Setup | Microsoft 365 and Box readiness without secret values |
| Guidance | Role-aware tracks, progress count, immutable Completed state |
| Company access | Human-readable permissions and source-aware assignment |
| Invite | Verified company, proposed seat, phase, and perimeter preview |
| Acceptance | Separate verification code and scoped welcome brief |
| Data Room | Phase-0 document first, phase-2 document after release |
| Audit | Actor, action, target, and timestamp for effective changes |

## Fast recovery

| Symptom | Response |
| --- | --- |
| Setup link is absent | Required flag is off. Do not toggle it live unless the migration and preflight are green. Skip to Company. |
| Microsoft 365 says Setup required | State that the environment is not configured and skip live OAuth. Never enter secrets on screen. |
| Box says Configured, not active | Do not claim Box is active. Continue with the server-enforced room and phase story, or use the pre-approved fallback environment. |
| Invite email is delayed | Check delivery status in pending invitations, then use Resend. Resend rotates the credential, so the old link stops working. |
| Invitee already exists | Stop before sending. Run `demo:reset-invitee` with the exact address, then rerun preflight. |
| Invitee is contained | Finish verification and acceptance. `onboarding_incomplete` is the intended fail-closed state. |
| Walkthrough save reports a conflict | Reload. The page fetches the authoritative revision and preserves the committed state. |
| Company access save reports a conflict | Reload the drawer before editing again. Do not repeat clicks against stale state. |
| Lookup returns unavailable | Stop the invitation beat and rerun the preflight. A missing preferred-role column or company-access migration must be repaired before the demo. |
| Perimeter preview returns Forbidden | For the unclaimed FutureProofing fixture, confirm Window A uses the firm-admin account and the proposed company role is Director. |
| Perimeter preview is unavailable | Say that the read failed closed. The surface does not show a partial result or grant access. |
| Acceptance says the company must retain a director | The invitation was sent as Member to an unclaimed company. Run `demo:reset-invitee`, sign in as the firm admin, and reissue it as Company Director. Do not alter the invitation row in place. |

## Post-demo cleanup

1. If `Demo invitation coordinator` was created, remove its member assignment,
   then archive the role. Assigned roles cannot be archived.
2. Reset the external invitee only when the address must be reused:
   `INVITEE_EMAIL=<exact-address> npm run demo:reset-invitee`.
3. Leave audit rows and completed walkthrough attestations intact. They are
   evidence, not demo residue.
4. Record any fallback used during the presentation so the next operator knows
   which beat was not exercised live.

## Source references

- [`../04-operations/setup-readiness.md`](../04-operations/setup-readiness.md)
- [`../07-decisions/ADR-0011-onboarding-invites-dataroom.md`](../07-decisions/ADR-0011-onboarding-invites-dataroom.md)
- [`../02-product/labor-day-mvp-2026-08-03.md`](../02-product/labor-day-mvp-2026-08-03.md)
- `scripts/seed-onboarding-demo.ts`
- `scripts/reset-demo-invitee.ts`
- `scripts/check-onboarding-demo.ts`
