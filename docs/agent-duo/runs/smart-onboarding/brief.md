---
run_id: smart-onboarding
type: brief
round: 0
---

# Smart onboarding demo experience

Implement the three recommended onboarding improvements as one coherent, demo-ready flow:

1. Smart company/email lookup.
2. A live, server-authoritative access-perimeter preview.
3. A personalized invitee welcome brief after acceptance and 2FA.

The goal is to make Conductia appear to understand the invited person, their company, and the safe collaboration boundary from a single work email, while preserving explicit human approval for every access decision.

## Product narrative

An authorized MD or company director enters a work email in the existing real invitation flow. Conductia immediately presents a compact intelligence card based on trustworthy platform data and deterministic domain analysis. It identifies an existing company when possible, proposes a human-readable company name for a new domain, explains domain or duplicate-invite warnings, and recommends the least-privilege role and starting disclosure phase. Every recommendation is visibly a proposal; the inviter must confirm the company, role, and phase before sending.

Before the invitation is sent, the inviter can open a live “What they’ll see” preview. The preview is calculated on the server from the same authorization rules that govern the real external experience. It shows the invitee’s available navigation, document totals by allowed room or disclosure band, and capabilities such as upload and own-company teammate invitation. It must also state what remains hidden, especially the Internal room and classification-4 MNPI. Changing a proposed role or phase updates the preview immediately without granting access. The same preview is available when an authorized user considers raising an existing member’s phase.

After the invitee verifies the out-of-band challenge, accepts the invite, records TOS consent, and completes 2FA, the external deal home presents a personalized welcome brief generated from current server-side deal and membership data. It names the deal codename, company, role, and current phase; summarizes currently available documents and capabilities; and offers only real, actionable next steps such as reviewing the Data Room, uploading when permitted, opening Team, or inviting an own-company teammate when authorized. It must never invent tasks or disclose metadata for inaccessible content.

## Required behavior

### Smart lookup

- Integrate with the current Gate 0 invite queue and the live Team invitation surface rather than creating a third invitation flow.
- Reuse and extend the existing invitation preflight/domain safeguards and current company, membership, and pending-invite data.
- For a known domain, surface the matched company and evidence for the match.
- For an unknown business domain, propose a readable company label derived from the domain and label it as unverified until the inviter confirms it.
- Warn on personal/disposable domains, domain mismatch, an existing user, an existing deal member, and duplicate or pending invitations when those conditions can be established from platform data.
- Recommend context-appropriate role and the least-privilege starting phase, with a short explanation.
- Never automatically create a company, send an invite, or grant/raise access from a lookup result.
- Do not add a public-web crawler, sanctions service, paid enrichment dependency, or mandatory LLM call in this release. The demo must work deterministically with existing application infrastructure and seeded/local data.

### Live perimeter preview

- The server computes the preview. Client code may render it but must not reproduce or become authoritative for access rules.
- Reuse the same central authorization/classification/phase predicates as real document and capability access, or introduce a single shared policy module used by both evaluation paths.
- Preview navigation visibility, accessible document counts, upload ability, Team visibility, and teammate-invite ability.
- Explicitly show invariant denials: external users cannot access Internal-room content or classification-4 MNPI at any phase.
- Do not return inaccessible document titles, filenames, storage identifiers, or other sensitive metadata merely to produce counts.
- Previewing is read-only and creates no membership, grant, or document-view audit event. The eventual send, accept, grant, phase change, view, and download actions retain their existing audit behavior.
- Provide clear loading, empty, unavailable, and stale-input behavior; a failed preview must fail closed and must not block the inviter from understanding that no access has been granted.

### Personalized welcome brief

- Render on the scoped external deal home reached after successful invite acceptance and 2FA; it should also remain useful on later visits rather than depending on fragile one-time client state.
- Derive all content from current trusted server data after validating project membership.
- Show deal codename, company, role, disclosure phase, available document count, capabilities, and a small ordered set of valid next actions.
- Seller upload and director/delegated-inviter actions must reflect real permissions. Buyer/read-only users must never be prompted to upload. Users without invitation authority must never be prompted to invite.
- Links must remain inside the external shell’s allowed Deal, Data Room, and Team destinations.
- Never reveal Internal-room or classification-4 metadata, hidden company data, unaccepted invite context, or another company’s roster.

## Experience and demo quality

- Design the three parts as a continuous experience, with confident Conductia copy and clear evidence/reason labels rather than a generic chatbot.
- Keep the primary path fast and visually legible at laptop demo size, keyboard accessible, and responsive.
- Include a deterministic demo fixture or documented setup that demonstrates: type one seller email, see the company/setup recommendation, open the perimeter preview, send and accept the invite, complete 2FA, and land on the matching personalized brief.
- Preserve the existing one-time verification-code handling and do not expose secrets in preview or lookup responses.
- Work under the existing `platform_onboarding` feature-flag contract and preserve behavior when the flag is off.

## Engineering and delivery constraints

- Read the repository README, CLAUDE.md, current onboarding spec/run artifacts, API docs, authorization helpers, and relevant tests before specifying the solution.
- All authorization remains server-side and fail-closed. UI gating is explanatory, never the security boundary.
- Keep API/OpenAPI documentation, schema constants, audit behavior, feature flags, and tests synchronized.
- Prefer no migration if existing durable state is sufficient. If new persistence is truly required, provide forward migration and rollback/containment notes.
- Add focused unit/integration tests for lookup outcomes, preview parity and leakage prevention, role/phase changes, personalized-action selection, feature-flag parity, and the end-to-end demo path.
- Run the repository’s mandatory lint, test, and production-build gates before opening a PR.
- Open a PR into `develop`, obtain reviewer approval, and stop without merging.

## Non-goals

- A free-form onboarding chatbot.
- Automatic access grants or autonomous phase raises.
- Public-web company research, sanctions adjudication, or claims that Conductia has completed KYC/KYB.
- New workflow/request-management primitives solely to populate the welcome brief.
- Changes to the fundamental external access invariants, TOS, recipient verification, 2FA, Box mediation, or audit-retention model.
- Replacing Gate 0, Team, Data Room, or the scoped external shell with new destinations.
