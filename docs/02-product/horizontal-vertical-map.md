# Conductia: The Horizontal/Vertical Map

**One canonical picture of the sell-side platform: the horizontal rails every deal runs on, and the vertical skills that do the work at each step.** Extracted 2026-07-08 from the Master Process & Build Sequence v2, the Execution Guide v2, the process whiteboard, the Compliance Build Plan, and the 2026-07-07 working-call notes. Status: for Storm's 1-on-1 review before the wider group.

## The model in one minute

- **Horizontal = the rails.** Everything that spans the whole deal lifecycle: the workflow engine that advances a deal through 5 phases and 65 steps, plus 21 always-on platform applications (search, QC, compliance, orchestration). **Futureproofing builds the horizontal layer** at the Operating System level.
- **Vertical = the skills.** The work that happens at a specific step: valuation, pitch deck, buyer outreach, diligence answers. Each step is one "application" — an agentic workflow with defined human control. **RTS builds the vertical skills** that run on the rails.
- **Hybrid\*** = a step that sits at a specific point on the timeline but is built by the horizontal team (e.g. Lead Registration, Codename/Deal Shell, Mandate Activation) — infrastructure that happens to live at one step.
- **Ignatious** supplies the process truth: step descriptions, ordering, prioritization (each vertical step gets a 5-page spec assigned to a banker + an RTS team member; integration is step-locked between the teams).
- **How a step runs:** every step carries an execution class — **A** (fully agentic) · **A+H** (agent does the work, banker approves) · **H+A** (human leads, agent checks) · **H** (fully human, agents observe to learn). Any step can be **skipped with logged human approval** (the reason routes to the right next step), any completed step can be **edited later** (outputs are versioned: Pitch Valuation V1/V2…), and every step is assigned to a human or an agent **with a deadline or priority tag**.

## Before the rails: Gate 0 (deal creation)

Four things happen before Step 1, every time:

1. **Assign a team (select team members/permissions)**
2. **Create a code name**
3. **Notify compliance and management**
4. **Confirm where in the lifecycle the deal is entering**

Gate 0 also confirms **where in the lifecycle the deal enters** — a mandate can arrive mid-process, and the rails start at the right step, not step 1.

## The deal lifecycle — 5 phases, 65 steps

★ = one of Storm's 16 priority builds. *Runs* shows the execution class. *Builds* = who builds that step's application.

### Phase 1: Origination, Qualification & Mandate  (25 steps)

Nothing signed yet: find and vet the opportunity, research company and buyers, win the mandate, sign the Engagement Letter.

**Who runs it today:** MD — relationship, pursue/pass, EL; Analyst/Assoc — research, pitch; Compliance — conflicts. **Tools today:** HubSpot (light), S&P Capital IQ, PitchBook, M365, email.

| # | Step | Layer | Builds | Runs | Input → Output | Tools |
|---|---|---|---|---|---|---|
| 1 | **Target Universe** | Vertical | RTS | Agent → human approves | Sector and company screening data → Prioritized target lists with thesis tags, source citations, and outreach priorities | Capital IQ, PitchBook, HubSpot (CRM) |
| 2 | **Exit Readiness** | Vertical | RTS | Agent → human approves | Funding, ownership, and pressure signals per company → Seller-propensity score with timing hypothesis, likely rationale, banker owner, and next action | Capital IQ, PitchBook, HubSpot (CRM) |
| 3 | **Acquirer Strategy** | Vertical | RTS | Agent → human approves | Buyer M&A history, capital capacity, and strategic-priority data → Likely-buyer list with targets-per-buyer map, acquisition criteria, and corp-dev contacts | Capital IQ, PitchBook |
| 4 | **Lead Registration** ★ | Hybrid* | Futureproofing (OS) | Agent | Inbound lead, referral, or MD-originated opportunity → Registered lead record in the funnel with source, owner, size, and confidentiality level | HubSpot (CRM) |
| 5 | **Source Intelligence** ★ | Vertical | RTS | Agent → human approves | Referrer/supporter conversations → Structured intelligence record: client goals, decision criteria, stakeholder map, competing banks, win probability, path to mandate | HubSpot (CRM) |
| 6 | **Conflicts Checklist** | Hybrid* | Futureproofing (OS) | Human leads, agent checks | Company, counterparties, and firm history → Completed conflicts/restricted-list check with status, walling notes, and required approvals | Compliance restricted list, HubSpot (CRM) |
| 7 | **Codename / Deal Shell** ★ | Hybrid* | Futureproofing (OS) | Agent → human approves | Qualified opportunity → Codename and deal shell with folder structure, early access list, confidentiality level, allowed document categories, and audit identifier | SharePoint (M365), HubSpot (CRM) |
| 8 | **Relationship Pathing** ★ | Vertical | RTS | Agent → human approves | Company ownership, board, and contact data → Decision-maker/influencer map with warm paths, best introducers, and board/investor alignment map | HubSpot (CRM), Knowledge Graph / Relationship Strength application (horizontal, OS Build #15) |
| 9 | **MD Briefing + Company Backgrounding** ★ | Vertical | RTS | Agent → human approves | Public and internal data on the company → Single briefing document: MD brief + source-cited company profile + ranked detailed case studies with objection cross-references | Capital IQ, PitchBook, HubSpot (CRM) (+1) |
| 10 | **Meeting Intelligence** | Vertical | RTS | Agent → human approves | Consent-gated meeting capture (or MD notes) → Structured summary with deal facts, sensitivities, action items, and CRM updates | Meeting notes/transcription tooling, HubSpot (CRM), Client Consent Tracker |
| 11 | **Deal Qualification** | Vertical | RTS | Human leads, agent checks | Opportunity profile and firm context → Qualification score with go/no-go recommendation and documented pursue/pass reasons | HubSpot (CRM) |
| 12 | **Client NDA Workflow** ★ | Vertical | RTS | Agent → human approves | Client NDA need → Prepared, precedent-compared NDA with tracked execution status and archived executed document, gating any private-document request | Word (M365) / contract templates, SharePoint (executed-document archive) |
| 13 | **Initial Diligence Request List** ★ | Vertical | RTS | Agent → human approves | Sector-specific templates + company profile → Tailored initial diligence request list, sent to the company only after NDA execution | Word (M365), Diligence-template library |
| 14 | **Outreach Strategy** ★ | Vertical | RTS | Agent → human approves | Persona and company data → Per-person approach, angle, likely objections, and personalized outreach sequence | HubSpot/CRM |
| 15 | **Strategy / SWOT** | Vertical | RTS | Agent → human approves | Company and market data → Strategy memo covering SWOT, strategic alternatives, why-sell-now rationale, buyer theses, valuation drivers, and recommended process strategy | Capital IQ, Word (M365) |
| 16 | **Stakeholder Psychology** | Vertical | RTS | Agent → human approves | Stakeholder data → Decision-style / anxiety / objection map plus a board–investor alignment map | HubSpot/CRM |
| 17 | **Buyer Universe** ★ | Vertical | RTS | Agent → human approves | Strategic and sponsor screening data → Ranked buyer universe with per-buyer rationale, contacts, access paths, ability-to-pay assessment, and likelihood-to-engage score | Capital IQ, PitchBook, HubSpot/CRM |
| 18 | **Case Study Library** | Vertical | RTS | Agent | Firm deal history plus curated external precedents → 3–5 highest-relevance case studies surfaced automatically into briefings and pitch materials | Internal deal database (SharePoint/M365) |
| 19 | **Engagement Economics** | Vertical | RTS | Agent → human approves | Firm fee history plus anonymized pool benchmarks → Proposed fee / retainer / success-fee / tail structure with rationale and accepted/fallback positions | Fee precedent database, Operating System Fee Structure Pool feed, Excel |
| 20 | **Engagement Letter Strategy** | Vertical | RTS | Agent → human approves | Firm clause library plus deal specifics → Internal EL framework with key provisions, risk positions, and drafting notes | CLM (contract lifecycle management), Word |
| 21 | **Pitchbook Drafting** | Vertical | RTS | Agent → human approves | Firm template plus upstream outputs (strategy/SWOT, buyer universe, engagement economics, case studies, league-table data) → Client-ready pitch deck with source appendix | PowerPoint, Firm template library, Capital IQ (+1) |
| 22 | **Pitch Page QC** ★ | Vertical | RTS | Agent → human approves | Draft pitch deck → Page-by-page QC findings and fixes, with a pass/fail result gating release | PowerPoint |
| 23 | **Pitch Rehearsal** | Vertical | RTS | Human leads, agent checks | Final deck plus team roster → Rehearsal pack (speaking roles, page owners, likely objections, Q&A, dry-run notes, follow-up owners, logistics) | Platform (internal), M365 |
| 24 | **Pitch Follow-Up** | Vertical | RTS | Agent → human approves | Pitch debrief plus stakeholder map → Follow-up drafts, promised-deliverables tracker, and open-question list | HubSpot/CRM, Outlook/M365 email |
| 25 | **Engagement Negotiation** | Vertical | RTS | Human leads, agent checks | Approved EL draft plus client redlines → Negotiated, fully executed Engagement Letter with complete version history | CLM / Word, Negotiation Copilot precedent database (OS Build #16) |

### Phase 2: Preparation & Market Readiness  (13 steps)

The bank is hired. The team mobilizes, stages the company for market, writes the selling documents (Teaser, CIM/MP).

**Who runs it today:** VP — runs prep; Analyst — model, materials; MD — approves narrative & buyer list. **Tools today:** Excel, Word/PPT, SharePoint, VDR (Box / Datasite — varies), S&P Capital IQ, PitchBook.

| # | Step | Layer | Builds | Runs | Input → Output | Tools |
|---|---|---|---|---|---|---|
| 26 | **Mandate Activation Checklist** | Hybrid* | Futureproofing (OS) | Agent → human approves | Executed EL + won-pitch record → Completed activation checklist, live deal workspace, and a registered mandate in the CRM | HubSpot (CRM), Compliance log, M365/SharePoint deal workspace and permission groups |
| 27 | **Win/Loss Debrief** | Vertical | RTS | Agent → human approves | Pitch outcome + deal-team and client feedback → Structured debrief record feeding the pitch-performance database | HubSpot (CRM), Internal pitch-performance database |
| 28 | **Kickoff / Org Meeting** | Vertical | RTS | Human leads, agent checks | Kickoff meeting content → Initial WGL, milestone targets, responsibility matrix, deliverable list, and cadence plan | Operating System (task engine, project dashboard), M365/SharePoint, Meeting notes |
| 29 | **Timeline** | Vertical | RTS | Agent | Sector/size/transaction-type template + kickoff milestone targets → Living transaction timeline with baseline-variance tracking and slippage alerts | Operating System, Excel/Google Sheets |
| 30 | **WGL** | Vertical | RTS | Agent → human approves | New contacts and party changes from every workstream → The always-current, visibility-segregated WGL | Shared online document (M365/SharePoint), HubSpot (CRM) |
| 31 | **VDR Setup** | Vertical | RTS | Agent → human approves | Deal scope + document plan → Configured VDR with folder taxonomy, permissions, and documented clean-team carve-outs | VDR (Box/Datasite or client-selected provider), M365/SharePoint staging |
| 32 | **Document Intake / Metadata** | Hybrid* | Futureproofing (OS) | Agent | Raw client document inflow → Curated, tagged, metadata-complete corpus plus a document-health report | M365/SharePoint, VDR |
| 33 | **Data Room Diligence** | Vertical | RTS | Agent → human approves | Populated data room → Risk register, missing-info log, strengths/weaknesses memo, strategic-info index, clean-team taxonomy, and remediation task list | VDR, Excel trackers, Operating System |
| 34 | **Financial Normalization** | Vertical | RTS | Human leads, agent checks | Raw historical financials + KPI/cohort data → Normalized financial database, assumptions log, and model-ready inputs with full source mapping | Excel/Google Sheets, Client accounting exports, M365/SharePoint |
| 35 | **Deal Pulse Checklist** ★ | Vertical | RTS | Agent | Live task, timeline, and document status across the deal's applications → Daily/weekly pulse digest to the deal team (plus the recurring weekly client update) | Operating System (task engine, timeline, document trackers), Email distribution |
| 36 | **Teaser** | Vertical | RTS | Agent → human approves | Approved deal data → Anonymized 1–2 page teaser / blind profile, checked for de-anonymization risk and queued for client and banker approval | Word/PowerPoint (M365), SharePoint deal shell |
| 37 | **CIM / Management Presentation** | Vertical | RTS | Agent → human approves | Approved, normalized deal data → CIM plus Management Presentation in the firm template, with a complete source/citation map | Word (M365), PowerPoint (M365), SharePoint/VDR |
| 38 | **FAQ&A** ★ | Vertical | RTS | Agent → human approves | Anticipated buyer questions plus every live question from MP, calls, diligence, Q&A, and follow-ups → A continuously updated, source-linked buyer FAQ&A | Platform (reusable Q&A knowledge base), M365/SharePoint, VDR |

### Phase 3: Marketing & First-Round Bids  (7 steps)

The process goes live. Buyers approached under a code name; interest converts into first-round offers (IOIs).

**Who runs it today:** MD/VP — outreach, strategy, meetings; Associate — trackers, Q&A; Analyst — weekly updates. **Tools today:** Email, VDR, Excel / Google Sheets trackers, manual call notes.

| # | Step | Layer | Builds | Runs | Input → Output | Tools |
|---|---|---|---|---|---|---|
| 39 | **Outreach Sequencing** | Vertical | RTS | Agent → human approves | Approved buyer universe + conflicts/restricted-list clearance → Wave plan with banker owners, tailored rationale, call scripts, and follow-up cadence in the CRM | HubSpot (CRM), Outlook/M365 email, SharePoint (outreach plan) |
| 40 | **Buyer Synergies Model + Valuation** | Vertical | RTS | Human leads, agent checks | Named buyer list + approved target financials and CIM data → Per-buyer synergies summary, accretion/dilution model, and ability/willingness-to-pay valuation | Excel (deterministic model engine), Capital IQ, PitchBook (+1) |
| 41 | **Buyer Log / Feedback** | Vertical | RTS | Agent → human approves | Outreach activity + buyer responses → Complete CRM buyer log with pass reasons, drafted follow-up outreach, and targeted coverage lists | HubSpot (CRM) as system of record, Outlook/M365 email |
| 42 | **Buyer NDA** | Vertical | RTS | Agent → human approves | Buyer NDA drafts and redlines → Executed-NDA status tracker with legal issue list, precedent-deviation comparison, and VDR-access-readiness flags | CLM (Contract Lifecycle Management) tooling, VDR (varies by deal), SharePoint (NDA archive) |
| 43 | **Buyer VDR Access** | Hybrid* | Futureproofing (OS) | Agent → human approves | Executed NDAs + client approval → Staged, watermarked, permissioned VDR access per buyer group with complete access and download logs | Operating System access-control layer, Deal VDR (provider varies by deal) |
| 44 | **Management Meeting** | Vertical | RTS | Human leads, agent checks | Buyer profile + approved CIM and synergies materials → Buyer-specific deck, coaching notes, anticipated-question prep, and post-meeting summary with next steps | PowerPoint (M365), Meeting notes/transcript capture, SharePoint |
| 45 | **Buyer Q&A** | Vertical | RTS | Agent → human approves | Incoming buyer questions → Owner-assigned, source-linked, approved answers plus a continuously updated FAQ&A | Operating System Q&A tracker, VDR Q&A module (varies by deal), SharePoint |

### Phase 4: Diligence, LOI & Definitive Docs  (5 steps)

Offers on the table. Narrow to one buyer under LOI; the buyer verifies everything while lawyers negotiate the definitive agreement.

**Who runs it today:** MD/VP — negotiation; Outside counsel — documents; Analyst — diligence support; Client — approvals. **Tools today:** VDR, Word, Excel, email.

| # | Step | Layer | Builds | Runs | Input → Output | Tools |
|---|---|---|---|---|---|---|
| 46 | **LOI / Process Letter** | Vertical | RTS | Agent → human approves | Advancing-bidder list + process timeline and required terms → Distributed process letters / LOI forms, per-bidder version and redline history, deadline calendar | Word / M365, SharePoint (bidder instruction log, LOI tracker, process calendar) |
| 47 | **Bid Comparison** | Vertical | RTS | Agent → human approves | Received IOIs / bids and their underlying documents → Term-by-term bid comparison matrix + next-round strategy input, with updates to the bid database | Excel, Bid database, term precedent library, and buyer reliability scores (platform / SharePoint) |
| 48 | **LOI Review** | Vertical | RTS | Human leads, agent checks | Selected buyer's LOI draft + exclusivity terms → Negotiation points, fallback positions, risk map, and client decision memo | CLM / Word (M365), Negotiation Copilot precedent library (OS Build #16), SharePoint |
| 49 | **Merger Agreement Distribution** | Vertical | RTS | Agent → human approves | Counsel's form merger / purchase agreement + distribution list → Distributed agreement, comment and issue tracker, buyer position log, version history | CLM (Contract Lifecycle Management), VDR (provider varies by deal), SharePoint / M365 (version tracking) |
| 50 | **Definitive Agreement Support** | Vertical | RTS | Human leads, agent checks | Purchase agreement drafts and redlines, confirmatory diligence requests, VDR activity, and counsel issue lists → Live issue log, disclosure schedule tracker, closing conditions checklist, and open-points status with owners | VDR (varies by deal), CLM (Contract Lifecycle Management) tool, M365/SharePoint (+1) |

### Phase 5: Signing, Closing & Post-Close  (15 steps)

Sign, announce, close — money moves under maximum human control; records, fees, and lessons are harvested (incl. the no-close/tail branch).

**Who runs it today:** VP/Analyst — closing mechanics; MD — sign-off; Finalis — billing / collection; Compliance — records. **Tools today:** Word / Excel / email, Word invoice → Finalis, manual league-table sites.

| # | Step | Layer | Builds | Runs | Input → Output | Tools |
|---|---|---|---|---|---|---|
| 51 | **Signing / Announcement Prep** | Vertical | RTS | Agent → human approves | Signed definitive agreement + deal record → Signing checklist, board/client updates, announcement/press-release/tombstone drafts, closing timeline, and stakeholder communications plan | Word/PowerPoint (M365), SharePoint |
| 52 | **Announcement** | Vertical | RTS | Human leads, agent checks | Approved announcement package from Seq 51 + client confidentiality constraints → Coordinated public release (press, web, social) with final transaction description, quotes, and approved tombstone | Communications/PR tools, Firm website queue, M365/SharePoint (+1) |
| 53 | **LinkedIn Post** | Vertical | RTS | Agent → human approves | Announcement facts + deal-team roster + MD-approved quote → Approved LinkedIn post queued and released at the announcement timestamp | LinkedIn (queued via the firm's comms/social tooling), HubSpot (engagement tracking) |
| 54 | **Email Blast** | Vertical | RTS | Agent → human approves | Deal announcement + segmented CRM contact lists → Pre-staged, personalized email blast released on announcement | Outlook/M365 email, HubSpot (CRM) distribution lists and engagement tracking |
| 55 | **League Table Submission** | Vertical | RTS | Agent → human approves | Signed transaction details + deal-team attribution → Submissions to every league-table/aggregator platform, confirmation receipts, and post-publication correction filings | Mergermarket, LSEG Workspace / Refinitiv SDC, Dealogic (+5) |
| 56 | **Regulatory Approval Tracker** | Vertical | RTS | Agent | Signed definitive agreement conditions + regulatory requirements → Live approval checklist with deadlines, responsible parties, evidence, and escalation alerts | Platform tracker (M365/SharePoint checklist, Excel exports) |
| 57 | **Closing Checklist** | Vertical | RTS | Human leads, agent checks | Definitive agreement, funds-flow memo, wire instructions, signature pages, certificates, board approvals, and condition list → Completed closing checklist with document status, confirmed funds flow, and final releases | Word/Excel (checklist and funds-flow tracking), SharePoint (M365) document record |
| 58 | **Fee Realization / Invoice** | Vertical | RTS | Agent → human approves | Executed engagement letter, closing terms (final transaction value), retainer and expense records, and partner-split terms → Approved invoice package (invoice + executed EL + client cover email) routed to the MD, with collection via Finalis | Word (invoice template and cover email), Finalis (payment collection), Excel (fee calculation support) |
| 59 | **Closing Compliance Checklist / Binder** | Vertical | RTS | Agent → human approves | Executed deal documents, approvals, communications, diligence records, fee evidence, and the public announcement → Closing binder, retention checklist, final transaction record, and compliance evidence package | SharePoint (M365) as archive of record, Deal folders, email, VDR (source records) |
| 60 | **Post-Close Fee Monitor** | Vertical | RTS | Agent → human approves | Engagement-letter fee terms plus purchase-agreement earnout, escrow, and milestone schedules → Fee-event alerts, collection tasks, and draft trailing invoices for human release | Platform fee tracker, Finalis (collection), Excel (fee calculations) |
| 61 | **Relationship Follow-Up (closing dinner)** | Vertical | RTS | Human leads, agent checks | Deal-team roster and client/buyer contact history → Dinner/celebration plan, thank-you note drafts, gift suggestions, and a testimonial/reference/referral task list for the relationship owner | HubSpot (CRM), Outlook/M365 |
| 62 | **Transaction Marketing / Asset Library** | Vertical | RTS | Agent → human approves | The closed-deal document set from pitch through definitive agreement → Tombstone/website/gift deliverables plus tagged reusable assets filed into the credential database and slide library | Firm website/CMS, SharePoint (M365) asset library and best-practice folders, HubSpot marketing queue |
| 63 | **Earned / Paid Publication** | Vertical | RTS | Agent → human approves | Approved announcement facts and deal narrative → Earned-media pitches to trade press plus drafted bylined articles or op-eds for MD and comms review | Comms/PR tooling, Sector trade-press relationship map, M365 (drafts) (+1) |
| 64 | **Deal Learning / Post-Mortem** | Vertical | RTS | Agent → human approves | Full deal record, buyer feedback, and deal-team debrief → Post-mortem findings plus approved updates to skills, prompts, buyer scores, and sector playbooks | Platform learning store, HubSpot (CRM), SharePoint (M365) training library |
| 65 | **Tail Rights & Termination Monitor** | Vertical | RTS | Agent | EL tail terms and termination type + buyer list and public market-event feeds → Tail calendar, fee-trigger alerts, potential fee claims, and Pipeline CRM funnel status (Terminated or Died) | HubSpot (Pipeline CRM), Capital IQ/PitchBook (public-event monitoring), SharePoint evidence folder |

## Three layers (Storm 07-08: "always-on is different than horizontal")

Storm is right that the always-on platform is not the same thing as the horizontal workflow. The model is **three** layers, not two:

- **Platform (always-on substrate)** — Infra that runs regardless of any deal or step: security/isolation, audit log, access control, storage, search, comms surveillance, cost/time metering, knowledge graph. *Built by Futureproofing (OS).*
- **Horizontal workflow rails** — The engine that carries a deal through the 65 steps: orchestration, step advancement + next-step recommender, QC gates, pipeline, verification. *Built by Futureproofing (OS).*
- **Vertical step-skills** — The per-step agents/skills that do the work at one step (59 builds). *Built by RTS.*

### Layer 1 — Platform (always-on substrate) · 14 apps

Runs regardless of any deal or step. ★ = priority build. *(proposed)* = added from Storm's note 5.

| Application | What it does | OS build # |
|---|---|---|
| **Multi-Model Verification** | 2+ independent models cross-check consequential outputs; discrepancies escalate | 7 |
| **Document Retention + Permission Cross-Check** | Retention/permission tagging; dual-control deletions (FINRA 4511 / SEC 17a-3/4) | 12 |
| **License / U4 / CE Compliance Tracker** | Tracks each banker's FINRA license, U4, CE; alerts the bank's (Chief Compliance Officer/CCO) | 13 |
| **Knowledge Graph / Relationship Strength** | Who-knows-whom graph, scored; warm-path discovery | 15 |
| **File Storage Reorganization** | Reorganizes SharePoint/Drive with permissions preserved | 18 |
| **Fee Structure Pool** | Anonymized cross-firm fee benchmarks — platform only | 21 |
| **Enterprise Search** | Permission-aware search and Q&A across the firm's documents, emails, and deal records; every query respects deal walls and is logged | 23 |
| **Model Optimization** | Routes each task to the most cost-effective model that clears the quality bar; tracks AI spend by user, deal, and task | 24 |
| **Data Room Hosting** | Hosted, permissioned data-room layer (Box) with tagging, staged access, and AI-readable APIs, sitting above SharePoint | 25 |
| **Communication Checking** | Communications compliance layer (Global Relay / Smarsh): capture, archiving, and surveillance of business communications | 26 |
| **Staffing** | Assigns bankers and agents to mandates and tracks deal-team capacity across live deals | 27 |
| **Agentic Containment** *(proposed)* | No agent spins out of control: token ceilings, document-change limits, external-email block, per-deal + global kill switch, autonomous-action logging. | — |
| **Time & Cost Tracking** *(proposed)* | Tracks banker hours AND AI spend by user, deal, and task (extends Model Optimization's cost view with time). | — |
| **Information Knowledge Graph** *(proposed)* | Meta-tagged knowledge graph over documents and deals — the firm controls the graph. Distinct from the people relationship graph (#15). | — |

### Layer 2 — Horizontal workflow rails · 10 apps

The engine that carries a deal through the 65 steps — including the **next-step recommender** (after each step, a ranked suggestion + full-step dropdown, most-likely surfaced).

| Application | What it does | OS build # |
|---|---|---|
| **External-Send QC** ★ | Final gate on every external artifact: recipients, attachments, code names, metadata, Reg FD / FINRA 2210 | 1 |
| **Pipeline CRM** ★ | Single firm-wide funnel (live lead → won/lost/hold/terminated/died) — moved here (firm-wide, not one stage) | 3 |
| **Work-Check** ★ | Checks every agent output before a senior banker sees it (consistency, citations, numbers, code-name map) | 4 |
| **Sector Intelligence** ★ | Maintains comps, precedents, market maps, competitive quadrants; monthly refresh | 6 |
| **Expert Panel Review** | Static + deal-specific panels red-team consequential work product | 8 |
| **Continuous Learning / Skill Optimization** | Captures deal patterns/edits; proposes prompt & template improvements | 10 |
| **Deal Workflow Coordinator** | Routes tasks, holds deal-state, monitors SLA, aggregates dashboard | 11 |
| **MD-Style Review** | Applies the named MD's approved voice before MD review | 14 |
| **Negotiation Copilot** | Counter-positions + precedent for ELs, NDAs, LOIs, definitive terms | 16 |
| **Workflow Monitoring** | Opt-in; surfaces repetitive patterns as new agent candidates | 17 |

## Build responsibilities

- **Futureproofing (Operating System team):** the workflow engine + rails, all 24 always-on applications, and 6 hybrid steps in the sequence (lead registration, conflicts, codename/deal shell, mandate activation, document intake, buyer VDR access). Orchestration, audit, tracking.
- **RTS (Markus, Svetozar):** 59 of the 65 step-applications — the vertical skills. Build order runs by the RTS Build # in the Master Process (first twelve of Storm's 16 priorities are RTS steps in Phases 1–2).
- **Ignatious:** process expertise — step descriptions, per-step 5-page specs (banker + RTS pairing), prioritization, and the sample deal folder ('Blinky') for RTS testing.
- **Step-lock:** integration and testing lock step-by-step between the two teams; the 4 execution classes define the human/agent contract per step.

## Why 65 and not 82

The earlier ~82 was a flat count that folded platform services into the sequence. v2 lifts the 21 always-on apps out into a separate layer, leaving 65 sequenced steps. 65 + 21 = 86 build items — same universe, re-partitioned; nothing dropped.

## Ownership — needs your confirm

Storm's 07-08 note reads 'Horizontal -> RTS, Vertical -> Conductia', which inverts our canon (Futureproofing = horizontal, RTS = vertical, per the working-call roles) and names an entity absent from every source. Two confirms needed: (1) ownership direction; (2) what 'Conductia' denotes. Not adopted into canon pending Storm.

## How the 16 priorities sequence

Sequence within the 16: the 4 always-on substrate apps first (External-Send QC, Pipeline CRM, Work-Check, Sector Intelligence) as the foundation, then the Phase-1 RTS spine (Source Intelligence, Relationship Pathing, MD Briefing, Client NDA, Diligence List, Outreach, Buyer Universe, Pitch QC) + Deal Pulse + FAQ. Storm's ranking overrides.

## Compliance & Trust spine

Regimes covered by the Compliance Build Plan: **SOC 2 Type II · 17a-4 WORM · FINRA 2210/4511 · DORA + EU residency · ISO 42001**.

- MVP: append-only inference audit log, access control + info barriers, data isolation, egress control, zero-retention LLM terms
- Pilot: WORM/17a-4 export (Smarsh/Global Relay), supervision workflow, VPC + CMEK, model change mgmt (SR 11-7)
- Diligence-grade: lineage & replay, agentic guardrails + kill switch, CCO console, SOC 2 report issued
- Scale: ISO 42001, on-prem/air-gapped, full DORA + residency

GDPR currently covered by proxy (residency + DORA + DPAs); to be named explicitly.

## What we need from you

- **Inputs:** the Blinky sample deal folder (+ a strong pitch/advocacy deck) for RTS; your ranked order within the 16; sign-off on the v1 subset.
- **Confirms:** ownership direction + what "Conductia" is (see above); the six decisions below.

## Open questions for Storm

1. **Step count:** confirmed as **65 sequenced steps + 21 always-on apps** (see crosswalk above) — intentional re-partition, nothing dropped. Confirm you're happy with it.
2. **Phase count is settled as 5** (whiteboard + Master Process v2); the 7-phase deck slide maps in (Diligence+Negotiation → P4, Signing+Close → P5). Confirm the deck gets updated, not the process.
3. **V1 subset of the always-on layer:** 21 apps are catalogued; the 4 shaded priorities (External-Send QC, Pipeline CRM, Work-Check, Sector Intelligence) look like the v1 cut. Bless a v1 subset?
4. **CIM drafting (Seq 37) and Negotiation Copilot (OS #16)** carry build numbers but the v1 exclusions defer both. Confirm: in catalog, not in v1.
5. **Models v1:** single provider behind the router seam now; Multi-Model Verification (OS #7) and Model Optimization (OS #24) activate that seam later. Confirm.
6. **Pre-Send QC verdict shape:** binary block (handbook) vs green/yellow/red with logged yellow (vision 2-pager) vs rush-send override (execution guide). One canonical answer needed before the QC surface is built.

## Sources

Master Process & Build Sequence v2 (2026-07-08) · Sell-Side M&A Execution Guide v2 (2026-07-08) · Ignatious Sell-Side Process whiteboard (2026-07-07) · Deal-lifecycle deck slide + Slack gate-0 note · Compliance Build Plan v2 · Working-call notes (2026-07-07) · Conductia 101 canon (Product Blueprint v11, Founders Planning Session, Handbook, Vision 2-pager, Seed Deck 10, RTS + demo notes). Full traceability: `docs/06-research/hv-extraction/` (ledger + conflict log).
