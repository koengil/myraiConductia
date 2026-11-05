/**
 * Node types the four call sites can receive but the measured corpus does not
 * yet contain: headings below h3, GFM strikethrough / task lists / autolinks /
 * footnotes, images, fenced code, blockquotes and nested lists.
 *
 * The contrast contract is the point of the last group of tests: the atom must
 * own its ink, including for node types it has no renderer for.
 */
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { Markdown } from '@/components/atoms';

describe('Markdown node coverage', () => {
  it('renders h4, h5 and h6 on the alias ink', () => {
    const { container } = render(<Markdown>{'#### four\n\n##### five\n\n###### six'}</Markdown>);
    for (const tag of ['h4', 'h5', 'h6']) {
      const el = container.querySelector(tag) as HTMLElement;
      expect(el).not.toBeNull();
      expect(el.style.color).toBe('var(--md-ink)');
    }
  });

  it('renders GFM strikethrough, task lists and autolinks', () => {
    const { container } = render(
      <Markdown>{'~~gone~~\n\n- [x] done\n- [ ] todo\n\nvisit www.example.com'}</Markdown>,
    );
    expect(container.querySelector('del')?.textContent).toBe('gone');
    const boxes = container.querySelectorAll('input[type=checkbox]');
    expect(boxes.length).toBe(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    // An autolink is an external link: a button, never an anchor with an href.
    expect(container.querySelector('a[href]')).toBeNull();
    const link = container.querySelector('button[data-md-external-link]');
    expect(link?.textContent).toBe('www.example.com');
    fireEvent.click(link as Element);
    expect(screen.getByTestId('external-link-href').textContent).toBe('http://www.example.com/');
  });

  it('renders GFM footnotes with a working reference', () => {
    const { container } = render(<Markdown>{'text[^1]\n\n[^1]: the note'}</Markdown>);
    expect(container.querySelector('sup')).not.toBeNull();
    expect(container.textContent).toContain('the note');
  });

  it('renders nested lists at both levels', () => {
    const { container } = render(<Markdown>{'- a\n  - b\n    1. c'}</Markdown>);
    expect(container.querySelectorAll('ul ul').length).toBe(1);
    expect(container.querySelectorAll('ul ol').length).toBe(1);
  });

  it('renders a fenced code block without highlighting', () => {
    const { container } = render(<Markdown>{'```ts\nconst x = 1;\n```'}</Markdown>);
    const pre = container.querySelector('pre') as HTMLElement;
    expect(pre).not.toBeNull();
    expect(pre.style.overflowX).toBe('auto');
    expect(container.querySelector('pre code')?.textContent).toContain('const x = 1;');
  });

  it('renders a blockquote on the secondary ink', () => {
    const { container } = render(<Markdown>{'> quoted'}</Markdown>);
    expect((container.querySelector('blockquote') as HTMLElement).style.color).toBe(
      'var(--md-ink-2)',
    );
  });

  it('never renders a remote image, and the note shows the alt text and host', () => {
    const { container } = render(<Markdown>{'![alt text](https://example.com/x.png)'}</Markdown>);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-md-image-removed]')?.textContent).toBe(
      'Image not shown: alt text (example.com)',
    );
  });

  it('drops a javascript: image source', () => {
    const { container } = render(<Markdown>{'![x](javascript:alert(1))'}</Markdown>);
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('javascript:');
  });

  it('owns its ink, so node types with no renderer still inherit it', () => {
    const md = ['~~s~~', '- [x] t', '![a](https://e.com/i.png)', 'text[^1]', '', '[^1]: n'].join(
      '\n\n',
    );
    const { container } = render(<Markdown variant="on-dark">{md}</Markdown>);
    const wrapper = container.firstElementChild as HTMLElement;
    // Without this the unmapped nodes below would inherit the host's colour,
    // which is exactly the invisible-text failure the contrast contract exists
    // to prevent.
    expect(wrapper.style.color).toBe('var(--md-ink)');
    expect(wrapper.style.getPropertyValue('--md-ink').trim()).toBe('var(--ink-on-dark)');
    for (const tag of ['del', 'sup', '[data-md-image-removed]']) {
      expect(container.querySelector(tag), `${tag} should render`).not.toBeNull();
    }
  });
});
