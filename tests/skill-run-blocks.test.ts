import { describe, expect, it } from 'vitest';

import { blockRanges, blockShapes, blocksWithin, isAligned } from '@/lib/skillRun/blocks';

function texts(doc: string): [string, string][] {
  return blockRanges(doc).map((block) => [block.kind, doc.slice(block.start, block.end)]);
}

const FLAT = [
  '# Title',
  '',
  'First paragraph.',
  '',
  '- one',
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

describe('blockRanges', () => {
  it('returns one block per heading, paragraph, list item, table row, quote and code block', () => {
    expect(texts(FLAT)).toEqual([
      ['heading', '# Title'],
      ['paragraph', 'First paragraph.'],
      ['listItem', '- one'],
      ['listItem', '- two'],
      ['tableRow', '| a | b |'],
      ['tableRow', '| 1 | 2 |'],
      ['blockquote', '> quoted'],
      ['code', '```\ncode\n```'],
    ]);
  });

  it('stops a parent list item before its nested items', () => {
    const doc = ['- parent', '  - child one', '  - child two', '- sibling'].join('\n');

    expect(texts(doc)).toEqual([
      ['listItem', '- parent'],
      ['listItem', '- child one'],
      ['listItem', '- child two'],
      ['listItem', '- sibling'],
    ]);
  });

  it('keeps the items of a loose list apart from the paragraph after it', () => {
    expect(texts(['- one', '', '- two', '', 'After.'].join('\n'))).toEqual([
      ['listItem', '- one'],
      ['listItem', '- two'],
      ['paragraph', 'After.'],
    ]);
  });

  it('keeps a wrapped paragraph and a wrapped list item whole', () => {
    expect(texts(['A paragraph', 'on two lines.', '', '- item', '  continued'].join('\n'))).toEqual([
      ['paragraph', 'A paragraph\non two lines.'],
      ['listItem', '- item\n  continued'],
    ]);
  });

  it('counts offsets in UTF-16 units, so text after an emoji is addressed correctly', () => {
    const doc = ['Growth 🚀 was strong.', '', 'Second é paragraph.'].join('\n');

    expect(blockRanges(doc)).toEqual([
      { kind: 'paragraph', start: 0, end: 21 },
      { kind: 'paragraph', start: 23, end: 42 },
    ]);
    expect(doc.slice(23, 42)).toBe('Second é paragraph.');
  });

  it('addresses text after a leading byte-order mark by its true offsets', () => {
    const doc = ['\uFEFF# Title', '', 'First paragraph.'].join('\n');

    expect(texts(doc)).toEqual([
      ['heading', '# Title'],
      ['paragraph', 'First paragraph.'],
    ]);
    expect(blockRanges(doc)[0].start).toBe(1);
  });

  it('returns nothing for an empty text', () => {
    expect(blockRanges('')).toEqual([]);
  });
});

describe('blockShapes', () => {
  function shapeOf(doc: string, pick: string) {
    const shape = blockShapes(doc).find((entry) => doc.slice(entry.start, entry.end) === pick);
    if (!shape) throw new Error(`no block ${pick}`);
    return shape;
  }

  const DOC = [
    '- parent',
    '  - child',
    '- sibling',
    '',
    'Text.',
    '',
    '3. third',
    '',
    '4. fourth',
  ].join('\n');

  it('names the item a nested item sits under, and how deep it sits', () => {
    expect(shapeOf(DOC, '- child')).toMatchObject({ parent: { start: 0, end: 8 }, depth: 1 });
    expect(shapeOf(DOC, '- sibling')).toMatchObject({ parent: null, depth: 0 });
  });

  it('gives each item its own number and the spacing of its list, and other blocks no list', () => {
    expect(shapeOf(DOC, '- child').list).toMatchObject({ number: null, loose: false });
    expect(shapeOf(DOC, '3. third').list).toMatchObject({ number: 3, loose: true });
    expect(shapeOf(DOC, '4. fourth').list).toMatchObject({ number: 4, loose: true });
    expect(shapeOf(DOC, 'Text.')).toMatchObject({ parent: null, depth: 0, list: null });
  });

  it('tells the items of one list from the items of another', () => {
    const same = shapeOf(DOC, '- parent').list?.key;

    expect(shapeOf(DOC, '- sibling').list?.key).toBe(same);
    expect(shapeOf(DOC, '- child').list?.key).not.toBe(same);
    expect(shapeOf(DOC, '3. third').list?.key).not.toBe(same);
  });

  it('moves a parent past a leading byte-order mark', () => {
    const doc = '\uFEFF- parent\n  - child';

    expect(blockShapes(doc)[1].parent).toEqual({ start: 1, end: 9 });
  });
});

describe('isAligned', () => {
  const blocks = blockRanges(FLAT);

  it('accepts one whole block', () => {
    expect(isAligned(blocks, { start: 9, end: 25 })).toBe(true);
  });

  it('accepts a run of whole blocks', () => {
    expect(isAligned(blocks, { start: 9, end: 38 })).toBe(true);
  });

  it('refuses a range that starts inside a block', () => {
    expect(isAligned(blocks, { start: 10, end: 25 })).toBe(false);
  });

  it('refuses a range that ends inside a block', () => {
    expect(isAligned(blocks, { start: 9, end: 30 })).toBe(false);
  });
});

describe('blocksWithin', () => {
  it('lists the blocks a passage covers', () => {
    const blocks = blockRanges(FLAT);

    expect(blocksWithin(blocks, { start: 27, end: 38 })).toEqual([
      { kind: 'listItem', start: 27, end: 32 },
      { kind: 'listItem', start: 33, end: 38 },
    ]);
  });
});
