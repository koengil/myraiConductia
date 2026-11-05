---
run_id: invite-safeguard-2fa-a
type: brief
round: 0
---
Two security hardening items for the onboarding/invite flow shipped in PR #124
(platform_onboarding), raised by Storm in the Aug 3, 2026 Conductia Weekly Build Sync:

1. Wrong-recipient safeguard on invites. A mistyped invite email is a regulatory
   risk ("there's a chance I sent it to the wrong Greg"). Two parts:
   a. Pre-send check: before the invite email goes out, validate the address
      against the working group / company context (e.g. domain match with the
      company selected on the invite) and force the inviter to explicitly
      confirm or correct a mismatch.
   b. Recipient-side verification: the recipient must pass a verification
      challenge proving they are the intended person before the accepted invite
      grants access.

2. Two-factor authentication at platform sign-in. 2FA applies at platform login
   (Supabase Auth), not per-project. Roberto confirmed at the sync this is
   expected to be straightforward with the current auth stack.

Repo constraints (Conductia, github.com:FutureProofingDev/intelibank):
- Branch off `develop` (the active integration branch), PR into `develop`.
- Read README.md, CLAUDE.md, and docs/03-engineering/api-v1.md before speccing.
- UI talks only to the typed ConductiaAPI seam (src/lib/api/) for M&A content;
  platform/auth endpoints live beside it at /api/v1/* (ADR-0008). Identity is
  Supabase Auth mirrored into public.users. The invite flow to extend is the
  one merged in PR #124 (invite flow + Box data room + external scoped shell).
- Surgical changes only. Brand voice: senior/precise/decisive, statements not
  questions, no em-dashes in visible copy.
