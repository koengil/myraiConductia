# Pending transferable lessons

These first-sighting candidates require confirmation in a different run before promotion to active lessons.

## Preserve exact product contracts across every artifact

- Status: pending
- First seen: `onboarding`
- Confirmations: 1
- Lesson: Carry every approved user-facing behavior, actor boundary, navigation destination, and exact failure contract into acceptance criteria and later plans without weakening or contradicting it.
- Evidence: Spec reviews blocked omissions and contradictions in live roster behavior, delegated invite scope, external navigation and membership routing, and the exact upload-outage response before the specification could be frozen.

## Ground plans in current repository seams and cutover surfaces

- Status: pending
- First seen: `onboarding`
- Confirmations: 1
- Lesson: Before proposing implementation steps, map the current schema, routes, typed registries, UI entry points, and feature-flag branches so every changed server and client surface has explicit flag-on and flag-off behavior.
- Evidence: Plan reviews blocked incorrect repository paths, incomplete typed-flag integration, and omitted flag coverage across existing and public surfaces.

## Model multi-system workflows as recoverable state machines

- Status: pending
- First seen: `onboarding`
- Confirmations: 1
- Lesson: For workflows spanning identity, database state, external delivery or storage, and audit, define legal transitions, ordering, idempotency, partial-failure recovery, and truthful audit points before implementation.
- Evidence: Plan and PR reviews repeatedly blocked invite creation, delivery, resend, acceptance, containment, and audit sequences that could diverge or become unrecoverable after partial failure.

## Make authorization invariants part of atomic writes

- Status: pending
- First seen: `onboarding`
- Confirmations: 1
- Lesson: Security-critical ownership, tenant, role, and lifecycle invariants must be predicates on the state-changing write itself, not only pre-write snapshots; tests should assert the conditional write or exercise mutation races.
- Evidence: Final PR rounds blocked a credential-recovery transition until tenant equality moved into the same conditional mutation as identity, status, and provisioning predicates and the test asserted that predicate.

## Migrate externally visible data fail-closed

- Status: pending
- First seen: `onboarding`
- Confirmations: 1
- Lesson: When legacy records gain fields that control external visibility, use a deliberate fail-closed backfill with deployment and rollback ordering rather than a permissive default.
- Evidence: Plan review blocked a migration that would have classified legacy sensitive documents into an externally eligible room by default.

## Check pre-gate disclosure when specifying a verification gate

- Status: pending
- First seen: `invite-safeguard-2fa-a`
- Confirmations: 1
- Lesson: When a spec introduces a verification or authorization gate, planners design the post-gate happy path and let the pre-gate experience disclose the context the gate exists to protect. Review what an unverified actor can see or learn before the gate passes.
- Evidence: Spec review blocked an acceptance surface that showed inviter, company, and deal context to the authenticated recipient before code entry, contradicting the fail-closed criterion and the wrong-recipient threat model.

## State reference-data provenance and empty-set behavior in the spec

- Status: pending
- First seen: `invite-safeguard-2fa-a`
- Confirmations: 1
- Lesson: Specs that make behavior depend on reference data (allowlists, trusted sets, configuration) omit where that data comes from, leaving the shipped default experience undefined. Require provenance and the empty-set behavior at the user-facing level before freezing.
- Evidence: Spec review blocked because the verified-domain set driving the match-versus-confirm branch had no defined provenance, making the non-confirmation acceptance criterion unsatisfiable as written.
