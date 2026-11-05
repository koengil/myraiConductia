<!--
PROVENANCE — DO NOT EDIT
Source:        "Conductia Product Direction Memo" (Word doc, dated 2026-09-11),
               produced by Storm's monitoring agent (tracks SEC, FINRA, customers'
               AI plans, competitors) in answer to "what has changed in the last
               two months, how it impacts us, and what to do".
Forwarded:     Storm -> Lance -> Marcelo (Slack, 2026-09-24)
Status:        Raw / verbatim text of the memo (Word footer dropped; headings and
               list markup added, wording unchanged). AI-generated, so external
               claims are UNVERIFIED. Distilled into
               01-business/competitive-landscape.md § 4 and
               03-engineering/regulatory-and-security-signals.md.
Note:          § 7 "Immediate decision" is the memo's recommendation, not a
               recorded team decision (see 07-decisions/decision-log.md).
-->

# Conductia Product Direction Memo — 2026-09-11

## 1. Product direction

Conductia's core strategy remains correct, but the competitive window is narrowing.

We should build the governed execution and supervisory evidence layer for investment banking, starting with one bounded sell-side M&A workflow. Conductia should control how humans, AI models, and existing applications move a mandate forward: what happens next, who or what may act, which evidence and policy apply, who approves and releases, what exceptions occur, and what record is retained.

We should integrate with existing CRM, VDR, meeting, data, Microsoft 365, and AI work-product tools rather than trying to replace them.

## 2. What changed in the last two months

1. Competitors are moving into the surrounding product layers. Rogo now spans transaction workspaces, meeting intelligence, Datasite content, institutional memory, and bank-backed distribution. Model ML is expanding financial work-product, data connectivity, model routing, and firmwide deployment. Intapp has moved its compliance platform to agent-first workflows using firm data and rules.
2. The SEC materials support our architecture, but are not new guidelines. September presentations to the SEC Investor Advisory Committee emphasize machine-readable data, semantic structure, contextual metadata, validation, source traceability, confidentiality, cybersecurity, and disclosure controls. They are not an SEC rule, safe harbor, or product endorsement.
3. Regulators are pointing toward risk-based, traceable control. Federal Reserve direction favors controls proportionate to the institution, use case, and material risk. The EU AI Act became generally applicable on August 2, creating conditional requirements for in-scope EU deployments. FinCEN enforcement reinforces meaningful risk-based CDD, remediation, independent review, and ongoing evidence.
4. Institutional buyers are defining the production standard. Goldman Sachs described the gap between a compelling AI demo and a product that works on its worst day. The required capabilities are auditable grounding, firm-specific context, explicit authority, source-level traceability, human judgment, and reliable failure handling.
5. Product and fundraising claims require stronger evidence. A recent SEC AI-startup enforcement matter highlights the risk of unsupported statements about customers, partnerships, projections, valuation, and product maturity.

## 3. Required build priorities

### P0: Required before an external pilot

1. Authoritative workflow state: Typed Deal, Task, Actor, Policy, Evidence, Approval, Exception, and Event objects.
2. Mandate and authority controls: Define what each user or agent may read, draft, change, approve, release, or escalate, under whose authority and in whose name.
3. Supervisory evidence: Preserve source lineage, policy version, model version, validations, reviewer, approval, release, exception, and retained record.
4. Worst-day reliability: Deterministic checks, abstention, bounded retries, exception handling, independent review, replay, rollback, and stop switches.
5. Human release gates: No irreversible or external action without the required named approval.
6. Security remediation: Close the known shared-credential exposure before external testing through verified rotation, removal, approved storage, least privilege, revocation testing, and log review.

### P1: Required for the initial partner experience

7. Entitlement-aware integrations: Connect approved CRM, VDR, meeting, data, M365, and AI tools without losing permissions, contractual-use restrictions, provenance, or release control.
8. Risk-tiered workflows: Apply lighter controls to low-risk internal work and stronger controls to external, supervisory, or high-consequence actions.
9. Jurisdiction and obligation mapping: Keep SEC/FINRA, BSA/CIP/CDD, CTA BOI, sanctions, privacy, EU AI Act, customer WSP, and firm-policy requirements distinct.
10. Value telemetry: Measure task value, AI cost, human review cost, rework, cycle time, and Net Labor Value Captured.

## 4. Features that are not standalone differentiation

Do not make these the center of the near-term roadmap:

- Generic deal rooms or workflow orchestration
- Standalone meeting recording or note-taking
- Basic VDR, CRM, or data connectors
- Generic source-cited research
- AI-generated decks, models, memos, or dashboards alone
- Generic institutional memory
- Broad “governed AI” positioning
- Autonomous KYC or compliance clearance
- A proprietary foundation-model strategy
- Expansion beyond sell-side M&A before the first bounded workflow is proven

These may be necessary capabilities, but our differentiation must be the supervisory and evidence layer above them.

## 5. Initial-partner definition of done

The initial partner should see one live or shadow sell-side workflow that demonstrates:

- Approved access to real or representative systems and data
- An authoritative workflow state with no duplicate manual tracker
- A successful path, exception path, rejected action, replay, and rollback
- Deterministic validation and source-level evidence
- Named human approval and release
- Customer-specific policy, WSP, records, and retention behavior
- Complete audit reconstruction
- Measured banker time, review burden, AI cost, rework, and NLVC
- A current-versus-target architecture and vendor-risk evidence room
- Pre-agreed success criteria, stop conditions, ownership, and escalation

## 6. Team actions

### Lance

- Convert the priorities above into a single pilot scope and acceptance criteria.

- Maintain the authoritative taxonomy crosswalk across the 81-step process, operating inventory, capability catalog, and skill catalog.

- Mark every capability as proposed, designed, built, tested, approved, deployed, or customer-accepted.

- Create owners, dependencies, evidence requirements, and target dates for every P0 and P1 control.

- Block pilot launch on unresolved security, permission, rollback, records, or human-release gates.

- Maintain a single decision, risk, exception, and remediation log.

### Engineering Team

- Implement the typed workflow and supervisory-evidence contracts first.

- Demonstrate permissions, isolation, deterministic validation, audit reconstruction, replay, rollback, and failure behavior before expanding feature breadth.

- Treat every model, agent, skill, connector, and policy as versioned and independently testable.

## 7. Immediate decision

Freeze broad feature expansion until the team can demonstrate one bounded sell-side workflow with authoritative state, explicit authority, complete evidence, human release, tested exceptions, replay, rollback, and measurable value.

The main product risk is not a shortage of ideas. It is failing to prove that Conductia safely controls the workflow layer competitors do not yet clearly own.
