# Data Room — build vs. integrate analysis

> Status: **decision support for the open item from the 10 June 2026 internal sync.**
> Owners: **Marcelo + Martín** ("Analyze existing third-party data room solutions and
> compare features to determine if the team should build their own or integrate").
> The team leaned **integrate, not build**, and deferred the call for ~1 week.
> This is research for that decision, not a final decision.
>
> **v2 (16 Jun):** added **Supabase Storage** to the comparison (per Martín) — it
> reshapes the recommendation, since we already run on Supabase. The doc is also
> mirrored to a Google Doc for inline comments (per Rob); this `.md` stays the record.

## The question (as framed on the call)

Lance: *"are we going to build that ourselves or are we going to try plug in an existing
solution?… if we find that these existing platforms have features and functionality that
is unnecessary for us to build, in the essence of security and compliance but also speed,
then I would opt for us to use something off the shelf. I'm going to leave it open for
this week."*

Martín: *"we can [use] Box… has a very good SDK and APIs to integrate easily. So maybe we
can start with a third party solution. Why [should] we create our own data room?… it can
be an own product itself… a business opportunity, there are not many competitors."*

So the real question is narrower than "build vs buy": **which off-the-shelf data room
can we *integrate into our own platform* (same interface, computed permissions) while
carrying the compliance our positioning demands — and what, if anything, must we still
build ourselves?**

## Decision criteria (drawn from the call)

1. **Embeddability** — can it live *inside* our Next.js app (so we keep the unified
   interface), or is it a standalone destination users get bounced to? This is the one
   that actually decides the architecture.
2. **Compliance** — SOC 2 Type II, GDPR, ISO 27001; bonus FINRA/SEC 17a-4 (we are a
   compliance-first M&A product; Lance benchmarked us against Rogo's SOC 2 / GDPR).
3. **VDR feature fit** — document classification, phase/stage-gated access, audit trail,
   per-recipient permissions. (We have already built ~50% of this — see Gap below.)
4. **Pricing model** — per-page vs per-seat vs storage vs flat; predictability.
5. **Speed** — time to a credible demo and to production.

## The candidates

| | **Supabase Storage** | **Box** | **Datasite** | **iDeals** | **Ansarada** | **DocSend** (Dropbox) |
|---|---|---|---|---|---|---|
| Category | Object storage (our existing backend) | Content platform + API | M&A VDR (market leader) | Enterprise M&A VDR | VDR + deal mgmt | Lightweight doc-sharing / data room |
| **Embeddable in our app** | ✅✅ **Yes, strongest** — S3-compatible + SDK; we already run on Supabase (no new vendor) | ✅ **Yes** — Content APIs + embeddable UI Elements | 🔴 Standalone SaaS (no public embed API surfaced) | 🔴 Standalone SaaS | 🔴 Standalone SaaS | 🟠 Partial — API on Advanced plan only; mostly its own UI |
| SOC 2 Type II | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| GDPR | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| ISO 27001 (+17018/27701) | ✅ (+ **HIPAA**) | ✅ (+27017/27018/27701, ISO 27701) | ✅ (+27017/27018/27701/**42001**) | ✅ | ✅ (+**42001** AI) | (relies on Dropbox infra) |
| FINRA / SEC 17a-4 | 🔴 — (not advertised) | ✅ **Yes** | — | — | — | — |
| VDR features (viewer / watermark / DRM) | 🔴 None (raw storage) | ✅ Yes | ✅ Yes | ✅ Yes | ✅ Yes | 🟠 Partial |
| Pricing model | Usage-based ($/GB + egress); folds into existing Supabase spend | Per-seat / platform (API tier ~100K calls/mo) | **Per-page** (~$0.60/page; mid-market deal $25K–$100K/yr) | Contact-sales; storage tiers (250GB–10TB) | **Published**, storage-based (~€419–4,479/mo); free prep period | Flat (~$750/mo Advanced Data Rooms tier) |
| Best at | The substrate we already own; cheapest, native — but raw storage | Being the secure storage/permissions *backbone we embed* | Big-deal credibility, page-level tracking | Enterprise raises, granular control | Transparent pricing, AI, deal prep | Cheap, fast, founder-friendly sharing |

(API capabilities for Datasite / iDeals / Ansarada are **not publicly documented** — a
real integration would need a vendor call. Treat their "no embed" as "unconfirmed but
not advertised," which for our purposes is the same risk.)

## The key insight

There are really **four archetypes**, not six vendors:

- **Already-owned substrate → Supabase Storage.** We are already on Supabase, so this is
  the *zero-new-vendor* option: S3-compatible, SDK-native, **SOC 2 / ISO 27001 / HIPAA**,
  cheapest. But it is *raw object storage* — no **FINRA/SEC 17a-4** retention and no VDR
  features (viewer, watermark, DRM), which we would build ourselves or defer.
- **Embeddable platform → Box.** The only candidate that is a *developer platform*
  (Content APIs + UI Elements you drop into React) rather than a destination. It also
  carries the heaviest compliance stack, including **FINRA/SEC 17a-4** — which maps
  directly to our "compliance is the moat" thesis — plus a document viewer/DRM. It
  preserves the **"one interface, computed per actor"** decision, but it is a new vendor
  with per-seat/page cost.
- **Standalone VDR → Datasite / iDeals / Ansarada.** Best-in-class M&A products, but you
  *send users to their app*. Integrating them means linking out, which breaks the unified
  interface. Good as a *referenced* name for Storm ("we're at Datasite-grade"), poor as a
  *plugged-in* component.
- **Lightweight → DocSend.** Cheapest and fastest for an MVP, SOC 2 Type II, but it is
  its own UI and its API is gated to the Advanced tier. A fine stopgap, not a backbone.

## Gap vs. what we have already built

Storm's "you've already built ~50%" is roughly right. Our `documents` schema +
`/api/v1` already cover the *VDR logic*; what we don't have is the hardened *storage/
security substrate*.

| Capability | Built today | Off-the-shelf gives us |
|---|---|---|
| Document classification (1–4) | ✅ `documents.classification` | — (we keep our model) |
| Phase-gated access | ✅ `documents.min_phase` + `access.ts` | — |
| Audit trail (view/grant) | ✅ `audit_log` | hardened, exportable, tamper-evident logs |
| Per-actor permissions | ✅ roles + memberships | — |
| Secure file storage at scale | 🔴 stubbed (fake docs, no store) | **encryption at rest, virus scan, watermarking, versioning** |
| Compliance certs (SOC 2 / FINRA) | 🔴 none yet | ✅ inherited from the vendor |
| Document viewer / watermark / DRM | 🔴 none | ✅ |

So the gap is **secure storage + the compliance certificate + viewer/DRM** — exactly the
expensive, slow-to-build, audit-bound parts. That is the textbook "integrate, don't
build" zone. Note the split: **Supabase Storage** closes *secure storage + the SOC 2 /
ISO 27001 / HIPAA certificate* (and we already own it), but **not** viewer/watermark/DRM
or FINRA/SEC 17a-4 retention — those remain a Box-only win, or something we build.

## Recommendation (for the Marcelo + Martín decision)

A **phased / Pac-Man path** (Storm's own framing — build the OS, plug in functionality):

1. **Now (demo):** keep our existing model — `classification` + `min_phase` + `audit_log`
   with mock documents. It is enough to demo the data-room *behaviour* (the gated buyer
   view already works in the integrated prototype). **Build nothing new.**
2. **Next (production substrate):** this is now a *two-way call*, because we already run
   on Supabase. **Default to Supabase Storage** as the secure store — we already own it
   (SOC 2 / ISO 27001 / HIPAA, fully embeddable, cheapest), keeping *our* classification
   + phase + audit model on top. **Choose Box instead only if FINRA/SEC 17a-4 retention
   or a built-in viewer/DRM are near-term hard requirements** — that is the specific
   thing Box buys us that Supabase does not. Either path honours Storm's "same system for
   everyone" and Lance's "stay focused on core business."
3. **Later (optionality):** the standalone VDRs are the *competitive benchmark to cite*,
   not to embed. Storm's "a data room could be its own product" remains a real long-term
   build — but only once the core platform pulls demand.

**One-line:** don't build a VDR. **Start on Supabase Storage (the substrate we already
own), keeping our own classification/phase/audit logic on top**; move to **Box** only if
FINRA/SEC 17a-4 or a built-in DRM/viewer become near-term requirements; treat
Datasite/iDeals/Ansarada as the benchmark we name rather than the thing we plug in.

## Open items before deciding

- **Confirm with Storm whether FINRA/SEC 17a-4 retention is a near-term requirement.**
  This single fact tips the substrate choice between Supabase Storage and Box.
- If **Supabase Storage**: scope what viewer / watermarking / DRM we build vs defer.
- If **Box**: vendor call to confirm UI Elements fit, API limits, and pricing at our
  scale (the free tier is ~100K API calls/mo).
- Decide demo scope with Martín: is a dedicated data-room demo a *future* Storm demo
  (Martín's preference) or folded into the integrated prototype now.

---

### Sources

- Supabase: [Supabase Security / compliance](https://supabase.com/security) (SOC 2 Type 2, ISO 27001, HIPAA), [Supabase Storage docs](https://supabase.com/docs/guides/storage) (S3-compatible, SDK), [Supabase Trust Center](https://trust.supabase.io/)
- Box compliance & platform: [Box Trust Center](https://www.box.com/trust), [Box Governance & Compliance](https://www.box.com/security/governance-and-compliance), [Box Enterprise specs (InvGate)](https://invgate.com/itdb/box-enterprise)
- Datasite: [Datasite VDR FAQs](https://www.datasite.com/en/resources/faqs), [VDR cost guide (Peony)](https://www.peony.ink/blog/virtual-data-room-cost-guide), [Datasite overview (Papermark)](https://www.papermark.com/blog/datasite-virtual-data-room-overview)
- iDeals / Ansarada: [Ansarada pricing guide](https://www.ansarada.com/article/pricing-guide), [VDR providers comparison 2026 (VDR Compare)](https://virtualdatarooms.net/blog/best-virtual-data-room-providers-2026-comprehensive-comparison), [Top VDR providers for security 2026 (Atlas)](https://atlas-cybersecurity.com/top-vdr-providers/)
- DocSend: [DocSend pricing](https://www.docsend.com/pricing/), [Dropbox DocSend Advanced Data Rooms](https://help.dropbox.com/plans/dropbox-docsend-advanced-data-rooms-plan), [DocSend data room analysis (Ellty)](https://www.ellty.com/blog/docsend-data-room)
