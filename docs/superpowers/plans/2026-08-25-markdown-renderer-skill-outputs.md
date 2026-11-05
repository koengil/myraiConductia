# Markdown Renderer for Skill Outputs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render agent-produced Markdown as real headings, tables, and lists at the four surfaces that currently dump it as raw text, via a single shared `<Markdown>` atom.

**Architecture:** One client-side atom (`src/components/atoms/Markdown.tsx`) wraps `react-markdown` + `remark-gfm` with an explicit `components` node map. Styling is expressed on those node renderers against five local CSS-variable aliases (`--md-ink`, `--md-ink-2`, `--md-stroke`, `--md-fill`, `--md-link`); only the root wrapper branches on `variant`, so no node renderer knows about light vs on-dark. Three call sites swap a `<pre>`/`whitespace-pre-wrap` node for the atom; the fourth (`MdBriefingRunner`) gains a lazy artifact fetch on `<details>` open and renders it with `variant="on-dark"`.

**Tech Stack:** Next.js 16 App Router · React 19.2.4 · TypeScript · Tailwind 4 (CSS-variable tokens) · `react-markdown@10.1.0` · `remark-gfm@4.0.1` · Vitest + React Testing Library (jsdom)

**Spec:** `docs/superpowers/specs/2026-08-25-markdown-renderer-skill-outputs-design.md`

## Global Constraints

- **Branch:** work on `feat/markdown-renderer` (already checked out), based on `feat/md-briefing-ignatious`. Never commit to `main`/`master`.
- **Dependencies:** add exactly `react-markdown@10.1.0` and `remark-gfm@4.0.1`. Do **not** add `rehype-raw`, `rehype-highlight`, Shiki, or any other highlighter. Do **not** route this path through `dompurify`.
- **Security:** no `rehype-raw`, no `dangerouslySetInnerHTML`, and a `urlTransform` allowlist of exactly `http:`, `https:`, `mailto:`.
- **Contrast contract:** every text node picks its color from `var(--md-ink)` / `var(--md-ink-2)`, never from a hardcoded hex and never from a type-ramp class that bakes a `color`.
- **Forbidden ramp classes inside the atom** (they hardcode a light-surface `color`): `.caption`, `.eyebrow`, `.bank-label`, `.mono-legal`, `.editorial-lead`, `.editorial-question`. **Allowed:** `.body`, `.bank-body`, `.bank-heading` (the last one is a single clamped size, so it is *not* used for the heading ramp here).
- **Fonts:** Fraunces (`--font-fraunces`) is forbidden here per ADR-0006. Headings use `--font-bank` at weight 600; `code`/`pre` use `--font-mono` (Geist Mono).
- **Heading sizes:** `h1` = `var(--text-xl)` (20px), `h2` = `var(--text-lg)` (16px), `h3` = `var(--text-md)` (14px).
- **No styling in `globals.css`.** Descendant selectors like `.md-prose h2 { … }` are explicitly rejected: unlayered classes silently beat Tailwind utilities, which is the documented root cause of past invisible-text bugs.
- **Scope:** no route changes, no `ConductiaAPI` changes, no session-store changes, no new API surface, no migration.
- **Brand voice for visible copy:** senior, precise, statements not questions, no em-dashes.
- **Test conventions:** flat files in `tests/`, `@` alias for `src`, `vitest` + `@testing-library/react`, jsdom. Run with `npx vitest run <file>`.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `package.json` | Modify | Add the two runtime dependencies |
| `scripts/extract-memo-fixture.ts` | Create | One-shot: pull the real Figma presearch memo out of `lead_research.memo_md` so the fixture is real agent grammar, not invented markdown |
| `tests/fixtures/presearch-memo-excerpt.md` | Create | Verbatim excerpt of the real memo (SWOT table + heading levels + ordered list) used by the atom test |
| `src/components/atoms/Markdown.tsx` | Create | The atom: node map, variant aliases, url allowlist, empty guard |
| `src/components/atoms/index.ts` | Modify | Barrel export |
| `tests/markdown-atom.test.tsx` | Create | Atom behavior: node coverage, GFM tables, raw-HTML inertness, url allowlist, variant aliases, empty guard |
| `src/components/leads/PresearchRunner.tsx` | Modify (~241) | Swap `<pre>` for the atom |
| `src/components/rail/BenchStepRunner.tsx` | Modify (~212) | Swap `<pre>` for the atom, except while the save-failure error shows |
| `tests/bench-step-runner-markdown.test.tsx` | Create | The save-failure `<pre>` fallback |
| `src/components/ignatious/BenchChat.tsx` | Modify (~241) | Assistant turns through the atom, user turns stay plain |
| `tests/bench-chat-markdown.test.tsx` | Create | User plain / assistant markdown split |
| `src/components/rail/MdBriefingRunner.tsx` | Modify (~268-287) | Lazy artifact preview beside the existing download links |
| `tests/md-briefing-preview.test.tsx` | Create | Fetch on open, error alert, 1 MB guard, download link survives |

---

### Task 1: The real-memo fixture

The atom's tests must run against real agent grammar, not invented markdown — the same
discipline `tests/presearch-apply.test.ts` already follows with verbatim memo fixtures.
The richest sample is the Figma presearch memo in `lead_research.memo_md`
(`execution_id exec_4f221d3891008d48`, 50,874 bytes: 23 headings, 39 table rows,
108 bold spans, 28 ordered items, 0 code fences, 0 links, 0 raw HTML).

**Files:**
- Create: `scripts/extract-memo-fixture.ts`
- Create: `tests/fixtures/presearch-memo-excerpt.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `tests/fixtures/presearch-memo-excerpt.md` — a markdown file that Task 2's
  test reads with `readFileSync`. It must contain, at minimum: one `#` h1, one `##` h2,
  one `###` h3, the SWOT GFM table (header row, `|---|---|` alignment row, at least two
  body rows with 300+ character cells), and one ordered list of at least three items.

- [ ] **Step 1: Write the extraction script**

```ts
// scripts/extract-memo-fixture.ts
//
// One-shot: pull the real Figma presearch memo out of lead_research so the
// markdown atom is tested against real agent grammar. Prints the memo to
// stdout; the excerpt is cut by hand and committed as a fixture.
//
//   node --env-file=.env.local --import tsx scripts/extract-memo-fixture.ts > /tmp/memo.md
import { createClient } from '@supabase/supabase-js';

const EXECUTION_ID = 'exec_4f221d3891008d48';

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set (see .env.example)');
  }
  const supabase = createClient(url, key);
  const { data, error } = await supabase
    .from('lead_research')
    .select('execution_id, memo_md')
    .eq('execution_id', EXECUTION_ID)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.memo_md) throw new Error(`no memo_md for ${EXECUTION_ID}`);
  process.stdout.write(data.memo_md);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

- [ ] **Step 2: Run it and capture the memo**

Run:
```bash
node --env-file=.env.local --import tsx scripts/extract-memo-fixture.ts > /tmp/figma-memo.md
wc -c /tmp/figma-memo.md
grep -c '^|' /tmp/figma-memo.md
```
Expected: roughly 50,000 bytes and 39+ table lines.

**If the database is unreachable** (no `.env.local`, revoked key, row deleted): do not
invent a substitute and do not skip this task. Stop, report the exact failure, and ask
whether to proceed with a hand-written fixture. A hand-written fixture is a real
downgrade in test value and is the user's call, not the implementer's.

- [ ] **Step 3: Cut the excerpt into the fixture**

Locate the SWOT table and its surrounding headings:
```bash
grep -n '^#\|^|' /tmp/figma-memo.md | grep -i -n -B2 -A2 'strength\|weakness\|opportunit\|threat'
```
Then write `tests/fixtures/presearch-memo-excerpt.md` **verbatim** from the memo —
copy the bytes, do not retype or reflow them. Include:
1. The memo's `#` h1 title line.
2. The `##` heading that introduces the SWOT section.
3. The full SWOT GFM table, including its `|---|---|` alignment row and every body row
   (the 300+ character prose cells are the point; do not truncate them).
4. One `###` sub-heading from the memo.
5. One ordered list of three or more items from the memo.

Cap the file at roughly 8 KB. Do not add a licence header, a comment, or any line that
is not in the source memo.

- [ ] **Step 4: Verify the fixture has the constructs the tests need**

Run:
```bash
grep -c '^# '   tests/fixtures/presearch-memo-excerpt.md
grep -c '^## '  tests/fixtures/presearch-memo-excerpt.md
grep -c '^### ' tests/fixtures/presearch-memo-excerpt.md
grep -cE '^\|[ :-]+\|' tests/fixtures/presearch-memo-excerpt.md
grep -cE '^[0-9]+\. '  tests/fixtures/presearch-memo-excerpt.md
```
Expected: at least `1`, `1`, `1`, `1`, `3` respectively. Every count must be non-zero.

- [ ] **Step 5: Commit**

```bash
git add scripts/extract-memo-fixture.ts tests/fixtures/presearch-memo-excerpt.md
git commit -m "test(fixtures): capture the real Figma presearch memo excerpt"
```

---

### Task 2: The `<Markdown>` atom

**Files:**
- Modify: `package.json` (dependencies)
- Create: `src/components/atoms/Markdown.tsx`
- Modify: `src/components/atoms/index.ts`
- Test: `tests/markdown-atom.test.tsx`

**Interfaces:**
- Consumes: `tests/fixtures/presearch-memo-excerpt.md` from Task 1.
- Produces:
  ```ts
  export type MarkdownVariant = 'light' | 'on-dark';
  export type MarkdownProps = {
    children: string;
    variant?: MarkdownVariant; // defaults to 'light'
    className?: string;
  };
  export function Markdown(props: MarkdownProps): React.ReactElement | null;
  export default Markdown;
  ```
  Re-exported from `@/components/atoms` as `Markdown` and `MarkdownProps`.
  Tasks 3-6 import it as `import { Markdown } from '@/components/atoms';`.

- [ ] **Step 1: Install the dependencies**

```bash
npm install react-markdown@10.1.0 remark-gfm@4.0.1
```

Verify the peer requirement is satisfied (`react-markdown` needs `react >=18`; this repo
is on `19.2.4`) and that nothing else moved:
```bash
npm ls react-markdown remark-gfm react
git diff --stat package.json package-lock.json
```
Expected: both packages resolve at the pinned versions, `react` stays `19.2.4`, and only
`package.json` + `package-lock.json` changed.

- [ ] **Step 2: Write the failing test**

```tsx
// tests/markdown-atom.test.tsx
/**
 * The shared Markdown atom. Node coverage and the two guards (raw HTML is inert,
 * non-http(s)/mailto hrefs are dropped) are tested against the real Figma
 * presearch memo excerpt, not invented markdown.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Markdown } from '@/components/atoms';

const MEMO = readFileSync(
  path.resolve(__dirname, 'fixtures/presearch-memo-excerpt.md'),
  'utf8',
);

describe('Markdown atom', () => {
  it('renders #/##/### as h1/h2/h3', () => {
    const { container } = render(<Markdown>{'# One\n\n## Two\n\n### Three'}</Markdown>);
    expect(container.querySelector('h1')?.textContent).toBe('One');
    expect(container.querySelector('h2')?.textContent).toBe('Two');
    expect(container.querySelector('h3')?.textContent).toBe('Three');
  });

  it('renders the real memo GFM table as thead/tbody without an alignment data row', () => {
    const { container } = render(<Markdown>{MEMO}</Markdown>);
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(table?.querySelector('thead')).not.toBeNull();
    expect(table?.querySelector('tbody')).not.toBeNull();
    // The `|---|---|` row is grammar, not data: it must not become a <tr>.
    const bodyText = table?.querySelector('tbody')?.textContent ?? '';
    expect(bodyText).not.toMatch(/^-{3,}$/m);
    expect(bodyText.replace(/[\s|]/g, '')).not.toMatch(/^-+$/);
  });

  it('wraps the table in a horizontally scrollable container', () => {
    const { container } = render(<Markdown>{MEMO}</Markdown>);
    const wrapper = container.querySelector('table')?.parentElement;
    expect(wrapper?.getAttribute('style')).toContain('overflow-x: auto');
  });

  it('renders the real memo headings across all three levels', () => {
    const { container } = render(<Markdown>{MEMO}</Markdown>);
    expect(container.querySelectorAll('h1').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('h2').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('h3').length).toBeGreaterThan(0);
  });

  it('renders ordered lists as ol/li', () => {
    const { container } = render(<Markdown>{'1. first\n2. second\n3. third'}</Markdown>);
    const items = container.querySelectorAll('ol > li');
    expect(items.length).toBe(3);
    expect(items[1].textContent).toBe('second');
  });

  it('renders raw HTML as visible text and creates no element for it', () => {
    const { container } = render(
      <Markdown>{'<img src=x onerror=alert(1)>\n\n<b>bold?</b>'}</Markdown>,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<b>bold?</b>');
  });

  it('drops a javascript: href and keeps an https: one with safe rel/target', () => {
    const { container } = render(
      <Markdown>{'[bad](javascript:alert(1)) and [good](https://example.com)'}</Markdown>,
    );
    const anchors = Array.from(container.querySelectorAll('a'));
    const good = anchors.find((a) => a.textContent === 'good');
    expect(good?.getAttribute('href')).toBe('https://example.com');
    expect(good?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(good?.getAttribute('target')).toBe('_blank');
    const bad = anchors.find((a) => a.textContent === 'bad');
    expect(bad?.getAttribute('href') ?? '').not.toContain('javascript:');
  });

  it('keeps a mailto: href', () => {
    const { container } = render(<Markdown>{'[mail](mailto:md@example.com)'}</Markdown>);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('mailto:md@example.com');
  });

  it('sets the on-dark aliases on the wrapper', () => {
    const { container } = render(<Markdown variant="on-dark">{'# Heading'}</Markdown>);
    const style = container.firstElementChild?.getAttribute('style') ?? '';
    expect(style).toContain('--md-ink: var(--ink-on-dark)');
    expect(style).toContain('--md-stroke: var(--on-dark-stroke-12)');
    // --accent is navy on the navy canvas, so on-dark links inherit the ink.
    expect(style).toContain('--md-link: var(--md-ink)');
  });

  it('defaults to the light aliases', () => {
    const { container } = render(<Markdown>{'# Heading'}</Markdown>);
    const style = container.firstElementChild?.getAttribute('style') ?? '';
    expect(style).toContain('--md-ink: var(--ink)');
    expect(style).toContain('--md-link: var(--accent)');
  });

  it('renders nothing for an empty or whitespace-only string', () => {
    const { container: empty } = render(<Markdown>{''}</Markdown>);
    expect(empty.innerHTML).toBe('');
    const { container: blank } = render(<Markdown>{'   \n\t  '}</Markdown>);
    expect(blank.innerHTML).toBe('');
  });

  it('applies the caller className to the wrapper', () => {
    const { container } = render(<Markdown className="mt-2 max-h-80">{'# H'}</Markdown>);
    expect(container.firstElementChild?.className).toContain('max-h-80');
  });

  it('does not throw on unterminated constructs', () => {
    expect(() => render(<Markdown>{'**unclosed and | a | half table'}</Markdown>)).not.toThrow();
    expect(screen.getByText(/unclosed/)).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/markdown-atom.test.tsx`
Expected: FAIL — `Markdown` is not exported from `@/components/atoms`.

- [ ] **Step 4: Write the atom**

```tsx
// src/components/atoms/Markdown.tsx
'use client';

import * as React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export type MarkdownVariant = 'light' | 'on-dark';

export type MarkdownProps = {
  children: string;
  variant?: MarkdownVariant;
  className?: string;
};

/**
 * The node map is written once against these aliases, so no node renderer
 * branches on `variant` and an on-dark host costs five declarations.
 *
 * `--md-link` is an alias rather than `var(--accent)` because `--accent` is
 * palette-dependent: navy in the default palette, gold in another. Navy links
 * on the navy on-dark canvas would be effectively invisible, so on-dark links
 * inherit the surrounding ink and rely on the underline.
 */
const ALIASES: Record<MarkdownVariant, React.CSSProperties> = {
  light: {
    '--md-ink': 'var(--ink)',
    '--md-ink-2': 'var(--ink-secondary)',
    '--md-stroke': 'var(--stroke)',
    '--md-fill': 'var(--surface-warm)',
    '--md-link': 'var(--accent)',
  } as React.CSSProperties,
  'on-dark': {
    '--md-ink': 'var(--ink-on-dark)',
    '--md-ink-2': 'var(--ink-on-dark-secondary)',
    '--md-stroke': 'var(--on-dark-stroke-12)',
    '--md-fill': 'var(--on-dark-fill-06)',
    '--md-link': 'var(--md-ink)',
  } as React.CSSProperties,
};

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * Allowlist, not denylist. The input is untrusted model output from a remote
 * control plane; anything that is not http/https/mailto never becomes an href.
 */
function safeUrl(url: string): string {
  try {
    const parsed = new URL(url, 'https://conductia.invalid/');
    return SAFE_SCHEMES.has(parsed.protocol) ? url : '';
  } catch {
    return '';
  }
}

const heading = (size: string): React.CSSProperties => ({
  fontFamily: 'var(--font-bank)',
  fontWeight: 600,
  fontSize: size,
  lineHeight: 1.25,
  letterSpacing: '-0.01em',
  color: 'var(--md-ink)',
  marginTop: 'var(--space-4)',
  marginBottom: 'var(--space-2)',
});

const cell: React.CSSProperties = {
  borderTop: '1px solid var(--md-stroke)',
  padding: 'var(--space-3)',
  textAlign: 'left',
  verticalAlign: 'top',
  color: 'var(--md-ink)',
};

const COMPONENTS = {
  h1: (props) => <h1 {...props} style={heading('var(--text-xl)')} />,
  h2: (props) => <h2 {...props} style={heading('var(--text-lg)')} />,
  h3: (props) => <h3 {...props} style={heading('var(--text-md)')} />,
  h4: (props) => <h4 {...props} style={heading('var(--text-md)')} />,
  h5: (props) => <h5 {...props} style={heading('var(--text-md)')} />,
  h6: (props) => <h6 {...props} style={heading('var(--text-md)')} />,

  p: (props) => (
    <p
      {...props}
      className="body"
      style={{ color: 'var(--md-ink)', margin: '0 0 var(--space-3)' }}
    />
  ),
  strong: (props) => <strong {...props} style={{ fontWeight: 600, color: 'var(--md-ink)' }} />,
  em: (props) => <em {...props} style={{ fontStyle: 'italic', color: 'var(--md-ink)' }} />,

  ul: (props) => (
    <ul
      {...props}
      className="body"
      style={{
        color: 'var(--md-ink)',
        listStyle: 'disc',
        paddingLeft: 'var(--space-5)',
        margin: '0 0 var(--space-3)',
      }}
    />
  ),
  ol: (props) => (
    <ol
      {...props}
      className="body"
      style={{
        color: 'var(--md-ink)',
        listStyle: 'decimal',
        paddingLeft: 'var(--space-5)',
        margin: '0 0 var(--space-3)',
      }}
    />
  ),
  li: (props) => <li {...props} style={{ margin: '0 0 var(--space-2)' }} />,

  // The SWOT table carries multi-sentence cells at 300+ characters. Containment
  // is the point: the wrapper scrolls, the panel does not.
  table: (props) => (
    <div style={{ overflowX: 'auto', margin: '0 0 var(--space-4)' }}>
      <table
        {...props}
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 'var(--text-sm)',
          color: 'var(--md-ink)',
        }}
      />
    </div>
  ),
  thead: (props) => <thead {...props} />,
  tbody: (props) => <tbody {...props} />,
  tr: (props) => <tr {...props} />,
  th: (props) => (
    <th
      {...props}
      style={{
        ...cell,
        fontWeight: 600,
        borderBottom: '1px solid var(--md-stroke)',
        whiteSpace: 'nowrap',
      }}
    />
  ),
  td: (props) => <td {...props} style={cell} />,

  a: (props) => (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        color: 'var(--md-link)',
        textDecoration: 'underline',
        textUnderlineOffset: 4,
      }}
    />
  ),

  code: (props) => (
    <code
      {...props}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-xs)',
        background: 'var(--md-fill)',
        borderRadius: 'var(--radius-input)',
        padding: '0.1em 0.35em',
        color: 'var(--md-ink)',
      }}
    />
  ),
  pre: (props) => (
    <pre
      {...props}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-xs)',
        background: 'var(--md-fill)',
        border: '1px solid var(--md-stroke)',
        borderRadius: 'var(--radius-input)',
        padding: 'var(--space-3)',
        overflowX: 'auto',
        color: 'var(--md-ink)',
        margin: '0 0 var(--space-3)',
      }}
    />
  ),

  blockquote: (props) => (
    <blockquote
      {...props}
      style={{
        borderLeft: '2px solid var(--md-stroke)',
        paddingLeft: 'var(--space-3)',
        margin: '0 0 var(--space-3)',
        color: 'var(--md-ink-2)',
      }}
    />
  ),
  hr: (props) => (
    <hr
      {...props}
      style={{
        border: 0,
        borderTop: '1px solid var(--md-stroke)',
        margin: 'var(--space-4) 0',
      }}
    />
  ),
} satisfies React.ComponentProps<typeof ReactMarkdown>['components'];

/**
 * Renders untrusted agent markdown. GFM tables and ordered lists are supported;
 * raw HTML is inert (no rehype-raw, so there is no HTML string to sanitize and
 * dompurify is deliberately not in this path).
 */
export function Markdown({ children, variant = 'light', className }: MarkdownProps) {
  if (!children || !children.trim()) return null;
  return (
    <div className={className} style={ALIASES[variant]}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrl}
        components={COMPONENTS}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export default Markdown;
```

If TypeScript complains about the implicit `props` parameter in the `COMPONENTS`
literal, annotate the map as
`const COMPONENTS: Components = { … }` with
`import type { Components } from 'react-markdown';` and drop the `satisfies` clause.
Do not reach for `any`.

- [ ] **Step 5: Export from the barrel**

Append to `src/components/atoms/index.ts`:

```ts
export { Markdown } from './Markdown';
export type { MarkdownProps, MarkdownVariant } from './Markdown';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/markdown-atom.test.tsx`
Expected: PASS, all cases.

- [ ] **Step 7: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/components/atoms/Markdown.tsx src/components/atoms/index.ts tests/markdown-atom.test.tsx
git commit -m "feat(atoms): add a shared Markdown renderer for agent output"
```

---

### Task 3: `PresearchRunner` renders the memo

The 50 KB Figma memo lands here. This is the visual proof for the whole change.

**Files:**
- Modify: `src/components/leads/PresearchRunner.tsx` (~line 241)

**Interfaces:**
- Consumes: `Markdown` from `@/components/atoms` (Task 2).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the import**

At the top of `src/components/leads/PresearchRunner.tsx`, alongside the other `@/`
imports:

```tsx
import { Markdown } from '@/components/atoms';
```

- [ ] **Step 2: Swap the `<pre>`**

Replace:

```tsx
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
            {latestMemo}
          </pre>
```

with:

```tsx
          <Markdown className="mt-2 max-h-80 overflow-auto">{latestMemo}</Markdown>
```

`latestMemo` is already `body.latest?.memo_md` resolved into state; no new plumbing.
The `text-[var(--ink-secondary)]` is dropped deliberately: the atom owns ink now, via
`var(--md-ink)`, which is the contrast contract.

- [ ] **Step 3: Verify the suite is still green**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS. `tests/presearch-apply.test.ts` is untouched — this change is
presentation only, no parsing or filing logic moves.

- [ ] **Step 4: Commit**

```bash
git add src/components/leads/PresearchRunner.tsx
git commit -m "feat(leads): render the presearch memo as markdown"
```

---

### Task 4: `BenchStepRunner` renders the reply, except on save failure

Line 136 sets the error "The skill ran, but the reply could not be saved onto the step.
Copy it from below." Rendering markdown strips the `**` and `|` that a user copying the
source would want, so that one state keeps the raw `<pre>`. A documented affordance
preserved for the cost of a ternary.

**Files:**
- Modify: `src/components/rail/BenchStepRunner.tsx` (~line 212)
- Test: `tests/bench-step-runner-markdown.test.tsx`

**Interfaces:**
- Consumes: `Markdown` from `@/components/atoms` (Task 2), `SAVE_FAILURE_MESSAGE` (introduced below).
- Produces: `export const SAVE_FAILURE_MESSAGE` from `src/components/rail/BenchStepRunner.tsx` — the exact copy string, exported so the test asserts against the constant rather than a duplicated literal.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/bench-step-runner-markdown.test.tsx
/**
 * The bench step reply renders as markdown, except while the save-failure error
 * is showing: that state exists so the MD can copy the raw source, and markdown
 * rendering would strip the ** and | they need.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { Markdown } from '@/components/atoms';
import { SAVE_FAILURE_MESSAGE } from '@/components/rail/BenchStepRunner';

const REPLY = '## Heading\n\n| a | b |\n|---|---|\n| 1 | 2 |';

// The rendering decision under test, extracted exactly as the component uses it.
function ReplyBody({ reply, error }: { reply: string; error: string | null }) {
  return error === SAVE_FAILURE_MESSAGE ? (
    <pre className="whitespace-pre-wrap">{reply}</pre>
  ) : (
    <Markdown>{reply}</Markdown>
  );
}

describe('BenchStepRunner reply body', () => {
  it('renders markdown when the reply saved', () => {
    const { container } = render(<ReplyBody reply={REPLY} error={null} />);
    expect(container.querySelector('h2')).not.toBeNull();
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('pre')).toBeNull();
  });

  it('falls back to raw pre while the save-failure error is showing', () => {
    const { container } = render(<ReplyBody reply={REPLY} error={SAVE_FAILURE_MESSAGE} />);
    expect(container.querySelector('pre')?.textContent).toBe(REPLY);
    expect(container.querySelector('table')).toBeNull();
  });

  it('renders markdown for an unrelated error', () => {
    const { container } = render(<ReplyBody reply={REPLY} error={'network down'} />);
    expect(container.querySelector('table')).not.toBeNull();
  });

  it('exports the exact save-failure copy the component sets', () => {
    expect(SAVE_FAILURE_MESSAGE).toBe(
      'The skill ran, but the reply could not be saved onto the step. Copy it from below.',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bench-step-runner-markdown.test.tsx`
Expected: FAIL — `SAVE_FAILURE_MESSAGE` is not exported from `BenchStepRunner`.

- [ ] **Step 3: Extract the constant and swap the `<pre>`**

In `src/components/rail/BenchStepRunner.tsx`, add the import alongside the other `@/` imports:

```tsx
import { Markdown } from '@/components/atoms';
```

Add the constant above the component declaration:

```tsx
export const SAVE_FAILURE_MESSAGE =
  'The skill ran, but the reply could not be saved onto the step. Copy it from below.';
```

At line ~136, replace the inline literal:

```tsx
        setError('The skill ran, but the reply could not be saved onto the step. Copy it from below.');
```

with:

```tsx
        setError(SAVE_FAILURE_MESSAGE);
```

At line ~212, replace:

```tsx
          {reply ? (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)] font-mono text-[length:var(--text-xs)]">
              {reply}
            </pre>
          ) : pending ? (
```

with:

```tsx
          {reply ? (
            error === SAVE_FAILURE_MESSAGE ? (
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)] font-mono text-[length:var(--text-xs)]">
                {reply}
              </pre>
            ) : (
              <Markdown className="max-h-72 overflow-auto rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)]">
                {reply}
              </Markdown>
            )
          ) : pending ? (
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/bench-step-runner-markdown.test.tsx && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/rail/BenchStepRunner.tsx tests/bench-step-runner-markdown.test.tsx
git commit -m "feat(rail): render bench step replies as markdown"
```

---

### Task 5: `BenchChat` renders assistant turns only

`Turn.role` is `'user' | 'assistant'`. User turns are typed by a human into an `<input>`
and are not markdown. Rendering them through the atom would also break the inline
`You: ` / `Bench: ` label grammar, since a markdown `<p>` is a block.

**Files:**
- Modify: `src/components/ignatious/BenchChat.tsx` (~line 241)
- Test: `tests/bench-chat-markdown.test.tsx`

**Interfaces:**
- Consumes: `Markdown` from `@/components/atoms` (Task 2).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/bench-chat-markdown.test.tsx
/**
 * Bench turns: assistant output is agent markdown and renders as such; the user
 * turn came out of an <input> and stays plain text under its inline label.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Markdown } from '@/components/atoms';

type Turn = { role: 'user' | 'assistant'; content: string };

// The rendering decision under test, extracted exactly as the component uses it.
function TurnBody({ turn }: { turn: Turn }) {
  return turn.role === 'assistant' ? (
    <div className="mb-2 text-[length:var(--text-sm)]">
      <span className="font-medium">Bench: </span>
      <Markdown>{turn.content}</Markdown>
    </div>
  ) : (
    <p className="mb-2 whitespace-pre-wrap text-[length:var(--text-sm)]">
      <span className="font-medium">You: </span>
      {turn.content}
    </p>
  );
}

describe('BenchChat turn body', () => {
  it('renders an assistant turn as markdown under the Bench label', () => {
    const { container } = render(
      <TurnBody turn={{ role: 'assistant', content: '## Findings\n\n**bold**' }} />,
    );
    expect(container.querySelector('h2')?.textContent).toBe('Findings');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(screen.getByText('Bench:')).toBeTruthy();
  });

  it('renders a user turn as plain text with its markup intact', () => {
    const { container } = render(
      <TurnBody turn={{ role: 'user', content: '## not a heading **not bold**' }} />,
    );
    expect(container.querySelector('h2')).toBeNull();
    expect(container.querySelector('strong')).toBeNull();
    expect(container.textContent).toContain('## not a heading **not bold**');
    expect(screen.getByText('You:')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bench-chat-markdown.test.tsx`
Expected: FAIL — the assertions on `h2`/`strong` fail until the atom is wired in
(if `@/components/atoms` already exports `Markdown` from Task 2, confirm the test is
red for the right reason by temporarily checking it against the current inline-`<p>`
shape; do not skip the red step).

- [ ] **Step 3: Swap the turn renderer**

In `src/components/ignatious/BenchChat.tsx`, add the import alongside the other `@/` imports:

```tsx
import { Markdown } from '@/components/atoms';
```

Replace the turn map at ~line 241:

```tsx
              turns.map((turn, index) => (
                <p key={`${turn.role}-${index}`} className="mb-2 whitespace-pre-wrap text-[length:var(--text-sm)]">
                  <span className="font-medium">{turn.role === 'user' ? 'You' : 'Bench'}: </span>
                  {turn.content}
                </p>
              ))
```

with:

```tsx
              turns.map((turn, index) =>
                turn.role === 'assistant' ? (
                  <div key={`${turn.role}-${index}`} className="mb-2 text-[length:var(--text-sm)]">
                    <span className="font-medium">Bench: </span>
                    <Markdown>{turn.content}</Markdown>
                  </div>
                ) : (
                  <p
                    key={`${turn.role}-${index}`}
                    className="mb-2 whitespace-pre-wrap text-[length:var(--text-sm)]"
                  >
                    <span className="font-medium">You: </span>
                    {turn.content}
                  </p>
                ),
              )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/bench-chat-markdown.test.tsx && npx vitest run tests/ignatious-bench.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/ignatious/BenchChat.tsx tests/bench-chat-markdown.test.tsx
git commit -m "feat(ignatious): render bench assistant turns as markdown"
```

---

### Task 6: `MdBriefingRunner` previews the primary artifact

The only site with new data flow. Today the memo is reachable only as a download link.
`content-disposition: attachment` on the artifacts route affects navigation, not
`fetch()`, so **no route change is required**.

Fetch is lazy on `<details>` open, matching the existing disclosure grammar in
`PresearchRunner` rather than inventing a new one, and avoiding a round trip for memos
nobody expands. The existing artifact `<a>` links are unchanged: preview is added
beside download, not in place of it.

**Files:**
- Modify: `src/components/rail/MdBriefingRunner.tsx` (~lines 52-56, 144-155, 268-287)
- Test: `tests/md-briefing-preview.test.tsx`

**Interfaces:**
- Consumes: `Markdown` from `@/components/atoms` (Task 2); `artifactUrl(dealId, executionId, path)` from `@/lib/ignatious/client`; `RunArtifactRef = { path: string; kind: 'document' | 'structured'; primary: boolean; bytes: number }` from `@/lib/ignatious/types`.
- Produces:
  ```ts
  export const MAX_PREVIEW_BYTES: number;                       // 1024 * 1024
  export function pickPreviewArtifact(
    artifacts: RunArtifactRef[],
  ): RunArtifactRef | null;
  ```
  Both exported from `src/components/rail/MdBriefingRunner.tsx` so the test drives the
  selection and guard directly instead of through the full run lifecycle.

- [ ] **Step 1: Write the failing test**

```tsx
// tests/md-briefing-preview.test.tsx
/**
 * The md-briefing primary artifact gets an inline preview: fetched lazily on
 * <details> open, rendered on-dark, with the download link surviving in every
 * state and a 1 MB guard in front of the parser.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { MAX_PREVIEW_BYTES, pickPreviewArtifact } from '@/components/rail/MdBriefingRunner';

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const MEMO = '## MD brief\n\n| topic | read |\n|---|---|\n| price | firm |';

function artifact(over: Partial<{ path: string; kind: 'document' | 'structured'; primary: boolean; bytes: number }> = {}) {
  return { path: 'brief.md', kind: 'document' as const, primary: true, bytes: 51_000, ...over };
}

describe('pickPreviewArtifact', () => {
  it('picks the primary markdown document', () => {
    expect(pickPreviewArtifact([artifact()])?.path).toBe('brief.md');
  });

  it('ignores non-primary, structured, and non-markdown artifacts', () => {
    expect(
      pickPreviewArtifact([
        artifact({ path: 'notes.md', primary: false }),
        artifact({ path: 'data.json', kind: 'structured' }),
        artifact({ path: 'deck.pdf' }),
      ]),
    ).toBeNull();
  });

  it('accepts .markdown and .txt', () => {
    expect(pickPreviewArtifact([artifact({ path: 'brief.markdown' })])?.path).toBe('brief.markdown');
    expect(pickPreviewArtifact([artifact({ path: 'brief.txt' })])?.path).toBe('brief.txt');
  });

  it('guards at 1 MB', () => {
    expect(MAX_PREVIEW_BYTES).toBe(1024 * 1024);
  });
});

// ArtifactPreview is the sub-component under test. Import it from the module.
import { ArtifactPreview } from '@/components/rail/MdBriefingRunner';

describe('ArtifactPreview', () => {
  it('does not fetch until the disclosure is opened, then renders markdown', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => MEMO }));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <ArtifactPreview dealId="deal-1" executionId="exec-1" artifact={artifact()} />,
    );
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText(/Preview/i));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container.querySelector('table')).not.toBeNull());
    expect(container.querySelector('h2')?.textContent).toBe('MD brief');
  });

  it('renders an alert on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, text: async () => '' })));
    render(<ArtifactPreview dealId="deal-1" executionId="exec-1" artifact={artifact()} />);
    fireEvent.click(screen.getByText(/Preview/i));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });

  it('renders an alert when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    render(<ArtifactPreview dealId="deal-1" executionId="exec-1" artifact={artifact()} />);
    fireEvent.click(screen.getByText(/Preview/i));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('offline'));
  });

  it('treats an empty body as no preview, not an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '' })));
    const { container } = render(
      <ArtifactPreview dealId="deal-1" executionId="exec-1" artifact={artifact()} />,
    );
    fireEvent.click(screen.getByText(/Preview/i));
    await waitFor(() => expect(screen.queryByText(/Running|Loading/i)).toBeNull());
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('skips the preview above the 1 MB guard and shows the size', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ArtifactPreview
        dealId="deal-1"
        executionId="exec-1"
        artifact={artifact({ bytes: MAX_PREVIEW_BYTES + 1 })}
      />,
    );
    expect(screen.queryByText(/Preview/i)).toBeNull();
    expect(screen.getByText(/MB/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches again when the executionId changes', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, text: async () => MEMO }));
    vi.stubGlobal('fetch', fetchMock);
    const { rerender, container } = render(
      <ArtifactPreview dealId="deal-1" executionId="exec-1" artifact={artifact()} />,
    );
    fireEvent.click(screen.getByText(/Preview/i));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    rerender(<ArtifactPreview dealId="deal-1" executionId="exec-2" artifact={artifact()} />);
    expect(container.querySelector('table')).toBeNull();
    fireEvent.click(screen.getByText(/Preview/i));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/md-briefing-preview.test.tsx`
Expected: FAIL — `MAX_PREVIEW_BYTES`, `pickPreviewArtifact`, and `ArtifactPreview` are
not exported from `MdBriefingRunner`.

- [ ] **Step 3: Add the selection helper and the guard constant**

In `src/components/rail/MdBriefingRunner.tsx`, add to the imports:

```tsx
import { Markdown } from '@/components/atoms';
```

and extend the existing type import with `RunArtifactRef`:

```tsx
import type {
  BriefDepth,
  MeetingType,
  PendingQuestion,
  RunArtifactRef,
  RunLifecycleStatus,
  RunStatus,
} from '@/lib/ignatious/types';
```

Add below the existing `ACTIVE` constant:

```tsx
/**
 * Parsing multi-megabyte markdown blocks the main thread. The largest known
 * artifact is 51 KB, so this guard costs nothing today and prevents a hang later.
 */
export const MAX_PREVIEW_BYTES = 1024 * 1024;

const PREVIEWABLE = /\.(md|markdown|txt)$/i;

export function pickPreviewArtifact(artifacts: RunArtifactRef[]): RunArtifactRef | null {
  return (
    artifacts.find((a) => a.primary && a.kind === 'document' && PREVIEWABLE.test(a.path)) ?? null
  );
}
```

- [ ] **Step 4: Write the `ArtifactPreview` sub-component**

Add at the bottom of `src/components/rail/MdBriefingRunner.tsx`, beside `QuestionsPanel`:

```tsx
/**
 * Lazy preview of the primary run artifact. `content-disposition: attachment`
 * on the artifacts route affects navigation only; fetch() ignores it, so no
 * route change is needed. Fetching on <details> open matches the disclosure
 * grammar in PresearchRunner and avoids a round trip for memos nobody expands.
 */
export function ArtifactPreview({
  dealId,
  executionId,
  artifact,
}: {
  dealId: string;
  executionId: string;
  artifact: RunArtifactRef;
}) {
  const [text, setText] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const key = `${executionId}:${artifact.path}`;
  const loaded = React.useRef<string | null>(null);

  // A re-run invalidates the cached text: the path is stable, the run is not.
  React.useEffect(() => {
    if (loaded.current === key) return;
    loaded.current = null;
    setText(null);
    setError(null);
    setPending(false);
  }, [key]);

  if (artifact.bytes > MAX_PREVIEW_BYTES) {
    return (
      <p className="mt-2 text-[length:var(--text-xs)] text-[color-mix(in_srgb,var(--ink-on-dark)_66%,transparent)]">
        {(artifact.bytes / (1024 * 1024)).toFixed(1)} MB. Too large to preview inline. Open the
        artifact link above.
      </p>
    );
  }

  async function load() {
    if (loaded.current === key || pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(artifactUrl(dealId, executionId, artifact.path), {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error(
          response.status === 503
            ? 'Ignatious is not configured in this environment.'
            : `The artifact could not be loaded (${response.status}).`,
        );
      }
      const body = await response.text();
      loaded.current = key;
      setText(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <details
      className="mt-2 rounded-[var(--radius-input)] border border-[var(--on-dark-stroke-12)] p-[var(--space-3)]"
      onToggle={(event) => {
        if ((event.currentTarget as HTMLDetailsElement).open) void load();
      }}
    >
      <summary className="cursor-pointer text-[length:var(--text-sm)] font-medium">
        Preview {artifact.path}
      </summary>
      {pending ? (
        <p className="mt-2 text-[length:var(--text-sm)] text-[color-mix(in_srgb,var(--ink-on-dark)_70%,transparent)]">
          Loading the brief…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[length:var(--text-sm)] text-[var(--negative)]">
          {error}
        </p>
      ) : null}
      {text ? (
        <Markdown variant="on-dark" className="mt-2 max-h-96 overflow-auto">
          {text}
        </Markdown>
      ) : null}
    </details>
  );
}
```

Note the empty-body case needs no branch: `text` is `''`, the `text ?` guard is false,
and the atom would return `null` regardless. An empty response is no preview, not an error.

- [ ] **Step 5: Mount the preview beside the artifact links**

In the artifacts block (~line 268), extend the `<li>` for the previewable artifact.
Replace:

```tsx
              <ul className="mt-2 space-y-1">
                {artifacts.map((artifact) => (
                  <li key={artifact.path}>
                    <a
                      href={artifactUrl(dealId, run.executionId, artifact.path)}
                      className="text-[length:var(--text-sm)] underline underline-offset-4 hover:text-white"
                    >
                      {artifact.path}
                      {artifact.primary ? ' · primary' : ''}
                    </a>
                  </li>
                ))}
              </ul>
```

with:

```tsx
              <ul className="mt-2 space-y-1">
                {artifacts.map((artifact) => (
                  <li key={artifact.path}>
                    <a
                      href={artifactUrl(dealId, run.executionId, artifact.path)}
                      className="text-[length:var(--text-sm)] underline underline-offset-4 hover:text-white"
                    >
                      {artifact.path}
                      {artifact.primary ? ' · primary' : ''}
                    </a>
                    {previewArtifact?.path === artifact.path ? (
                      <ArtifactPreview
                        dealId={dealId}
                        executionId={run.executionId}
                        artifact={artifact}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
```

and derive `previewArtifact` beside the existing `artifacts` line (~153):

```tsx
  const artifacts = run?.artifacts ?? [];
  const previewArtifact = pickPreviewArtifact(artifacts);
```

The download link is untouched in every state: preview is added beside it, not in place of it.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/md-briefing-preview.test.tsx && npx tsc --noEmit && npm run lint`
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
git add src/components/rail/MdBriefingRunner.tsx tests/md-briefing-preview.test.tsx
git commit -m "feat(rail): preview the md-briefing artifact inline"
```

---

### Task 7: Verify against the real memo and measure the bundle

The `overflow-x` wrapper around the table is the highest-risk visual detail: the SWOT
table's 300+ character cells are the most likely thing to look wrong on first render.
The spec is explicit that this is verified against the real 50 KB Figma memo, not a
synthetic fixture. The bundle delta is asserted nowhere in the spec — it is measured
here and reported in the PR.

**Files:**
- Modify: none required. Any fix this task uncovers lands in `src/components/atoms/Markdown.tsx`.

**Interfaces:**
- Consumes: everything from Tasks 1-6.
- Produces: the PR description body.

- [ ] **Step 1: Run the full suite**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: all 170+ files pass, clean typecheck, clean lint. `tests/presearch-apply.test.ts`
must still pass untouched.

- [ ] **Step 2: Measure the bundle delta**

```bash
npm run build 2>&1 | tee /tmp/build-after.txt
git stash --include-untracked
npm install                      # restore the pre-change lockfile state
npm run build 2>&1 | tee /tmp/build-before.txt
git stash pop
npm install
```

Compare the First Load JS figures for the routes hosting the four call sites and record
the delta in KB. Report the number in the PR; do not assert one in code or docs.

- [ ] **Step 3: Verify the real memo renders**

```bash
npm run dev
```

Open the lead that carries the Figma presearch memo, expand "Latest presearch memo",
and check every one of these against the running app, not against the test suite:

1. Headings render at three distinct sizes (h1 20px / h2 16px / h3 14px), all in Inter, none in Fraunces.
2. The SWOT table's 300+ character cells wrap inside the cell and do not push the lead panel wider. If the panel itself grows a horizontal scrollbar, the containment is wrong: the `overflow-x: auto` belongs on the table wrapper only.
3. Body text is legible on the light surface (`var(--ink)`), not washed out.
4. The 28 ordered-list items are numbered correctly and are not renumbered from 1 per paragraph.
5. Scrolling 50 KB inside `max-h-80` is smooth, with no visible parse stall.

Then open the md-briefing rail step, run it (or replay a completed run), and expand the
artifact preview. Check that headings, table hairlines, and body text are all legible on
the navy canvas, and that no text renders in a light-surface ink.

Take a screenshot of the SWOT table on both surfaces for the PR.

- [ ] **Step 4: Fix any containment or contrast defect found**

Fixes belong in `src/components/atoms/Markdown.tsx` and nowhere else — one atom, four
call sites. If a fix changes rendered structure, extend `tests/markdown-atom.test.tsx`
to cover it before making the change.

Run: `npx vitest run tests/markdown-atom.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit any fixes and open the PR**

```bash
git add -A
git commit -m "fix(atoms): tighten markdown table containment against the real memo"
git push -u origin feat/markdown-renderer
```

The PR description must carry:
- The measured bundle delta from Step 2, per route.
- The two screenshots from Step 3 (light and on-dark).
- The explicit statement that raw HTML is inert (no `rehype-raw`) and that `urlTransform`
  allowlists `http`, `https`, `mailto` only.
- The follow-ups, restated as not-in-this-PR: a dedicated document viewer surface if the
  memo proves cramped inline; converging `Chat.tsx`'s `Block[]` grammar onto the atom
  once the command bar returns real AI answers; surfacing the five orphaned
  `lead_documents` rows.

Target `develop` per the completion bar in `CLAUDE.md`: work is done when merged to
`develop`, not `main`.
