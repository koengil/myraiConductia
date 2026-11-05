---
run_id: onboarding
type: spec
round: 2
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
- The existing bank-internal compliance-theatre Team page is untouched: all
  real roster/invite/phase work in this arc lands on the Working Group
  surface, not that page.

## User-facing behavior

### Inviting

- A bank MD or deal-team member with member-management rights invites anyone:
  internal colleagues (deal roles such as Deal Team or Legal) or external
  people (a buyer/seller company plus Seller or Buyer role, as director or
  standard member).
- An external company director invites standard members of their own company
  only, onto any deal their company is party to. Nobody else can invite.
- Invites are also available inside deal creation (Gate 0 Team step): queued
  while the wizard runs, sent once the deal exists.
- The invitee receives a branded email with an accept link. Pending invites can
  be resent or revoked. One live (pending) invite per email address; an email
  that already has an active account is rejected with guidance to grant deal
  access directly instead.

### Roster management (bank side)

- The Working Group surface runs on real platform data instead of fixtures:
  it shows actual deal members and pending invites, its formerly stubbed
  invite control launches the live invite flow, and each member row exposes
  phase state plus pending-invite resend/revoke actions.

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
- Storage failures are never silent: if Box is unavailable, uploads fail with
  a retryable error and downloads show an explicit error state.

### External experience

- After accepting, external users land in a scoped shell with exactly three
  rail destinations: Deal (their deal home), Data Room, and Team. No command
  console, no MD destinations.
- Sign-in routes an external user with a single deal membership directly into
  that deal; a user with multiple memberships gets a minimal deal picker.
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
5. An external director can invite a member of their own company onto any deal
   their company is party to. Invites into a different company, or onto a deal
   their company is not party to, are server-rejected (not merely hidden).
6. The Gate 0 Team step offers invite-by-email; queued invites are created
   against the deal after successful creation, and the "comes later" copy is
   gone.
7. Bank users see the Data Room destination with Internal/Deal Room split,
   classification and min-phase badges, working upload and download.
8. In production/demo configuration, file bytes live in Box; in dev/CI the
   suite passes with no Box credentials configured.
9. With Box unavailable, an upload fails with a retryable error and a download
   shows an explicit error state; neither degrades silently.
10. The Working Group surface shows real deal members and pending invites (no
    fixtures), its invite control launches the live invite flow, and member
    rows expose phase state and pending-invite resend/revoke.
11. An external user's shell shows exactly the Deal, Data Room, and Team
    destinations and no command console. Sign-in routes a single-membership
    external user directly into their deal; a multi-membership external user
    reaches a minimal deal picker.
12. An external user can never retrieve an Internal-room document or an
    MNPI-classified (class 4) document — enforced server-side, verified by
    tests, regardless of phase. Deal Room documents appear only once
    membership phase ≥ the document's minimum phase.
13. A seller account can upload to the Deal Room (classes 1–3); a buyer
    account cannot upload.
14. Raising a member's phase (single or team-wide) makes newly eligible
    documents visible to them without further action.
15. The per-deal audit view shows invite_sent, invite_accepted,
    invite_revoked, grant, upload, view, and download entries for the steps
    above, with actor and document attribution.
16. All new behavior ships behind the platform_onboarding feature flag; with
    the flag off, current behavior is unchanged.
17. The demo script (brief, final section) runs end-to-end against a real Box
    tenant and real email delivery.

## Open questions — resolved

- Email delivery: platform-sent branded email (Resend) rather than
  Supabase-native SMTP, which is rate-limited and undeliverable enough to kill
  a live demo. Keys already provisioned.
- Box access model: fully platform-mediated (users never see Box) so
  permissions stay in one place and audit is synchronous and complete.
- External surface: scoped shell with the three rail destinations (Deal, Data
  Room, Team) rather than the full permission-gated shell; the full shell
  audit is future work.
- Vendor: Box confirmed at the 2026-07-28 build sync (supersedes open decision
  D31 for this arc); dev/CI runs without it by design (criterion 8).

## Changes from v1 (review round 1)

- 1.1: Working Group conversion added to behavior + criterion 10.
- 1.2: Box-outage behavior added to behavior + criterion 9.
- 2.1: criterion 5 boundary corrected to company-party scope.
- 3.1: compliance-theatre Team page boundary added to non-goals.
- 5.1: external navigation fixed to three destinations (Deal/Data Room/Team).
- 5.2: multi-membership minimal picker restored (behavior + criterion 11).
