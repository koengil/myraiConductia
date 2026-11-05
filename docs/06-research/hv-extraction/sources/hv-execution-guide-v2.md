**Ignatious Sell-Side M&A\
Execution Guide**

**Status:** Working draft — steps may be added or removed; build responsibilities are a first take, to be validated jointly

**Note:** Please read with the companion document, Sell-Side M&A Master Process & Build Sequence, which lists every step in deal order with its build order.

# Background Information

**Regulatory wrapper:** Ignatious operates through Finalis Securities LLC (Member FINRA/SIPC), the broker-dealer of record — supervision, recordkeeping, and fee collection flow through it. Everything below sits inside that perimeter.

**What this document is:** The build guide behind the Master Process & Build Sequence. One block per step: what happens in that step, inputs → outputs, the systems it touches, its learning loop, its execution class (how autonomous the AI is allowed to be), and its compliance gate (what must be human-approved, logged, or walled).

**How to Read the Execution Class**

| **Code** | **Class** | **Meaning** |
|----|----|----|
| **A** | Fully agentic | The agent completes the step autonomously; reversible, internal, low-risk; fully logged. A human sees the result but does not gate it. |
| **A+H** | Agentic-led, human-in-the-loop | The agent does the work end-to-end; a banker reviews and approves before it is used, sent, or relied on. |
| **H+A** | Human-led, agentic check | A banker does the core work (judgment, build, negotiation); an agent checks, sources, or assists. |
| **H** | Fully human | Relationship, live judgment, or irreversible sign-off. Agents only observe to learn. |

**Governing rule:** reversible work can be automated with logs; anything irreversible, regulated, external, financial, or permission-changing requires a human approval on the record. Every class runs inside the runtime controls: per-agent budgets, step limits, loop detection, tool permissions, and a kill switch.

**Build Responsibility:** Operating System = built by the OS engineering team \| RTS = built by RTS at the application layer. Each block carries its team's build number; the 16 priority builds are marked in the companion Master Process document. All assignments are a first take — to be validated jointly.

Note, a Glossary at the end of this document is provided for the build team.

# Part 1: Horizontal Applications (Always-On)

**Deal Context:** Horizontal applications are platform services available to every workflow step and every deal — they are not part of the deal sequence itself. Built at the Operating System level. The last five are newly added; their ordering is provisional pending joint prioritization.

### Global: External-Send QC

**Phase:** Horizontal (always-on) \| **Build Responsibility:** Operating System \| **OS Build \#:** 1 \| **Execution Class:** A+H

**What Happens in This Step:** A quality-control (QC) agent checks every external email, deck, model, attachment, file name, and version before it leaves the firm. It runs four explicit verifications: (a) content for regulatory / legal / reputational compliance, including Regulation Fair Disclosure (Reg FD) and Financial Industry Regulatory Authority (FINRA) Rule 2210 promissory limits; (b) codenames used in place of real company names; (c) addressee correctness — right client for the deal, right content for the email, complete recipient list including cc/bcc, no wrong-document-to-wrong-party errors; and (d) hidden metadata, speaker notes, tracked changes, embedded comments, and prior-deal template leakage. A banker may invoke a rush-send override — rush mode verifies addressees only, with the content, codename, and metadata checks deferred and logged for supervisory review.

**Inputs → Outputs:** Every outbound artifact (email, deck, model, attachment) → pass/flag verdict; the banker clicks send.

**Systems:** Email / Outlook (M365), SharePoint, VDR (virtual data room; provider varies by deal).

**Learning Loop:** Logs QC outcomes, recurring defects, corrected versions, reviewer edits, template issues, and rush-bypass invocations and outcomes; feeds training and reusable checklists.

**Compliance Gate:** **No external send until the responsible banker confirms** accuracy, recipients, attachments, and that the artifact is free of material non-public information (MNPI). Rush bypass requires an affirmative banker click; the bypass and send are recorded in the supervisory log for after-the-fact review (Reg FD, FINRA 2210).

### Global: Pipeline CRM

**Phase:** Horizontal (always-on) \| **Build Responsibility:** Operating System \| **OS Build \#:** 3 \| **Execution Class:** A

**What Happens in This Step:** Auto-maintains the single firm-wide funnel report in the customer relationship management (CRM) system, built from banker actions and agent outputs rather than manual data entry. Every opportunity sits in one of six categories: Live lead, Won mandate, Lost mandate, Mandate hold, Terminated, or Died. The agent tracks outreach campaigns, responses, follow-ups, and meeting conversion, and enforces coverage discipline against the funnel.

**Inputs → Outputs:** Banker actions, CRM events, and agent outputs → a live, current funnel with dashboards.

**Systems:** HubSpot (CRM).

**Learning Loop:** Updates the funnel record on every banker action, CRM event, and agent output; surfaces dashboards at banker, deal-team, MD, and firm level; flags stale stages and duplicate outreach.

**Compliance Gate:** Records approved business communications; every entry is scrubbed against the restricted list; stale tasks and duplicate outreach are flagged.

### Global: Work-Check

**Phase:** Horizontal (always-on) \| **Build Responsibility:** Operating System \| **OS Build \#:** 4 \| **Execution Class:** A

**What Happens in This Step:** An automatic second set of eyes that runs against every primary-agent output before it reaches the banker. It checks internal consistency, citation completeness, numeric reasonableness, codename-map adherence, and tone versus the firm voice, and attaches advisory defect flags to anything it catches.

**Inputs → Outputs:** Every primary-agent output → advisory defect flags attached before banker review.

**Systems:** Operating System (agent runtime).

**Learning Loop:** Logs the first-pass failure rate per agent and common defect classes; feeds primary-agent prompt refinements and drives an internal regression suite.

**Compliance Gate:** Secondary defense only — the banker owns final disposition. Defects are logged in support of human supervisory review under Financial Industry Regulatory Authority (FINRA) Rule 3110.

### Global: Sector Intelligence

**Phase:** Horizontal (always-on) \| **Build Responsibility:** Operating System \| **OS Build \#:** 6 \| **Execution Class:** A

**What Happens in This Step:** Continuously maintains, across the entire tech sector, the four core research assets bankers draw on: Comparable Companies sets, Precedent Transactions tables, Market Maps ("digiscapes"), and Gartner-quadrant-equivalent competitive analyses. The library refreshes on a defined cadence (monthly), and every data point carries a source citation.

**Inputs → Outputs:** Public sector and market data → a refreshed, fully source-cited comps / precedents / market-map library ready for pitch and materials use.

**Systems:** Capital IQ, PitchBook.

**Learning Loop:** Updates the sector library, comp sets, precedent database, digiscapes, and competitive landscape; learns which sub-sector framings convert to pitches.

**Compliance Gate:** Public-source baseline; every set is screened against the conflict / restricted list before pitch use; private data is labeled and walled.

### Global: Multi-Model Verification

**Phase:** Horizontal (always-on) \| **Build Responsibility:** Operating System \| **OS Build \#:** 7 \| **Execution Class:** A+H

**What Happens in This Step:** Independent verification of every consequential AI output — financial models, valuations, fairness opinions, legal positions, communications adjacent to material non-public information (MNPI), and citations — by two or more alternate frontier models routed through a structured discrepancy-resolution process. The primary model generates; two alternate models independently regenerate or critique against the same sources; conflicts are diffed and severity-scored. Material discrepancies surface to the banker; non-material discrepancies are aggregated. The Operating System partially subsidizes cross-check compute initially.

**Inputs → Outputs:** Consequential AI outputs → a severity-scored discrepancy list, with material items escalated to the banker.

**Systems:** Operating System / multiple frontier model providers.

**Learning Loop:** Cross-check runs are logged per identity triplet — primary output, alternate outputs, discrepancy list, banker resolution; discrepancy patterns feed the Continuous Learning Agent and the Big Finance Benchmark.

**Compliance Gate:** Cross-check is advisory — **the banker resolves discrepancies and owns the final output**; cross-check budget caps are configured at the per-deal, per-workspace, and per-firm level.

### Global: Expert Panel Review

**Phase:** Horizontal (always-on) \| **Build Responsibility:** Operating System \| **OS Build \#:** 8 \| **Execution Class:** A+H

**What Happens in This Step:** Convenes simulated expert panels to red-team every consequential work product. Static panels: Legal & Regulatory, Product & Engineering, Process Experts, Writers / Editors / Storytellers, Persuasion & Sales, Negotiation Experts, Compliance & Risk, and a CCO (Chief Compliance Officer) Stand-In. Dynamic deal-specific panels: Sector / Sub-Sector Experts, Product-Domain Experts, Digital Twins of the counterparty board and management, and Client Psychology. Outputs are a structured critique per panel, a consolidated red-team verdict (PASS / REVISE / REWRITE), "how this lands in the room" predictions, and best-alternative-framing suggestions.

**Inputs → Outputs:** Client-facing work product → per-panel critiques plus a consolidated PASS / REVISE / REWRITE verdict.

**Systems:** Operating System.

**Learning Loop:** Panel critiques are logged into the supervisory archive; digital-twin construction uses only public information about the counterparty, and twins are deal-scoped and destroyed at deal close.

**Compliance Gate:** Advisory only. **No material non-public information (MNPI) ever flows into twin models**; twins are deal-scoped and destroyed at close; counterparty-psychology insights are confidential internal work product and are never disclosed externally.

### Global: Continuous Learning / Skill Optimization

**Phase:** Horizontal (always-on) \| **Build Responsibility:** Operating System \| **OS Build \#:** 10 \| **Execution Class:** A+H

**What Happens in This Step:** Captures completed-deal patterns, banker edits, outcomes, and banker feedback across every agent, and turns them into proposed prompt updates, template improvements, and weight adjustments to the other agents. This is the mechanism by which the whole agent fleet gets better with each deal rather than staying static.

**Inputs → Outputs:** Deal patterns, edits, outcomes, and banker feedback → proposed prompt / template / weighting improvements for partner review.

**Systems:** Operating System (skill and prompt library).

**Learning Loop:** Updates the skill library, prompt versions, and template ranks; produces a quarterly Agent Performance Review for partner sign-off.

**Compliance Gate:** Separates client-confidential data from generalized learning; **a partner must approve any reusable pattern before adoption**; no cross-tenant training.

### Global: Deal Workflow Coordinator

**Phase:** Horizontal (always-on) \| **Build Responsibility:** Operating System \| **OS Build \#:** 11 \| **Execution Class:** A

**What Happens in This Step:** The orchestration layer, built on a coordinator pattern — not autonomous command. It routes tasks across agents, holds deal-state per identity triplet (Tenant:Client:Deal:User), monitors agent health and SLA (service-level agreement) compliance, escalates blocked agents, and aggregates outputs into a deal-team dashboard.

**Inputs → Outputs:** Agent tasks and deal-state events → routed work, SLA monitoring, and a live deal-team dashboard.

**Systems:** Operating System.

**Learning Loop:** Logs end-to-end latency per stage, agent-handoff failures, and deal-state drift; identifies bottleneck agents.

**Compliance Gate:** Respects the identity triplet and information-wall status on every routing decision; no cross-deal data bleed.

### Global: Document Retention + Permission Cross-Check

**Phase:** Horizontal (always-on) \| **Build Responsibility:** Operating System \| **OS Build \#:** 12 \| **Execution Class:** H+A

**What Happens in This Step:** Inventories every document created by every agent and banker, tagging each with a record category, retention category, and supervisory significance. It cross-checks every deletion request against regulatory retention requirements — Financial Industry Regulatory Authority (FINRA) Rule 4511 and Securities and Exchange Commission (SEC) Rules 17a-3 and 17a-4 — before anything can be removed. Deletion is dual-control: human approval AND the regulatory check must both pass.

**Inputs → Outputs:** Every firm record and deletion request → tagged retention inventory plus approved/blocked deletion decisions.

**Systems:** SharePoint (M365), VDR (virtual data room; provider varies by deal).

**Learning Loop:** Updates the retention database, the deletion-request log, and the regulatory mapping.

**Compliance Gate:** **No deletion without dual-control approval — a human must co-approve alongside the regulatory check**; 17a-4 / audit-trail-alternative routing; chain-of-custody preserved.

### Global: License / U4 / CE Compliance Tracker

**Phase:** Horizontal (always-on) \| **Build Responsibility:** Operating System \| **OS Build \#:** 13 \| **Execution Class:** A

**What Happens in This Step:** Tracks each banker's Financial Industry Regulatory Authority (FINRA) license status, the currency of their Form U4 (the securities-industry registration form that must be amended when a banker's circumstances change), continuing-education (CE) completion, and internal certifications. Alerts both the banker and the CCO (Chief Compliance Officer) ahead of deadlines and on remediation requirements.

**Inputs → Outputs:** Banker registration, U4, and CE records → a compliance dashboard with deadline and remediation alerts.

**Systems:** Compliance / CCO Console dashboard on the Operating System.

**Learning Loop:** Updates the banker compliance dashboard, expiration alerts, and CE completion log; identifies systemic CE gaps across the firm.

**Compliance Gate:** Broker-dealer compliance requirement; surfaced on the CCO Console; data is banker-private with CCO visibility.

### Global: MD-Style Review

**Phase:** Horizontal (always-on) \| **Build Responsibility:** Operating System \| **OS Build \#:** 14 \| **Execution Class:** A+H

**What Happens in This Step:** Applies the named Managing Director's (MD's) prior approved voice — sentence cadence, opening style, hallmark phrases, and prohibited phrases — to drafts before they reach the MD for review. The goal is that work product arrives already sounding like the MD who will sign it, cutting review cycles.

**Inputs → Outputs:** Draft documents → styled drafts in the named MD's approved voice; the MD owns the final version.

**Systems:** Operating System (per-MD style library).

**Learning Loop:** Learns each MD's voice from approved Confidential Information Memorandums (CIMs), pitches, and emails (opt-in by MD); rejected edits feed back into the style library.

**Compliance Gate:** Opt-in per MD; tenant-isolated; never trains cross-MD or cross-firm; output is advisory — **the MD owns the final draft**.

### Global: Knowledge Graph / Relationship Strength

**Phase:** Horizontal (always-on) \| **Build Responsibility:** Operating System \| **OS Build \#:** 15 \| **Execution Class:** A

**What Happens in This Step:** Builds a relationship graph across people and organizations, with each connection strength-scored on contact frequency, response rate, introduction success, and history. Uses a Pally integration for graph completeness, with CRM (customer relationship management), calendar, and email metadata supplying the signal. The output is warm-path discovery: who at the firm actually knows the person a deal needs to reach.

**Inputs → Outputs:** CRM, calendar, and email metadata → a scored who-knows-whom graph with warm-path discovery.

**Systems:** HubSpot (CRM), M365 calendar and email metadata, Pally.

**Learning Loop:** Updates the relationship graph, introduction-success metrics, banker-relationship-density scores, and warm-path discovery.

**Compliance Gate:** Privacy-aware — no email-content scanning by default; permission-aware retrieval; each banker controls the visibility of their own contacts.

### Global: Negotiation Copilot

**Phase:** Horizontal (always-on) \| **Build Responsibility:** Operating System \| **OS Build \#:** 16 \| **Execution Class:** H+A

**What Happens in This Step:** The banker negotiates; the agent assists. It suggests counter positions, justifications drawn from market precedent, and anticipated counterparty responses across the deal's negotiated documents: engagement letters, non-disclosure agreements (NDAs), Letters of Intent (LOIs), definitive-agreement representations, escrow, and earnouts.

**Inputs → Outputs:** Live negotiation positions and document terms → suggested counters with precedent-backed justifications and anticipated counterparty responses.

**Systems:** Operating System, negotiation precedent database.

**Learning Loop:** Updates the negotiation precedent database, banker-success-by-position scoring, and counterparty behavior profiles; continuously learns from all deals and bankers, anonymized cross-firm via the Operating System.

**Compliance Gate:** Advisory only; **no autonomous response to a counterparty — the banker conducts the negotiation**; cross-firm patterns are anonymized.

### Global: Workflow Monitoring

**Phase:** Horizontal (always-on) \| **Build Responsibility:** Operating System \| **OS Build \#:** 17 \| **Execution Class:** A

**What Happens in This Step:** Opt-in instrumentation (Mimica / Worktrace style) that observes how bankers actually work. It captures repetitive workflow patterns, surfaces agent-candidate suggestions to the product team, and can auto-generate first-pass agent specifications for review — turning observed drudgery into the backlog for the next round of builds.

**Inputs → Outputs:** Opt-in workflow telemetry → a repetitive-pattern heat-map and an agent-candidate backlog with ROI (return-on-investment) estimates.

**Systems:** Operating System (instrumentation layer).

**Learning Loop:** Updates the workflow heat-map and agent-candidate backlog; learns which patterns automate well; produces an ROI estimate per candidate.

**Compliance Gate:** **Affirmative opt-in only, and the banker can pause or stop monitoring at any time**; no individual-level HR monitoring.

### Global: File Storage Reorganization

**Phase:** Horizontal (always-on) \| **Build Responsibility:** Operating System \| **OS Build \#:** 18 \| **Execution Class:** A+H

**What Happens in This Step:** Analyzes the current SharePoint / Drive / iManage structure, naming conventions, and access patterns, then proposes reorganization options designed for both human and AI retrieval. It asks the banker, partner, or CCO (Chief Compliance Officer) which option to implement, and executes the chosen reorganization with permissions preserved throughout.

**Inputs → Outputs:** Existing file structure, naming, and access patterns → proposed reorg options; the selected option executed with permissions intact.

**Systems:** SharePoint (M365), Google Drive, iManage.

**Learning Loop:** Logs filing-pattern adherence, search-success rate, and retrieval-time deltas; refines the structure quarterly.

**Compliance Gate:** **Executes only the option a banker / partner / CCO selects, and no file deletions during reorg**; permissions preserved at every move; full audit trail of every move.

### Global: Fee Structure Pool

**Phase:** Horizontal (always-on) \| **Build Responsibility:** Operating System \| **OS Build \#:** 21 \| **Execution Class:** A

**What Happens in This Step:** Pools fee structures across all the Operating System-customer firms anonymously: transaction type, size band, retainer, success fee percentage, minimum fee, tail, and expense terms. No firm or deal identifier is preserved. The result is percentile fee benchmarks by transaction type and size that individual firms could never assemble alone.

**Inputs → Outputs:** Anonymized cross-firm fee structures → percentile benchmark bands by transaction type and size band.

**Systems:** Operating System (cross-firm pooling infrastructure).

**Learning Loop:** Updates the anonymized fee pool, percentile bands by transaction type and size, and trends over time; feeds the Engagement Economics Agent at every customer firm.

**Compliance Gate:** Anonymization at ingestion; no firm or deal ID stored; cross-firm pooling is subject to customer consent. Operating System only — not built at Ignatious.

### Global: Enterprise Search

**Phase:** Horizontal (always-on) \| **Build Responsibility:** Operating System \| **OS Build \#:** 23 \| **Execution Class:** A

**What Happens in This Step:** A permission- and barrier-aware retrieval service over the firm's corpus — documents, emails, CRM records, data-room contents, and prior work product. Answers natural-language questions with cited sources and assembles context for other agents, so no application searches from scratch. The system can show that a document exists while withholding its contents until the user is permissioned.

**Inputs → Outputs:** Natural-language query or agent context request → cited, permission-filtered results and assembled context.

**Systems:** SharePoint (primary store), Box, M365 email, CRM, data rooms; the OS search index.

**Learning Loop:** Logs query patterns, retrieval quality, and missing-content gaps; improves ranking and the firm's context map.

**Compliance Gate:** Every query is permission-checked against deal walls and code names; all queries and retrievals are logged in retainable form.

### Global: Model Optimization

**Phase:** Horizontal (always-on) \| **Build Responsibility:** Operating System \| **OS Build \#:** 24 \| **Execution Class:** A

**What Happens in This Step:** Routes every task to the most cost-effective model that clears the quality bar for that task — high-stakes work runs on frontier models with critique-looping (a second model reviews and the first improves); routine work runs on cheaper models. Tracks token usage and cost by user, deal, task, and agent, with budget caps at each level.

**Inputs → Outputs:** Task + sensitivity/quality profile → model selection, executed run, and full cost attribution.

**Systems:** The OS model-routing layer; all connected model providers.

**Learning Loop:** Learns quality-per-cost by task type; refines routing rules; feeds the cost dashboard.

**Compliance Gate:** Approved-model list only; no client data to unapproved models; budget caps escalate before overrun; every call logged.

### Global: Data Room Hosting

**Phase:** Horizontal (always-on) \| **Build Responsibility:** Operating System \| **OS Build \#:** 25 \| **Execution Class:** A+H

**What Happens in This Step:** A hosted, permissioned data-room layer (Box) sitting above SharePoint: folder taxonomy, file tagging by deal and sensitivity, staged buyer access, watermarking, and AI-readable APIs so applications can read and organize files without breaching the compliance perimeter. Serves as the working file surface for the build (example files in, skill outputs out).

**Inputs → Outputs:** Firm/deal files + permission rules → organized, tagged, API-accessible data room.

**Systems:** Box (hosting layer), SharePoint (system of record), the OS permission service.

**Learning Loop:** Logs access patterns and folder-taxonomy adherence; refines structure and tagging rules.

**Compliance Gate:** **Access changes are banker-approved**; buyer segregation enforced; every view and permission change logged (GDPR/SOC 2 posture inherited from Box).

### Global: Communication Checking

**Phase:** Horizontal (always-on) \| **Build Responsibility:** Operating System \| **OS Build \#:** 26 \| **Execution Class:** A

**What Happens in This Step:** The communications-compliance layer (Global Relay / Smarsh): captures and archives business communications across approved channels, runs surveillance rules, and flags exceptions to compliance. Works alongside External-Send QC — QC gates outbound quality before send; this layer preserves and surveils the record.

**Inputs → Outputs:** Business communications across approved channels → archived, searchable, surveilled record with exception flags.

**Systems:** Global Relay or Smarsh, M365 email, approved messaging channels.

**Learning Loop:** Logs exception patterns; tunes surveillance rules; feeds supervisory reporting.

**Compliance Gate:** FINRA 3110 supervision and 2210 communications obligations; SEC 17a-4 retention; exceptions route to compliance/CCO.

### Global: Staffing

**Phase:** Horizontal (always-on) \| **Build Responsibility:** Operating System \| **OS Build \#:** 27 \| **Execution Class:** H+A

**What Happens in This Step:** Assigns bankers and agents to mandates and tracks deal-team capacity across live deals. Humans make staffing decisions; the agent recommends allocations from workload, skills, and pipeline, flags over-allocation, and checks proposed staffing against information walls and conflicts.

**Inputs → Outputs:** Live mandates + team capacity → staffing recommendations, capacity dashboard, wall-checked assignments.

**Systems:** CRM/pipeline, the OS permission service, staffing tracker.

**Learning Loop:** Learns effort-per-deal-stage patterns; improves capacity forecasts.

**Compliance Gate:** Staffing decisions are human-made; wall/conflict check on every proposed assignment; assignment history logged.

# Part 2: Chronological Deal Process (Seq 1 → 65)

## Phase 1: Origination, Qualification & Mandate

**Deal Context:** Nothing signed yet — find and vet the opportunity, research the company and buyers, win the mandate, and sign the Engagement Letter (EL).

### Seq 1: Target Universe

**Phase:** 1 \| **Build Responsibility:** RTS \| **RTS Build \#:** 13 \| **Execution Class:** A+H

**What Happens in This Step:** The application defines the firm's market thesis and coverage universe — where the next mandates will come from. It specifies priority sectors and subsectors, geography, ownership profile, growth metrics, strategic pressure points, buyer themes, and likely exit triggers, and flexes those criteria by company quality and Ignatious mandate fit. The result is a prioritized target list with thesis tags and outreach priorities, every data point source-cited, which a banker reviews before it drives any coverage activity.

**Inputs → Outputs:** Sector and company screening data → prioritized target lists with thesis tags, source citations, and outreach priorities.

**Systems:** Capital IQ, PitchBook, HubSpot (CRM).

**Learning Loop:** Creates and maintains the sector universe, target lists, thesis tags, and outreach priorities, and learns which market theses actually generate meetings and mandates.

**Compliance Gate:** Public-source data only unless use of other sources is authorized; estimates labeled as estimates; restricted-list and conflicted entities excluded from every target list.

### Seq 2: Exit Readiness

**Phase:** 1 \| **Build Responsibility:** RTS \| **RTS Build \#:** 14 \| **Execution Class:** A+H

**What Happens in This Step:** The application scores which companies in the universe are most likely to sell soon — seller propensity. Signals scored include funding history, sponsor (private-equity owner) hold period, founder and board dynamics, capital needs, strategic pressure, growth and margin profile, known inbound interest, and timing catalysts. Each scored company carries a timing hypothesis and likely sale rationale so bankers can sequence outreach toward the ripest opportunities; a banker reviews the scoring before acting on it.

**Inputs → Outputs:** Funding, ownership, and pressure signals per company → seller-propensity score with timing hypothesis, likely rationale, banker owner, and next action.

**Systems:** Capital IQ, PitchBook, HubSpot (CRM).

**Learning Loop:** Updates seller-propensity scores, timing hypotheses, likely rationales, banker owners, and next actions, and learns from conversion outcomes which signals actually predict a sale.

**Compliance Gate:** Public signals kept separate from confidential observations; source provenance preserved on every signal; output framed strictly as decision support, not a determination.

### Seq 3: Acquirer Strategy

**Phase:** 1 \| **Build Responsibility:** RTS \| **RTS Build \#:** 15 \| **Execution Class:** A+H

**What Happens in This Step:** The mirror image of Exit Readiness: the application identifies companies likely to buy, and the likely targets for each buyer. For each acquirer it maps product gaps, M&A (mergers and acquisitions) history, capital capacity, strategic priorities, corporate-development contacts, and stated or inferred acquisition criteria. This buyer-propensity map seeds later buyer-universe work and gives bankers a defensible, source-cited answer to "who would buy this company and why"; a banker reviews before the map informs outreach.

**Inputs → Outputs:** Buyer M&A history, capital capacity, and strategic-priority data → likely-buyer list with targets-per-buyer map, acquisition criteria, and corp-dev contacts.

**Systems:** Capital IQ, PitchBook.

**Learning Loop:** Updates the buyer universe, sponsor and strategic appetite profiles, target categories, past-acquisition records, contact quality, and outreach paths.

**Compliance Gate:** Conflict and restricted-list screening on every buyer; confidential buyer preferences respected; all rationale source-cited.

### Seq 4: Lead Registration

**Phase:** 1 \| **Build Responsibility:** Operating System \| **OS Build \#:** 2 \| **Execution Class:** A

**What Happens in This Step:** The moment a lead arrives — inbound, referral, or MD-originated — the application registers it immediately (target: within 24 hours) with source, referrer, company, transaction type, status, estimated size, confidentiality level, and lead owner. It creates the lead record, source attribution, referrer record, and company/contact profile, and writes the entry into the Pipeline CRM (customer relationship management) funnel under "Live lead." This runs fully agentically because it is internal, reversible, and logged; the banker sees the result but does not gate it.

**Inputs → Outputs:** Inbound lead, referral, or MD-originated opportunity → registered lead record in the funnel with source, owner, size, and confidentiality level, within 24 hours.

**Systems:** HubSpot (CRM).

**Learning Loop:** Creates the lead record, source attribution, referrer record, and company/contact profile; builds lead-source analytics; writes to the Pipeline CRM funnel under Live lead.

**Compliance Gate:** Lead registration is mandatory for every lead; the record labels prospect vs. client and flags solicitation, restricted-list, and confidentiality issues at intake.

### Seq 5: Source Intelligence

**Phase:** 1 \| **Build Responsibility:** RTS \| **RTS Build \#:** 2 \| **Execution Class:** A+H

**What Happens in This Step:** When a lead comes through a referrer or supporter, the application captures everything that person knows: the client's goals, the decision-makers, the decision criteria, stakeholder sensitivities, supporters and detractors, which competing banks are in the picture, the estimated win probability, and the best path to the mandate. This converts an informal tip into a structured pursuit brief; a banker reviews the capture before it shapes pitch strategy.

**Inputs → Outputs:** Referrer/supporter conversations → structured intelligence record: client goals, decision criteria, stakeholder map, competing banks, win probability, and path to mandate.

**Systems:** HubSpot (CRM).

**Learning Loop:** Updates the relationship map, stakeholder map, pitch strategy, and supporter follow-up tasks, and feeds the win/loss learning dataset.

**Compliance Gate:** Supporter commentary treated as confidential; opinion explicitly separated from fact; sensitive relationship information protected.

### Seq 6: Conflicts Checklist

**Phase:** 1 \| **Build Responsibility:** Operating System \| **OS Build \#:** 9 \| **Execution Class:** H+A

**What Happens in This Step:** Before anyone reviews private information, a conflicts check runs covering the restricted list, existing NDAs (non-disclosure agreements), board roles, and prior engagements. Today this is a deliberately human-led manual checklist — Ignatious handles conflicts manually, and v9 deprioritized automation here because AI leverage is higher elsewhere first — with the agent assembling the checklist and evidence while the banker and compliance make the determination. the Operating System later productizes this as a full conflicts engine. Unresolved issues are escalated rather than judged by the agent.

**Inputs → Outputs:** Company, counterparties, and firm history → completed conflicts/restricted-list check with status, walling notes, and required approvals — before any private information is reviewed.

**Systems:** Compliance restricted list, HubSpot (CRM).

**Learning Loop:** Updates the conflict log, check status, walling notes, required approvals, and restricted-party flags.

**Compliance Gate:** **Unresolved conflicts must route to a senior banker, compliance, or legal — and be resolved — before any private information review; the human/compliance decision gates the step, not the agent.**

### Seq 7: Codename / Deal Shell

**Phase:** 1 \| **Build Responsibility:** Operating System \| **OS Build \#:** 5 \| **Execution Class:** A+H

**What Happens in This Step:** Once the opportunity is real enough to hold confidential material, the application assigns a preliminary codename and creates the deal shell: the workspace folder structure, the early access list (who may know the deal exists), the confidentiality level, and the allowed document categories. It also generates the project code, permission record, audit identifier, and initial deal checklist. From this point forward the codename — not the real company name — is what appears in communications and file names; a banker approves the shell configuration.

**Inputs → Outputs:** Qualified opportunity → codename, deal shell with folder structure, early access list, confidentiality level, allowed document categories, and audit identifier.

**Systems:** SharePoint (M365), HubSpot (CRM).

**Learning Loop:** Creates the project code, folder shell, permission record, audit identifier, and initial deal checklist that downstream agents inherit.

**Compliance Gate:** The codename is not a substitute for canonical identity — real identities remain access-controlled and logged; every permission on the shell is explicit and auditable.

### Seq 8: Relationship Pathing

**Phase:** 1 \| **Build Responsibility:** RTS \| **RTS Build \#:** 1 \| **Execution Class:** A+H

**What Happens in This Step:** The application maps who actually decides and who can open the door: decision makers, influencers, board members, investors, corporate-development contacts, CEOs/CFOs, sponsor partners, existing Ignatious and banker relationships, warm paths, and the best introducers. For founder-led or VC (venture capital)-backed sellers it builds an explicit board/investor alignment map, since those stakeholders can approve or kill a sale independently of management. A banker reviews the paths before any approach is made.

**Inputs → Outputs:** Company ownership, board, and contact data → decision-maker/influencer map with warm paths, best introducers, and board/investor alignment map.

**Systems:** HubSpot (CRM), Knowledge Graph / Relationship Strength application (horizontal, OS Build \#15).

**Learning Loop:** Updates CRM contacts, the relationship graph, intro paths, confidence levels, missing fields, and relationship owners; feeds the firm-wide Knowledge Graph.

**Compliance Gate:** Privacy-aware and permitted-source only; the confidence and source of every relationship claim is logged.

### Seq 9: MD Briefing + Company Backgrounding

**Phase:** 1 \| **Build Responsibility:** RTS \| **RTS Build \#:** 3 \| **Execution Class:** A+H

**What Happens in This Step:** Before the MD (Managing Director) walks into the first call, the application produces one document with three layers. First, the MD brief up front: call objectives, questions to ask, relationship context, and the qualification score. Second, a source-cited company profile: product, business model, customers, ownership, investors, financings, board and management, competitors, likely buyers, valuation indicators, and transaction rationale. Third, Relevant Past Deals — expanded in v9 to full detailed case studies rather than just contacts and multiples: process arc, value-creation thesis, fee economics where disclosable, buyer dynamics, and lessons applied — ranked by relevance (deals with the target firm's prior bankers first, then same sub-sector, then same sector). An "If they ask about X" cross-reference pairs each likely objection the target might raise with the precedent that answers it. The MD reviews the document before use.

**Inputs → Outputs:** Public and internal data on the company → single briefing document: MD brief + source-cited company profile + ranked detailed case studies with objection cross-references.

**Systems:** Capital IQ, PitchBook, HubSpot (CRM); pulls from the Case Study Library application (Seq 18, RTS Build \#11).

**Learning Loop:** Updates the company record, sector tags, financing history, buyer hypotheses, presearch archive, and past-deal callback database, and learns MD briefing patterns over time.

**Compliance Gate:** Public data separated from banker/client-confidential data; every claim source-cited; estimates flagged; past-deal content passes a client-confidentiality scrub before reuse.

### Seq 10: Meeting Intelligence

**Phase:** 1 \| **Build Responsibility:** RTS \| **RTS Build \#:** 16 \| **Execution Class:** A+H

**What Happens in This Step:** At the start of the first client meeting, the client is asked whether AI note-taking is permitted. If yes, the AI takes notes or a transcript per the consent terms; if no, the MD (Managing Director) sends their own notes to the agent after the meeting for structured capture. Either way, the application summarizes issues raised, financials discussed, timing, strategic rationale, buyer mentions, sensitivities, and next actions, and turns them into CRM activity, contacts, tasks, relationship notes, and deal facts. The banker reviews the structured output before it is relied on.

**Inputs → Outputs:** Consent-gated meeting capture (or MD notes) → structured summary with deal facts, sensitivities, action items, and CRM updates.

**Systems:** Meeting notes/transcription tooling, HubSpot (CRM), Client Consent Tracker.

**Learning Loop:** Updates CRM activity, contacts, tasks, relationship notes, and deal facts; records the consent decision into the Client Consent Tracker.

**Compliance Gate:** **AI-notes consent must be asked and recorded at meeting start — no capture without it**; transcript is kept distinct from AI summary; sensitive notes privileged as needed.

### Seq 11: Deal Qualification

**Phase:** 1 \| **Build Responsibility:** RTS \| **RTS Build \#:** 17 \| **Execution Class:** H+A

**What Happens in This Step:** The go/no-go decision. The agent scores mandate fit across eight dimensions — fee potential, transaction likelihood, banker credibility in the space, strategic relevance to the firm, conflicts, resource burden, reputation risk, and ability to win — and produces a pursue/pass recommendation with reasons. The scoring is decision support only: this step is human-led, and a senior banker makes the actual pursue/pass call on the record.

**Inputs → Outputs:** Opportunity profile and firm context → qualification score with go/no-go recommendation and documented pursue/pass reasons.

**Systems:** HubSpot (CRM).

**Learning Loop:** Updates the qualification score, go/no-go recommendation, and pursue/pass reasons, building a learning dataset that sharpens future qualification.

**Compliance Gate:** **Senior banker approval required for every pursue/pass decision — the agent recommends, the senior banker decides**; the confidential rationale is protected.

### Seq 12: Client NDA Workflow

**Phase:** 1 \| **Build Responsibility:** RTS \| **RTS Build \#:** 5 \| **Execution Class:** A+H

**What Happens in This Step:** Before the firm can request the company's private documents, an NDA (non-disclosure agreement) or confidentiality arrangement is put in place where required. The application prepares the NDA workflow, compares the draft against firm precedent to flag non-standard terms, and tracks execution status so that no private-document request goes out before the NDA is signed. Executed documents and the resulting permitted information categories are archived; a banker approves before anything is sent to the client.

**Inputs → Outputs:** Client NDA need → prepared and precedent-compared NDA with tracked execution status and archived executed document, gating any private-document request.

**Systems:** Word (M365) / contract templates; executed-document archive in SharePoint.

**Learning Loop:** Updates NDA status, versions, the executed-document archive, and the permitted information categories that downstream requests must respect.

**Compliance Gate:** Legal review required for non-standard terms; **no private document request before NDA execution where an NDA is required**.

### Seq 13: Initial Diligence Request List

**Phase:** 1 \| **Build Responsibility:** RTS \| **RTS Build \#:** 6 \| **Execution Class:** A+H

**What Happens in This Step:** Once the NDA (non-disclosure agreement) is executed, the application drafts the initial diligence request list — the first formal ask for the company's internal information. It pulls from sector-specific templates and adapts to company size, type, and transaction type, covering financial, legal, HR (human resources), customer/commercial, IP (intellectual property), regulatory, technology, and ESG (environmental, social, and governance) categories. The list categorizes sensitive vs. general information up front so the company can stage what it shares; a banker reviews the list before it is sent.

**Inputs → Outputs:** Sector-specific templates + company profile → tailored initial diligence request list, sent to the company only after NDA execution.

**Systems:** Word (M365), diligence-template library.

**Learning Loop:** Updates the diligence-template library, recurring missing-item patterns, and company-response timing to sharpen future request lists.

**Compliance Gate:** No request before NDA execution; **banker review and approval before the list is sent**; sensitive vs. general information categorized up front.

### Seq 14: Outreach Strategy

**Phase:** 1 \| **Build Responsibility:** RTS \| **RTS Build \#:** 4 \| **Execution Class:** A+H

**What Happens in This Step:** For each target person and company, the application recommends the best approach and messaging hypothesis: a CEO narrative, a CFO economics case, a sponsor (private-equity investor) thesis, a board angle, and the market-timing argument. It anticipates each person's likely objections and produces a personalized outreach sequence per contact. The point is that a CEO, a CFO, a board member, and a sponsor each respond to different arguments, so the same company is approached with different messages depending on who is being contacted.

**Inputs → Outputs:** Persona and company data from the CRM and Relationship Pathing → per-person approach, angle, likely objections, and a personalized outreach sequence.

**Systems:** HubSpot/CRM.

**Learning Loop:** Stores outreach hypotheses, message variants, persona insights, and response outcomes; over time it learns which language works by sector and by persona.

**Compliance Gate:** Pre-send review on all outreach; no misleading transaction claims; no disclosure of MNPI (material non-public information); **banker approval required before any outreach is sent**.

### Seq 15: Strategy / SWOT

**Phase:** 1 \| **Build Responsibility:** RTS \| **RTS Build \#:** 20 \| **Execution Class:** A+H

**What Happens in This Step:** Builds the strategic analysis that underpins the pitch: a company SWOT (Strengths, Weaknesses, Opportunities, Threats), the strategic alternatives available to the client, the "why sell (or buy) now" argument, likely buyer theses, market timing, risk issues, valuation drivers, and a recommended process strategy. This is the analytical backbone the rest of the pitch narrative hangs on.

**Inputs → Outputs:** Company and market data → strategy memo covering SWOT, strategic alternatives, why-sell-now rationale, buyer theses, valuation drivers, and recommended process strategy.

**Systems:** Capital IQ for market and company data; memo drafted in M365 (Word).

**Learning Loop:** Updates the strategy memo, pitch narrative, diligence questions, and positioning library; captures lessons learned once the pitch outcome is known.

**Compliance Gate:** Every claim source-cited; hypotheses clearly separated from facts; **the MD (Managing Director) approves the narrative before it is used**.

### Seq 16: Stakeholder Psychology

**Phase:** 1 \| **Build Responsibility:** RTS \| **RTS Build \#:** 21 \| **Execution Class:** A+H

**What Happens in This Step:** Maps each individual stakeholder — CEO, CFO, board members, investors, advisors — on decision style, anxieties, desired outcome, status concerns, timing pressure, likely objections, and what Ignatious must prove to win their support. Produces an explicit board/investor alignment map for founder-led or VC-backed sellers, where the people who must approve the mandate may want different outcomes. The output shapes who says what in the pitch room and which concerns get addressed head-on.

**Inputs → Outputs:** Stakeholder data from the CRM and prior source intelligence → decision-style / anxiety / objection map plus a board–investor alignment map.

**Systems:** HubSpot/CRM.

**Learning Loop:** Updates the pitch strategy, talking points, objection handling, and supporter plan; feeds the win/loss learning dataset.

**Compliance Gate:** Confidential internal use only; the application must avoid manipulative or misleading claims; **a senior banker controls how the analysis is used**.

### Seq 17: Buyer Universe

**Phase:** 1 \| **Build Responsibility:** RTS \| **RTS Build \#:** 9 \| **Execution Class:** A+H

**What Happens in This Step:** Before the pitch, constructs a detailed universe of both strategic buyers (corporate acquirers) and sponsors (private-equity buyers): the best buyers, the rationale for each, their acquisition history, contacts, existing relationships, access paths, ability to pay, and likelihood to engage. Showing a credible, ranked buyer list in the pitch demonstrates that Ignatious already knows who will buy the company and how to reach them. The universe is drafted here in Phase 1; the approved buyer list is finalized during Phase 2 preparation.

**Inputs → Outputs:** Strategic and sponsor screening data → ranked buyer universe with per-buyer rationale, contacts, access paths, ability-to-pay assessment, and likelihood-to-engage score.

**Systems:** Capital IQ, PitchBook, HubSpot/CRM.

**Learning Loop:** Updates the buyer database, sponsor map, contact quality, banker relationship ownership, intro paths, and the buyer-fit score.

**Compliance Gate:** Conflict and restricted-party screening on every name; **no confidential outreach to any buyer before the mandate is won and the client approves**.

### Seq 18: Case Study Library

**Phase:** 1 \| **Build Responsibility:** RTS \| **RTS Build \#:** 11 \| **Execution Class:** A

**What Happens in This Step:** Maintains a five-tier ranked library of deal case studies: Tier 1 — Ignatious deals done with the target firm's prior bankers; Tier 2 — Ignatious deals in the same sub-sector; Tier 3 — Ignatious deals in the same sector; Tier 4 — curated external precedents in the same sub-sector; Tier 5 — curated external precedents in the same sector. It proactively surfaces the 3–5 highest-tier matches on every MD Briefing, Outreach Strategy run, Buyer Universe construction, and pitchbook draft. Each case study is a full payload — process arc, value-creation thesis, fee economics where disclosable, buyer dynamics, lessons applied — not a tombstone (the one-line deal credential).

**Inputs → Outputs:** Firm deal history plus curated external precedents → 3–5 highest-relevance case studies surfaced automatically into briefings and pitch materials.

**Systems:** Internal deal database (SharePoint/M365).

**Learning Loop:** Continuously expands — every closed Ignatious deal becomes a structured case-study entry drawing from the Win/Loss Debrief, Deal Learning, and Transaction Marketing / Asset Library agents; external precedents feed in from Sector Intelligence.

**Compliance Gate:** **Client consent verified via the Client Approval Tracker before any Ignatious deal is used externally**; confidentiality scrub on every external precedent before pitch use.

### Seq 19: Engagement Economics

**Phase:** 1 \| **Build Responsibility:** RTS \| **RTS Build \#:** 18 \| **Execution Class:** A+H

**What Happens in This Step:** Before the pitch deck is built, analyzes what the firm should propose to charge: fee structure, retainer (the monthly fee), success fee, minimum fee, tail (the post-termination period during which a sale still owes a fee), expense terms, fairness-opinion fee, and the likely negotiation points. It pulls the firm's own fee history plus cross-firm anonymized benchmarks from the Fee Structure Pool (horizontal, OS Build \#21 — a platform-level anonymized data pool), so proposed economics are grounded in precedent rather than guesswork.

**Inputs → Outputs:** Firm fee history plus anonymized pool benchmarks → proposed fee / retainer / success-fee / tail structure with rationale and accepted/fallback positions.

**Systems:** Fee precedent database, the Operating System Fee Structure Pool feed, Excel.

**Learning Loop:** Updates the fee precedent database, proposal ranges, economics rationale, and accepted/fallback positions; learns from fee-related win/loss outcomes.

**Compliance Gate:** **Legal / commercial review before proposed economics are used**; deviations from firm-standard terms are tracked.

### Seq 20: Engagement Letter Strategy

**Phase:** 1 \| **Build Responsibility:** RTS \| **RTS Build \#:** 19 \| **Execution Class:** A+H

**What Happens in This Step:** Drafts the structure and key provisions of the EL (Engagement Letter — the contract that hires the bank) as internal strategy: which clauses to propose, which risk positions to hold, and what approvals each provision requires. This is preparation only — the actual sending and negotiation of the EL happen later, at Seq 25 (Engagement Negotiation).

**Inputs → Outputs:** Firm clause library plus deal specifics → internal EL framework with key provisions, risk positions, and drafting notes.

**Systems:** CLM (contract lifecycle management) / Word.

**Learning Loop:** Updates the clause library, risk checklist, client-specific drafting notes, and approval requirements.

**Compliance Gate:** **Counsel / senior banker review required for final terms**; all drafts version-controlled.

### Seq 21: Pitchbook Drafting

**Phase:** 1 \| **Build Responsibility:** RTS \| **RTS Build \#:** 22 \| **Execution Class:** A+H

**What Happens in This Step:** Generates the pitch deck in the firm template: company analysis, buyer universe, strategic rationale, valuation, engagement approach, timeline, team credibility, and war stories. v9 adds two mandatory elements: (a) league-table rankings — Ignatious's ranking overall (global/regional), in the target's sector, and in the target's sub-sector, sourced from the most recent Mergermarket / LSEG SDC / Dealogic / S&P Capital IQ / Bloomberg league tables (fed by League Table Submission, Seq 55 / RTS Build \#12); and (b) detailed case studies — the top 3–5 surfaced by the Case Study Library (Seq 18, RTS Build \#11), each a full page rather than a tombstone, prioritized by a client-overlap heuristic.

**Inputs → Outputs:** Firm template plus upstream outputs (strategy/SWOT, buyer universe, engagement economics, case studies, league-table data) → client-ready pitch deck with source appendix.

**Systems:** PowerPoint and firm template library; Capital IQ / PitchBook data feeds.

**Learning Loop:** Updates the deck precedent library, accepted/rejected slides, sector slides, and MD style preferences; pulls league-table rankings (Seq 55, RTS Build \#12) and case studies (Seq 18, RTS Build \#11) on every run.

**Compliance Gate:** **No client delivery until senior banker approval**; source appendix required; communications review before external use.

### Seq 22: Pitch Page QC

**Phase:** 1 \| **Build Responsibility:** RTS \| **RTS Build \#:** 7 \| **Execution Class:** A+H

**What Happens in This Step:** Reviews every page of the pitch deck against eight checks: point (does the page make one clear point), simplicity, story impact, uniqueness versus other banks, source accuracy, formatting, number consistency, and client relevance. Output is a page-by-page QC (quality control) report with specific fixes, applied before the deck leaves the building.

**Inputs → Outputs:** Draft pitch deck → page-by-page QC findings and fixes, with a pass/fail result gating release.

**Systems:** PowerPoint.

**Learning Loop:** Updates slide-quality rules, the reusable best-pages library, rejected-page reasons, and the style library.

**Compliance Gate:** **Must pass before the pitch deck is sent or presented.**

### Seq 23: Pitch Rehearsal

**Phase:** 1 \| **Build Responsibility:** RTS \| **RTS Build \#:** 23 \| **Execution Class:** H+A

**What Happens in This Step:** The bankers rehearse; the agent prepares and captures. It assigns speaking roles and page owners, compiles likely objections, war stories, and Q&A, produces dry-run notes, designates follow-up owners, and handles meeting logistics. The live rehearsal and the pitch itself remain human work — the agent's job is to make sure no one walks into the room unprepared.

**Inputs → Outputs:** Final deck plus team roster → rehearsal pack (speaking roles, page owners, likely objections, Q&A, dry-run notes, follow-up owners, logistics).

**Systems:** Platform (internal); M365 for prep materials.

**Learning Loop:** Updates the pitch-prep checklist, Q&A library, banker coaching notes, and rehearsal feedback.

**Compliance Gate:** Internal-only work product — never distributed externally; purpose is consistency and reducing avoidable mistakes in the live pitch.

### Seq 24: Pitch Follow-Up

**Phase:** 1 \| **Build Responsibility:** RTS \| **RTS Build \#:** 24 \| **Execution Class:** A+H

**What Happens in This Step:** After the pitch, runs the internal debrief and drafts stakeholder-specific follow-ups: requests for missing data, permissions, and references; answers to client questions; delivery of promised items; and "surprise-to-the-upside" incremental material that goes beyond what was promised in the room. Every commitment made during the pitch is tracked to completion so nothing promised is dropped.

**Inputs → Outputs:** Pitch debrief plus stakeholder map → follow-up drafts, promised-deliverables tracker, and open-question list.

**Systems:** HubSpot/CRM; email via M365 (Outlook).

**Learning Loop:** Updates the CRM, action tracker, open questions, client concerns, follow-up commitments, and resonant-page data (which slides landed with which stakeholders).

**Compliance Gate:** **Pre-send review — a banker approves every follow-up before it goes out**; no private-document request before an NDA (non-disclosure agreement) is in place; all commitments tracked.

### Seq 25: Engagement Negotiation

**Phase:** 1 \| **Build Responsibility:** RTS \| **RTS Build \#:** 25 \| **Execution Class:** H+A

**What Happens in This Step:** The banker negotiates the mandate to signature; the agent manages the paper. It sends the approved EL (Engagement Letter), manages client comments, compares redlines across versions, prepares negotiation positions — with the Negotiation Copilot (horizontal, OS Build \#16) surfacing market precedent for counters and justifications — and tracks the document through to execution. The negotiation itself, and every concession in it, is human judgment.

**Inputs → Outputs:** Approved EL draft plus client redlines → negotiated, fully executed Engagement Letter with complete version history.

**Systems:** CLM (contract lifecycle management) / Word; Negotiation Copilot precedent database.

**Learning Loop:** Updates engagement status, versions, open issues, fee terms, tail terms, and approvals.

**Compliance Gate:** **Counsel / senior banker approval on final terms; the banker — not the agent — conducts the negotiation**; full audit trail maintained; the executed agreement is archived.

## Phase 2: Preparation & Market Readiness

**Deal Context:** The bank is hired. The team mobilizes, stages the company for market, and writes the selling documents (Teaser, CIM/MP).

### Seq 26: Mandate Activation Checklist

**Phase:** 2 \| **Build Responsibility:** Operating System \| **OS Build \#:** 19 \| **Execution Class:** A+H

**What Happens in This Step:** The moment the mandate is won, this application converts the prospect into an active mandate by driving a manual activation checklist to completion. The checklist items come straight from v9: final conflicts check, signed Engagement Letter (EL), IRS Form W-9, code name, deal team assignment, system permissions, compliance registration, folder setup, engagement scope, fee economics, timeline, and the kickoff plan. Nothing downstream — kickoff, data room, materials — should begin until every item is checked off; the agent assembles and tracks the checklist and chases open items, while bankers and compliance perform the judgment steps such as conflicts clearance.

**Inputs → Outputs:** Executed EL + won-pitch record → completed activation checklist, live deal workspace, and a registered mandate in the CRM.

**Systems:** HubSpot (CRM), compliance log, M365/SharePoint deal workspace and permission groups.

**Learning Loop:** Moves the Pipeline CRM entry from Live Lead to Won Mandate and writes back the project ID, workspace, revenue forecast, permission groups, compliance log, and mandate-checklist status.

**Compliance Gate:** **Final conflicts check must clear before activation**; information barriers stand up with the deal-team assignment; the records-retention schedule is initialized at activation.

### Seq 27: Win/Loss Debrief

**Phase:** 2 \| **Build Responsibility:** RTS \| **RTS Build \#:** 26 \| **Execution Class:** A+H

**What Happens in This Step:** A mandatory debrief runs on every pitch outcome — won or lost, no exceptions. For a win, it captures what resonated, the supporting factors, and which specific slides and pitchers moved the needle; for a loss, it captures who won, why the firm lost, the client-articulated reasons, deal-team gaps, missing data, and competitive positioning. The agent structures and files the debrief; a banker supplies and validates the substance. Over time this builds the firm's best-pitcher / best-pitch database — one of the v9 "secret sauce" assets.

**Inputs → Outputs:** Pitch outcome + deal-team and client feedback → structured debrief record feeding the pitch-performance database.

**Systems:** HubSpot (CRM), internal pitch-performance database.

**Learning Loop:** Updates the pitch-performance database and the banker-pitch-quality and pitch-deck-effectiveness scores by sector, size, and transaction type; identifies the best pitchers and best pitches over time and feeds the Continuous Learning application.

**Compliance Gate:** Internal confidential learning only; **banker-attributed performance data sits under privacy/HR controls**; client-specific content is separated from reusable patterns.

### Seq 28: Kickoff / Org Meeting

**Phase:** 2 \| **Build Responsibility:** RTS \| **RTS Build \#:** 27 \| **Execution Class:** H+A

**What Happens in This Step:** The organizational (kickoff) meeting is run by humans — the bankers and the client agree on how the transaction will be executed. The agent's role is output generation from that meeting: it produces the initial Working Group List (WGL — handed to the WGL application at Seq 30), milestone targets (handed to the Timeline application at Seq 29), roles, deliverables, the weekly meeting cadence, and the client-versus-banker ownership split for each workstream. This single meeting seeds most of the Stage 3 machinery.

**Inputs → Outputs:** Kickoff meeting content → initial WGL, milestone targets, responsibility matrix, deliverable list, and cadence plan.

**Systems:** Operating System (task engine, project dashboard), M365/SharePoint, meeting notes.

**Learning Loop:** Initializes the deal's task engine, contacts, deadlines, responsibility matrix, and project dashboard.

**Compliance Gate:** **The client must approve the process plan**; material schedule changes are captured under firm recordkeeping.

### Seq 29: Timeline

**Phase:** 2 \| **Build Responsibility:** RTS \| **RTS Build \#:** 28 \| **Execution Class:** A

**What Happens in This Step:** Builds the detailed transaction timeline from a template matched to the deal's sector, size, and transaction type, then tracks every milestone against that baseline for the life of the deal. When a milestone slips, it alerts both the banker and the Managing Director (MD). The timeline refreshes weekly.

**Inputs → Outputs:** Sector/size/transaction-type template + kickoff milestone targets → living transaction timeline with baseline-variance tracking and slippage alerts.

**Systems:** Operating System, Excel/Google Sheets.

**Learning Loop:** Updates the timeline-template library, sector/size variance data, and milestone-prediction accuracy with every deal.

**Compliance Gate:** Material schedule changes are captured under firm recordkeeping; the client-approved baseline is retained as evidence.

### Seq 30: WGL

**Phase:** 2 \| **Build Responsibility:** RTS \| **RTS Build \#:** 29 \| **Execution Class:** A+H

**What Happens in This Step:** Maintains the Working Group List (WGL) — the master roster of every party working the deal — as a continuously updated shared online document rather than a static attachment that goes stale. Visibility is segregated by design: the Company and the Company's advisors see all parties, while each buyer sees only the Company and its own advisors — never another buyer. The list updates on every new contact across all parties, so it is always current.

**Inputs → Outputs:** New contacts and party changes from every workstream → the always-current, visibility-segregated WGL.

**Systems:** Shared online document (M365/SharePoint), HubSpot (CRM).

**Learning Loop:** Updates the WGL database, contact-velocity patterns, and buyer-engagement signals; tracks which contacts drive deal momentum.

**Compliance Gate:** **Access controls enforce buyer segregation — no cross-buyer visibility**; every WGL view and edit is captured in an audit trail.

### Seq 31: VDR Setup

**Phase:** 2 \| **Build Responsibility:** RTS \| **RTS Build \#:** 30 \| **Execution Class:** A+H

**What Happens in This Step:** Creates the internal Virtual Data Room (VDR) architecture immediately after mandate activation, well before any buyer enters the process: folder structure, file-naming conventions, permission scheme, indexing, upload rules, draft/final tagging, and the access plan. It also establishes clean-team / highly-confidential schedule folders — for competitively sensitive material only cleared individuals may see — kept separate from the general buyer-access folders. A banker approves the architecture and the permission plan before the room goes live.

**Inputs → Outputs:** Deal scope + document plan → configured VDR with folder taxonomy, permissions, and documented clean-team carve-outs.

**Systems:** VDR (Box/Datasite or client-selected provider), M365/SharePoint staging.

**Learning Loop:** Updates the data-room index, folder taxonomy, permissions map, document ownership, and access-readiness status.

**Compliance Gate:** **No buyer access until NDA execution and client approval**; sensitive folders isolated; the clean-team carve-out is documented.

### Seq 32: Document Intake / Metadata

**Phase:** 2 \| **Build Responsibility:** Operating System \| **OS Build \#:** 20 \| **Execution Class:** A

**What Happens in This Step:** As client documents flow in, this application curates the corpus for both human use now and machine retrieval later: folder structure, naming, metadata, draft/final tagging, source ownership (who provided each document), and document health (completeness, currency, version integrity). v9 frames this explicitly as future RAG (retrieval-augmented generation) readiness — disciplined metadata today is what makes permission-aware, citation-ready AI retrieval possible on the platform later.

**Inputs → Outputs:** Raw client document inflow → curated, tagged, metadata-complete corpus plus a document-health report.

**Systems:** M365/SharePoint, VDR.

**Learning Loop:** Updates the curated corpus, metadata taxonomy, source map, and document-health report.

**Compliance Gate:** Sensitive classification applied at intake; retrieval must remain permission-aware; citation readiness enforced from day one.

### Seq 33: Data Room Diligence

**Phase:** 2 \| **Build Responsibility:** RTS \| **RTS Build \#:** 31 \| **Execution Class:** A+H

**What Happens in This Step:** Once the data room is populated, the agent reviews it the way a buyer's diligence team eventually will: strengths, weaknesses, missing information, internal inconsistencies, MNPI (material non-public information) and private data, highly confidential strategic information, disclosure risk, and red flags. It separately tags clean-team / restricted-access materials so they can be withheld or released only under clean-team rules. A banker reviews the findings and owns the remediation decisions before anything is fixed, disclosed, or restricted.

**Inputs → Outputs:** Populated data room → risk register, missing-info log, strengths/weaknesses memo, strategic-info index, clean-team taxonomy, and remediation task list.

**Systems:** VDR, Excel trackers, Operating System.

**Learning Loop:** Creates and maintains the risk register, missing-info log, strengths/weaknesses memo, strategic-info index, clean-team taxonomy, and remediation tasks for the deal.

**Compliance Gate:** **Highly confidential / MNPI issues escalate to the banker**; buyer-access restrictions are flagged; **clean-team rules enforced before any buyer release**.

### Seq 34: Financial Normalization

**Phase:** 2 \| **Build Responsibility:** RTS \| **RTS Build \#:** 32 \| **Execution Class:** H+A

**What Happens in This Step:** A banker — typically working with the client's finance team — owns the numbers; the agent performs the mechanical normalization and checking. The v9 scope: normalize historical financials, build the ARR (annual recurring revenue) / revenue bridge, gross margin, EBITDA (earnings before interest, taxes, depreciation, and amortization), customer concentration, cohort/KPI data, working capital, and addbacks. These normalized figures feed the financial model and Quality of Earnings (QoE) inputs — and ultimately every number a buyer will see, which is why the human owns them.

**Inputs → Outputs:** Raw historical financials + KPI/cohort data → normalized financial database, assumptions log, and model-ready inputs with full source mapping.

**Systems:** Excel/Google Sheets, client accounting exports, M365/SharePoint.

**Learning Loop:** Updates the financial database, assumptions log, model inputs, and source mapping.

**Compliance Gate:** Calculations must be deterministic (spreadsheet-verifiable, never model-estimated); **human approval required for all numbers used externally**.

### Seq 35: Deal Pulse Checklist

**Phase:** 2 \| **Build Responsibility:** RTS \| **RTS Build \#:** 10 \| **Execution Class:** A

**What Happens in This Step:** Produces the daily or weekly deal pulse — the Daily Deal Update Email deliverable from the original project requirements. Each pulse covers overdue items, current-week priorities, owners, blockers, document gaps, open items, and the updated expected timeline. Where the underlying data is sufficient, the pulse also includes a risk-to-signing indicator — and that indicator is banker-reviewed before it appears in any distribution. This application also produces the recurring weekly client update.

**Inputs → Outputs:** Live task, timeline, and document status across the deal's applications → daily/weekly pulse digest to the deal team.

**Systems:** Operating System (task engine, timeline, document trackers), email distribution.

**Learning Loop:** Tracks task latency, process bottlenecks, and milestone delays; uses them to improve timeline templates and staffing models.

**Compliance Gate:** **Distribution limited to authorized deal-team recipients — no cross-wall exposure**; the risk-to-signing indicator requires banker review before inclusion.

### Seq 36: Teaser

**Phase:** 2 \| **Build Responsibility:** RTS \| **RTS Build \#:** 33 \| **Execution Class:** A+H

**What Happens in This Step:** The application drafts the anonymized teaser — also called a blind profile — the 1–2 page document used to test buyer interest before the company's identity is revealed. Working only from approved deal data, it assembles the four v9-specified elements: key metrics, investment highlights, a process overview, and confidentiality-safe positioning. Because the teaser circulates before any buyer has signed an NDA (non-disclosure agreement), every description, metric, and market detail is checked so that the combination cannot be used to identify the client. The agent produces the draft end-to-end; the banker and the client then review and approve it before it is used with any buyer.

**Inputs → Outputs:** Approved deal data → anonymized 1–2 page teaser / blind profile, checked for de-anonymization risk and queued for client and banker approval.

**Systems:** Word/PowerPoint (M365), with source material drawn from the SharePoint deal shell.

**Learning Loop:** Templates blind profiles for reuse and learns which positioning drives buyer engagement, feeding those patterns back into future teaser drafts.

**Compliance Gate:** Anonymization checks on every draft; **no release without client and banker approval**.

### Seq 37: CIM / Management Presentation

**Phase:** 2 \| **Build Responsibility:** RTS \| **RTS Build \#:** 34 \| **Execution Class:** A+H

**What Happens in This Step:** The application drafts the Confidential Information Memorandum (CIM) — the detailed selling document shared only after a buyer signs an NDA (non-disclosure agreement) — and the Management Presentation (MP) in the firm template, built strictly from approved data. The v9 section set is: investment highlights, market, company, products, financials, KPIs (key performance indicators), growth strategy, risks, and appendix. Every claim is tied to a source/citation map so each statement traces back to approved underlying material, and the draft goes through a sensitive-information review before anything reaches a buyer. Under v9, CIM draft completion is a defined trigger event for the Expert Panel Review agent, which red-teams the document (PASS / REVISE / REWRITE verdict) before buyer release.

**Inputs → Outputs:** Approved, normalized deal data → CIM plus Management Presentation in the firm template, with a complete source/citation map.

**Systems:** Word and PowerPoint (M365) on the firm template; source documents in SharePoint/VDR.

**Learning Loop:** Writes back to the narrative library, accepted language, sector content, red-flag responses, and client feedback, so future CIMs start from proven, pre-approved material.

**Compliance Gate:** Source/citation map required; sensitive-information review before buyer release; Expert Panel red-team review on draft completion; **senior and client approval before any buyer release**.

### Seq 38: FAQ&A

**Phase:** 2 \| **Build Responsibility:** RTS \| **RTS Build \#:** 8 \| **Execution Class:** A+H

**What Happens in This Step:** The application builds the anticipated buyer FAQ&A (Frequently Asked Questions & Answers) — a pre-drafted set of the questions buyers are expected to ask about the company and the process, with sourced answers prepared before the questions arrive. It then continually updates the document with every real question that comes in from the Management Presentation (MP), buyer calls, diligence, formal Q&A, and follow-ups, so the FAQ&A stays current across the whole marketing phase. Downstream applications feed it: the Management Meeting application writes MP themes and questions back into the FAQ&A, and the Buyer Q&A application (Seq 45) updates it from live buyer questions. Each answer carries its source citation and an assigned owner, and full question/answer history is retained.

**Inputs → Outputs:** Anticipated buyer questions plus every live question from MP, calls, diligence, Q&A, and follow-ups → a continuously updated, source-linked buyer FAQ&A.

**Systems:** Platform (reusable Q&A knowledge base with responsive-document links); source documents in M365/SharePoint and the VDR.

**Learning Loop:** Updates the reusable Q&A knowledge base, answer owners, source citations, recurring diligence themes, and responsive document links — building a compounding library of pre-approved answers across deals.

**Compliance Gate:** **Every answer requires a source citation and banker approval before buyer distribution**; full history retained.

## Phase 3: Marketing & First-Round Bids

**Deal Context:** The process goes live. Buyers are approached under a code name; interest converts into first-round offers / Indication of Interest (IOIs).

### Seq 39: Outreach Sequencing

**Phase:** 3 \| **Build Responsibility:** RTS \| **RTS Build \#:** 35 \| **Execution Class:** A+H

**What Happens in This Step:** With materials approved, the deal team plans how to actually approach the buyer universe — under the deal code name, never the client's real name. The application segments the approved buyer list into outreach waves, tailors the acquisition rationale for each buyer (why this target fits that buyer specifically), and assigns a banker owner to every buyer. For each wave it prepares call scripts and a follow-up cadence, and it prioritizes warm relationship paths — routing an approach through a banker who already knows the buyer's decision-maker — over cold contact. The output is a sequenced outreach plan the deal team executes, not outreach itself.

**Inputs → Outputs:** Approved buyer universe + conflicts/restricted-list clearance → wave plan with banker owners, tailored rationale, call scripts, and follow-up cadence in the CRM.

**Systems:** HubSpot (CRM), Outlook/M365 email, SharePoint for the outreach plan.

**Learning Loop:** Writes back the outreach plan, banker assignments, buyer scores, and wave status as the process advances, so the live plan and the CRM never diverge.

**Compliance Gate:** **No buyer may be contacted before conflicts/restricted-list screening, client approval of the contact list, and banker approval of the outreach** — the agent plans and sequences but does not initiate contact.

### Seq 40: Buyer Synergies Model + Valuation

**Phase:** 3 \| **Build Responsibility:** RTS \| **RTS Build \#:** 36 \| **Execution Class:** H+A

**What Happens in This Step:** For each named buyer on the outreach list, the application generates a revenue-plus-cost synergies summary, a buyer-specific accretion/dilution model, and a buyer-specific valuation covering both ability to pay and willingness to pay. It maps the target's capabilities against each buyer's gaps, and quantifies cross-sell, channel, overhead, and infrastructure synergies buyer by buyer. This is what lets the banker argue a different, higher number to each buyer instead of one generic valuation. The banker owns the valuation judgment; the agent builds and maintains the per-buyer models underneath it, with all arithmetic routed to deterministic engines (Excel/Python), never LLM (large language model) math.

**Inputs → Outputs:** Named buyer list + approved target financials and CIM (Confidential Information Memorandum) data → per-buyer synergies summary, accretion/dilution model, and ability/willingness-to-pay valuation.

**Systems:** Excel (deterministic model engine), Capital IQ and PitchBook for buyer financials, SharePoint.

**Learning Loop:** Updates the synergy precedent library, tracks buyer-quantification accuracy against realized outcomes, and refines the model per sector — each closed deal makes the next deal's synergy estimates sharper.

**Compliance Gate:** Every figure source-cited with estimates clearly labeled; **all numbers human-approved, with MD (Managing Director) approval before any external use**; numbers walled to the authorized deal team only.

### Seq 41: Buyer Log / Feedback

**Phase:** 3 \| **Build Responsibility:** RTS \| **RTS Build \#:** 37 \| **Execution Class:** A+H

**What Happens in This Step:** The application drafts buyer outreach, tracks responses, and maintains the buyer log as outreach waves go out. Every buyer touch is logged into the target company's CRM (customer relationship management) record: buyer firm, contact name, contact title, date of outreach, response (interested / declined / no-response), and — if declined — the reason for passing. It proactively requests feedback from buyers who pass, then converts that pass feedback into follow-on relationship meetings and targeted coverage lists for future companies. Over time this CRM record becomes the firm's proprietary buyer-intelligence asset, compounding across every deal.

**Inputs → Outputs:** Outreach activity + buyer responses → complete CRM buyer log with pass reasons, drafted follow-up outreach, and targeted coverage lists.

**Systems:** HubSpot (CRM) as the system of record; Outlook/M365 email for tracked correspondence.

**Learning Loop:** Writes buyer feedback, buyer preferences, sector criteria, contact changes, follow-up meetings, and buyer propensity scores back into the CRM — this is the feedback loop that turns each process into durable buyer intelligence.

**Compliance Gate:** **No autonomous send — banker releases all buyer outreach.** All communications recorded; no cross-wall exposure; confidential process information protected under the deal code name.

### Seq 42: Buyer NDA

**Phase:** 3 \| **Build Responsibility:** RTS \| **RTS Build \#:** 38 \| **Execution Class:** A+H

**What Happens in This Step:** Interested buyers must sign an NDA (Non-Disclosure Agreement) before receiving anything beyond the anonymous teaser. The application tracks each buyer's NDA status, redlines, approvals, and document versions, and flags VDR (Virtual Data Room)-access readiness the moment an NDA is fully executed. It compares each buyer's requested deviations against the firm's precedent NDAs, so the deal team can see instantly which redlines are standard and which are unusual and need counsel. In a live auction this is a high-volume tracking problem — dozens of buyers, each with their own markup and version history.

**Inputs → Outputs:** Buyer NDA drafts and redlines → executed-NDA status tracker with legal issue list, precedent-deviation comparison, and VDR-access-readiness flags.

**Systems:** CLM (Contract Lifecycle Management) tooling, VDR (varies by deal), SharePoint for the NDA archive.

**Learning Loop:** Updates buyer status, the NDA archive, the legal issue list, and VDR permission readiness; the growing precedent base makes deviation-flagging more accurate on each deal.

**Compliance Gate:** **Legal review required for any deviation from standard terms; no buyer receives confidential access before NDA execution and approval.**

### Seq 43: Buyer VDR Access

**Phase:** 3 \| **Build Responsibility:** Operating System \| **OS Build \#:** 22 \| **Execution Class:** A+H

**What Happens in This Step:** Once a buyer's NDA is executed, the application provisions staged VDR (Virtual Data Room) access by buyer group: permissions scoped to what that buyer group is cleared to see, watermarking on documents, full access logs, download rules, and clean-team restrictions on restricted-access materials (e.g., competitively sensitive data only a walled-off subset of the buyer's team may view). "Staged" means access widens as a buyer advances in the process rather than exposing everything at once. This is an Operating System build (Build Scope IN) — it requires platform-level access control and audit infrastructure, so it is not on the Ignatious consulting-partner build list.

**Inputs → Outputs:** Executed NDAs + client approval → staged, watermarked, permissioned VDR access per buyer group with complete access and download logs.

**Systems:** Operating System access-control layer over the deal VDR (provider varies by deal).

**Learning Loop:** Updates the access log, buyer activity, document views/downloads, and a diligence engagement score per buyer — buyer VDR behavior becomes a signal of real interest for the deal team.

**Compliance Gate:** **Access granted only on executed NDA plus client approval; every wall-crossing logged.** Strict permission controls, access revoked immediately on pass or process termination, full audit trail, clean-team carve-outs enforced.

### Seq 44: Management Meeting

**Phase:** 3 \| **Build Responsibility:** RTS \| **RTS Build \#:** 39 \| **Execution Class:** H+A

**What Happens in This Step:** Serious buyers get a management meeting — the client's leadership presenting to the buyer's team. The live meeting is human; the application does the preparation and capture around it. Before each meeting it produces a buyer-specific meeting deck, management coaching notes, and talking points covering that buyer's acquisition rationale, prior deals, the synergies case, known weaknesses, and anticipated questions — so management walks in prepared for that specific buyer rather than delivering a generic pitch. After the meeting it produces a structured post-meeting summary and routes follow-ups.

**Inputs → Outputs:** Buyer profile + approved CIM (Confidential Information Memorandum) and synergies materials → buyer-specific deck, coaching notes, anticipated-question prep, and post-meeting summary with next steps.

**Systems:** PowerPoint (M365), meeting notes/transcript capture, SharePoint.

**Learning Loop:** Updates buyer feedback, recurring management-meeting themes, the FAQ&A (frequently asked questions and answers) library, buyer score, and next steps — questions asked in one meeting improve preparation for the next.

**Compliance Gate:** **Only approved materials go in front of buyers**; content is buyer-specific and MNPI (material non-public information)-safe; meeting capture is structured and consent-based, with recordkeeping for material follow-ups.

### Seq 45: Buyer Q&A

**Phase:** 3 \| **Build Responsibility:** RTS \| **RTS Build \#:** 40 \| **Execution Class:** A+H

**What Happens in This Step:** As buyers dig into the VDR (Virtual Data Room) and management meetings, questions pour in from every active buyer. The application manages the buyer question queue: it logs each question, assigns an owner (banker, management, or advisor), drafts answers exclusively from approved sources, and updates the shared FAQ&A (frequently asked questions and answers) document so the same question is never re-worked twice. It also tracks response time and answer quality per question, keeping the process moving and consistent — every buyer receives the same approved answer to the same question.

**Inputs → Outputs:** Incoming buyer questions → owner-assigned, source-linked, approved answers plus a continuously updated FAQ&A.

**Systems:** Operating System Q&A tracker, VDR Q&A module (varies by deal), SharePoint.

**Learning Loop:** Updates the Q&A tracker, FAQ&A, recurring-issue library, per-buyer diligence score, and management workload view — recurring questions become pre-approved answers on future deals.

**Compliance Gate:** **No answer released to a buyer without a source link and banker approval**; full question-and-answer history retained for the record.

## Phase 4: Diligence, LOI & Definitive Docs

**Deal Context:** Offers are on the table. Narrow to one buyer under a Letter of Intent (LOI); the buyer verifies everything while lawyers negotiate the definitive agreement.

### Seq 46: LOI / Process Letter

**Phase:** 4 \| **Build Responsibility:** RTS \| **RTS Build \#:** 41 \| **Execution Class:** A+H

**What Happens in This Step:** The application drafts and distributes process letters and/or Letter of Intent (LOI) forms to the bidders advancing in the process. Process letters tell remaining buyers exactly how to submit their offers — bid instructions, submission deadlines, and required terms — while a standard LOI form makes the resulting bids directly comparable. The application tracks every version and redline of these documents per bidder, alongside the bid instructions, deadlines, and required terms it has communicated. Because bid instructions must be consistent across all buyers, the tracked record of what was sent to whom, and when, is part of the work product itself.

**Inputs → Outputs:** Advancing-bidder list + process timeline and required terms → distributed process letters / LOI forms, per-bidder version and redline history, deadline calendar.

**Systems:** Word / M365 for drafting; SharePoint for the bidder instruction log, LOI tracker, and process calendar.

**Learning Loop:** Writes back to the bidder instruction log, LOI tracker, term comparison matrix, and process calendar, so downstream bid comparison starts from a current, structured record of what each bidder was asked to submit.

**Compliance Gate:** **Legal/client and senior approval before distribution — no autonomous send**; consistent terms and instructions to all buyers; full audit trail of versions and redlines.

### Seq 47: Bid Comparison

**Phase:** 4 \| **Build Responsibility:** RTS \| **RTS Build \#:** 42 \| **Execution Class:** A+H

**What Happens in This Step:** The application compares Indications of Interest (IOIs) and bids term by term across the dimensions v9 specifies: price, structure, cash/stock mix, rollover, earnout, escrow, conditionality, timing, certainty, diligence burden, and buyer fit. The output is the side-by-side comparison the deal team uses to decide which bidders advance and to shape next-round strategy. Every term in the comparison must be sourced from the actual bid documents rather than paraphrased or reconstructed. The comparison also feeds a growing term precedent library and per-buyer reliability scoring, which is why v9 classifies this agent as part of the firm's proprietary edge.

**Inputs → Outputs:** Received IOIs / bids and their underlying documents → term-by-term bid comparison matrix + next-round strategy input, with updates to the bid database.

**Systems:** Excel for the comparison matrix; bid database, term precedent library, and buyer reliability scores maintained on the platform / SharePoint.

**Learning Loop:** Updates the bid database, term precedent library, negotiation outcomes, and buyer reliability score — over successive deals the application learns which terms are market and which buyers bid reliably versus retrade.

**Compliance Gate:** **MD (Managing Director) / legal review — the banker interprets the comparison; the application is decision support only**; all terms sourced from actual bid documents.

### Seq 48: LOI Review

**Phase:** 4 \| **Build Responsibility:** RTS \| **RTS Build \#:** 43 \| **Execution Class:** H+A

**What Happens in This Step:** The banker and counsel own the negotiation of the Letter of Intent (LOI) and exclusivity; the application prepares the analysis underneath it. It analyzes the selected buyer's LOI and exclusivity issues and produces negotiation points — with the Negotiation Copilot (OS Build \#16) surfacing precedent from prior deals — plus fallback positions, a risk map, and a client decision memo. Exclusivity commits the seller to negotiate with a single buyer, so the client decision memo frames what is being given up and on what terms before the client signs off. Per v9, the Negotiation Copilot is advisory only and never responds autonomously to a counterparty, and drafted LOI responses are routed through Expert Panel Review for negotiation posture and language before release.

**Inputs → Outputs:** Selected buyer's LOI draft + exclusivity terms → negotiation points, fallback positions, risk map, and client decision memo.

**Systems:** CLM (Contract Lifecycle Management) / Word (M365); Negotiation Copilot (OS Build \#16) precedent library; SharePoint for the decision memo and clause records.

**Learning Loop:** Updates the clause precedent library, the buyer behavior profile, and negotiated issue outcomes, so each negotiation strengthens the precedent base the Negotiation Copilot draws on for the next deal.

**Compliance Gate:** **Legal/MD approval and counsel/senior review — the human negotiates; no autonomous legal advice**; **client sign-off required** before exclusivity terms are accepted.

### Seq 49: Merger Agreement Distribution

**Phase:** 4 \| **Build Responsibility:** RTS \| **RTS Build \#:** 44 \| **Execution Class:** A+H

**What Happens in This Step:** The application distributes the form merger / purchase agreement to buyers and tracks their comments and issues. Timing depends on process type, per v9: in an auction, the form agreement is distributed pre-exclusivity; in a single-bidder process, it goes out post-LOI (Letter of Intent) and exclusivity. As buyer markups come back, the application tracks comments, open issues, and each buyer's positions across versions, maintaining a complete version history. The agreement itself is legal-team work product — the application's role is distribution logistics and issue tracking in support of counsel and the banker.

**Inputs → Outputs:** Counsel's form merger / purchase agreement + distribution list → distributed agreement, comment and issue tracker, buyer position log, version history.

**Systems:** CLM (Contract Lifecycle Management) and VDR (Virtual Data Room; provider varies by deal); SharePoint / M365 for version tracking.

**Learning Loop:** Updates the agreement tracker, issue list, buyer positions, legal diligence timeline, and version history, building a record of which agreement issues recur and how they resolve.

**Compliance Gate:** **Legal-team controlled and counsel-owned — the application provides banker support only**; privileged materials protected; version control and full audit trail maintained.

### Seq 50: Definitive Agreement Support

**Phase:** 4 \| **Build Responsibility:** RTS \| **RTS Build \#:** 45 \| **Execution Class:** H+A

**What Happens in This Step:** Counsel and the banker own this phase; the application is a tracking and support layer, not a drafter. It tracks confirmatory diligence (the winning buyer's final verification of everything it was told), disclosure schedules, purchase agreement issues, closing conditions, open points, reps and covenants (representations — the seller's factual statements in the contract — and covenants, the promised behaviors between signing and closing), and issue resolution. As contested points arise, the Negotiation Copilot (horizontal, OS Build \#16) surfaces market precedent on contested reps and on escrow / earnout positions — the holdback and contingent-payment structures where negotiations most often stall. The output is a single live picture of what remains open, who owns each item, and what stands between the deal and signing. Board approval of the transaction happens here, before signing; approvals referenced in Phase 5 are closing mechanics only.

**Inputs → Outputs:** Purchase agreement drafts and redlines, confirmatory diligence requests, VDR (Virtual Data Room) activity, and counsel issue lists → live issue log, disclosure schedule tracker, closing conditions checklist, and open-points status with owners.

**Systems:** VDR (varies by deal), CLM (Contract Lifecycle Management) tool, M365/SharePoint for supporting records.

**Learning Loop:** Updates the closing checklist, issue log, risk register, legal status, and task owners as items are raised and resolved, so the deal team and counsel always work from the same current state; resolved-issue patterns feed the precedent base the Negotiation Copilot draws on.

**Compliance Gate:** **Legal controlled — counsel and banker own the definitive agreement; the agent tracks only, with legal approval required and disclosure schedules verified against the record.** All approvals and version history preserved for the audit trail.

## Phase 5: Signing, Closing & Post-Close

**Deal Context:** The deal signs, goes public, and closes — money moves under maximum human control; records, fees, and lessons are harvested. Includes the no-close / termination branch (tail rights).

### Seq 51: Signing / Announcement Prep

**Phase:** 5 \| **Build Responsibility:** RTS \| **RTS Build \#:** 46 \| **Execution Class:** A+H

**What Happens in This Step:** In the run-up to signing, this application assembles everything needed for the moment the deal is signed and goes public. It builds the signing checklist, drafts board and client updates, and prepares the announcement draft, press release, and tombstone draft (the tombstone is the public "we did this deal" credential graphic). It also lays out the closing timeline and the stakeholder communications plan so client, buyer, employees, and press each hear the right message in the right order. Because everything is staged in advance, the downstream Announcement, LinkedIn Post, Email Blast, and League Table Submission steps can fire the instant the announcement goes live.

**Inputs → Outputs:** Signed definitive agreement + deal record → signing checklist, board/client updates, announcement/press-release/tombstone drafts, closing timeline, and stakeholder communications plan.

**Systems:** Word/PowerPoint drafts staged on M365/SharePoint.

**Learning Loop:** Updates the transaction record, the marketing queue, the post-signing task list, and announcement-approval status so downstream release steps inherit an approved, current package.

**Compliance Gate:** Communications review on all drafted materials; final terms verified against the signed definitive agreement; **client and legal approval before any release**.

### Seq 52: Announcement

**Phase:** 5 \| **Build Responsibility:** RTS \| **RTS Build \#:** 47 \| **Execution Class:** H+A

**What Happens in This Step:** The human deal team runs the public release; the application assembles and sequences the materials behind it. It coordinates release timing across channels, prepares the press, web, and social materials, finalizes the transaction description and quotes, and manages tombstone approvals. It also enforces client confidentiality constraints — some clients restrict what may be disclosed publicly (deal value, buyer identity, specific terms), and the release must stay inside those limits. Execution class H+A by design: the Managing Director (MD) and communications team own the go/no-go and the moment of release; the agent handles assembly and timing.

**Inputs → Outputs:** Approved announcement package from Seq 51 + client confidentiality constraints → coordinated public release (press, web, social) with final transaction description, quotes, and approved tombstone.

**Systems:** Communications/PR tools and firm website queue, with source materials on M365/SharePoint and links written back to HubSpot (CRM).

**Learning Loop:** Writes back to the marketing database, transaction credentials, league-table record, website queue, and CRM/news links.

**Compliance Gate:** Publicity approval and final-terms accuracy checks; client consent on all disclosed content; **no public release without client + MD + Comms approval — the human coordinates the release**.

### Seq 53: LinkedIn Post

**Phase:** 5 \| **Build Responsibility:** RTS \| **RTS Build \#:** 48 \| **Execution Class:** A+H

**What Happens in This Step:** During signing prep, this application pre-drafts the firm's LinkedIn deal post so it is ready before the news is public. The draft includes client and buyer logos, deal-team tags for the named Managing Director (MD), VP, associate, analysts, and legal partner, a one-line transaction descriptor, an MD-approved quote, and hashtags. Once approved, the post is queued for release at the exact announcement timestamp, so the firm's social presence lands simultaneously with the public announcement rather than hours behind it.

**Inputs → Outputs:** Announcement facts + deal-team roster + MD-approved quote → approved LinkedIn post queued and released at the announcement timestamp.

**Systems:** LinkedIn (queued via the firm's comms/social tooling), with engagement results tracked back into HubSpot.

**Learning Loop:** Updates the marketing engagement database and tag/post performance by sector, links league-table credit attribution, and learns which post structures generate inbound mandate inquiries.

**Compliance Gate:** Tag verification and banker-name spelling check; no MNPI (material nonpublic information); authorized disclosure only; conforms to firm social-media policy; **client + MD + Comms approval before the post is queued — no autonomous posting**.

### Seq 54: Email Blast

**Phase:** 5 \| **Build Responsibility:** RTS \| **RTS Build \#:** 49 \| **Execution Class:** A+H

**What Happens in This Step:** This application pre-drafts the deal-announcement email blast during signing prep, targeting five recipient sets: the firm distribution list, deal-team relationship contacts, prior pitch attendees, prospects harvested from the buyer log, and referrer thank-yous. Each message carries a personalized salutation and the one-line transaction descriptor. On announcement, the approved blast is released immediately so the firm's network hears the news from the firm first.

**Inputs → Outputs:** Deal announcement + segmented CRM contact lists → pre-staged, personalized email blast released on announcement.

**Systems:** Outlook/M365 email with distribution lists and engagement tracking in HubSpot (CRM).

**Learning Loop:** Updates the CRM marketing-touch record and recipient engagement (open, click, reply), and tracks conversion to inbound leads.

**Compliance Gate:** Regulation Fair Disclosure (Reg FD) and solicitation rules observed; CAN-SPAM (the US commercial-email statute) compliance with opt-outs honored; restricted-list scrub of recipients; suppression/consent lists respected; **pre-send review and Comms approval before release — no autonomous send**.

### Seq 55: League Table Submission

**Phase:** 5 \| **Build Responsibility:** RTS \| **RTS Build \#:** 12 \| **Execution Class:** A+H

**What Happens in This Step:** League tables are the published advisor rankings that drive future pitch credibility, and credit is claimed at announcement. On the announcement timestamp, this application submits the signed (or closed) transaction to every league-table-credit database and deal aggregator: Mergermarket, LSEG Workspace / Refinitiv SDC, Dealogic (ION), S&P Capital IQ, Bloomberg M&A, PitchBook, The Deal, 451 Research / S&P Global Tech, Crunchbase, sector-specific trade press, and industry-specific league tables (Axios Pro Rata, IFR, GlobalCapital). Submissions are pre-staged during signing prep with deal-team attribution mapped to each platform's league-table taxonomy. It then tracks confirmation receipts, flags any missed platform, and after publication monitors each platform's next league-table cycle and files corrections where the firm's credit is missing or wrong.

**Inputs → Outputs:** Signed transaction details + deal-team attribution → submissions to every league-table/aggregator platform, confirmation receipts, and post-publication correction filings.

**Systems:** Mergermarket, LSEG Workspace / Refinitiv SDC, Dealogic, S&P Capital IQ, Bloomberg, PitchBook and other aggregator submission portals; receipt tracking on the platform.

**Learning Loop:** Feeds league-table ranking data to the Pitchbook Drafting (Seq 21, RTS Build \#22) for use in pitch materials, feeds the Transaction Marketing / Asset Library, and updates per-banker deal-team credit attribution.

**Compliance Gate:** Final-terms accuracy verified against the signed definitive agreement; authorized disclosure categories tracked per engagement letter; **client + MD + Comms approval before any submission**.

### Seq 56: Regulatory Approval Tracker

**Phase:** 5 \| **Build Responsibility:** RTS \| **RTS Build \#:** 50 \| **Execution Class:** A

**What Happens in This Step:** Signing starts the regulatory clocks, and this application tracks every approval and consent standing between signing and closing: HSR (Hart-Scott-Rodino antitrust) clearance, foreign-investment approvals, lender consents, shareholder approvals, customer consents, board approvals, and other third-party consents. For each item it maintains the deadline, the responsible party, and the supporting evidence, and raises escalation alerts as dates approach. It is a tracking application, not a filing application — outside counsel and the legal/compliance team own the actual regulatory filings.

**Inputs → Outputs:** Signed definitive agreement conditions + regulatory requirements → live approval checklist with deadlines, responsible parties, evidence, and escalation alerts.

**Systems:** Platform tracker (checklist maintained on M365/SharePoint with Excel exports for the deal team).

**Learning Loop:** Updates the approval checklist, deadlines, responsible parties, and escalation alerts as consents progress.

**Compliance Gate:** Legal/compliance controlled; regulatory deadlines and evidence logged; **filings are counsel-owned — the application tracks and alerts, never files**.

### Seq 57: Closing Checklist

**Phase:** 5 \| **Build Responsibility:** RTS \| **RTS Build \#:** 51 \| **Execution Class:** H+A

**What Happens in This Step:** The deal is legally consummated: documents are signed, closing conditions are satisfied, and purchase funds are wired. The application tracks every closing deliverable to completion — funds flow, wires, signatures, certificates, board approvals, closing conditions, and final releases — maintaining a live checklist of what is done, what is outstanding, and who owns each item. The agent also runs anti-fraud checks on wire instructions (wire fraud via spoofed payment instructions is a known attack vector at M&A closings). The human banker owns all funds-flow, wire, and signature actions outright; the agent's role is limited to checklist tracking and verification support. Every payment and signature requires explicit human confirmation, and wires operate under dual control — two humans must authorize before money moves.

**Inputs → Outputs:** Definitive agreement, funds-flow memo, wire instructions, signature pages, certificates, board approvals, and condition list → completed closing checklist with document status, confirmed funds flow, and final releases.

**Systems:** Word/Excel (checklist and funds-flow tracking); SharePoint (M365) for the document record.

**Learning Loop:** Writes back the final closing book, document status, post-closing obligations, and task completion, giving Stage 10 (closing binder, post-close fee monitoring) a complete and verified starting record.

**Compliance Gate:** Anti-fraud wire checks on all payment instructions; **human confirmation required for all payments and signatures; dual control on wires; funds movement is never agent-initiated.**

### Seq 58: Fee Realization / Invoice

**Phase:** 5 \| **Build Responsibility:** RTS \| **RTS Build \#:** 52 \| **Execution Class:** A+H

**What Happens in This Step:** With the deal closed, the bank's fee is earned and must be calculated and billed. The application calculates the success fee per the engagement letter (EL — the signed contract that defines how the bank is paid), applying retainer credits, expenses, broker-dealer / partner splits, reimbursables, and interest. It then generates the invoice from a Word template, attaches the executed engagement letter, and drafts the client cover email. The complete package routes to the Managing Director (MD) for review, approval, and send — the agent never sends the invoice itself. Payment collection is handled through Finalis rather than by the agent or the deal team directly.

**Inputs → Outputs:** Executed engagement letter, closing terms (final transaction value), retainer and expense records, and partner-split terms → approved invoice package (invoice + executed EL + client cover email) routed to the MD, with collection via Finalis.

**Systems:** Word (invoice template and cover email); Finalis (payment collection); Excel for fee calculation support.

**Learning Loop:** Updates revenue, accounts receivable, the fee record, partner splits, and the firm economics database, so realized fees feed future fee benchmarking and pipeline economics.

**Compliance Gate:** Every fee component reconciled to the engagement letter; **MD / finance approval required before send — no autonomous send**; invoice + EL + email recorded in the compliance archive; **payment collected through Finalis**.

### Seq 59: Closing Compliance Checklist / Binder

**Phase:** 5 \| **Build Responsibility:** RTS \| **RTS Build \#:** 53 \| **Execution Class:** A+H

**What Happens in This Step:** After the deal closes, this application assembles the post-closing compliance file — the "closing binder" that regulators, auditors, or litigators would ask for years later. It compiles the executed documents, approvals, communications, diligence records, fee evidence, the public announcement, the final work product, and an archive index into a single organized package. Output is the closing binder itself plus a retention checklist and a final transaction record — together the compliance evidence package for the engagement. Per v9, automated routing into an SEC Rule 17a-4 audit-trail archive comes in a later build; for now the application produces a manual supervisory evidence checklist that a human works through.

**Inputs → Outputs:** Executed deal documents, approvals, communications, diligence records, fee evidence, and the public announcement → closing binder, retention checklist, final transaction record, and compliance evidence package.

**Systems:** SharePoint (M365) as the archive of record; source records pulled from deal folders, email, and the VDR (Virtual Data Room — provider varies by deal).

**Learning Loop:** Creates the closing binder, retention checklist, final transaction record, and compliance evidence package as permanent records; the archive index becomes the retrieval map for any future audit or reference request.

**Compliance Gate:** SEC Rule 17a-4 records must be complete and preserved; automated 17a-4 / audit-trail archive routing is deferred to a later build, so a human completes the manual supervisory evidence checklist now.

### Seq 60: Post-Close Fee Monitor

**Phase:** 5 \| **Build Responsibility:** RTS \| **RTS Build \#:** 54 \| **Execution Class:** A+H

**What Happens in This Step:** Not all fees arrive at closing. This application tracks every deferred economic right under the engagement letter: earnouts, second closings, escrow releases, milestone payments, contingent fees, expense reimbursements, and trailing invoices. When a trigger event approaches or occurs, it raises alerts, generates collection tasks, and prepares trailing invoice drafts — but it never sends them on its own. Fee collection routes through Finalis, the firm's broker-dealer platform.

**Inputs → Outputs:** Engagement-letter fee terms plus purchase-agreement earnout, escrow, and milestone schedules → fee-event alerts, collection tasks, and draft trailing invoices for human release.

**Systems:** Platform fee tracker plus Finalis for collection; Excel for fee calculations; reminders surfaced to the deal team.

**Learning Loop:** Updates accounts receivable, future revenue reminders, client obligations, and collection tasks so no contingent fee is silently forgotten.

**Compliance Gate:** All tracking must align to the executed engagement letter and every fee event is logged; **human approval before any invoice or escalation — the agent never autonomously invoices or escalates a client**.

### Seq 61: Relationship Follow-Up (closing dinner)

**Phase:** 5 \| **Build Responsibility:** RTS \| **RTS Build \#:** 55 \| **Execution Class:** H+A

**What Happens in This Step:** This step is human-led: the banker owns the relationship, and the agent preps the materials. It suggests the closing dinner or celebration and the attendee list, drafts thank-you notes, proposes closing gifts, and queues the asks that convert a closed deal into future business — testimonials, reference requests, future opportunities, and referral asks. Nothing goes out except through the relationship owner.

**Inputs → Outputs:** Deal-team roster and client/buyer contact history → dinner/celebration plan, thank-you note drafts, gift suggestions, and a testimonial/reference/referral task list for the relationship owner.

**Systems:** HubSpot (CRM — Customer Relationship Management) for the relationship record; Outlook/M365 for notes and scheduling.

**Learning Loop:** Updates the CRM relationship map, the client satisfaction record, referral prospects, and the next coverage plan so post-close goodwill feeds the origination pipeline.

**Compliance Gate:** Relationship-owner led (human leads, agent assists); FINRA gift and entertainment policy limits apply to all gifts and celebrations; client approval is required before any public use of references or testimonials.

### Seq 62: Transaction Marketing / Asset Library

**Phase:** 5 \| **Build Responsibility:** RTS \| **RTS Build \#:** 56 \| **Execution Class:** A+H

**What Happens in This Step:** This application harvests the closed deal twice: once for marketing and once for reuse. On the marketing side it manages the tombstone, lucite, swag, and closing gift, plus the firm website update. On the asset side it captures deal learnings and extracts reusable materials from the full document trail — pitch, teaser, MP (management presentation), advocacy deck, Q&A, buyer email, LOI (Letter of Intent), definitive agreement, and QoE (Quality of Earnings) report — tagging each for the firm's asset library. Per v9 cross-references, its output feeds the Case Study Library, and it receives deal credentials and league-table credit from the League Table Submission Agent.

**Inputs → Outputs:** The closed-deal document set from pitch through definitive agreement → tombstone/website/gift deliverables plus tagged reusable assets filed into the credential database and slide library.

**Systems:** Firm website/CMS, SharePoint (M365) asset library and best-practice folders, HubSpot marketing queue.

**Learning Loop:** Updates the credential database, slide library, read-only best-practice folders, meta-tags, sector playbooks, and the marketing queue; every closed deal becomes a structured case-study entry for future pitches.

**Compliance Gate:** Client consent required; confidentiality scrub of every harvested asset; final-terms accuracy verified before publication; no unapproved case-study use; comms approval before anything is published.

### Seq 63: Earned / Paid Publication

**Phase:** 5 \| **Build Responsibility:** RTS \| **RTS Build \#:** 57 \| **Execution Class:** A+H

**What Happens in This Step:** Within 48 hours of the deal announcement, this application pursues earned media first — journalist coverage of the transaction — and turns to paid placement or a contributed article/op-ed only where strategically useful and clearly disclosed as paid. Bylined pieces carry the MD (Managing Director) byline. Content is limited to contextual deal insight; MNPI (material nonpublic information) is never included. The agent drafts and pitches; humans approve everything before it reaches an editor.

**Inputs → Outputs:** Approved announcement facts and deal narrative → earned-media pitches to trade press plus drafted bylined articles or op-eds for MD and comms review.

**Systems:** Comms/PR tooling and the sector trade-press relationship map; drafts in M365; HubSpot for reach tracking.

**Learning Loop:** Updates the marketing reach database, the MD-byline credential library, and the sector trade-press relationship map so each placement improves the next one.

**Compliance Gate:** Client consent for any byline content; final-terms accuracy; MD plus Comms approval before pitching or publication; advertorial/paid-placement disclosure wherever required; no MNPI.

### Seq 64: Deal Learning / Post-Mortem

**Phase:** 5 \| **Build Responsibility:** RTS \| **RTS Build \#:** 58 \| **Execution Class:** A+H

**What Happens in This Step:** The structured post-mortem that closes the learning loop on every deal. The debrief captures what worked and what failed, buyer feedback, process timing, fees, diligence issues, the winning buyer's rationale, lost-buyer reasons, template improvements, and banker lessons. Findings are converted into approved reusable playbooks under the controlled-learning rules: edits, outcomes, buyer feedback, and accepted outputs become firm knowledge without training indiscriminately on client-confidential data. v9 classifies this agent SECRET SAUCE — it is part of the firm's core competitive moat and is never disclosed externally.

**Inputs → Outputs:** Full deal record, buyer feedback, and deal-team debrief → post-mortem findings plus approved updates to skills, prompts, buyer scores, and sector playbooks.

**Systems:** Platform learning store, HubSpot (CRM) for buyer-score and relationship writebacks, SharePoint (M365) training library.

**Learning Loop:** Updates skills, prompts, buyer scores, sector playbooks, model assumptions, CRM, the training library, and future campaign targeting; feeds structured case-study entries to the Case Study Library.

**Compliance Gate:** Confidential client data is separated from generalized learning; reusable patterns require approval before they enter shared playbooks, keeping client-confidential material out of firm-wide assets.

### Seq 65: Tail Rights & Termination Monitor

**Phase:** 5 \| **Build Responsibility:** RTS \| **RTS Build \#:** 59 \| **Execution Class:** A

**What Happens in This Step:** This agent activates on either of two triggers: the engagement letter (EL — the contract that hires the bank) does not result in a close, or the engagement is terminated, whether by automatic expiration or voluntary termination. It tracks the tail period — the post-termination window defined in the EL during which a subsequent sale of the client still owes the bank a fee. Throughout that window it monitors the relevant buyers from the process, watches for capital-raise and change-of-control events involving the client, tracks fee triggers, and follows client/buyer activity during the tail. As tail expiration approaches, it sends date-approaching alerts to the deal team and the group head so any live fee right is asserted before it lapses.

**Inputs → Outputs:** EL tail terms and termination type + buyer list and public market-event feeds → tail calendar, fee-trigger alerts, potential fee claims, and Pipeline CRM funnel status (Terminated or Died).

**Systems:** HubSpot (Pipeline CRM — customer relationship management) for tail calendar, reminders, and funnel status; Capital IQ/PitchBook for public-event monitoring; SharePoint evidence folder.

**Learning Loop:** Updates the tail calendar, termination type, potential fee claims, CRM reminders, public-event alerts, and the evidence folder, and writes funnel status into Pipeline CRM as Terminated or Died — so the firm's pipeline data and future fee-claim posture stay accurate after a mandate ends.

**Compliance Gate:** All monitoring must be engagement-letter aligned, per the EL's tail terms; fee-trigger events are logged as they occur to build the evidence record; the agent is not used for closed deals; **legal/commercial review before any fee claim is asserted**.

# Glossary

| **Term** | **Meaning** |
|----|----|
| Sell-side / buy-side | Representing the seller vs. a buyer. This playbook is sell-side. |
| Mandate | The signed engagement to represent a client — "winning the mandate" = being hired |
| Engagement Letter (EL) | The contract that hires the bank: retainer, success fee, tail, expenses |
| Retainer / success fee / tail | Monthly fee; fee paid on closing; post-termination period in which a sale still owes us a fee |
| Strategic vs. sponsor | Corporate acquirer vs. private-equity buyer |
| Teaser | 1–2 page anonymous profile used to test buyer interest (no company name) |
| CIM | Confidential Information Memorandum — the detailed selling document, shared only after an NDA; frequently known as the Management Presentation (MP) |
| MP | Management Presentation — the presentation of the business delivered by management to buyers in management meetings |
| Operating System (OS) | The platform layer — data, orchestration, governance, and the horizontal applications — built by the OS engineering team |
| Horizontal application | An always-on platform application available to every workflow step (e.g., enterprise search, model optimization) |
| Application layer | The deal-workflow skills built by RTS on top of the Operating System |
| CCO | Chief Compliance Officer — the firm's senior compliance executive; supervisory and licensing alerts route here |
| NDA / MNDA | (Mutual) non-disclosure agreement; gates access to private information |
| IOI | Indication of Interest — a non-binding first-round offer |
| LOI | Letter of Intent — later-stage offer, usually granting exclusivity |
| Exclusivity | Agreed period negotiating with one buyer only |
| Definitive agreement | The final, binding purchase contract |
| Diligence | The buyer's verification of the business (financial, legal, technology, customers) |
| VDR / data room | Secure online repository of diligence documents |
| WGL | Working Group List — the deal contact roster, segregated so buyers never see each other |
| MNPI | Material non-public information — the legally sensitive core of every deal |
| Information barrier / clean team | Controls limiting who sees sensitive data; a "clean team" sees the most restricted items |
| Code name | Alias for the seller and every counterparty; real identities are access-controlled and logged |
| Comps / precedents | Valuation benchmarks: comparable public companies; past similar transactions |
| Pitchbook | The presentation used to win the mandate |
| League tables | Published advisor rankings (Mergermarket, LSEG, Dealogic…); credit is claimed at announcement |
| HSR | Hart-Scott-Rodino — the US antitrust filing/approval required on larger deals |
| Earnout / escrow | Post-close contingent payments; held-back funds released over time |
| Tombstone | The public "we did this deal" credential (announcement graphic) |
| Finalis Securities | The broker-dealer of record (Member FINRA/SIPC); Ignatious operates under its regulatory umbrella — supervision, records, and fee collection flow through it |
| Reg FD / FINRA 2210 / SEC 17a-4 | US rules on fair disclosure; approval of external communications; record retention |
