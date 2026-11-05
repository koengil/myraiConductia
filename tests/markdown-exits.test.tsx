/**
 * #226 A1: model output rendered by the Markdown atom must never make the
 * browser load or prefetch anything. Every input in the corpus asserts the same
 * thing: no network-loading element, no src/srcset/poster attribute, and no
 * anchor whose href is anything but an in-page fragment. External links are
 * buttons, so the rendered output carries no external href at all.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { Markdown, type MarkdownVariant } from '@/components/atoms';

const CORPUS: Array<[string, string]> = [
  ['inline image', '![buyer list](https://x.example/p.png?q=secret)'],
  ['reference image', '![ref][r]\n\n[r]: https://x.example/ref.png?q=secret'],
  ['image inside a link', '[![pixel](https://x.example/t.gif)](https://x.example/landing)'],
  ['data: image', '![d](data:image/png;base64,iVBORw0KGgo=)'],
  ['www autolink', 'see www.x.example/a?b=c'],
  ['https autolink', 'see https://x.example/a?b=c'],
  ['email autolink', 'write to md@x.example'],
  ['javascript: autolink', '<javascript:alert(1)>'],
  ['raw img', '<img src="https://x.example/p.png" onerror="alert(1)">'],
  ['raw svg image', '<svg><image href="https://x.example/p.png"/></svg>'],
  ['block link element', '<link rel="stylesheet" href="https://x.example/s.css">'],
  ['protocol-relative url', '[x](//x.example/a)'],
  ['backslash host', '[x](\\\\x.example\\a)'],
  ['slash-backslash host', '[x](/\\x.example/a)'],
  ['percent-encoded javascript', '[x](%6Aavascript:alert(1))'],
  ['javascript: link', '[x](javascript:alert(1))'],
  ['relative image', '![r](/api/v1/secret.png)'],
];

const FORBIDDEN = 'img, image, picture, source, video, audio, iframe, object, embed, link, script';
const VARIANTS: MarkdownVariant[] = ['light', 'on-dark'];

function expectNoExits(container: HTMLElement) {
  expect(container.querySelectorAll(FORBIDDEN).length, 'network-loading element').toBe(0);
  expect(container.querySelectorAll('[src], [srcset], [poster]').length, 'src attr').toBe(0);
  for (const a of Array.from(container.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') ?? '';
    expect(href, `href ${href}`).toMatch(/^#/);
  }
}

describe('Markdown exits: nothing in model output loads or prefetches', () => {
  for (const variant of VARIANTS) {
    for (const [name, md] of CORPUS) {
      it(`${name} (${variant})`, () => {
        const { container } = render(<Markdown variant={variant}>{md}</Markdown>);
        expectNoExits(container);
      });
    }

    it(`all inputs concatenated (${variant})`, () => {
      const md = CORPUS.map(([, m]) => m).join('\n\n');
      const { container } = render(<Markdown variant={variant}>{md}</Markdown>);
      expectNoExits(container);
    });
  }

  it('turns an image into an inert note with its alt text and host', () => {
    const { container } = render(
      <Markdown>{'![buyer list](https://x.example/p.png?q=secret)'}</Markdown>,
    );
    const note = container.querySelector('[data-md-image-removed]');
    expect(note?.textContent).toBe('Image not shown: buyer list (x.example)');
    expect(container.innerHTML).not.toContain('secret');
  });

  it('names an image with no alt text and no usable source without a host', () => {
    const { container } = render(<Markdown>{'![](data:image/png;base64,AAAA)'}</Markdown>);
    expect(container.querySelector('[data-md-image-removed]')?.textContent).toBe(
      'Image not shown: no description',
    );
  });

  it('renders every rejected URL form as plain text, never a dead anchor', () => {
    for (const bad of [
      '//x.example/a',
      '\\\\x.example\\a',
      '/\\x.example/a',
      '%6Aavascript:alert(1)',
      'javascript:alert(1)',
      '/relative',
    ]) {
      const { container, unmount } = render(<Markdown>{`[label](${bad})`}</Markdown>);
      expect(container.querySelector('a'), bad).toBeNull();
      expect(container.textContent, bad).toContain('label');
      unmount();
    }
  });

  it('hands the normalized href of an absolute http(s) link to the panel, not the DOM', () => {
    const { container } = render(<Markdown>{'[x](HTTPS://Example.COM:443/a/../b)'}</Markdown>);
    expect(container.querySelector('a')).toBeNull();
    expect(container.innerHTML).not.toContain('example.com/b');
    fireEvent.click(container.querySelector('button[data-md-external-link]') as Element);
    expect(screen.getByRole('link', { name: 'Open link' }).getAttribute('href')).toBe(
      'https://example.com/b',
    );
  });

  it('keeps footnote links in-page, in the same tab', () => {
    const { container } = render(<Markdown>{'text[^1]\n\n[^1]: the note'}</Markdown>);
    const anchors = Array.from(container.querySelectorAll('a[href]'));
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      expect(a.getAttribute('href')).toMatch(/^#/);
      expect(a.getAttribute('target')).toBeNull();
    }
  });

  it('guard: no raw-HTML pipeline is wired in', () => {
    const pkg = readFileSync(path.resolve(__dirname, '../package.json'), 'utf8');
    expect(pkg).not.toContain('rehype-raw');
    const src = readFileSync(
      path.resolve(__dirname, '../src/components/atoms/Markdown.tsx'),
      'utf8',
    );
    expect(src).not.toContain('rehypePlugins');
  });
});
