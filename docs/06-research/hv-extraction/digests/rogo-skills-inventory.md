# Rogo Skills Inventory

Extraction digest for the Conductia program. Every claim is tagged to its source file. Nothing is inferred beyond what the sources state; contradictions between sources are flagged, not resolved.

**Source tags**

| Tag | File |
|---|---|
| [SL] | `sources/rogo-skills-library.html` — full Skills library capture, app.rogo.ai/skills, Jul 7 2026 |
| [WN] | `sources/rogo-whats-new.html` — Rogo product changelog capture, Jul 7 2026 |
| [SN] | `sources/rogo-slack-notes.txt` — internal Slack notes (Jess Mah / Martin), hands-on testing via Seth's Ignatious account |
| [QA] | `sources/rogo-question-answer.txt` — Rogo's own in-product answers on Projects, connectors, sharing |
| [TD] | `sources/rogo-teardown.html` — internal teardown from app.rogo.ai capture (264 JS bundles) + live testing |
| [EP] | `~/Downloads/rogo-research/rogo-enhanced-projects-one-pager.pdf` — Rogo "Enhanced Projects" one-pager |

**Headline count:** 53 skill entries in the library — 49 Rogo built-ins + 4 custom workspace skills, of which "Ignatious PPT Brand" is a duplicate entry, so 52 unique skills. [SL] Slack corroborates: "they only have about 50 skills. And it's very clear what the instructions for each skill are." [SN]

---

## Skills taxonomy — full table

All skill names, categories, and behaviors below are verbatim-derived from the full instruction text shown in the Skills library. [SL] Inputs/outputs are listed only where the instruction text states them.

### Modeling & Valuation (16)

| Skill | Category | What it does | Inputs / outputs (if stated) |
|---|---|---|---|
| 3-Statement Model | Modeling & Valuation | Build, populate, or update a fully integrated 3-statement model (IS/BS/CF), incl. supporting schedules (PP&E, working capital, debt) and scenario/case toggles. Not for standalone LBO/DCF/operating models. | Out: Excel |
| DCF Model | Modeling & Valuation | DCF valuation: UFCF projections, terminal value (exit multiple + perpetuity), WACC with comparable betas, CAPM, equity bridge to share price, sensitivity tables. | Out: Excel |
| LBO Model | Modeling & Valuation | Full LBO: sources & uses, entry valuation, financing, operating build, debt schedules with circularity, IRR/MOIC + attribution, sensitivities, one-page IC summary. Routes debt-only asks to lbo-debt-schedule, recaps to dividend-recap, SLBs to sale-leaseback. | Out: Excel incl. one-page IC summary |
| LBO Debt Schedule | Modeling & Valuation | Standalone debt-side mechanics: tranche roll-forwards (revolver, TLA, TLB, mezz, PIK toggle), interest circularity, CFADS, mandatory amort, prepayment waterfall, credit metrics. | Out: Excel |
| Merger Model | Modeling & Valuation | Full merger model: pro forma EPS accretion/dilution, purchase price allocation, synergy phase-in, S&U, stress-testing across consideration mix. Not for PE bolt-ons (bolt-on-ma). | Out: model (Excel implied by category) |
| IPO Model | Modeling & Valuation | IPO model: offer pricing/sizing, fees, use of proceeds, pro forma cap table, dilution, implied valuation, float, lockups, pre-IPO returns, sensitivities; also sponsor IPO exits inside an LBO (sell-down, MIP payouts). | Out: Excel |
| Bolt-On M&A | Modeling & Valuation | Bolt-on / tuck-in add-on module for an LBO using cohort-based acquisition triangles; DDTL funding, synergy phase-in for acquired businesses. | — |
| Earnout Modeling | Modeling & Valuation | Contingent earnout consideration across LBOs, strategic deals, roll-ups, milestone payments, CVRs, ASC 805; explicitly layers alongside a host-model skill (lbo-model / merger-model / dcf-model) and governs earnout mechanics only. | — |
| Dividend Recap | Modeling & Valuation | Dividend recapitalization: incremental debt funding a special dividend; standalone or added to an existing LBO; loads sources-and-uses alongside for the S&U grid. | — |
| Sale Leaseback | Modeling & Valuation | SLB inside a model: accretion test, rent layering, cash flow impact, proceeds waterfall, valuation adjustment, value-creation-bridge contribution. | — |
| Structured Equity | Modeling & Valuation | LBO with a preferred/structured equity sleeve (convertible, participating, redeemable+warrants, PIK): instrument-specific exit waterfalls, convert/redeem decisions, per-cohort IRR & MOIC. | — |
| Sources & Uses | Modeling & Valuation | Standalone S&U schedule + pro forma cap table for any deal type (LBO entry, M&A, recap, refi, A&E, take-private, carve-out); loaded by full-model skills for their S&U section; pulls sized tranches from lbo-debt-schedule. | — |
| SOTP Valuation | Modeling & Valuation | Sum-of-the-parts / break-up analysis, segment valuation, spin-off / RemainCo re-valuation, conglomerate discount. | — |
| Liquidation Waterfall | Modeling & Valuation | Translates term sheet / LLCA / operating agreement terms into a liquidation waterfall model across exit scenarios (preferences, accruals, step-ups, participation caps). | In: investment terms. Out: .xlsx |
| Fully Diluted Shares | Modeling & Valuation | FDSO / Treasury Stock Method: options, RSUs, PSUs, warrants; At-Various-Prices analysis. | In: dilutive instrument data |
| Management Incentive Plan | Modeling & Valuation | Builds MIPs into LBO models and exit waterfalls: options pool, sweet equity, profits interests, SARs, phantom equity, management rollover/promote. Not for fund-level carry. | — |

### Returns & Value Creation (3)

| Skill | Category | What it does | Inputs / outputs (if stated) |
|---|---|---|---|
| IRR Decomposition | Returns & Value Creation | IRR bridge / sources-of-return attribution across ~20 named drivers (base unlevered yield, organic growth, margin, M&A, multiple expansion, MIP, recaps, etc.); also audits the IRR panel on an LBO returns tab. | — |
| Value Creation Bridge | Returns & Value Creation | Equity value bridge + MOIC decomposition for LBOs — dollar/multiple attribution entry to exit (IRR % attribution routes to irr-decomposition). | — |
| Synergy Analysis | Returns & Value Creation | Synergy model: post-close cost savings, headcount RIF, EBITDA uplift, pro forma EBITDA bridge, revenue synergies/dis-synergies; triggers when a CIM, census/headcount file, or P&L arrives in buyer context. | In: CIM / census / P&L (optional) |

### Comps & Screening (6)

| Skill | Category | What it does | Inputs / outputs (if stated) |
|---|---|---|---|
| Public Comps | Comps & Screening | Trading comps: peer selection, grouped comp tables, market/operating stats, multiples, historical trading context, summary stats. | Out: Excel |
| Precedent Transaction Comps | Comps & Screening | Transaction comps: tiered groupings, deal multiples, implied target valuation, deal profiles, premium analysis. | Out: Excel |
| Private Company Screen | Comps & Screening | Private-company screens for sourcing / target ID: long list / short list, landscape of private businesses matching criteria. | — |
| Buyer List | Comps & Screening | Sell-side buyer universe: strategics (direct/adjacent/vertical/platform) + sponsors, ability-to-pay, fund-sizing checks, real contact mapping, acquisition rationale. | Out: Excel or PowerPoint |
| Negative News Screener | Comps & Screening | Adverse-media screen on a target + key people for private-markets diligence: financial-crime, legal/regulatory, governance, ESG, operational risk with Low/Mod/High ratings and a web-search log. Loads web-search alongside; loads dow-jones-compliance for flagged DJ/WSJ/Barron's/MarketWatch items. | In: CIM/data room or just a name/ticker/URL. Out: in-chat + .docx |
| ECM Cross-Holder Analysis | Comps & Screening | Single-slide institutional cross-holder analysis for follow-on/IPO allocation targeting: peer-set holders ranked, underweight/absent accounts flagged. Only runs if the org has S&P Capital IQ institutional ownership data enabled. Defers slide chrome to a loaded PPT brand skill. | Requires: S&P CIQ Ownership entitlement. Out: slide |

### Market & Research (8)

| Skill | Category | What it does | Inputs / outputs (if stated) |
|---|---|---|---|
| Bottom-Up TAM | Market & Research | Bottom-up market sizing (logos × ASP × penetration) for software / tech-enabled services: segmentation, SAM penetration, CAGR, greenfield vs switching. Defers formatting to xlsx/rogo-xlsx-brand. | Out: Excel |
| Top-Down TAM | Market & Research | Top-down TAM/SAM/SOM with defensible filters and sources for IC memos, pitches, CIM industry sections, S-1 slides, CDD; triangulates with bottoms-up-tam. | — |
| Industry Primer | Market & Research | Sector primer from recent equity research, thematic reports, earnings commentary (needs 3+ relevant public companies); loads broker-research-master alongside for recency/citation/coverage rules. | — |
| Market Map | Market & Research | Visual market landscape slide segmenting companies into sub-segments + appendix profile slides; loads pptx (and firm PPT brand skill) for the deck. | Out: landscape slide + appendix slides, not a data table |
| Equity Research Initiation | Market & Research | Sell-side initiation of coverage: rating, 12-month PT, thesis, valuation, bull/base/bear, catalysts, risks; loads valuation skills underneath and docx/pdf/pptx to render. | Out: report deliverable |
| Earnings Update | Market & Research | Succinct earnings summary: performance vs consensus/guidance, stock performance, call highlights, updated guidance, takeaways. | Out: email, Word, or PowerPoint |
| PIB Builder | Market & Research | Public Information Book: merged PDF of IR docs, earnings materials, transcripts, news, press releases, equity research, filings. | Out: merged PDF |
| AI Disruption Risk Scorer | Market & Research | Scores AI disruption exposure vs defensibility on a six-dimension framework, 2×2 risk map (Fortress/Battleground/Niche/Vulnerable); for tech and white-collar service businesses. | Out: .docx scorecard + 3-slide PowerPoint |

### Due Diligence (8)

| Skill | Category | What it does | Inputs / outputs (if stated) |
|---|---|---|---|
| DD Question Creator | Due Diligence | Business diligence request list (DRL) generation for M&A/PE, with or without a CIM/VDR provided. Also invoked automatically by dd-tracker-creator when no requests are provided. | In: CIM/VDR optional |
| DD Tracker Builder | Due Diligence | M&A/PE diligence tracker workbook: summary dashboard, DRL, working group list, Gantt deal calendar. | Out: multi-tab .xlsx |
| VDR Review & Gap Finder | Due Diligence | Maps a received VDR to standard buy-side diligence questions, flags gaps: Q&A memo with page/slide refs, completeness checklist, gap assessment, follow-up requests. | In: VDR. Out: in-chat + .docx memo |
| Business Quality Checklist | Due Diligence | One-page rated INDUSTRY/COMPANY/FINANCIAL/INVESTMENT scorecard with six-state color dots and figure-anchored commentary; loads pptx + firm brand skill for chrome, qoe-buyer-analysis when QoE materials present. | Out: one-page slide |
| QoE Buyer Analysis | Due Diligence | Buy-side QoE from a sell-side QoE report: adjustment-by-adjustment assessment, EBITDA bridge, underwritten EBITDA. | In: sell-side QoE report. Out: Excel model + optional PPT stoplight summary |
| Expert Call Agenda | Due Diligence | Agenda for expert-network calls (GLG/Third Bridge/Tegus/AlphaSights; former employee / competitor / customer / supplier), with a compliance/MNPI disclaimer, sequenced questions, time-permitting section; loads docx alongside. | Out: Word document |
| Management Questions List | Due Diligence | Structured qualitative question list for a live management meeting in M&A/PE diligence. | Out: .docx |
| Credit Agreement Summary | Due Diligence | Condenses credit agreements into partner-ready memos: key economic terms, covenant packages, prep for a client call. | In: credit agreement. Out: PowerPoint |

### Customer Analytics (3)

| Skill | Category | What it does | Inputs / outputs (if stated) |
|---|---|---|---|
| Customer Cube Cleanup | Customer Analytics | Audits MRR / customer-level time-series for data-quality issues: gaps, double-counts, spikes, onboarding revenue fade; hands clean data to customer-cube-analytics. | In: .xlsx or .csv subscription export |
| Customer Cube Analytics | Customer Analytics | Customer cube workbook: Master tab + Retention, Cohorts, Top Customers, Churn / New Customers / Largest Movers double-clicks; NRR, concentration, cross-sell/upsell tagging. | In: customer-level revenue file. Out: workbook |
| Retention & Cohort Analysis | Customer Analytics | Retention waterfalls and cohort tables: NRR/GRR, churn, logo retention, revenue bridge (narrower than customer-cube-analytics). | In: customer-level revenue data |

### Deliverables & Utilities (5)

| Skill | Category | What it does | Inputs / outputs (if stated) |
|---|---|---|---|
| CIM Executive Summary Builder | Deliverables & Utilities | Exec Summary / Investment Highlights section of a sell-side CIM/CIP: 10–20 slide opener (snapshot, overview, previews, management, growth levers, financials, highlights); loads pptx + firm PPT brand skill; a separate CIP Builder skill may route its exec-summary section here. | Out: PowerPoint, 10–20 slides |
| Teaser | Deliverables & Utilities | Sell-side investment teasers, blind or named, incl. reviewing an existing teaser. | Out: .docx or .pptx |
| Excel Editing | Deliverables & Utilities | Modifies an existing Excel file: extend projections, update assumptions, add/remove data, restructure tabs while preserving formulas and formatting. | In: uploaded .xlsx |
| Model Audit | Deliverables & Utilities | Audits financial models in any format (3-statement, LBO, DCF, merger, comps, credit, operating): "does this balance", model QC, assumption review. | In: .xlsx, PDF, or verbal description |
| Project Overview Generator | Deliverables & Utilities | Default project-overview generation: reads the project's files, produces an at-a-glance HTML dashboard for a deal team. Linked to each Project via `Project.overviewGeneratorSkillId`; editable per-project from the overview Edit Generation modal. | In: project files. Out: HTML dashboard |

### Custom Workspace Skills (4 entries, 3 unique — Ignatious's own)

| Skill | Category | What it does | Inputs / outputs (if stated) |
|---|---|---|---|
| Acquisition Targets By Number | Custom (updated Jun 11, 2026) | "ALWAYS load" for buyside target lists for a specific client, especially with a target count specified ("build a list of N acquisition targets for [Client]"). Not for sell-side buyer landscapes. | — |
| Ignatious Management Presentation Builder | Custom (updated Jun 25, 2026) | "ALWAYS load" for management presentations in a financing or sell-side process. Runs a conversational, section-by-section flow: proposes the standard structure, asks which section first, requests a formatting reference (master template or prior deck) and only the data needed for that section. | In: formatting reference + per-section data |
| Ignatious PPT Brand (×2 — duplicate entry) | Custom (updated Jun 11 / Jun 22, 2026) | "ALWAYS load" for any PowerPoint output: firm colors, typography, layouts, table/chart styling, financial conventions. User-uploaded .pptx template takes precedence; otherwise starts from the master template attached to the skill. | In: optional user .pptx template; skill carries an attached master template |

**Referenced-but-unlisted skills.** The instruction texts route to skill names that do not appear as cards in the library: `web-search`, `dow-jones-compliance`, `broker-research-master`, `broker-research-digest`, `initiation-report-analysis`, `peer-identification`, `xlsx`, `rogo-xlsx-brand`, `pptx`, `docx`, `pdf`, `term-sheet-waterfall-builder`, and a possible "CIP Builder". [SL] This indicates a layer of infrastructure/rendering skills below the 53 visible entries; the sources do not state how many exist or whether users can see them.

---

## Invocation & configuration model

### How skills are discovered and run

- **Trigger-phrase routing with explicit negative space.** Every skill's instruction text is a routing contract: "Trigger on: [phrase list]... Do NOT use for X — use [sibling-skill] instead." Cross-references are dense and bidirectional (e.g., lbo-model routes debt-only work to lbo-debt-schedule; sources-and-uses refuses to run inside full-model builds that "own the full build and load this skill only for the S&U section"). [SL]
- **Skill composition / layering.** Skills explicitly load other skills in the same turn: Earnout Modeling "layers alongside the host-model skill... it governs earnout mechanics only, not the base model"; Negative News Screener loads `web-search` and conditionally `dow-jones-compliance`; content skills defer formatting to `xlsx`/`pptx`/`docx` and slide chrome to "any firm PPT brand skill" loaded in the same turn. [SL]
- **Programmatic skill-to-skill invocation exists.** DD Question Creator is "also invoked automatically by the dd-tracker-creator skill when no requests are provided" — one shipped instance of a skill calling another without user prompting. [SL]
- **Object-bound invocation exists in exactly one place.** Project Overview Generator is bound to a Project via `Project.overviewGeneratorSkillId` and configured per-project through an Edit Generation modal — invocation by object linkage rather than trigger phrase. [SL]
- **Entitlement-gated skills.** ECM Cross-Holder Analysis states it should only run "when the user's organization has S&P Capital IQ institutional ownership data enabled — without it, this skill has no holdings data and shouldn't be run." [SL]
- **Custom workspace skills.** Firms add their own skills marked "Custom" with update dates; Ignatious has three unique ones. They use "ALWAYS load" framing, can carry attached assets (the PPT Brand skill's master template), and can define multi-turn conversational flows (the Management Presentation Builder's section-by-section flow). The workspace shows a duplicate "Ignatious PPT Brand" entry (Jun 11 and Jun 22 versions coexisting). [SL]
- **Skills follow the user across surfaces.** The Excel plugin gives access to "the same custom skills available in Rogo." [WN]
- **Prompt Optimizer** (Oct 2025, Ctrl+I): one-click rewriting of any query "for clarity, precision, and domain-specific effectiveness" — a shipped concession that raw prompting is the invocation path. [WN] The teardown reads it as "you only build a tool to fix the user's prompt if the raw prompt bar is too hard to use." [TD]

### Model selection and what Felix is

- **Four user-facing tiers** (Sep 2025), toggled via a Mode Selector or Ctrl+\: Instant (immediate, GPT-5 only, no external sources), Rogo Fast (<30 sec, all connected sources), Rogo Pro (<5 min, all connected sources, for ambiguous/complex questions), Deep Research (5+ min, OpenAI Deep Research across web). [WN] Rogo Pro "uses our proprietary reasoning model specifically trained for financial Q&A" and adds sources like non-US filings. [WN]
- **Felix is a brand over a proprietary router, not a single model.** The bundles expose a router over frontier models — gpt-5.1, o3, gemini-3-pro, claude-opus-4.8, qwen, glm, plus one proprietary financial-reasoning model — with per-model admin gates (ModelOpus4, ModelGpt5, ModelGemini3). Rogo does not pretrain a foundation model; it fine-tunes third-party models and routes with what it publicly calls the "Model Broker." [TD] Slack, from live testing: "it seems like 'Felix' is their own proprietary router of sorts... not based off a Chinese open source model." [SN]
- **Discrepancy to flag:** the teardown's summary table lists `claude-fable-5` among the router's bundle strings, while its Section 07 states "Fable 5 is not in the lineup," and Slack observed "looks like no Fable 5." [TD][SN] Treat Fable 5's presence as unresolved (string in bundles vs. active lineup).
- **The UI never discloses which model answered** a given query, or why Felix beats calling a frontier model directly. [TD]
- **In-product answer on processing:** "a multi-model orchestration layer over frontier models from Anthropic, OpenAI, and Google (all US-based labs)"; processing geography not documented. [SN]
- **Rogo publishes its own eval**, the Big Finance Benchmark, using its headline result (no single frontier model wins; best scores under 60%) to justify routing. [TD]

### Internal vs external data sources

- **Licensed/external bench:** S&P Capital IQ (Ownership live Oct 2025; Transactions and Company Intelligence named as coming; "available to S&P Global clients with the appropriate agreement in place"), FactSet, PitchBook, Preqin, Moody's, LSEG, expert-network content from Third Bridge and GuidePoint, plus filings, transcripts, and news. VDR integrations with Ideals and Intralinks give "document Q&A across deal rooms you have access to." [WN][TD]
- **Firm-native connectors:** SharePoint (first-class searchable, cited source, Nov 2025; Full Access or admin-site-Limited variants), Google Drive, OneDrive, Box, Egnyte (Felix only), Outlook, Teams, Gmail, Calendar, Notion, Salesforce. [WN][QA]
- **Connector posture:** all read-only, OAuth through the provider's own login, credentials never stored by Rogo, access inherits the user's existing permissions (SharePoint via Microsoft Graph), retrieved at query time rather than indexed/stored, admin-gated enablement per org, user self-authorizes under Account Settings → Connections. [QA][SN]
- **Training policy:** "Rogo does not train its models on your content. Per Rogo's documentation, your prompts, files, and outputs are never used to train any Rogo or third-party model." [SN]
- **Excel plugin data handling:** the workbook is never uploaded wholesale; only the specific cell values read for a prompt are transmitted, plus a stored workbook ID, file name, and conversation history. [SN]

### Projects and memory

- **Projects** (Jan 2026): persistent per-deal workspace — chats organized in folders, persistent instructions applied to every conversation in the project, and a Project Library of files (PDF, PPT, Word, Excel, images; plus .txt/.md/.json/.html/.xml/.tsv/.csv via Felix), up to ~100 files per project. [WN][QA]
- **Deal separation is structural, not tag-based:** "one Project = one deal's document universe." There is no free-form per-file tag field and no automatic deal tagging; project scoping keeps retrieval inside that project's library, with per-file "context" toggles and direct document referencing for finer slicing. [QA]
- **Projects do not carry conversational state:** "Projects do not currently pull context from your previous chats in the same Project — they share the files and Project instructions, not prior conversation history." [QA]
- **Enhanced Projects** (one-pager): scales to hundreds of files per project, built-in document viewer (including password-protected files), folder-structure-aware querying ("Rogo automatically understands project structure"), cross-project search ("surface relevant precedents, research, and past deliverables from other projects without re-uploading"), and shared/forkable project chats. Framed as "the foundation for a more intelligent, collaborative workspace... continued improvements in memory, deal automation, workflow management, and collaborative intelligence in the months ahead." [EP]
- **Memory** (May 2026): Felix stores role/coverage area, formatting conventions, and recurring companies/themes across conversations; viewable, editable, and clearable in Settings → Memory. [WN] The teardown characterizes it as a passive preference store: "it remembers preferences, it does not act on the deal." [TD]
- **Project sharing is internal-only:** Owner/Editor/Viewer roles scoped to users/teams/org within the tenant; colleagues can't download underlying files off a shared thread; no workflow for external counterparties or NDAs — export (Word/PPT/PDF/Excel, ZIP bundle option) and distribute through existing channels. [QA] Slack: "sharing feature at least has some built in protections." [SN]

---

## Platform capabilities

### Citations and verification

- **In-cell citations** (Nov 2025): every hardcode in a Rogo-generated spreadsheet cites its exact source, clickable from the cell back to the filing/transcript/web source, "just like Rogo's text responses." [WN]
- **Sheets Agent** (Dec 2025): multi-tab model building, auto-opens a spreadsheet on detected modeling intent, uses "high-fidelity financial data sources... as opposed to relying on the model's knowledge alone," and builds "like a real banker would, with clean structure and proper conventions." [WN] Rogo acquired Subset (Sep 2025) to get the spreadsheet agent. [TD]
- **Citation depth limit:** competitors frame Rogo's citations as response-level, "not traced to the sentence or the computation." [TD]
- **Verification skills exist** (Model Audit; QoE Buyer Analysis; sources-and-uses auditing) but verification is user-initiated, not systemic. [SL]

### Integrations and surfaces

- **Excel plugin** (May 2026): Felix in a taskpane works on models already open on the user's machine — update models, create analyses with the same data sources and custom skills, visualize workbook data. [WN]
- **Slide Annotations** (May 2026): comment directly on any PPTX-backed slide deck attached to a chat; each annotation becomes a targeted instruction Felix applies in place, preserving the rest of the deck. [WN]
- **Exports:** PowerPoint, Word, PDF (Nov 2025; emailed or downloaded), Excel; rich copy-paste into PPT/Word/email preserving tables, bullets, bolding. [WN]
- **AI Tables:** Clay-like grid where AI auto-fills answers; upgraded Nov 2025 to run on Rogo's proprietary financial reasoning models — multi-step in-cell logic, real-time reference to filings/ownership/news. [WN] Slack's read: "It's a bit like Clay... not sure how useful this is going to be from Storm's perspective." [SN]
- **UX conveniences:** Prompt Optimizer (Ctrl+I), model toggle (Ctrl+\), new chat (Ctrl+K), `/` shortcut dropdown, Dark Mode. [WN]

### Permissions and security

- **Org-grade controls exist** (from bundles): SSO via enterprise IdPs, SCIM provisioning, idle/session-lifespan timeouts with forced logout, audit log filterable by user/action/client IP, DLP-style blocked-words and regex controls, tenant-level connector admin consent, ChatRbac authorization, granular share scopes across Chat/Project/Skill/Note. [TD]
- **All admin-scoped and SSO-dependent** — nothing is surfaced to the individual as a trust surface. [TD]
- **No native 2FA**, confirmed three ways: hands-on (logged into Seth's account, no 2FA prompt, no settings toggle), in code (`twoFactor`, `totp`, `saml` return zero real hits in the bundles), and on Rogo's own trust center (never names 2FA/MFA/SSO/SAML while advertising SOC 2, ISO 27001, and an autonomous red-team agent). [SN][TD]
- **Retention:** conversation history stored server-side per account; per-chat deletion only ("bulk history deletion isn't currently available"); org-level file retention policies are admin/tenant-specific. [SN]

### Limits and complaints (as testers/analysts recorded them)

- **No per-user spend visibility.** "No way to see how many tokens I am burning and how much I'm spending as a user. That seems shitty." [SN] The plumbing exists — CostGuard polls cost every five minutes and can hard-block the input bar; a beta admin-only Credit Center shows per-team/per-user credit trends; a `getMyUsage` endpoint is gated behind UsageV2 — but billing is denominated in opaque credits on Metronome usage-based rails, never tokens or dollars, and no per-model cost is merchandised. [TD]
- **Reactive by design.** Entry points are "What can Felix do for you?" and "Ask a question"; the only proactive surface is user-configured Scheduled Tasks. Deal Room, an institutional-memory CRM, and an Agents surface exist in the bundles as employee-gated prototypes with seeded data and no backend. [TD]
- **No domain guardrails:** Rogo happily "ran a thorough analysis" for a fictitious Disney World family vacation. [SN]
- **Changelog concentration:** "more than half of the updates are related to their powerpoint/excel plugin... and they are copying a lot of the stuff you find in claude/chatGPT." [SN]
- **Field result:** Ignatious ran Rogo for three weeks, judged it weak, and reverted to their existing PowerPoint tool; the read on its real value there was "liability insurance, AI credibility, and junior-banker retention, not output quality." [TD]
- **External critiques on record:** dependence on third-party models (Sacra; AlphaSense's hallucination attack), data partners able to bundle against it, bulge brackets building in-house, strain on thousands-of-documents analysis (Hebbia), response-level-only citations. [TD]
- **Open questions the team is pushing to Rogo sales:** FINRA compliance, token pricing, whether Felix is built off an open-source model, and the missing 2FA. [SN]

---

## Implications for Conductia verticals

Mapping Rogo's skill patterns onto RTS's per-step skills on the 5-phase/65-step rails. The frame, per the teardown's build comparison: the rails (orchestration, permissions, approval gates, audit log, cost attribution, pre-send checks) are ours; deal-specific skills sit on top, agents run the repeatable work, and the banker keeps the judgment. [TD]

### Patterns that transfer

1. **The skill-as-contract format transfers; the routing mechanism does not.** Rogo's best structural idea is that each skill is a tight contract: scope, trigger conditions, explicit "Do NOT use — route to X" boundaries, declared output format. [SL] RTS per-step skills should keep that contract discipline (scope, inputs, outputs, refusal conditions) — but bind skills deterministically to rail steps instead of probabilistic trigger-phrase matching against a user prompt. On rails, the step invokes the skill; the user never has to know the magic phrase. Rogo's own Prompt Optimizer is the evidence that phrase-routing taxes the user. [SL][TD]

2. **Skill layering (content skill + module skill + format skill + firm-brand skill).** Rogo cleanly separates content skills from rendering skills (`xlsx`/`pptx`/`docx`) and firm-brand skills (Ignatious PPT Brand), with defined precedence ("defer slide chrome to it"). [SL] This maps directly to rail steps: each step's content skill composes with a firm-deliverable-brand overlay, so one rail serves many client firms without forking step logic.

3. **Object-bound skill invocation — Rogo's one instance is Conductia's whole model.** `Project.overviewGeneratorSkillId` — a skill linked to a workspace object and configurable per-object — is the only place Rogo invokes a skill by linkage rather than prompt. [SL] The 65-step rail generalizes exactly this: every step is an object with a bound skill, per-deal configurable. Rogo has proven the pattern works; it just never scaled it past one skill.

4. **Programmatic skill chaining.** dd-tracker-creator auto-invoking dd-question-creator is a proto-pipeline. [SL] Rails formalize this: step outputs feed downstream step inputs as a first-class mechanic, not as an exceptional case buried in one skill's instructions.

5. **Entitlement declarations per skill.** ECM Cross-Holder declaring "don't run without S&P CIQ Ownership enabled" [SL] is the right pattern: each RTS step skill should declare its data prerequisites so the rail can surface degraded/blocked steps visibly at mandate setup — which for a compliance-first product doubles as a data-provenance control.

6. **Sell-side process atoms exist; the sequence is the product.** Rogo already ships most sell-side atoms — Teaser, CIM Executive Summary Builder, Buyer List, DD Question Creator/Tracker, VDR Review & Gap Finder, Management Questions List, Expert Call Agenda, Negative News Screener, Credit Agreement Summary, Project Overview Generator. [SL] But they are disconnected: the user must know each exists and prompt for it in order. The 5-phase/65-step rail's differentiation is not inventing new atoms — it is sequencing them as a stateful process with owners, deadlines, and gates, which the teardown confirms Rogo has only mocked (Deal Room/CRM/Agents: no backend, seeded data). [TD]

7. **Custom workspace skills validate per-firm skill demand — with a governance lesson.** Ignatious built its own target-list, management-presentation, and brand skills within weeks of onboarding. [SL] Demand for firm-specific skills at the step level is real. The duplicate "Ignatious PPT Brand" entry (two versions, Jun 11 and Jun 22, both live) [SL] is the cautionary detail: Rogo has no visible versioning or approval on custom skills. On compliance-first rails, firm skills need versioned, approved, auditable lifecycle — consistent with the teardown's policy-hash pattern (log the policy version in force with every action). [TD]

8. **Deliverable-native output with traceable sourcing is the trust bar.** In-cell citations and banker-format conventions are why Rogo clears review. [WN][TD] Every RTS step deliverable should meet or beat that bar — and the recorded critique that Rogo's citations are response-level, not sentence/computation-level [TD], sets the target for a sign-off-grade product: per-figure, per-assumption traceability an MD can attest to.

9. **Conversational section-by-section flows for judgment-heavy deliverables.** The Ignatious Management Presentation Builder's flow — propose structure, ask which section first, request only the inputs needed for that section [SL] — is a good interaction model for rail steps that need MD input, mirroring the rail's human direction gates rather than one-shot generation.

### Patterns that do not transfer (compliance-first M&A, MD seat)

1. **Prompt-triggered invocation as the primary interface.** Rogo relocates cognitive load to prompt-authoring; the Prompt Optimizer patches the symptom. [TD] Rails advance on their own through repeatable steps and stop at human gates — the MD delegates and approves, not prompts. [TD]

2. **Model-opaque routing.** Felix never says which model answered — fatal for a user who personally attests to how a number was produced. [TD] Conductia's stated position: name the model, single Anthropic model via enterprise API in v1, clean audit trail over cost-optimization; multi-model is a v2 decision after the audit story is airtight. [TD]

3. **The analyst-modeling wedge.** 16 of 49 built-ins are Excel modeling skills, plus 3 returns skills — the most commoditizable, most model-substitutable layer, and the treadmill Rogo spends its changelog on. [SL][TD][SN] The teardown's explicit build decision: PowerPoint generation, financial modeling, and complex valuation are out of v1. [TD] RTS step skills should stay on repeatable low-judgment process work, not compete on model construction.

4. **Unscoped skill invocation.** Nothing keeps Rogo in its lane (the Disney World vacation plan). [SN] On the rails, skills execute inside a mandate context with compliance screening of what leaves the building [TD] — scope control is a feature of the rail, not a courtesy of the model.

5. **Compliance as a footnote inside skills.** Across all 53 skills, compliance appears only as document furniture: the Expert Call Agenda's "compliance/MNPI disclaimer" and the unlisted `dow-jones-compliance` licensing-attribution helper. [SL] No skill routes output through a compliance check before it ships. Conductia inverts this: pre-send green/yellow/red screening, agents cross-checking agents, and the policy-version hash on every logged action are rail-level services every step inherits. [TD]

6. **Credits-denominated opacity.** Rogo's cost model (credits, admin-only, hard-block UX) is a margin instrument a financial buyer reads as an undisclosed spread. [TD][SN] Cost attribution per person and per deal is a rails job — every step deliverable already knows which deal and who drove the spend. [TD]

7. **Project-as-folder instead of deal-as-state.** Rogo Projects hold files and instructions but not conversational state, dependencies, owners, or process status — "a folder around reactive chat plus a preference store." [QA][TD] The rail is the stateful deal object Rogo lacks. Note the direction of travel, though: Enhanced Projects explicitly promises "deal automation, workflow management, and collaborative intelligence in the months ahead" [EP] — Rogo is announcing its intent to climb toward the rail. The window is the gap between that promise and a shipped backend. [TD]

8. **Internal-only sharing with no counterparty rail.** Rogo has no path for NDA'd external distribution — download and send. [QA] Sell-side M&A steps are largely counterparty-facing (teasers out, NDAs in, buyer Q&A); on compliance-first rails, outbound distribution is precisely where the compliance screen and audit ledger earn their keep, so this is an entire step-category Rogo's pattern simply does not cover.

### One-line synthesis

Rogo has built a well-specified library of 50-odd prompt-triggered analyst atoms with strong output discipline and no process spine; Conductia's rails should steal the skill-contract format, the layering model, and the entitlement declarations, generalize Rogo's single object-bound skill into all 65 steps, and refuse the four things that disqualify Rogo for the MD seat — prompt-dependence, model opacity, cost opacity, and compliance-as-footnote.
