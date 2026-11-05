'use client';

import * as React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { blockRanges, sourceShift, type Block, type BlockKind } from '@/lib/skillRun/blocks';

import { ExternalLink } from './ExternalLink';

export type MarkdownVariant = 'light' | 'on-dark';

export type MarkdownAnchors = {
  marks?: ReadonlyMap<number, string>;
  labels?: ReadonlyMap<number, string>;
  selected?: { start: number; end: number } | null;
  tabStop?: number | null;
};

export type MarkdownProps = {
  children: string;
  variant?: MarkdownVariant;
  className?: string;
  anchors?: MarkdownAnchors;
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

/**
 * Allowlist, not denylist. The input is untrusted model output from a remote
 * control plane. Only an absolute http(s)/mailto URL survives, and it is
 * returned as the parser's normalized `href`, so what the browser would use is
 * exactly what was checked. A `#fragment` stays in-page. Everything else
 * (`//host`, `\\host`, `/\host`, `%6Aavascript:`, relative paths, `data:`)
 * becomes '' and renders as plain text.
 */
function safeUrl(url: string): string {
  if (url.startsWith('#')) return url;
  if (!/^(https?:|mailto:)/i.test(url)) return '';
  try {
    return new URL(url).href;
  } catch {
    return '';
  }
}

const LINK: React.CSSProperties = {
  color: 'var(--md-link)',
  textDecoration: 'underline',
  textUnderlineOffset: 'var(--space-1)',
};

/**
 * Model output must never make the browser load anything, so an image is never
 * an `<img>`. The note names the alt text and the host the model pointed at; the
 * source itself never reaches the DOM. Design to confirm (look and copy).
 */
function RemovedImage({ alt, src }: { alt?: string; src?: string }) {
  let host = '';
  try {
    host = src ? new URL(src).host : '';
  } catch {
    host = '';
  }
  return (
    <span
      data-md-image-removed
      style={{ color: 'var(--md-ink-2)', fontSize: 'var(--text-xs)' }}
    >
      Image not shown: {alt || 'no description'}
      {host ? ` (${host})` : ''}
    </span>
  );
}

/**
 * Headings compose the semantic type ramp (`.bank-heading`) rather than
 * restating the family, weight and tracking inline. Only the size the ramp
 * cannot express per level, the atom's own ink, and the rhythm are set here.
 */
const heading = (size: string): React.CSSProperties => ({
  fontSize: size,
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

/**
 * react-markdown v10 sets `passNode: true`, so every renderer receives the parsed
 * hast node. Spreading it onto a DOM element ships `node="[object Object]"` and
 * retains the parsed tree in React props, and React 19 passes it through without
 * warning. Stripping it here rather than destructuring it away in each renderer
 * keeps 21 `'node' is defined but never used` lint warnings out of the file:
 * `eslint-config-next` sets `no-unused-vars` to `warn` with no options object,
 * so there is no `ignoreRestSiblings` escape.
 */
function domProps<P extends object>(props: P): Omit<P, 'node'> {
  const rest = { ...props };
  delete (rest as { node?: unknown }).node;
  return rest;
}

type AnchorState = MarkdownAnchors & { blocks: ReadonlyMap<number, Block>; shift: number };

const AnchorContext = React.createContext<AnchorState | null>(null);

const TAG_KINDS = {
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  p: 'paragraph',
  li: 'listItem',
  tr: 'tableRow',
  blockquote: 'blockquote',
  pre: 'code',
} as const satisfies Record<string, BlockKind>;

type HastNode = { tagName?: string; position?: { start: { offset?: number } } };

type AnchoredProps = React.HTMLAttributes<HTMLElement> & {
  as: keyof typeof TAG_KINDS;
  node?: HastNode;
};

const LIST_TAGS = new Set(['ul', 'ol']);

function isNestedList(child: React.ReactNode): boolean {
  if (!React.isValidElement<{ node?: HastNode }>(child)) return false;
  const tagName = child.props.node?.tagName;
  return tagName !== undefined && LIST_TAGS.has(tagName);
}

function Anchored({ as, node, children, ...rest }: AnchoredProps) {
  const anchors = React.useContext(AnchorContext);
  const start = node?.position?.start.offset;
  const block =
    anchors && typeof start === 'number' ? anchors.blocks.get(start + anchors.shift) : undefined;
  if (!anchors || !block || block.kind !== TAG_KINDS[as]) {
    return React.createElement(as as string, rest, children);
  }
  const selected =
    anchors.selected != null &&
    block.start >= anchors.selected.start &&
    block.end <= anchors.selected.end;
  const stamps = {
    'data-block-start': block.start,
    'data-block-end': block.end,
    'data-block-kind': block.kind,
    'data-mark': anchors.marks?.get(block.start),
    'data-mark-label': anchors.labels?.get(block.start),
    'data-selected': selected ? 'true' : undefined,
    tabIndex: anchors.tabStop === undefined ? undefined : anchors.tabStop === block.start ? 0 : -1,
  };
  const label = anchors.labels?.get(block.start);
  if (as === 'tr' && label !== undefined) {
    const style = { ...(rest.style as React.CSSProperties | undefined), '--mark-label': `"${label}"` };
    return React.createElement(as, { ...rest, ...stamps, style }, children);
  }
  const items = React.Children.toArray(children);
  const firstList = as === 'li' ? items.findIndex(isNestedList) : -1;
  if (firstList === -1) {
    return React.createElement(as as string, { ...rest, ...stamps }, children);
  }
  return React.createElement(
    as as string,
    rest,
    React.createElement('div', stamps, items.slice(0, firstList)),
    items.slice(firstList),
  );
}

const COMPONENTS = {
  h1: (props) => (
    <Anchored
      as="h1"
      node={props.node}
      {...domProps(props)}
      className="bank-heading"
      style={heading('var(--text-xl)')}
    />
  ),
  h2: (props) => (
    <Anchored
      as="h2"
      node={props.node}
      {...domProps(props)}
      className="bank-heading"
      style={heading('var(--text-lg)')}
    />
  ),
  h3: (props) => (
    <Anchored
      as="h3"
      node={props.node}
      {...domProps(props)}
      className="bank-heading"
      style={heading('var(--text-md)')}
    />
  ),
  h4: (props) => (
    <Anchored
      as="h4"
      node={props.node}
      {...domProps(props)}
      className="bank-heading"
      style={heading('var(--text-md)')}
    />
  ),
  h5: (props) => (
    <Anchored
      as="h5"
      node={props.node}
      {...domProps(props)}
      className="bank-heading"
      style={heading('var(--text-md)')}
    />
  ),
  h6: (props) => (
    <Anchored
      as="h6"
      node={props.node}
      {...domProps(props)}
      className="bank-heading"
      style={heading('var(--text-md)')}
    />
  ),

  p: (props) => (
    <Anchored
      as="p"
      node={props.node}
      {...domProps(props)}
      className="body"
      style={{ color: 'var(--md-ink)', margin: '0 0 var(--space-3)' }}
    />
  ),
  strong: (props) => (
    <strong {...domProps(props)} style={{ fontWeight: 600, color: 'var(--md-ink)' }} />
  ),
  em: (props) => (
    <em {...domProps(props)} style={{ fontStyle: 'italic', color: 'var(--md-ink)' }} />
  ),

  ul: (props) => (
    <ul
      {...domProps(props)}
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
      {...domProps(props)}
      className="body"
      style={{
        color: 'var(--md-ink)',
        listStyle: 'decimal',
        paddingLeft: 'var(--space-5)',
        margin: '0 0 var(--space-3)',
      }}
    />
  ),
  li: (props) => (
    <Anchored as="li" node={props.node} {...domProps(props)} style={{ margin: '0 0 var(--space-2)' }} />
  ),

  // The SWOT table carries multi-sentence cells. Containment is the point:
  // the wrapper scrolls, the panel does not.
  table: (props) => (
    <div style={{ overflowX: 'auto', margin: '0 0 var(--space-4)' }}>
      <table
        {...domProps(props)}
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 'var(--text-sm)',
          color: 'var(--md-ink)',
        }}
      />
    </div>
  ),
  // `style` is spread last on purpose: remark-gfm passes GFM column alignment
  // (`:---`, `:---:`, `---:`) through as an inline `text-align`, and replacing
  // the incoming style instead of merging it would silently discard it.
  th: (props) => (
    <th
      {...domProps(props)}
      style={{
        ...cell,
        fontWeight: 600,
        borderBottom: '1px solid var(--md-stroke)',
        whiteSpace: 'nowrap',
        ...props.style,
      }}
    />
  ),
  td: (props) => <td {...domProps(props)} style={{ ...cell, ...props.style }} />,
  tr: (props) => <Anchored as="tr" node={props.node} {...domProps(props)} />,

  // A rejected URL arrives as href '' and becomes plain text rather than a dead
  // anchor. In-page fragments (footnotes) stay in the same tab. An external link
  // is never an `<a href>`: it is a button with a host suffix that opens the
  // leaving panel, so no external href reaches the DOM.
  a: (props) => {
    const { href, children, ...rest } = domProps(props);
    if (!href) return <span>{children}</span>;
    if (href.startsWith('#')) {
      return (
        <a {...rest} href={href} style={LINK}>
          {children}
        </a>
      );
    }
    return <ExternalLink href={href}>{children}</ExternalLink>;
  },

  code: (props) => (
    <code
      {...domProps(props)}
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-xs)',
        background: 'var(--md-fill)',
        borderRadius: 'var(--radius-input)',
        padding: '0 var(--space-1)',
        color: 'var(--md-ink)',
      }}
    />
  ),
  pre: (props) => (
    <Anchored
      as="pre"
      node={props.node}
      {...domProps(props)}
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
    <Anchored
      as="blockquote"
      node={props.node}
      {...domProps(props)}
      style={{
        borderLeft: '2px solid var(--md-stroke)',
        paddingLeft: 'var(--space-3)',
        margin: '0 0 var(--space-3)',
        color: 'var(--md-ink-2)',
      }}
    />
  ),
  img: (props) => (
    <RemovedImage alt={props.alt} src={typeof props.src === 'string' ? props.src : undefined} />
  ),

  hr: (props) => (
    <hr
      {...domProps(props)}
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
export function Markdown({ children, variant = 'light', className, anchors }: MarkdownProps) {
  const anchored = anchors !== undefined;
  const blocks = React.useMemo(
    () =>
      anchored ? new Map(blockRanges(children ?? '').map((block) => [block.start, block])) : null,
    [anchored, children],
  );
  const state = React.useMemo(
    () => (blocks && anchors ? { ...anchors, blocks, shift: sourceShift(children ?? '') } : null),
    [anchors, blocks, children],
  );

  if (!children || !children.trim()) return null;
  return (
    <div className={className} style={{ ...ALIASES[variant], color: 'var(--md-ink)' }}>
      <AnchorContext.Provider value={state}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeUrl} components={COMPONENTS}>
          {children}
        </ReactMarkdown>
      </AnchorContext.Provider>
    </div>
  );
}

export default Markdown;
