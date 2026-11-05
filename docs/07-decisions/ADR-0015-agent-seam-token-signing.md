# ADR-0015 — Sign the Ignatious trigger token and enforce it at the `/v1` seam

- **Status:** Accepted
- **Date:** 2026-09-18
- **Source:** Finding `docs/03-engineering/finding-agent-seam-unsigned-token-2026-09-18.md`
  (static review, 2026-09-18). Extends D28 / ADR-0008 (the platform
  contract beside the `ConductiaAPI` seam). Relates to D54's open RLS follow-ups
  (#78, #79). Reverses none.

## Context

The inbound agent callback surface at `src/app/v1/**` (13 routes) is gated only by
`requireConductiaScope`. `middleware.ts` excludes `v1` from its matcher, correctly,
because an agent has no browser session; there is no `vercel.json` and no network
allowlist; and every handler receives the service-role Supabase client, which bypasses
RLS by design. The seam is therefore the entire trust boundary.

That gate accepted **either** the shared `IGNATIOUS_API_KEY` **or** any token
`readTriggerClaims` could base64-decode. The second branch performed no cryptographic
operation at all: no JWT library exists in the project, the header and signature
segments were never read, and `mintTriggerToken` wrote the literal `local-dev` as the
signature. A non-null decode was the authentication decision.

Consequently an unauthenticated caller could read any deal by id or code across tenants,
write into the data room, and set `audit_log.actor_id` to any existing user. The
`scope_denied` response also echoed `expected: config.tenantId`, supplying the one
identifier the gate demanded.

This was known, documented debt. `jwt.ts` said "Production must sign with the Conductia
key once that verifier exists", and `tests/conductia-callback.test.ts` pinned the
unsigned behaviour as the contract. The local-dev affordance was never fenced off from
production, and the Ignatious beta has been live since `v0.5.6` on 2026-09-07.

The constraint on any fix was that it must not break the skills that call back through
the seam (MD Briefing, skill step runs, skill bench, presearch, debrief and the digital
twins; the Teaser runs in-process and never calls `/v1`), and the repo holds no evidence of which
credential the agents backend actually presents on a callback.

## Decision

1. **Sign the trigger token, and verify it at the seam.** `src/lib/ignatious/triggerToken.ts`
   signs `header.payload` with HMAC-SHA256, modelled on the existing
   `src/lib/compliance/screenToken.ts`. Signing the header makes `alg` substitution
   useless. `verifyTriggerClaims` is the only function that authenticates;
   `readTriggerClaims` remains decode-only and is documented as never being an auth
   decision.

2. **No change to `conductia-agents-backend`.** This repo mints the token at eight call
   sites and Ignatious forwards it back verbatim, so both ends of the round trip are
   this deployment. Asymmetric signing would buy nothing and would require a coordinated
   two-repo rollout.

3. **Key from `CONDUCTIA_TRIGGER_TOKEN_SECRET`, falling back to a purpose-derived key
   from `INVITE_VERIFICATION_PEPPER`.** The pepper is already required in every
   environment including CI, so signing works immediately with nothing new provisioned.
   With neither set the seam cannot verify, the token path closes, and only the shared
   key authenticates.

4. **Name the credential.** `ConductiaCredential` is `api_key`, `signed_token` or
   `legacy_unsigned`, and it travels with the scope to every handler. The shared key is
   the deployment's credential and stays unscoped; a trigger token is one run's
   credential and is held to its grant. Conflating the two is what allowed the weaker
   one to become no credential at all.

5. **Bind a verified token to its deal, tolerantly.** The `dealId` claim is not uniform:
   lead-scoped agents mint the lead id, skill bench and skill step runs mint the deal
   uuid, and presearch and the twins mint a company id. The check resolves both sides to a deal and stands
   down when the claim is not one, rather than refusing a legitimate run.

6. **Enforce scopes per route**, now that they are unforgeable. They were minted per
   agent and had zero readers.

7. **Stop echoing the expected tenant** in `scope_denied`, and hash before comparing the
   api key so the early length guard no longer leaks its length.

8. **Derive the audit actor from proof.** `resolveFilingActor` accepts a named user only
   from verified claims and only after a `deal_memberships` check, falling back to
   `mandate_owner_id` read from the database.

9. **Roll out through an observe window.** `CONDUCTIA_TRIGGER_TOKEN_MODE` defaults to
   `enforce`; `observe` accepts an unverifiable token, discards its claims, and logs one
   `legacy_unsigned` line per call. It is an env var rather than a feature flag because
   `requireConductiaScope` is synchronous and `isEnabled` is an async database read, and
   because the switch is meant to be deleted.

## Consequences

- The seam authenticates cryptographically, and a token is bound to one deal and one
  grant. A leaked token no longer generalises across deals.
- `audit_log.actor_id` on an agent filing is now backed by a signature and a membership
  check. Referential integrity could only ever answer "does this user exist", never "did
  this user do this".
- **The hole remains open during the observe window.** That is the accepted cost of not
  guessing what the agents backend sends. The window should be one supervised cycle of
  the seam agents (MD Briefing, skill step runs where `skill_authoring` is on, presearch,
  debrief, digital twins), watched, not weeks. The Teaser runs in-process and cannot
  produce the signal, and no screen launches skill bench since #184.
- `deals/[dealId]/bench/chat` mints `presearchScopes()`, which is read-only. If skill
  bench files documents, that grant must be widened before the flip, not after. The
  observe log surfaces it as `reason: "scope_would_deny"`. Done in #196: both bench chat routes now mint
  `benchScopes()`, the skill-step-run grant, which adds `documents.write`.
- PRs #183 and #184 touch the same two functions and add `stepId` to the claims. They
  merged first; this change was rebased onto them and reads `stepId`, `stepTitle` and
  the filing actor from verified claims only. Because those claims choose a rail step,
  the step-run feature should not reach Production ahead of this change.
- Rotating `IGNATIOUS_API_KEY` remains an outstanding ops action, and deal-scoped RLS
  remains the durable database backstop (D54 follow-ups #78, #79). This ADR makes the
  application layer trustworthy; it does not make it the only thing between a caller and
  the data.

## References

- `docs/03-engineering/finding-agent-seam-unsigned-token-2026-09-18.md` — evidence,
  reachability, read-only forensic queries.
- `src/lib/ignatious/triggerToken.ts`, `src/lib/conductia/auth.ts`,
  `src/lib/conductia/scopes.ts`.
- `tests/conductia-seam-auth.test.ts`, `tests/conductia-seam-binding.test.ts`.
- Prior art: `src/lib/compliance/screenToken.ts`,
  `src/app/api/v1/inbound/webhook/route.ts`.
