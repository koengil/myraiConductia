---
run_id: invite-safeguard-2fa-a
type: spec
round: 1
---
# Invite safeguards and platform two-factor authentication

## Problem statement

An authorized inviter can currently address an invitation to any syntactically valid email and the recipient can gain access by using the emailed credential. A typo or selection error can therefore grant confidential company and deal access to a person who merely controls the mistyped mailbox. The current password sign-in also establishes a platform session with one factor, leaving every deal reachable through that session exposed to a compromised password.

## Goals

1. Warn before an invitation is sent when the recipient email is inconsistent with the selected company, and require a deliberate correction or override.
2. Require every invite recipient to pass a challenge independent of the emailed invite link before the invitation can grant usable access.
3. Require two-factor authentication for every platform sign-in, across all companies, projects, and deals.
4. Preserve the current invitation authorization, containment, expiry, revocation, resend, and audit guarantees while making the new gates fail closed.
5. Keep the experience precise and recoverable without weakening either security gate.

## Explicit non-goals

- Changing deal, company, role, document-wall, or data-room authorization rules.
- Moving identity or platform access into the M&A content contract.
- Adding per-project, per-deal, per-role, or user-optional two-factor policies.
- Supporting SMS or email as the platform second factor.
- Building a company-domain administration surface in this work item.
- Building end-user factor recovery or account-recovery workflows. Authorized support can use the existing Supabase administrative recovery path.
- Replacing the existing invite email provider, invitation lifecycle, or Supabase Auth identity model.

## User-facing behavior

### Pre-send recipient check

- Every invite entry point checks the normalized recipient email against the selected company's verified email-domain set before the invite email can be sent.
- A matching domain proceeds through the normal send action. It does not bypass recipient verification.
- A non-matching domain, a personal-email domain, or a company with no verified domain is treated as a mismatch. The inviter sees the exact recipient email and selected company together with a decisive warning.
- A mismatch presents two actions: correct the invitation, or explicitly confirm and send it. Confirmation is never preselected or inferred.
- Confirmation applies only to the exact normalized email and company shown. Editing either value clears it. Each resend following an address or company change requires a new check and, when applicable, a new confirmation.
- Gate 0 queued invitations receive the same check before entering the queue. An unconfirmed mismatch cannot be sent automatically when mandate creation completes.

### Recipient-side verification

- Each sent invitation has a six-digit, single-use verification code that is shown once to the inviter. The interface directs the inviter to deliver it to the intended recipient through a trusted channel separate from the invitation email.
- The verification code is never placed in the invitation email, invite URL, acceptance context, logs, or audit detail.
- After opening the invitation, the authenticated recipient sees the inviter, company, deal context when present, and addressed email, then must enter the verification code before accepting.
- Five failed code attempts lock that invitation's challenge. A locked, expired, revoked, superseded, already accepted, or otherwise invalid challenge grants no access and directs the recipient to obtain a fresh invitation.
- Resend rotates both the invitation credential and verification code. All prior links and codes stop working. The new code is shown once to the authorized inviter.
- Successful verification is single-use and bound to that invitation and authenticated recipient. Company membership, deal membership, active-user status, and access become usable only when current invitation checks and recipient verification all succeed.
- Invitations that were pending before this safeguard is deployed cannot be accepted without the new challenge. An authorized inviter must resend them to issue a current link and code.

### Platform sign-in two-factor authentication

- Password verification is the first sign-in step. A user with a verified authenticator factor must then enter a current authenticator-app code before any protected platform content or protected platform API is available.
- A user without a verified authenticator factor is directed through authenticator-app enrollment after password verification. Enrollment is complete only after the user successfully verifies a generated code.
- Newly accepted invitees are directed to authenticator enrollment before they can use their new company or deal access.
- A password-authenticated session that has not completed the second factor is restricted to the sign-in, invite completion, authenticator enrollment, authenticator challenge, and sign-out paths required to finish authentication. Direct navigation and direct API calls cannot bypass this restriction.
- Existing users and existing password-only sessions must complete enrollment or a challenge on their next protected platform access after rollout.
- Once the second factor is verified, the session may enter any project the user's existing permissions allow. No additional project-specific challenge is introduced.
- Failed, expired, or invalid authenticator codes leave the session restricted and show a recoverable error. Signing out clears the partial sign-in state.

## Acceptance criteria

1. Given a syntactically valid invite email whose normalized domain is in the selected company's verified domain set, an authorized inviter can proceed without a mismatch confirmation, and all existing invite authorization checks still apply.
2. Given a syntactically valid invite email whose domain does not match, is personal, or cannot be verified for the selected company, no invite email is sent until the inviter explicitly confirms the exact normalized email and company or corrects the invitation.
3. Changing the email or company after a mismatch confirmation invalidates that confirmation, and a server-enforced check prevents a modified or direct request from bypassing the required confirmation.
4. Gate 0 and Working Group invite entry points present the same mismatch classification and explicit-confirmation behavior, with clear copy that contains no questions or em dashes.
5. Sending an invite produces a new single-use six-digit challenge for that invitation, exposes it once only to the authorized inviter, and excludes it from the recipient email, URL, acceptance context, application logs, and audit detail.
6. Possession of a valid invite link and control of the addressed mailbox are insufficient to grant company or deal access without the correct current verification code.
7. A correct current code supplied by the authenticated addressed recipient allows acceptance to complete exactly once; the membership grants, user activation, and acceptance audit remain atomic with the successful acceptance.
8. An incorrect code does not change invitation or access state. The fifth failed attempt locks the challenge, and further attempts cannot grant access until an authorized resend issues a fresh link and code.
9. Resending a pending invitation invalidates every prior invite link and verification code, returns a new code once to the authorized inviter, and preserves the existing pending-invite scope and authorization rules.
10. Revoked, expired, accepted, superseded, locked, wrong-account, and pre-safeguard pending invitations fail closed without exposing confidential company or deal data; a pre-safeguard pending invitation becomes usable only after authorized resend.
11. A successful password sign-in without a verified second factor cannot reach protected application routes or protected platform APIs.
12. A user with no verified authenticator factor can enroll one and must verify an authenticator code before gaining protected access. A newly accepted invitee follows this same enrollment gate.
13. A user with a verified authenticator factor must complete an authenticator challenge after password verification before protected access is available.
14. Platform two-factor enforcement applies uniformly across companies, projects, deals, roles, direct route navigation, and direct protected API requests, while preserving existing authorization after the session reaches two-factor assurance.
15. Invalid or expired authenticator codes never raise the session to two-factor assurance, expose protected content, or alter project permissions; the user can retry or sign out.
16. Existing active password-only sessions are restricted on their next protected request after rollout until enrollment or challenge succeeds.
17. Security-relevant outcomes are auditable without storing either secret: mismatch override, challenge issuance or rotation, challenge lock, successful invite verification and acceptance, authenticator enrollment, and successful two-factor completion record actor, target context, outcome, and time where an authenticated actor exists.
18. Existing invite expiry, revocation, duplicate-pending handling, containment, tenant and email binding, wall-side role rules, feature-off behavior for the onboarding invite flow, and delivery truthfulness continue to behave as before except where these criteria explicitly add a fail-closed gate.

## Out of scope

- Domain ownership discovery, DNS verification, or an administrator UI for maintaining verified company domains.
- Alternative second factors such as WebAuthn, passkeys, hardware security keys, SMS, voice, or email OTP.
- Remembered-device controls, risk-based step-up authentication, or per-action reauthentication.
- A self-service lost-device, backup-code, or factor-reset experience.
- Changes to public marketing pages, M&A content surfaces, Box storage, document classification, or deal workflow.
- Retrofitting direct membership grants with the invitation challenge.

## Open questions resolved with recommendations

1. **What counts as a company match.** Use normalized registrable domains from a trusted verified-domain set for the selected company. Subdomains match their verified parent. Personal domains and companies with no verified domain never silently pass; they require explicit confirmation. This avoids pretending that an unknown domain is safe.
2. **Whether an override should block the invitation.** Permit the already-authorized inviter to override a mismatch after seeing the exact address and company. The brief requires deliberate confirmation rather than a new supervisory approval, and the override remains auditable.
3. **What proves the recipient is the intended person.** Use a per-invite code delivered out of band by the inviter. The email link already proves mailbox control, so another email challenge would not protect against inviting the wrong person who owns that mailbox.
4. **Challenge lifetime and abuse handling.** Bind the code to the current invitation credential and its existing expiry, allow five failed attempts, then require resend. Resend rotates both secrets and gives the inviter a clean recovery path.
5. **Second-factor method.** Require time-based codes from an authenticator app through Supabase Auth. Do not treat the invite email, mailbox control, or recipient verification code as platform 2FA because those serve different risks.
6. **Two-factor rollout.** Enforce two-factor assurance at the platform boundary for every user, including existing users and sessions, instead of relying on the sign-in screen alone. Existing sessions are gated at their next protected request, which closes direct-route and direct-API bypasses.
7. **Invite acceptance versus 2FA enrollment.** Complete the verified invitation transition, then contain the newly active user at authenticator enrollment until two-factor assurance is reached. This keeps invite acceptance atomic while ensuring the resulting entitlement is not usable with one factor.
8. **Lost authenticator handling.** Keep recovery administrative for this work item using Supabase's existing factor-management capability. A secure end-user recovery design requires a separate threat model and must not weaken this release.
