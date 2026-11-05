# Compliant Communications — Landscape and Build-vs-Integrate

Status: draft for team discussion (2026-06-18). Author: Marcelo.

Companion to `data-room-analysis.md` (same build-vs-integrate lens, different workstream).

## Why this doc exists

Compliant communications is priority output workstream #1 from the strategy pivot. Storm's
framing: the pre-send compliance check is the high-value unlock, because tools like Global
Relay and Smarsh are ex-post storage and surveillance only. This doc maps the incumbent
landscape, locates exactly where our moat is, and recommends what to build vs integrate.

The question is not "can we beat Global Relay at archiving." It is "everyone archives and
surveils after the fact; what is the thing nobody does, and do we build it."

## The market shape: everyone lives ex-post

Every major financial-communications compliance vendor sits on the same pipeline, and they
all act AFTER a message exists:

```
   message      CAPTURE        ARCHIVE              SURVEIL / DETECT          REVIEW
   sent ───►  (ingest from  ─► (WORM, immutable, ─► (lexicon + AI scan,  ─►  (compliance
              email/chat/     17a-4 / 4511        flag risky messages,      officer triages
              voice/WhatsApp) retention)          generate ALERTS)          alerts, e-discovery)
                                                        ▲
                                       the whole incumbent market is HERE and to the right
                                       = post-hoc. The message already left.
```

Even the "real-time" players (Theta Lake, Behavox Quantum) do continuous detection and
alerting on messages that already exist. Real-time alert is not the same as pre-send block.
The banker's risky message is still sent; a human is merely told about it faster.

## Vendor landscape

| Vendor | Category | When it acts | AI | Financial-specific | Notes |
|---|---|---|---|---|---|
| Global Relay | Archiving + surveillance | Post-hoc | Yes | Yes (22 of top 25 global banks) | Tamper-proof defensible archive; own compliant messaging app (voice, SMS, WhatsApp); since 1999 |
| Smarsh | Capture + supervision | Post-hoc, broad capture | Yes | Yes | Strongest at capturing many modern channels; active supervision |
| Behavox | Surveillance + archive | Post-hoc (high-volume) | Yes (proprietary Behavox LLM 2.0) | Yes (10 of 24 G-SIBs, BNY, Mizuho) | Quantum (comms), Polaris (trade), Intelligent Archive; raised $175M from BlackRock's HPS |
| Theta Lake | DCG for collaboration | Real-time detection + archive | Yes | Partial (collaboration/UC focus) | API-level capture of video/voice/chat/screen; continuous policy detection |
| Shield | eComms surveillance | Post-hoc + AI risk analysis | Yes | Yes | Surveillance + compliance archiving for financial services |
| SteelEye | Comms + trade surveillance | Post-hoc | Yes | Yes | Integrated comms and trade record |
| Bloomberg Vault | Comms + voice surveillance | Post-hoc | Yes | Yes | Tied to Bloomberg e-comms and trading data |
| Microsoft Purview | Communication compliance / DLP | Some pre-send + post-hoc | Yes | No (generic) | Can block/route outbound on policy, but generic, not deal/MNPI-aware |
| Generic DLP / email security | Data loss prevention | Pre-send blocking | Pattern/keyword | No | Blocks on sensitive-data patterns, not financial-regulation context |

## Where the moat actually is (honest version)

Pre-send blocking is not unheard of. Generic DLP and Microsoft Purview can block or hold an
outbound message on policy. So we should not claim "nobody blocks before send." That would
not survive Storm's scrutiny.

The honest, defensible gap is narrower and stronger:

```
   PRE-SEND  ✕  DEAL-CONTEXT-AWARE  ✕  APPLIED TO AGENT-GENERATED CONTENT  ✕  IN-WORKFLOW

   - Pre-send                 : the check happens BEFORE the message leaves, not after.
   - Deal-context-aware       : it knows the deal phase, who the recipient is, what is
                                MNPI for THIS deal, NDA state. Generic DLP does not.
   - Agent-generated content  : when an AGENT drafts the message, ex-post surveillance is
                                structurally too late. The gate must sit between draft and
                                send. This is the new requirement agents create.
   - In-workflow              : the gate is a state in the deal's orchestration, not a
                                separate surveillance product bolted on the side.
```

No incumbent does all four. The archiving/surveillance leaders (Global Relay, Smarsh,
Behavox) are structurally ex-post. The pre-send tools (DLP, Purview) are context-blind and
not built for financial regulation or agent output.

## Why agents make this urgent, not optional

The pivot puts agents in the drafting seat. An agent that writes an NDA, a teaser, or an
outreach email can produce a non-compliant artifact at machine speed and volume. Ex-post
surveillance was designed for humans who send a few hundred messages a day. It cannot be
the control for agents that draft thousands. The control has to move to BEFORE send.

We have already encoded exactly this. The orchestration spine screens every draft at
`COMPLIANCE_SCREEN` and will not let an external-facing artifact reach the recipient
without passing the gate and a human sign-off (see `copilot-surface-action-map.md`). The
pre-send gate is not a future feature, it is already the shape of the spine.

## Recommendation: integrate the commodity, build the differentiator

Same conclusion shape as the data-room analysis: do not rebuild what is commoditised, build
the thing that is the moat.

1. Build: the pre-send, deal-aware compliance gate on agent output. This is the product. It
   is already started (`screenMessage` + the spine's `COMPLIANCE_SCREEN`). Deepen it with
   deal-phase, recipient, and MNPI context.
2. Integrate (later, if/when required): the ex-post archiving and retention leg (WORM /
   SEC 17a-4 / FINRA 4511). This is a commodity and a hard regulatory checkbox. When a
   client demands certified immutable retention, partner or integrate an archiving vendor
   rather than building a WORM store. Do not lead with this; it is table stakes, not moat.
3. Cite, do not embed: the surveillance incumbents are the benchmark we position against
   ("they tell you after, we stop it before"), not something we resell.

Sequencing: the pre-send gate is the demo and the differentiator, so it leads. Retention is
a procurement requirement that surfaces at enterprise sales time, so it can follow.

## Open questions for the team

1. Do any near-term target clients have a hard WORM / 17a-4 retention requirement that
   forces the archiving-integration leg sooner rather than later?
2. For the pre-send gate, what is the rule source: our existing screening rules, a
   configurable per-firm policy, or both? This affects whether compliance is a fixed engine
   or a per-tenant config.
3. Capture scope: do we only gate what agents and the platform generate, or also human
   messages typed into the platform? The first is clean and agent-native; the second pulls
   us toward competing with capture incumbents.

## Sources

- [Global Relay vs Smarsh — Gartner Peer Insights](https://www.gartner.com/reviews/market/digital-communications-governance-and-archiving-solutions/compare/global-relay-vs-smarsh)
- [Top Smarsh competitors & alternatives — Gartner](https://www.gartner.com/reviews/market/digital-communications-governance-and-archiving-solutions/vendor/smarsh/alternatives)
- [Behavox AI / Quantum](https://www.behavox.com/behavox-ai/) and [Behavox raises $175M from BlackRock's HPS](https://thenextweb.com/news/behavox-175m-hps-blackrock-ai-compliance)
- [Theta Lake — compliance for modern collaboration](https://thetalake.com/)
- [Smarsh — the modernization of SEC Rule 17a-4](https://www.smarsh.com/blog/thought-leadership/the-modernization-of-sec-rule-17a-4)
- [Mimecast — what is FINRA WORM compliance](https://www.mimecast.com/content/finra-worm-compliance/)
- [Microsoft Purview — communication compliance policies](https://learn.microsoft.com/en-us/purview/communication-compliance-policies)
