/**
 * #226 A1: an external link in model output is a button with a host suffix and
 * opens the "Leaving Conductia" panel. Nothing leaves without the MD seeing the
 * host and the full address, and no external href sits in the rendered output.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { Markdown } from '@/components/atoms';

function renderLink(md: string) {
  const utils = render(<Markdown>{md}</Markdown>);
  const button = utils.container.querySelector('button[data-md-external-link]') as HTMLElement;
  return { ...utils, button };
}

describe('ExternalLink', () => {
  it('shows the link text with a muted host suffix and no href in the DOM', () => {
    const { container, button } = renderLink('[Filing](https://sec.gov/x?q=1)');
    expect(button.textContent).toBe('Filing (sec.gov)');
    expect(button.getAttribute('type')).toBe('button');
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('[href]')).toBeNull();
    expect(container.innerHTML).not.toContain('q=1');
  });

  it('adds no suffix when the visible text already is the destination', () => {
    for (const md of [
      '<https://sec.gov/x>',
      'see www.sec.gov/x',
      'write to md@x.example',
      '[sec.gov](https://sec.gov)',
    ]) {
      const { button, unmount } = renderLink(md);
      expect(button.textContent, md).not.toContain('(');
      unmount();
    }
  });

  it('keeps the suffix when the text names a different destination', () => {
    const { button } = renderLink('[https://sec.gov](https://attacker.example/p)');
    expect(button.textContent).toBe('https://sec.gov (attacker.example)');
  });

  it('shows a lookalike host in punycode', () => {
    const { button } = renderLink('[x](https://éxample.com)');
    expect(button.textContent).toBe('x (xn--xample-9ua.com)');
  });

  it('opens a portal dialog with the host and the full address, query included', () => {
    const { container, button } = renderLink('[Filing](https://sec.gov/x?q=Buyer%20list)');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(button);
    // Named by its title, so the host is announced.
    const dialog = screen.getByRole('dialog', { name: 'This link opens sec.gov' });
    expect(document.body.contains(dialog)).toBe(true);
    expect(container.contains(dialog)).toBe(false);
    expect(dialog.querySelector('h2')?.textContent).toBe('This link opens sec.gov');
    expect(screen.getByTestId('external-link-href').textContent).toBe(
      'https://sec.gov/x?q=Buyer%20list',
    );
  });

  it('offers a real new-tab link with the normalized address', () => {
    const { button } = renderLink('[x](HTTPS://Example.COM:443/a/../b)');
    fireEvent.click(button);
    const open = screen.getByRole('link', { name: 'Open link' });
    expect(open.getAttribute('href')).toBe('https://example.com/b');
    expect(open.getAttribute('target')).toBe('_blank');
    expect(open.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('closes when Open link is clicked', async () => {
    const { button } = renderLink('[x](https://example.com)');
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('link', { name: 'Open link' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('focuses Cancel on open, and Escape closes and returns focus to the link', async () => {
    const { button } = renderLink('[x](https://example.com)');
    button.focus();
    fireEvent.click(button);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(document.activeElement).toBe(button);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Cancel closes and returns focus to the link', async () => {
    const { button } = renderLink('[x](https://example.com)');
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(button);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('closes on a scrim click but not on a click inside the panel', async () => {
    const { button } = renderLink('[x](https://example.com)');
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog')).not.toBeNull();
    fireEvent.click(screen.getByRole('dialog').parentElement as Element);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('gives a mailto link the same panel, with the full mailto shown', () => {
    const { container, button } = renderLink('[a](mailto:x@y.com?body=deal)');
    expect(button.textContent).toBe('a (email)');
    expect(container.querySelector('a')).toBeNull();
    fireEvent.click(button);
    expect(screen.getByRole('dialog').querySelector('h2')?.textContent).toBe(
      'This link opens mailto:',
    );
    expect(screen.getByTestId('external-link-href').textContent).toBe('mailto:x@y.com?body=deal');
    expect(screen.getByRole('link', { name: 'Open link' }).getAttribute('href')).toBe(
      'mailto:x@y.com?body=deal',
    );
  });

  it('keeps a footnote jump as an in-page anchor in the same tab', () => {
    const { container } = render(<Markdown>{'text[^1]\n\n[^1]: the note'}</Markdown>);
    expect(container.querySelector('button[data-md-external-link]')).toBeNull();
    const anchors = Array.from(container.querySelectorAll('a[href]'));
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) expect(a.getAttribute('target')).toBeNull();
  });
});
