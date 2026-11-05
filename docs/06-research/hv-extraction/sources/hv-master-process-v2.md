**Ignatious Sell-Side M&A\
Master Process & Build Sequence**

**Status:** Working draft — steps may be added or removed; build responsibilities are a first take, to be validated jointly

**Note:** Please read with the companion document, Sell-Side M&A Execution Guide, which carries the full per-step detail and execution class

# Background Information

**Regulatory wrapper:** Ignatious operates through Finalis Securities LLC (Member FINRA/SIPC), the broker-dealer of record — supervision, recordkeeping, and fee collection flow through it. Everything below sits inside that perimeter.

**What this document is:** The build backlog for the sell-side platform: every step of selling a company numbered in the order a deal unfolds (**Seq \#**), organized into the same **five phases** as the process whiteboard, with build responsibility and per-team build order.

**Each step = one "application"**: an agentic workflow with defined human control.

The platform has three layers — data, **Operating System**, and **application**. The **Operating System team** builds the OS, including the horizontal (always-on) applications; **RTS** builds the application-layer skills that run on top.

**A Company Sale ("Sell-Side M&A") Unfolds in Five Phases:**

> 1\. **Origination, Qualification & Mandate** — find and vet the opportunity, win the engagement, sign the Engagement Letter (EL).
>
> 2\. **Preparation & Market Readiness** — kickoff, timeline, data room, financials; write the Teaser and CIM (Confidential Information Memorandum) / Management Presentation (MP).
>
> 3\. **Marketing & First-Round Bids** — approach buyers under a code name, sign NDAs, host management meetings, collect first-round offers (IOIs).
>
> 4\. **Diligence, LOI & Definitive Docs** — compare offers, negotiate the Letter of Intent (LOI), grant exclusivity if applicable, verify everything, finalize the definitive agreement.
>
> 5\. **Signing, Closing & Post-Close** — sign, announce, close (money moves under human control), then records, remaining fees, and lessons. (Note: if the deal dies instead, "tail" rights may still produce a fee later.)

**How to Read the Tables**

| **Column** | **Meaning** |
|----|----|
| **Seq \#** | Chronological process order (1–65) — how a deal unfolds |
| **Phase** | Which of the five phases the step belongs to (matches the whiteboard) |
| **Build Responsibility** | **Operating System** = built by the OS engineering team; **RTS** = built by RTS at the application layer. First take — to be validated jointly |
| **RTS Build \# / OS Build \#** | Build order within each team's own backlog (1 = first) |
| **Execution Class** (full definitions in the Execution Guide) | **A** = fully agentic; **A+H** = agent does the work, a banker approves before use; **H+A** = human leads, agent checks; **H** = fully human, agents only observe to learn |

**Shaded rows** = the 16 priority builds from Storm.

Note, a Glossary at the end of this document is provided for the build team.

# Part 1: Horizontal Applications (Always-On)

Horizontal applications are platform services available to every workflow step and every deal — they are not part of the deal sequence itself. Built at the Operating System level.

| **Application** | **Build Responsibility** | **RTS Build \#** | **OS Build \#** | **What It Does** |
|----|----|----|----|----|
| External-Send QC | Operating System | \- | 1 | Final gate on every external artifact: recipients, attachments, code names, metadata, Reg FD / FINRA 2210 |
| Pipeline CRM | Operating System | \- | 3 | Single firm-wide funnel (live lead → won/lost/hold/terminated/died) — moved here (firm-wide, not one stage) |
| Work-Check | Operating System | \- | 4 | Checks every agent output before a senior banker sees it (consistency, citations, numbers, code-name map) |
| Sector Intelligence | Operating System | \- | 6 | Maintains comps, precedents, market maps, competitive quadrants; monthly refresh |
| Multi-Model Verification | Operating System | \- | 7 | 2+ independent models cross-check consequential outputs; discrepancies escalate |
| Expert Panel Review | Operating System | \- | 8 | Static + deal-specific panels red-team consequential work product |
| Continuous Learning / Skill Optimization | Operating System | \- | 10 | Captures deal patterns/edits; proposes prompt & template improvements |
| Deal Workflow Coordinator | Operating System | \- | 11 | Routes tasks, holds deal-state, monitors SLA, aggregates dashboard |
| Document Retention + Permission Cross-Check | Operating System | \- | 12 | Retention/permission tagging; dual-control deletions (FINRA 4511 / SEC 17a-3/4) |
| License / U4 / CE Compliance Tracker | Operating System | \- | 13 | Tracks each banker's FINRA license, U4, CE; alerts the bank's (Chief Compliance Officer/CCO) |
| MD-Style Review | Operating System | \- | 14 | Applies the named MD's approved voice before MD review |
| Knowledge Graph / Relationship Strength | Operating System | \- | 15 | Who-knows-whom graph, scored; warm-path discovery |
| Negotiation Copilot | Operating System | \- | 16 | Counter-positions + precedent for ELs, NDAs, LOIs, definitive terms |
| Workflow Monitoring | Operating System | \- | 17 | Opt-in; surfaces repetitive patterns as new agent candidates |
| File Storage Reorganization | Operating System | \- | 18 | Reorganizes SharePoint/Drive with permissions preserved |
| Fee Structure Pool | Operating System | \- | 21 | Anonymized cross-firm fee benchmarks — platform only |
| Enterprise Search | Operating System | \- | 23 | Permission-aware search and Q&A across the firm's documents, emails, and deal records; every query respects deal walls and is logged |
| Model Optimization | Operating System | \- | 24 | Routes each task to the most cost-effective model that clears the quality bar; tracks AI spend by user, deal, and task |
| Data Room Hosting | Operating System | \- | 25 | Hosted, permissioned data-room layer (Box) with tagging, staged access, and AI-readable APIs, sitting above SharePoint |
| Communication Checking | Operating System | \- | 26 | Communications compliance layer (Global Relay / Smarsh): capture, archiving, and surveillance of business communications |
| Staffing | Operating System | \- | 27 | Assigns bankers and agents to mandates and tracks deal-team capacity across live deals |

# Part 2: Chronological Deal Process (Seq 1 → 65)

## Phase 1: Origination, Qualification & Mandate

**Deal context:** Nothing signed yet — find and vet the opportunity, research the company and buyers, win the mandate, and sign the Engagement Letter (EL).

| **Seq** | **Phase** | **Application (step)** | **Build Responsibility** | **RTS Build \#** | **OS Build \#** | **What It Does** |
|----|----|----|----|----|----|----|
| 1 | 1 | Target Universe | RTS | 13 | \- | Defines priority sectors/targets, exit triggers, buyer themes |
| 2 | 1 | Exit Readiness | RTS | 14 | \- | Scores which companies are most likely to sell, and when |
| 3 | 1 | Acquirer Strategy | RTS | 15 | \- | Identifies likely buyers and likely targets per buyer |
| 4 | 1 | Lead Registration | Operating System | \- | 2 | Registers every lead \<24h with source, type, size, owner |
| 5 | 1 | Source Intelligence | RTS | 2 | \- | Captures referrer/supporter intel: goals, criteria, competing banks |
| 6 | 1 | Conflicts Checklist | Operating System | \- | 9 | Conflicts / restricted-list / prior-engagement check before private info |
| 7 | 1 | Codename / Deal Shell | Operating System | \- | 5 | Assigns code name, deal shell, access list, confidentiality |
| 8 | 1 | Relationship Pathing | RTS | 1 | \- | Maps decision-makers, board/investors, warm paths, introducers |
| 9 | 1 | MD Briefing + Company Backgrounding | RTS | 3 | \- | One doc: MD brief + sourced company profile + relevant case studies |
| 10 | 1 | Meeting Intelligence | RTS | 16 | \- | AI-notes consent; structured capture of first calls |
| 11 | 1 | Deal Qualification | RTS | 17 | \- | Scores mandate fit (fee, likelihood, fit, conflicts) → go/no-go |
| 12 | 1 | Client NDA Workflow | RTS | 5 | \- | Prepares/tracks client NDA before requesting private documents |
| 13 | 1 | Initial Diligence Request List | RTS | 6 | \- | Drafts first diligence request list post-NDA, from sector templates |
| 14 | 1 | Outreach Strategy | RTS | 4 | \- | Per-person approach: narrative, angle, objections, sequence |
| 15 | 1 | Strategy / SWOT | RTS | 20 | \- | SWOT, strategic alternatives, why-sell-now, valuation drivers |
| 16 | 1 | Stakeholder Psychology | RTS | 21 | \- | Maps each stakeholder's decision style, anxieties, objections |
| 17 | 1 | Buyer Universe | RTS | 9 | \- | Strategic + sponsor universe: rationale, ability/likelihood to pay; universe drafted here, approved buyer list finalized during Phase 2 preparation |
| 18 | 1 | Case Study Library | RTS | 11 | \- | Surfaces 3–5 most-relevant prior deals for the pitch (spans pipeline → pitch prep) |
| 19 | 1 | Engagement Economics | RTS | 18 | \- | Fee structure, retainer, success fee, tail vs. precedent |
| 20 | 1 | Engagement Letter Strategy | RTS | 19 | \- | Drafts Engagement Letter (EL) structure and key provisions (internal strategy) |
| 21 | 1 | Pitchbook Drafting | RTS | 22 | \- | Pitch deck in firm template + league-table rankings + case studies |
| 22 | 1 | Pitch Page QC | RTS | 7 | \- | Page-by-page QC: point, story, sources, numbers, formatting |
| 23 | 1 | Pitch Rehearsal | RTS | 23 | \- | Roles, page owners, likely objections, Q&A, dry-run |
| 24 | 1 | Pitch Follow-Up | RTS | 24 | \- | Debrief, stakeholder follow-ups, promised deliverables |
| 25 | 1 | Engagement Negotiation | RTS | 25 | \- | Sends/negotiates EL, redlines, tracks signature |

## Phase 2: Preparation & Market Readiness

**Deal context:** The bank is hired. The team mobilizes, stages the company for market, and writes the selling documents (Teaser, CIM/MP).

| **Seq** | **Phase** | **Application (step)** | **Build Responsibility** | **RTS Build \#** | **OS Build \#** | **What It Does** |
|----|----|----|----|----|----|----|
| 26 | 2 | Mandate Activation Checklist | Operating System | \- | 19 | Converts prospect → mandate: conflicts, EL, W9, team, permissions |
| 27 | 2 | Win/Loss Debrief | RTS | 26 | \- | Mandatory debrief on every pitch outcome (won or lost) |
| 28 | 2 | Kickoff / Org Meeting | RTS | 27 | \- | Org meeting → initial WGL, milestones, roles, cadence |
| 29 | 2 | Timeline | RTS | 28 | \- | Builds + tracks the transaction timeline vs. baseline |
| 30 | 2 | WGL | RTS | 29 | \- | Working Group List, buyer-segregated visibility |
| 31 | 2 | VDR Setup | RTS | 30 | \- | Data-room architecture, permissions, clean-team folders |
| 32 | 2 | Document Intake / Metadata | Operating System |  | 20 | Folder/naming/metadata hygiene, draft/final tagging |
| 33 | 2 | Data Room Diligence | RTS | 31 | \- | Reviews data room for gaps, risks, MNPI (material non-public information), red flags |
| 34 | 2 | Financial Normalization | RTS | 32 | \- | Normalizes financials, ARR bridge, EBITDA, add-backs |
| 35 | 2 | Deal Pulse Checklist | RTS | 10 | \- | Daily/weekly pulse: overdue items, priorities, blockers, risk-to-signing; produces the recurring weekly client update |
| 36 | 2 | Teaser | RTS | 33 | \- | Anonymized teaser / blind profile |
| 37 | 2 | CIM / Management Presentation | RTS | 34 | \- | Confidential Information Memorandum (CIM) / management presentation from approved data |
| 38 | 2 | FAQ&A | RTS | 8 | \- | Anticipated buyer FAQ&A, continuously updated |

## Phase 3: Marketing & First-Round Bids

**Deal context:** The process goes live. Buyers are approached under a code name; interest converts into first-round offers / Indication of Interest (IOIs).

| **Seq** | **Phase** | **Application (step)** | **Build Responsibility** | **RTS Build \#** | **OS Build \#** | **What It Does** |
|----|----|----|----|----|----|----|
| 39 | 3 | Outreach Sequencing | RTS | 35 | \- | Segments buyers into waves; owners, scripts, cadence |
| 40 | 3 | Buyer Synergies Model + Valuation | RTS | 36 | \- | Per-buyer synergies + accretion/dilution + ability/willingness to pay |
| 41 | 3 | Buyer Log / Feedback | RTS | 37 | \- | Logs every buyer touch + pass reasons into CRM; feedback loop |
| 42 | 3 | Buyer NDA | RTS | 38 | \- | Tracks buyer NDA status, redlines, VDR-access readiness |
| 43 | 3 | Buyer VDR Access | Operating System | \- | 22 | Staged VDR access, watermarking, logs — platform only |
| 44 | 3 | Management Meeting | RTS | 39 | \- | Buyer-specific decks, coaching, post-meeting summaries |
| 45 | 3 | Buyer Q&A | RTS | 40 | \- | Manages buyer questions, sourced answers, FAQ updates |

## Phase 4: Diligence, LOI & Definitive Docs

**Deal context:** Offers are on the table. Narrow to one buyer under a Letter of Intent (LOI); the buyer verifies everything while lawyers negotiate the definitive agreement.

| **Seq** | **Phase** | **Application (step)** | **Build Responsibility** | **RTS Build \#** | **OS Build \#** | **What It Does** |
|----|----|----|----|----|----|----|
| 46 | 4 | LOI / Process Letter | RTS | 41 | \- | Process letters / LOI forms, bid instructions, deadlines |
| 47 | 4 | Bid Comparison | RTS | 42 | \- | Compares IOIs (first-round offers)/bids on price, structure, certainty, fit |
| 48 | 4 | LOI Review | RTS | 43 | \- | LOI/exclusivity issues, negotiation points, decision memo |
| 49 | 4 | Merger Agreement Distribution | RTS | 44 | \- | Distributes form agreement; tracks comments/issues |
| 50 | 4 | Definitive Agreement Support | RTS | 45 | \- | Confirmatory diligence, disclosure schedules, closing conditions; includes board approval of the transaction (pre-signing) |

## Phase 5: Signing, Closing & Post-Close

**Deal context:** The deal signs, goes public, and closes — money moves under maximum human control; records, fees, and lessons are harvested. Includes the no-close / termination branch (tail rights).

| **Seq** | **Phase** | **Application (step)** | **Build Responsibility** | **RTS Build \#** | **OS Build \#** | **What It Does** |
|----|----|----|----|----|----|----|
| 51 | 5 | Signing / Announcement Prep | RTS | 46 | \- | Signing checklist, announcement + press/tombstone drafts |
| 52 | 5 | Announcement | RTS | 47 | \- | Coordinates release timing, materials, approvals |
| 53 | 5 | LinkedIn Post | RTS | 48 | \- | Pre-staged deal post, released at announcement timestamp |
| 54 | 5 | Email Blast | RTS | 49 | \- | Pre-staged announcement email to firm/relationships/prospects |
| 55 | 5 | League Table Submission | RTS | 12 | \- | Submits the deal to every league-table/aggregator on announcement; monitors post-close correction cycles |
| 56 | 5 | Regulatory Approval Tracker | RTS | 50 | \- | Tracks HSR/antitrust, consents, deadlines (runs signing → closing) |
| 57 | 5 | Closing Checklist | RTS | 51 | \- | Closing deliverables, funds flow, wires, signatures (anti-fraud checks) |
| 58 | 5 | Fee Realization / Invoice | RTS | 52 | \- | Calculates fee, generates invoice, attaches EL, drafts client email |
| 59 | 5 | Closing Compliance Checklist / Binder | RTS | 53 | \- | Compiles the closing binder + compliance evidence package |
| 60 | 5 | Post-Close Fee Monitor | RTS | 54 | \- | Tracks earnouts, escrow releases, milestone/contingent fees |
| 61 | 5 | Relationship Follow-Up (closing dinner) | RTS | 55 | \- | Closing dinner, thank-yous, references, referral asks |
| 62 | 5 | Transaction Marketing / Asset Library | RTS | 56 | \- | Tombstone, website, reusable materials harvesting |
| 63 | 5 | Earned / Paid Publication | RTS | 57 | \- | Earned-media/byline within 48h of announcement |
| 64 | 5 | Deal Learning / Post-Mortem | RTS | 58 | \- | Debrief → updates skills, buyer scores, playbooks |
| 65 | 5 | Tail Rights & Termination Monitor | RTS | 59 | \- | Tracks tail period, fee triggers, termination; updates funnel |

# Part 3: The Execution Guide (Build Guide)

The Execution Guide keys to the same Seq \#s, adding per step: (a) full description, (b) inputs/outputs & systems touched, (c) the execution class — fully agentic, agentic-led HITL, human-led with agentic check, fully human, and (d) the compliance/human-gate.

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
