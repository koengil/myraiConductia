---
run_id: onboarding
type: spec
round: 1
---

# Spec: Onboarding — Buyer/Seller Invites + Box Data Room

## Problem statement

Conductia onboards only bank-internal users, and only via a seed script. Buyers
and sellers on a deal have no way to join the platform: there is no sign-up, no
invite mechanism, and the membership API rejects unknown emails ("invitee must
sign up first"). Documents exist as metadata rows with no real storage behind
them, and the two roster surfaces (Team, Working Group) run on fixtures with the
invite affordance explicitly stubbed. The platform promise — every party on a
deal working inside one compliance-audited environment — is unrealized.

## Goals

1. Sellers and buyers join a deal through a clean invite flow: email, accept,
   create account — as a standard user or a company director who brings in
   their own team.
2. Bank-internal colleagues can also be invited by email (from deal creation
   onward), replacing the "invite by email comes later" stub.
3. Data room access runs through Box, mediated entirely by the platform, with
   every action captured in the audit log from day one.
4. External users get an honest, scoped platform experience: their deal, its
   data room, their team — nothing else.
5. The whole flow is demonstrable live end-to-end in a weekly build sync.

## Non-goals / out of scope

- Bank-level and user-level setup (connecting a user's email, supporting
  tools) — the "next 30 days" arc.
- User/admin training walkthroughs (platform training, FINRA/data-security/
  screening content).
- Text or email prescreening (separate workstream).
- Box events sync or any Box-native collaboration; users never touch Box.
- Per-document ACLs beyond room/classification/phase (deferred per D37).
- Terms-of-service or compliance-attestation screens during accept.

## User-facing behavior

### Inviting

- A bank MD or deal-team member with member-management rights invites anyone:
  internal colleagues (deal roles such as Deal Team or Legal) or external
  people (a buyer/seller company plus Seller or Buyer role, as director or
  standard member).
- An external company director invites standard members of their own company
  only, onto deals their company is party to. Nobody else can invite.
- Invites are also available inside deal creation (Gate 0 Team step): queued
  while the wizard runs, sent once the deal exists.
- The invitee receives a branded email with an accept link. Pending invites can
  be resent or revoked. One live (pending) invite per email address; an email
  that already has an active account is rejected with guidance to grant deal
  access directly instead.

### Accepting

- The accept link opens a public (unauthenticated) accept page showing who
  invited you, to which company, and the deal codename. The invitee sets a
  display name and password and lands signed in.
- Acceptance provisions everything in one step: account, company membership
  with the invited company role, and deal membership at the entry phase.
  Partial provisioning must be impossible.
- Expired (7 days) or revoked links reach an honest dead-end telling the
  invitee to request a resend.

### Data room

- Bank users get a Data Room destination per deal: files split into an
  Internal room and a Deal Room, with classification and minimum-phase
  visibility badges, upload, and download.
- External users see only Deal Room files whose minimum phase their membership
  has reached. The Internal room and MNPI-classified documents are never
  visible to external users under any circumstances.
- Sellers can upload to the Deal Room (classes 1–3); buyers are read-only.
- The MD can raise a member's phase (individually or for a whole team at
  once); newly eligible files appear for that member.

### External experience

- After accepting, external users land on a scoped deal home with exactly two
  destinations: Data Room and Team. No command console, no MD destinations.
- Directors see their team roster with invite/manage affordances for their own
  company; standard members see the roster read-only.

### Audit

- Every step is captured in the per-deal audit view: invite sent, invite
  accepted, invite revoked, membership grant, upload, view, download.

## Acceptance criteria

1. An authorized bank user can create an invite (internal role, or external
   company + Seller/Buyer + director/member); a branded email is delivered
   with a working accept link, and the invite appears as pending with resend
   and revoke actions.
2. Creating an invite for an email with an active account fails with guidance;
   a second pending invite for the same email fails with a resend hint.
3. The accept page shows inviter, company, and deal codename; a revoked or
   expired link shows the dead-end state and cannot be redeemed.
4. Completing acceptance yields, atomically: a working sign-in, company
   membership with the invited role, and deal membership at entry phase. No
   partial state is observable after a failed acceptance.
5. An external director can invite a member of their own company to their
   deal; the same director cannot invite into another company or another deal
   (server-rejected, not merely hidden).
6. The Gate 0 Team step offers invite-by-email; queued invites are created
   against the deal after successful creation, and the "comes later" copy is
   gone.
7. Bank users see the Data Room destination with Internal/Deal Room split,
   classification and min-phase badges, working upload and download.
8. In production/demo configuration, file bytes live in Box; in dev/CI the
   suite passes with no Box credentials configured.
9. An external user's shell shows only their deal, Data Room, and Team; no
   command console; sign-in routes them into their deal directly.
10. An external user can never retrieve an Internal-room document or an
    MNPI-classified (class 4) document — enforced server-side, verified by
    tests, regardless of phase. Deal Room documents appear only once
    membership phase ≥ the document's minimum phase.
11. A seller account can upload to the Deal Room (classes 1–3); a buyer
    account cannot upload.
12. Raising a member's phase (single or team-wide) makes newly eligible
    documents visible to them without further action.
13. The per-deal audit view shows invite_sent, invite_accepted,
    invite_revoked, grant, upload, view, and download entries for the steps
    above, with actor and document attribution.
14. All new behavior ships behind the platform_onboarding feature flag; with
    the flag off, current behavior is unchanged.
15. The demo script (brief, final section) runs end-to-end against a real Box
    tenant and real email delivery.

## Open questions — resolved

- Email delivery: platform-sent branded email (Resend) rather than
  Supabase-native SMTP, which is rate-limited and undeliverable enough to kill
  a live demo. Keys already provisioned.
- Box access model: fully platform-mediated (users never see Box) so
  permissions stay in one place and audit is synchronous and complete.
- External surface: scoped deal home (Data Room + Team) rather than the full
  permission-gated shell; the full shell audit is future work.
- Vendor: Box confirmed at the 2026-07-28 build sync (supersedes open decision
  D31 for this arc); dev/CI runs without it by design (criterion 8).
