'use client';

import * as React from 'react';

import { ExternalLinkDialog } from './ExternalLinkDialog';

const LINK_BUTTON: React.CSSProperties = {
  display: 'inline',
  background: 'none',
  border: 0,
  padding: 0,
  margin: 0,
  font: 'inherit',
  textAlign: 'inherit',
  cursor: 'pointer',
  color: 'var(--md-link)',
  textDecoration: 'underline',
  textUnderlineOffset: 'var(--space-1)',
};

const HOST_SUFFIX: React.CSSProperties = {
  display: 'inline-block',
  color: 'var(--md-ink-2)',
  fontSize: 'var(--text-xs)',
  textDecoration: 'none',
};

function textOf(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const tidy = (s: string) => s.trim().toLowerCase().replace(/\/+$/, '');

/** True when the visible text already is the destination (autolinks), so a host suffix adds nothing. */
function textIsDestination(text: string, url: URL): boolean {
  const shown = tidy(text);
  if (!shown) return false;
  const candidates = [
    url.href,
    url.href.replace(/^[a-z][a-z0-9+.-]*:(\/\/)?/i, ''),
    url.host,
    url.protocol === 'mailto:' ? safeDecode(url.pathname) : '',
  ];
  return candidates.some((c) => c !== '' && tidy(c) === shown);
}

/**
 * An external link in model output. It renders as a button with no `href`, so
 * middle-click, drag, copied output and DNS prefetch have nothing to act on, and
 * it shows its host (punycode, as `URL.host` returns it) next to the text. The
 * click opens the leaving panel. `href` arrives already normalized by `safeUrl`.
 */
export function ExternalLink({ href, children }: { href: string; children?: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const buttonRef = React.useRef<HTMLButtonElement | null>(null);

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return <span>{children}</span>;
  }

  const showHost = !textIsDestination(textOf(children), url);
  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-md-external-link
        onClick={() => setOpen(true)}
        style={LINK_BUTTON}
      >
        {children}
        {showHost ? <span style={HOST_SUFFIX}> ({url.host || 'email'})</span> : null}
      </button>
      <ExternalLinkDialog open={open} url={url} onClose={close} />
    </>
  );
}

export default ExternalLink;
