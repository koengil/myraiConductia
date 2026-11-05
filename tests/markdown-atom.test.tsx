/**
 * The shared Markdown atom. Node coverage and the two guards (raw HTML is inert,
 * non-http(s)/mailto hrefs are dropped) are tested against the real Figma
 * presearch memo excerpt, not invented markdown.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

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

  it('drops a javascript: href and opens an https: link only through the panel', () => {
    const { container } = render(
      <Markdown>{'[bad](javascript:alert(1)) and [good](https://example.com)'}</Markdown>,
    );
    // No external href reaches the DOM; the rejected link keeps its text only.
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('span')?.textContent).toBe('bad');
    expect(container.innerHTML).not.toContain('javascript:');

    fireEvent.click(screen.getByRole('button', { name: /good/ }));
    const open = screen.getByRole('link', { name: 'Open link' });
    expect(open.getAttribute('href')).toBe('https://example.com/');
    expect(open.getAttribute('rel')).toBe('noopener noreferrer');
    expect(open.getAttribute('target')).toBe('_blank');
  });

  it('keeps a mailto: target behind the same panel', () => {
    const { container } = render(<Markdown>{'[mail](mailto:md@example.com)'}</Markdown>);
    expect(container.querySelector('a')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /mail/ }));
    expect(screen.getByRole('link', { name: 'Open link' }).getAttribute('href')).toBe(
      'mailto:md@example.com',
    );
  });

  it('sets all five on-dark aliases on the wrapper', () => {
    const { container } = render(<Markdown variant="on-dark">{'# Heading'}</Markdown>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.getPropertyValue('--md-ink')).toBe('var(--ink-on-dark)');
    expect(el.style.getPropertyValue('--md-ink-2')).toBe('var(--ink-on-dark-secondary)');
    expect(el.style.getPropertyValue('--md-stroke')).toBe('var(--on-dark-stroke-12)');
    expect(el.style.getPropertyValue('--md-fill')).toBe('var(--on-dark-fill-06)');
    // --accent is navy on the navy canvas, so on-dark links inherit the ink.
    expect(el.style.getPropertyValue('--md-link')).toBe('var(--md-ink)');
  });

  it('defaults to all five light aliases', () => {
    const { container } = render(<Markdown>{'# Heading'}</Markdown>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.getPropertyValue('--md-ink')).toBe('var(--ink)');
    expect(el.style.getPropertyValue('--md-ink-2')).toBe('var(--ink-secondary)');
    expect(el.style.getPropertyValue('--md-stroke')).toBe('var(--stroke)');
    expect(el.style.getPropertyValue('--md-fill')).toBe('var(--surface-warm)');
    expect(el.style.getPropertyValue('--md-link')).toBe('var(--accent)');
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

  it('does not leak the hast node prop onto any rendered element', () => {
    const { container } = render(<Markdown>{MEMO}</Markdown>);
    expect(container.querySelectorAll('[node]').length).toBe(0);
  });

  it('does not throw on unterminated constructs', () => {
    expect(() => render(<Markdown>{'**unclosed and | a | half table'}</Markdown>)).not.toThrow();
    expect(screen.getByText(/unclosed/)).toBeTruthy();
  });
});
