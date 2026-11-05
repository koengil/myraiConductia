# Regulatory, Privacy and Security Signals — 2026-09

Status: distilled 2026-09-24 from Storm's monitoring-agent memo dated 2026-09-11.
Everything below comes from an AI-generated summary and is **UNVERIFIED**. Check the
primary source before building to it or quoting it to a customer.

Source: `99-source/04-product-direction-memo-2026-09-11.md`. Competitor movement
from the same memo is in `01-business/competitive-landscape.md` § 4.

## Regulatory signals

| Signal (as reported) | Status | What it asks of the product |
|---|---|---|
| SEC Investor Advisory Committee presentations (Sep 2026): machine-readable data, semantic structure, contextual metadata, validation, source traceability, confidentiality, cybersecurity, disclosure controls | **Not** a rule, safe harbor, or endorsement. It supports our architecture but does not require it | Source-level lineage on every output. Never describe it as SEC-mandated |
| Federal Reserve direction: controls proportionate to the institution, use case, and material risk | Supervisory direction | Risk-tiered controls: lighter for low-risk internal work, stronger for external or high-consequence actions |
| EU AI Act generally applicable since 2026-08-02 | Law, with conditional requirements for in-scope EU deployments | Map the obligation per deployment. Only applies if an EU deployment is in scope |
| FinCEN enforcement: risk-based CDD (customer due diligence), remediation, independent review, ongoing evidence | Enforcement trend | The KYC/CDD (know your customer / customer due diligence) screen needs retained evidence and independent review, not only a pass/fail result |
| SEC enforcement against an AI startup for unsupported claims (customers, partnerships, projections, valuation, product maturity) | Enforcement precedent | Sales and fundraising claims need evidence (see `01-business/competitive-landscape.md` § 4) |

The memo asks that these obligation families stay **distinct**, not blended into
one "compliance" check: SEC/FINRA, BSA/CIP/CDD (Bank Secrecy Act / customer
identification program / customer due diligence), CTA BOI (Corporate Transparency
Act beneficial ownership information), sanctions, privacy, EU AI Act, the
customer's WSP (written supervisory procedures), and firm policy.

## Buyer production standard

Goldman Sachs publicly described the gap between an impressive AI demo and a
product that works on its worst day. Institutional buyers expect:

- auditable grounding in sources
- firm-specific context
- explicit authority (who or what may act, and in whose name)
- source-level traceability
- human judgment at the release point
- reliable failure handling

## Security and privacy items the memo calls out

1. **Shared-credential exposure (P0, before any external testing).** The memo
   refers to "the known shared-credential exposure" and asks that it be closed
   through verified rotation, removal, approved storage, least privilege,
   revocation testing, and log review. It does not say which credential. **The
   owner and scope need to be confirmed with Storm or Lance.** Record it in
   `compliance-vulnerabilities.md` once identified.
2. **Entitlement-aware integrations (P1).** Connections to CRM, VDR, meeting,
   data, M365, and AI tools must keep the source system's permissions,
   contractual-use restrictions, provenance, and release control.
3. **Human release gates (P0).** No irreversible or external action without the
   required named approval.
4. **Supervisory evidence (P0).** Keep source lineage, policy version, model
   version, validations, reviewer, approval, release, exception, and the retained
   record for every action.
5. **Customer-specific records and retention.** The pilot must show the
   customer's own policy, WSP, records, and retention behavior, which may differ
   from our default retention rules.
