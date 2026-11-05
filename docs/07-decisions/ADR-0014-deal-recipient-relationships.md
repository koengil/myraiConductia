# ADR-0014: Deal-relative recipient relationships

Status: Accepted, September 21, 2026 (Marcelo's approved implementation plan).
Product source: [Storm follow-ups](../project-memory/storm-follow-ups-2026-09-21.md).
Decision: D60. [Approved design](../superpowers/specs/2026-09-21-recipient-relationships-design.md).

## Context

Deal membership and access roles cannot determine whether an email recipient is a
client, advisor or counterparty. Storm explicitly requires counterparty approval
even on the working group; company-domain matches do not establish trust.

## Decision

Maintain explicit affiliations in platform persistence, edited by authorized
internal deal managers in Team. Recheck current memberships, delivered pending
invitations, company identity and represented parties on every send. Unknown or
contradictory data requires confirmation; failed reads stop the send.

The composer preview is advisory. Outbox issues a short-lived, purpose-separated
signed confirmation bound to the actor, tenant, deal, message and effective policy.
The normal outgoing record carries decisions; recipient preflight creates no
history. Existing Risk Patcher approval remains a separate decision.

Post-send addition opens governed Team invitations with explicit relationship and
access selection. Invitation/grant and relationship writes commit atomically.
External permissions retain existing party-derived seats and phase zero defaults;
internal defaults are read_only. No automatic director promotion is introduced.

## Consequences and limits

Old memberships without reliable affiliation need manager review. Counterparty
approval remains necessary after onboarding. Revocation, expiry, failed delivery,
removal and conflicting identity cannot silently preserve an exemption.
New advisor firms unsupported by the current party model need a separate extension;
#172 remains open. Q1/Q7 retention, Q5 routing and Q6 configurable highest-risk
confirmation are separate slices. Rob applies the migration and handles merging.
