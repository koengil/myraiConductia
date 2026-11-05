# Rogo — architecture notes (competitive reference)

> **Provenance & status.** Compiled from a Slack thread: a team member ran Rogo's
> assistant ("Felix") through a set of architecture questions and shared the Q&A
> verbatim. This is **competitive reference material, point-in-time, and NOT a
> primary driver of Conductia's decisions.** Several answers are explicitly
> *architectural inference* (from Rogo's public docs / trust.rogo.ai), not stated
> SLAs — those are flagged inline. Kept here alongside `rogo-ui-findings.md` and
> `rogo-skills-inventory.md` because the "Not Rogo" thesis benefits from an
> accurate read of how Rogo actually works.

## Why this matters to us

Two patterns here are worth contrasting against our own design (not copying):
- **Hallucination control = retrieval-over-generation + mandatory citations.** Rogo
  pulls financial figures from structured sourced databases rather than model
  memory, and cites every response click-through. Relevant to how our data-room /
  work-product surfaces should treat any figure that lands in a memo or deck.
- **Connector permissions = query-time enforcement, no cached index.** Access is
  enforced at the provider per call (Microsoft Graph, Salesforce, Drive), so a
  revoked permission propagates on the next query. Relevant to our internal
  Deal Folder vs external Data Room access boundary (WS1).

---

## Q&A (verbatim, lightly formatted)

### Q: When I don't manually pick a provider, how does Rogo decide which model handles my query?
The specific internal routing logic isn't publicly documented, so no precise
decision-tree without speculating. What *is* documented: the **mode** you pick is
the primary input — five tiers (Instant, Fast, Pro, Deep Research, Felix), each
mapped to a class of task complexity. Under the hood it's a multi-model
orchestration layer over Anthropic, OpenAI, and Google, with Rogo's orchestration
on top; how it routes a given query between providers at runtime isn't disclosed.
In the Excel plugin you can override via a model picker (provider + tier); outside
the plugin that selection isn't user-facing. Practically: mode selection is how you
calibrate compute weight; sub-model routing within that is Rogo's proprietary logic.

### Q: If a provider is degraded or down, is there automatic failover to another lab?
Not covered in accessible documentation (failover behavior, redundancy, provider
SLAs), so no reliable yes/no without speculating. Confirmed answers would come from
the account team (uptime commitments under contract), trust.rogo.ai, or support.

### Q: What financial data sources are built in vs. what I need to connect myself?

**Built-in / ready with no user setup:**

| Source | Coverage | Refresh |
|---|---|---|
| SEC Filings (EDGAR) | 10-Ks, 10-Qs, 8-Ks, proxies, S-1s | every 15 min |
| Earnings Transcripts | earnings calls (S&P Global) | within 15 min of release |
| Investor Presentations | public company IR decks | every 15 min |
| International Filings | non-US/non-UK filings | regular |
| UK Companies House | UK regulatory filings | regular |
| Web | Rogo proprietary web index | continuous |

**Rogo-managed (no OAuth, but needs firm contract + admin enablement):** Capital IQ,
LSEG, PitchBook, Crunchbase, Third Bridge, Broker Research, Preqin, Daloopa (needs
Daloopa approval), Moody's (needs Moody's approval).

**Self-connect via OAuth (admin enables, then you authenticate):** FactSet,
SharePoint/OneDrive, Google Drive, Box, Egnyte, Salesforce, Outlook/Gmail, Teams,
Google Calendar, Notion.

Note: **CapIQ and FactSet are mutually exclusive.**

### Q: What's the story on hallucination control for financial figures specifically?
Addressed through architecture and auditability, not by claiming to eliminate it.
Two controls: (1) **retrieval over generation** — figures pulled from structured
sourced databases (CapIQ, FactSet, LSEG, EDGAR, S&P transcripts), a
retrieved-and-cited number being a different risk profile than a generated one;
(2) **mandatory citations** on every response, click-through to verify. Residual
risks Rogo acknowledges: context drift in long threads (start fresh threads),
third-party data discrepancies (click the citation to compare against source),
qualitative synthesis carrying more generation risk than quantitative retrieval,
and exhaustive "all/every" requests being inconsistent (use Screenings).
Non-negotiable per Rogo: click the citation on any figure going into a model,
deck, or memo.

### Q: How do connectors handle permission changes (e.g. someone loses SharePoint access)?
Documented: SharePoint integration is **query-time retrieval only — no index, no
stored files.** Every query calls Microsoft Graph API in the moment and inherits
your existing SharePoint permissions. Because there's no cached index, if someone
loses access, the next query hitting Graph gets denied on the updated permissions —
the change propagates the same way it does in SharePoint itself, not on a delayed
sync. (Docs don't say "real time" explicitly — this is an architectural inference.)
Same logic for Salesforce, Drive, OneDrive, Box: OAuth, credentials not stored,
access enforced at the provider per call. **One caveat:** OAuth token expiry — if a
token hasn't expired but underlying permissions were revoked, there could be a
window where Rogo holds a valid token for a deprovisioned account. Whether Rogo
revalidates per-query or relies on token expiry isn't documented — worth confirming.
