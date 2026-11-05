import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from '@/components/atoms';

describe('Markdown tables — edge cases', () => {
  it('honours GFM column alignment markers', () => {
    const md = [
      '| L | C | R |',
      '|:---|:---:|---:|',
      '| a | b | c |',
    ].join('\n');
    const { container } = render(<Markdown>{md}</Markdown>);
    const th = Array.from(container.querySelectorAll('th'));
    expect(th.map((c) => (c as HTMLElement).style.textAlign)).toEqual(['left', 'center', 'right']);
    const td = Array.from(container.querySelectorAll('td'));
    expect(td.map((c) => (c as HTMLElement).style.textAlign)).toEqual(['left', 'center', 'right']);
  });

  it('renders inline formatting inside cells', () => {
    const md = [
      '| Buyer | Note |',
      '|---|---|',
      '| **Bold co** | *lean* and `code` and [link](https://example.com) |',
    ].join('\n');
    const { container } = render(<Markdown>{md}</Markdown>);
    expect(container.querySelector('td strong')?.textContent).toBe('Bold co');
    expect(container.querySelector('td em')?.textContent).toBe('lean');
    expect(container.querySelector('td code')?.textContent).toBe('code');
    // An external link in a cell is a button with a host suffix, not an anchor.
    expect(container.querySelector('td a')).toBeNull();
    expect(container.querySelector('td button')?.textContent).toBe('link (example.com)');
  });

  it('handles empty cells and ragged rows without dropping the table', () => {
    const md = [
      '| A | B | C |',
      '|---|---|---|',
      '| 1 |  | 3 |',
      '| only-one |',
      '| 1 | 2 | 3 | 4 |',
    ].join('\n');
    const { container } = render(<Markdown>{md}</Markdown>);
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(table?.querySelectorAll('tbody tr').length).toBe(3);
    // GFM pads a short row and truncates an over-long one to the header arity
    const rows = Array.from(table!.querySelectorAll('tbody tr'));
    expect(rows.map((r) => r.querySelectorAll("td").length)).toEqual([3, 3, 3]);
  });

  it('keeps every cell in the table on the alias ink, not a baked colour', () => {
    const md = ['| A | B |', '|---|---|', '| 1 | 2 |'].join('\n');
    const { container } = render(<Markdown variant="on-dark">{md}</Markdown>);
    const cells = Array.from(container.querySelectorAll('th,td')) as HTMLElement[];
    expect(cells.length).toBe(4);
    for (const c of cells) expect(c.style.color).toBe('var(--md-ink)');
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.style.getPropertyValue('--md-ink').trim()).toBe('var(--ink-on-dark)');
  });

  it('wraps each table in its own horizontally scrollable container', () => {
    const md = ['| A |', '|---|', '| 1 |', '', '| B |', '|---|', '| 2 |'].join('\n');
    const { container } = render(<Markdown>{md}</Markdown>);
    const tables = Array.from(container.querySelectorAll('table'));
    expect(tables.length).toBe(2);
    for (const t of tables) {
      expect((t.parentElement as HTMLElement).style.overflowX).toBe('auto');
    }
  });
});
