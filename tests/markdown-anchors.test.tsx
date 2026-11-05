import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Markdown } from '@/components/atoms';

const DOC = [
  '# Title',
  '',
  'First paragraph.',
  '',
  '- parent',
  '  - child',
  '- two',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  '> quoted',
  '',
  '```',
  'code',
  '```',
].join('\n');

describe('Markdown anchors', () => {
  it('stamps nothing unless anchors are asked for', () => {
    render(<Markdown>{DOC}</Markdown>);

    expect(screen.getByText('First paragraph.')).not.toHaveAttribute('data-block-start');
    expect(screen.getByRole('heading', { name: 'Title' })).not.toHaveAttribute('data-block-start');
  });

  it('stamps each block with its range in the source text', () => {
    render(<Markdown anchors={{}}>{DOC}</Markdown>);

    const heading = screen.getByRole('heading', { name: 'Title' });
    expect(heading).toHaveAttribute('data-block-start', '0');
    expect(heading).toHaveAttribute('data-block-end', '7');
    expect(heading).toHaveAttribute('data-block-kind', 'heading');
    expect(screen.getByText('First paragraph.')).toHaveAttribute('data-block-end', '25');
    expect(screen.getByText('two')).toHaveAttribute('data-block-kind', 'listItem');
    expect(screen.getByText('quoted').closest('blockquote')).toHaveAttribute('data-block-kind', 'blockquote');
    expect(screen.getByText('quoted')).not.toHaveAttribute('data-block-start');
    expect(screen.getByText('code').closest('pre')).toHaveAttribute('data-block-kind', 'code');
    expect(screen.getAllByRole('row')[1]).toHaveAttribute('data-block-kind', 'tableRow');
  });

  it('ends a parent list item before its nested items', () => {
    render(<Markdown anchors={{}}>{DOC}</Markdown>);

    const parent = screen.getByText('parent').closest('[data-block-kind="listItem"]');
    expect(parent).toHaveAttribute('data-block-start', '27');
    expect(parent).toHaveAttribute('data-block-end', '35');
    expect(DOC.slice(27, 35)).toBe('- parent');
  });

  it('keeps nested items out of the element stamped with the parent range', () => {
    render(<Markdown anchors={{}}>{DOC}</Markdown>);

    const parent = screen.getByText('parent').closest('[data-block-start="27"]');
    const child = screen.getByText('child').closest('li');
    expect(parent).not.toContainElement(screen.getByText('child'));
    expect(child).toHaveAttribute('data-block-start', '38');
    expect(child).toHaveAttribute('data-block-kind', 'listItem');
  });

  it('selects a parent item without selecting anything that holds its child', () => {
    render(<Markdown anchors={{ selected: { start: 27, end: 35 } }}>{DOC}</Markdown>);

    const selected = document.querySelectorAll('[data-selected="true"]');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveAttribute('data-block-start', '27');
    expect(selected[0]).not.toContainElement(screen.getByText('child'));
  });

  it('stamps shifted ranges when the text starts with a byte-order mark', () => {
    render(<Markdown anchors={{}}>{'\uFEFF' + DOC}</Markdown>);

    const heading = screen.getByRole('heading', { name: 'Title' });
    expect(heading).toHaveAttribute('data-block-start', '1');
    expect(heading).toHaveAttribute('data-block-end', '8');
    expect(screen.getByText('First paragraph.')).toHaveAttribute('data-block-start', '10');
    expect(screen.getByText('First paragraph.')).toHaveAttribute('data-block-end', '26');
  });

  it('writes marks, labels and the selection onto the blocks they name', () => {
    render(
      <Markdown
        anchors={{
          marks: new Map([[9, 'pending']]),
          labels: new Map([[9, '1']]),
          selected: { start: 0, end: 7 },
        }}
      >
        {DOC}
      </Markdown>,
    );

    const paragraph = screen.getByText('First paragraph.');
    expect(paragraph).toHaveAttribute('data-mark', 'pending');
    expect(paragraph).toHaveAttribute('data-mark-label', '1');
    expect(paragraph).not.toHaveAttribute('data-selected');
    expect(screen.getByRole('heading', { name: 'Title' })).toHaveAttribute('data-selected', 'true');
  });

  it('gives one block the tab stop and takes the others out of the tab order', () => {
    render(<Markdown anchors={{ tabStop: 9 }}>{DOC}</Markdown>);

    expect(screen.getByText('First paragraph.')).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('heading', { name: 'Title' })).toHaveAttribute('tabindex', '-1');
  });

  it('leaves blocks out of the tab order when no tab stop is given', () => {
    render(<Markdown anchors={{}}>{DOC}</Markdown>);

    expect(screen.getByText('First paragraph.')).not.toHaveAttribute('tabindex');
  });

  it('hands a labelled table row its label as a quoted custom property and no other block', () => {
    const labels = new Map([
      [DOC.indexOf('| 1 | 2 |'), '3'],
      [DOC.indexOf('First paragraph.'), '1'],
      [DOC.indexOf('- two'), '2'],
    ]);
    render(<Markdown anchors={{ labels }}>{DOC}</Markdown>);

    const [header, row] = screen.getAllByRole('row');
    expect(row.style.getPropertyValue('--mark-label')).toBe('"3"');
    expect(header.style.getPropertyValue('--mark-label')).toBe('');
    expect(screen.getByText('First paragraph.')).toHaveAttribute('data-mark-label', '1');
    expect(screen.getByText('First paragraph.').getAttribute('style') ?? '').not.toContain('--mark-label');
    expect(screen.getByText('two').closest('li')?.getAttribute('style') ?? '').not.toContain('--mark-label');
  });

  it('adds no style to a table row when anchors are not passed', () => {
    render(<Markdown>{DOC}</Markdown>);

    for (const row of screen.getAllByRole('row')) expect(row).not.toHaveAttribute('style');
  });
});
