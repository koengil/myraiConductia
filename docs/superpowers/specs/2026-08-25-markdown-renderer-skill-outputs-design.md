# Markdown Renderer for Skill Outputs — Design

> **Later (D48, 2026-08-27):** the Workbench register replaced the navy accent and dropped Fraunces two days after this spec. Its reasoning about `--accent` being navy `#163561` and about Fraunces availability describes the palette of that date; the current tokens are in `docs/design/workbench/HANDOVER.md` and `src/app/globals.css`.

**Date:** 2026-08-25
**Status:** Approved design, pending implementation plan
**Base branch:** `feat/md-briefing-ignatious`
**Working branch:** `feat/markdown-renderer`

## Problem

Ignatious agents (`presearch`, `md-briefing`, the skill bench) return their
output as Markdown. Every surface that displays that output today dumps it as
raw text into a `<pre>` or a `whitespace-pre-wrap` paragraph, so the MD reads
pipe characters and asterisks instead of tables and emphasis. One surface,
`MdBriefingRunner`, does not display the memo at all: it is reachable only as a
download link.

This is not a hypothetical. The markdown is real, it is already in the
database, and it is table-heavy.

## Evidence

A read-only survey of every markdown-bearing column (2026-08-25):

| Table · column | Rows | Lead | Size | Constructs |
|---|---|---|---|---|
| `lead_research.memo_md` | 1 | Figma | 50.9 KB | h, bold, ul, ol, table |
| `lead_documents.text_content` | 4 | Line | 4.6–9.0 KB | h, bold, ul, ol, table |
| `lead_documents.text_content` | 1 | Figma | 6.7 KB | h, bold, ol, table |
| `lead_personas.body` | 0 | — | — | — |
| `deal_steps.work` | 0 of 500 | — | — | — |

Every stored document contains GFM tables.

The richest sample is the Figma presearch memo (`execution_id
exec_4f221d3891008d48`, 50,874 bytes):

```
headings: 23   table rows: 39   bold spans: 108   ordered items: 28
code fences: 0  links: 0        raw HTML: 0
```

Four consequences follow directly from that profile:

1. `#` h1 is used, so the heading map covers h1 through h3.
2. Ordered lists are real (28 items), so the renderer cannot assume a flat
   heading-and-bullet grammar.
3. The tables are wide and prose-filled. The SWOT table is two columns of
   multi-sentence cells at 300+ characters each. This is a layout containment
   problem, not only a styling one.
4. Zero code fences means no syntax highlighting is required, so Shiki and
   equivalent highlighters stay out of the dependency tree. Zero links and zero
   raw HTML means the current XSS surface is empty, but the input is untrusted
   model output from a remote control plane and is guarded regardless.

## Scope

**In scope** — the surfaces that render real skill output:

| File | Line | Renders |
|---|---|---|
| `src/components/leads/PresearchRunner.tsx` | 241 | `latestMemo` (`memo_md`) |
| `src/components/rail/BenchStepRunner.tsx` | 212 | skill `reply` |
| `src/components/ignatious/BenchChat.tsx` | 241 | bench turns (assistant only) |
| `src/components/rail/MdBriefingRunner.tsx` | 277 | primary run artifact (new preview) |

**Out of scope:**

- `src/components/rail/StepRunner.tsx:400` and
  `src/components/rail/TeaserRunner.tsx:332` render fixture text
  (`feature.draft`, canned teaser copy), not skill output.
- `src/components/workspace/Chat.tsx` renders a hand-authored `Block[]` from
  `TEMPLATES`. It never handles a markdown string, so it is not a raw-text
  site. It becomes a genuine consumer once the command bar returns real AI
  answers; converging it onto this atom is a follow-up, not this change.
- The five `lead_documents` rows have no UI consumer at all. The only reader is
  `src/app/v1/leads/[leadId]/documents/route.ts`, which is the inbound
  Ignatious callback API (`/v1/`, not `/api/v1/`), authenticated by
  `readTriggerClaims`. Surfacing those documents is a separate product
  decision.

## Approach

**Chosen: a single shared `<Markdown>` atom, rendered inline at all four call
sites.**

Rejected alternatives:

- *A dedicated full-height document viewer surface.* Genuinely better for a
  50 KB memo with 39 table rows, which will feel cramped inline. Deferred
  rather than dropped: it is strictly additive on top of this atom (same
  component, new host), so shipping the inline renderer first lets the real
  memo tell us whether the panel is needed instead of guessing at a layout
  problem we can observe.
- *A markdown-to-`Block[]` pipeline feeding `Chat.tsx`'s `AnswerDocument`.*
  Attractive for grammar unification, but `Block[]` today supports neither
  tables, nor ordered lists, nor code — all of which the real memo uses.
  Extending it means hand-writing an mdast-to-`Block` mapper, which
  reintroduces hand-rolled-parser risk one layer up. Converge `Chat.tsx` onto
  the atom later instead.
- *A hand-rolled parser.* Rejected on evidence: GFM tables with alignment rows,
  nested and ordered lists, and CommonMark's left/right-flanking emphasis rules
  are not a weekend regex job, and the output is untrusted.

## Dependencies

```
react-markdown  10.1.0   peer: react >=18   satisfied by 19.2.4
remark-gfm       4.0.1
```

No `rehype-raw`. No highlighter. `dompurify` is already a dependency for
`src/lib/mail/format.ts` and is deliberately not used in this path (see
Security).

## Architecture — the atom

**Location:** `src/components/atoms/Markdown.tsx`, exported from
`src/components/atoms/index.ts`.

**API:**

```ts
{ children: string; variant?: 'light' | 'on-dark'; className?: string }
```

`variant` defaults to `'light'`.

### Styling mechanism

Styling is expressed as an explicit react-markdown `components` map — each node
type routed to a token-styled element — and not as a `.md-prose` class with
descendant selectors in `globals.css`. Two repo-specific reasons:

1. **The contrast contract.** Every text node must choose between `--ink*` and
   `--ink-on-dark*`. Descendant selectors would have to re-derive that choice
   from an ancestor class.
2. **Layer precedence.** `globals.css` wraps its semantic type ramp in
   `@layer components` (lines 954–1080) precisely because unlayered classes
   silently beat Tailwind utilities — the documented root cause of past
   invisible-text bugs. A global `.md-prose h2 { … }` would override a
   call-site `text-[…]` utility with no warning. A component map cannot.

### Variant mechanism

The node map is written once against local CSS variable aliases. Only the root
wrapper branches on `variant`:

| Alias | `light` | `on-dark` |
|---|---|---|
| `--md-ink` | `var(--ink)` | `var(--ink-on-dark)` |
| `--md-ink-2` | `var(--ink-secondary)` | `var(--ink-on-dark-secondary)` |
| `--md-stroke` | `var(--stroke)` | `var(--on-dark-stroke-12)` |
| `--md-fill` | `var(--surface-warm)` | `var(--on-dark-fill-06)` |
| `--md-link` | `var(--accent)` | `var(--md-ink)` |

Every node renderer references `var(--md-ink)` and friends, so no renderer
branches on `variant` and `MdBriefingRunner`'s on-dark panel costs five
declarations.

`--md-link` earns its own alias rather than resolving to `var(--accent)`
directly because `--accent` is palette-dependent: it is navy `#163561` in the
default palette and gold `#C29445` in another (`globals.css:33`, `:354`,
`:389`). Navy links on the navy on-dark canvas would be effectively invisible.
The on-dark treatment instead inherits the surrounding ink and relies on the
underline, which matches the existing on-dark link grammar at
`MdBriefingRunner.tsx:278` (`underline underline-offset-4 hover:text-white`).

### Node coverage

Driven by the measured content profile, and by the prose grammar already
specified in `docs/design-system.md` ("Chat = document, not widget: a single
~900px prose column, real headings, bold-led bullets, NO bubble chrome" and
"Tables: quiet hairline grid, tall rows").

Two constraints from the existing token system bound this map, both verified
against `src/app/globals.css`:

1. **Fraunces is not available here.** ADR-0006 restricts Fraunces
   (`--font-fraunces`) to two named utility classes only. Memo headings
   therefore use `--font-bank`, which resolves to Inter, at weight 600.
2. **Only ramp classes that do not bake a color are variant-safe.** `.body`,
   `.bank-body`, and `.bank-heading` set no `color` and are safe. `.caption`,
   `.eyebrow`, `.bank-label`, `.mono-legal`, `.editorial-lead`, and
   `.editorial-question` hardcode a light-surface `color` and must not be used
   inside the atom, because they would be unreadable under
   `variant="on-dark"`.

`.bank-heading` is also a single clamped size (`clamp(20px, 2.4vw, 28px)`), not
a ramp. Applying it to `h1`, `h2`, and `h3` alike would render all three
identically, which is wrong for a memo carrying 23 headings across three
levels. Heading sizes come from the `--text-*` scale instead.

| Nodes | Treatment |
|---|---|
| `h1` | `--font-bank` 600, `var(--text-xl)` (20px), `var(--md-ink)` |
| `h2` | `--font-bank` 600, `var(--text-lg)` (16px), `var(--md-ink)` |
| `h3` | `--font-bank` 600, `var(--text-md)` (14px), `var(--md-ink)` |
| `p`, `strong`, `em` | `.body`, `var(--md-ink)`; `strong` at 600 weight |
| `ul`, `ol`, `li` | Bold-led bullets, `--space-*` rhythm, no marker restyling |
| `table` and children | Hairline grid on `var(--md-stroke)`, tall rows, wrapped in an `overflow-x: auto` container |
| `a` | `var(--md-link)`, underline offset 4, `rel="noopener noreferrer"`, `target="_blank"` |
| `code`, `pre` | Geist Mono on `var(--md-fill)`, no highlighting |
| `blockquote`, `hr` | Left rule / hairline on `var(--md-stroke)` |

The `overflow-x` wrapper around `table` is the highest-risk visual detail: the
SWOT table's 300+ character cells are the most likely thing to look wrong on
first render, and it must be verified against the real Figma memo rather than a
synthetic fixture.

### Security

- **No `rehype-raw`.** Raw HTML in agent output renders as inert text, and
  react-markdown never reaches for `dangerouslySetInnerHTML`. This is why
  `dompurify` is not in this path: there is no HTML string to sanitize. It also
  avoids repeating the `sanitizeHtml` problem in `src/lib/mail/format.ts`,
  which returns `''` under SSR because it is browser-only.
- **`urlTransform` allowlist** of `http`, `https`, and `mailto`. Any other
  scheme, `javascript:` included, is dropped so it cannot become an `href`.
- Today's memo contains zero links and zero HTML. The guards go in now because
  the input is untrusted remote model output and the first memo that cites a
  source will contain links.

### Bundle cost

All four call sites are `'use client'`, so react-markdown and remark-gfm land
in client bundles. The actual delta is to be measured on the branch during
implementation and reported in the PR description. No number is asserted here.

## Call sites and data flow

### `PresearchRunner.tsx:241` — light

`latestMemo` is `body.latest?.memo_md`, already resolved into state at line 42.
A direct swap with no new plumbing:

```tsx
<pre className="mt-2 max-h-80 …">{latestMemo}</pre>
→ <Markdown className="mt-2 max-h-80 overflow-auto">{latestMemo}</Markdown>
```

This site renders the 50 KB Figma memo and is the visual proof for the change.

### `BenchStepRunner.tsx:212` — light

`reply` is a plain string in state. Same swap, with one conditional. Line 136
sets an error reading "The skill ran, but the reply could not be saved onto the
step. Copy it from below." Rendering markdown strips the `**` and `|` that a
user copying the source would want. When that save-failure error is showing,
the raw `<pre>` is retained; otherwise the atom renders. This preserves a
documented affordance for the cost of a ternary.

### `BenchChat.tsx:241` — light

`Turn.role` is `'user' | 'assistant'`. User turns are typed by a human into an
`<input>` and are not markdown. **Only assistant turns render through the
atom.** User turns keep `whitespace-pre-wrap`, which also preserves the
`You: ` / `Bench: ` inline label grammar.

### `MdBriefingRunner.tsx:277` — on-dark

The only site with new data flow. `content-disposition: attachment` on
`/api/v1/deals/{dealId}/steps/{stepId}/ignatious/artifacts` affects navigation
only; `fetch()` ignores it. **No route change is required.**

Target selection uses fields already on `RunArtifactRef`:

```ts
run.artifacts.find(
  (a) => a.primary && a.kind === 'document' && /\.(md|markdown|txt)$/.test(a.path),
)
```

Fetch is lazy, triggered on disclosure open, matching the existing `<details>`
grammar in `PresearchRunner` rather than inventing a new one and avoiding a
round trip for memos nobody expands:

```
<details> opened
  → fetch(artifactUrl(dealId, run.executionId, artifact.path))   [existing proxy]
  → response.text()
  → <Markdown variant="on-dark">
```

Three new pieces of local state — `preview`, `previewError`, `previewPending` —
keyed on `executionId + path` so a re-run invalidates the cached text. The
existing artifact `<a>` links are unchanged: download remains available and
preview is added beside it, not in place of it.

### What does not change

No route changes, no `ConductiaAPI` changes, no session-store changes, no new
API surface, no migration.

## Error handling

**In the atom:**

- `children` that is empty or whitespace-only renders nothing (returns `null`).
- Malformed markdown does not throw. CommonMark has no parse errors;
  unterminated constructs degrade to literal text. No error boundary is
  warranted for parsing.

**In `MdBriefingRunner`:**

- Network failure or non-2xx sets `previewError` and renders a `role="alert"`
  line. The download link remains as the escape hatch. A 503 ("Ignatious is not
  configured") is the common local-development case and must read as a normal
  state, not a crash.
- An artifact whose `bytes` exceeds 1 MB skips the preview and shows the size
  with a pointer to the artifact link. Parsing multi-megabyte markdown blocks
  the main thread, and the largest known artifact is 51 KB, so the guard costs
  nothing today and prevents a hang later.
- An empty response body is treated as no preview, not as an error.

## Testing

Vitest + RTL, jsdom, flat files in `tests/`, `@` alias — matching the existing
169-file suite.

**`tests/markdown-atom.test.tsx`:**

- Headings `#`/`##`/`###` render as `h1`/`h2`/`h3`.
- A GFM table renders `thead`/`tbody` with the alignment row consumed, not
  emitted as a data row.
- Ordered lists render `ol`/`li` with correct numbering.
- Raw HTML in the source renders as visible text, and no corresponding element
  is created.
- A `javascript:` href is dropped; an `https:` href survives and carries
  `rel="noopener noreferrer"`.
- `variant="on-dark"` sets the alias variables on the wrapper.
- An empty string renders nothing.

**Fixture:** extract the SWOT table section from the real Figma memo
(`lead_research.memo_md`, `execution_id exec_4f221d3891008d48`) into
`tests/fixtures/presearch-memo-excerpt.md`. Testing against real agent grammar
rather than invented markdown is the point; this mirrors how
`tests/presearch-apply.test.ts` already uses verbatim memo fixtures.

**Call-site tests:**

- `BenchChat` renders a user turn as plain text and an assistant turn as
  markdown.
- `BenchStepRunner` falls back to `<pre>` while the save-failure error is
  showing.
- `MdBriefingRunner` fetches on `<details>` open with a mocked `fetch`, renders
  an alert on failure, retains the download link in both states, and skips
  preview above the 1 MB guard.

**Regression:** `tests/presearch-apply.test.ts` is untouched. This change
alters presentation only; no parsing or filing logic moves.

## Risks

| Risk | Mitigation |
|---|---|
| Wide SWOT tables overflow the rail panel | `overflow-x` containment wrapper, verified against the real 50 KB memo, not a synthetic fixture |
| Client bundle growth on four `'use client'` surfaces | Measure on branch, report in the PR |
| `react-markdown` is dormant (no release since 2025-03-07) | CommonMark is frozen and 33M weekly downloads surface breakage fast; `streamdown` and `marked` + sanitizer are drop-in escape hatches |
| Inline rendering proves cramped for a 50 KB memo | The deferred viewer surface is strictly additive on the same atom |

## Follow-ups (explicitly not this PR)

1. A dedicated document viewer surface, if the real memo proves cramped inline.
2. Converging `Chat.tsx`'s `Block[]` grammar onto the atom once the command bar
   returns real AI answers.
3. Surfacing the five orphaned `lead_documents` rows, which currently have no
   UI consumer.
