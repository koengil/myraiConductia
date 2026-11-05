// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { blockRanges } from '@/lib/skillRun/blocks';
import {
  cleanReplacement,
  countBy,
  editsDigest,
  keepsStructure,
  parseRevisionInputs,
  parseRevisionRequest,
  shiftRange,
  splice,
  storageProblem,
  validateEdits,
} from '@/lib/skillRun/revisions';

const PARENT = '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11';
const OTHER = '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6';
const DOC = ['# Title', '', 'First paragraph.', '', '- one', '- two'].join('\n');

function removeRanges(text: string, ranges: { start: number; end: number }[]): string {
  let out = '';
  let cursor = 0;
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    out += text.slice(cursor, range.start);
    cursor = range.end;
  }
  return out + text.slice(cursor);
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

describe('parseRevisionRequest', () => {
  it('keeps teach on a comment edit', () => {
    expect(parseRevisionRequest({ parentId: PARENT, edits: [{ kind: 'comment', start: 9, end: 25, comment: 'End bullets with a period.', teach: true }] }))
      .toEqual({ kind: 'edits', parentId: PARENT, edits: [{ kind: 'comment', start: 9, end: 25, comment: 'End bullets with a period.', teach: true }] });
  });
  it('drops teach: false from a comment edit', () => {
    expect(parseRevisionRequest({ parentId: PARENT, edits: [{ kind: 'comment', start: 9, end: 25, comment: 'Fix.', teach: false }] }))
      .toEqual({ kind: 'edits', parentId: PARENT, edits: [{ kind: 'comment', start: 9, end: 25, comment: 'Fix.' }] });
  });
  it('refuses teach on a hand edit', () => {
    expect(parseRevisionRequest({ parentId: PARENT, edits: [{ kind: 'hand', start: 27, end: 32, text: '- uno', teach: true }] }))
      .toEqual({ error: 'Only a comment can teach the skill' });
  });
  it('refuses a teach value that is not true or false', () => {
    expect(parseRevisionRequest({ parentId: PARENT, edits: [{ kind: 'comment', start: 9, end: 25, comment: 'Fix.', teach: 'yes' }] }))
      .toEqual({ error: 'teach must be true or false' });
  });
  it('reads a comment edit and a hand edit', () => {
    expect(
      parseRevisionRequest({
        parentId: PARENT,
        edits: [
          { kind: 'comment', start: 9, end: 25, comment: '  Name the buyer.  ' },
          { kind: 'hand', start: 27, end: 32, text: '- uno' },
        ],
      }),
    ).toEqual({
      kind: 'edits',
      parentId: PARENT,
      edits: [
        { kind: 'comment', start: 9, end: 25, comment: 'Name the buyer.' },
        { kind: 'hand', start: 27, end: 32, text: '- uno' },
      ],
    });
  });

  it('reads a restore', () => {
    expect(parseRevisionRequest({ parentId: PARENT, restoreOf: OTHER })).toEqual({
      kind: 'restore',
      parentId: PARENT,
      restoreOf: OTHER,
    });
  });

  it('refuses edits and a restore together', () => {
    expect(
      parseRevisionRequest({
        parentId: PARENT,
        restoreOf: OTHER,
        edits: [{ kind: 'hand', start: 0, end: 7, text: '# T' }],
      }),
    ).toEqual({ error: 'Send edits or restoreOf, not both' });
  });

  it('refuses more than 20 edits', () => {
    const edits = Array.from({ length: 21 }, (_, index) => ({
      kind: 'hand',
      start: index * 2,
      end: index * 2 + 1,
      text: 'x',
    }));

    expect(parseRevisionRequest({ parentId: PARENT, edits })).toEqual({
      error: 'At most 20 edits can be applied at once',
    });
  });

  it('refuses an empty comment and one over 2,000 characters', () => {
    expect(
      parseRevisionRequest({ parentId: PARENT, edits: [{ kind: 'comment', start: 0, end: 7, comment: '   ' }] }),
    ).toEqual({ error: 'A comment cannot be empty' });
    expect(
      parseRevisionRequest({
        parentId: PARENT,
        edits: [{ kind: 'comment', start: 0, end: 7, comment: 'a'.repeat(2001) }],
      }),
    ).toEqual({ error: 'A comment is too long' });
  });

  it('refuses a comment whose raw length is over four times the limit before it is canonicalized', () => {
    const padded = `Tighten this.${' '.repeat(8_000)}`;

    expect(
      parseRevisionRequest({
        parentId: PARENT,
        edits: [{ kind: 'comment', start: 0, end: 7, comment: padded }],
      }),
    ).toEqual({ error: 'A comment is too long' });
  });

  it('refuses a batch whose hand texts together are over 200,000 characters', () => {
    const edits = [0, 1, 2].map((index) => ({
      kind: 'hand',
      start: index * 2,
      end: index * 2 + 1,
      text: 'x'.repeat(70_000),
    }));

    expect(parseRevisionRequest({ parentId: PARENT, edits })).toEqual({
      error: 'The hand edits together are too long',
    });
  });

  it('accepts hand texts that together fit in 200,000 characters', () => {
    const edits = [0, 1].map((index) => ({
      kind: 'hand',
      start: index * 2,
      end: index * 2 + 1,
      text: 'x'.repeat(100_000),
    }));

    expect(parseRevisionRequest({ parentId: PARENT, edits })).toMatchObject({ kind: 'edits' });
  });

  it('refuses a range that does not run forward and a parent that is not a UUID', () => {
    expect(
      parseRevisionRequest({ parentId: PARENT, edits: [{ kind: 'hand', start: 7, end: 7, text: 'x' }] }),
    ).toEqual({ error: 'Each edit needs a start and a later end' });
    expect(parseRevisionRequest({ parentId: 'nope', edits: [] })).toEqual({
      error: 'parentId must be a UUID',
    });
  });
});

describe('validateEdits', () => {
  it('accepts edits on whole blocks that do not overlap', () => {
    expect(validateEdits(DOC, [{ start: 27, end: 38 }, { start: 9, end: 25 }])).toBeNull();
  });

  it('refuses an edit past the end of the text', () => {
    expect(validateEdits(DOC, [{ start: 33, end: 99 }])).toBe('An edit lies outside the output');
  });

  it('refuses two edits on the same passage', () => {
    expect(validateEdits(DOC, [{ start: 27, end: 38 }, { start: 33, end: 38 }])).toBe(
      'Two edits cover the same passage',
    );
  });

  it('refuses an edit that cuts into a block', () => {
    expect(validateEdits(DOC, [{ start: 10, end: 25 }])).toBe('An edit does not cover whole passages');
  });
});

describe('splice', () => {
  it('replaces several passages of different lengths and reports where each landed', () => {
    const replacements = [
      { start: 27, end: 32, text: '- the first item, now longer' },
      { start: 9, end: 25, text: 'Short.' },
    ];

    const result = splice(DOC, replacements);

    expect(result.text).toBe(
      ['# Title', '', 'Short.', '', '- the first item, now longer', '- two'].join('\n'),
    );
    expect(result.ranges).toEqual([
      { start: 17, end: 45 },
      { start: 9, end: 15 },
    ]);
  });

  it('removes a passage when its replacement is empty', () => {
    const result = splice(DOC, [{ start: 9, end: 25, text: '' }]);

    expect(result.text).toBe(['# Title', '', '', '', '- one', '- two'].join('\n'));
    expect(result.ranges).toEqual([{ start: 9, end: 9 }]);
  });

  it('leaves the delimiter row in place when a table header row is replaced', () => {
    const table = ['| a | b |', '| - | - |', '| 1 | 2 |'].join('\n');
    const header = blockRanges(table)[0];

    const result = splice(table, [{ ...header, text: '| Buyer | Bid |' }]);

    expect(result.text).toBe(['| Buyer | Bid |', '| - | - |', '| 1 | 2 |'].join('\n'));
  });

  it('lands on the right characters after an emoji', () => {
    const doc = ['Growth 🚀 was strong.', '', 'Second é paragraph.'].join('\n');
    const second = blockRanges(doc)[1];

    const result = splice(doc, [{ ...second, text: 'Margin held.' }]);

    expect(result.text).toBe(['Growth 🚀 was strong.', '', 'Margin held.'].join('\n'));
  });

  it('leaves every character outside the passages identical, for any valid set of edits', () => {
    const random = seeded(20261013);
    const words = ['Revenue', 'grew', '12%', 'in', 'FY25', '🚀', 'café', 'EBITDA', 'margin', 'held'];
    const sentence = () =>
      `${Array.from({ length: 2 + Math.floor(random() * 5) }, () => words[Math.floor(random() * words.length)]).join(' ')}.`;

    for (let round = 0; round < 200; round += 1) {
      const piece = () => {
        const roll = random();
        if (roll < 0.2) return `- ${sentence()}`;
        if (roll < 0.35) return `- ${sentence()}\n  - ${sentence()}\n  - ${sentence()}\n- ${sentence()}`;
        if (roll < 0.5) return `| a | b |\n| - | - |\n| ${sentence()} | ${sentence()} |\n| ${sentence()} | ${sentence()} |`;
        return sentence();
      };
      const text = Array.from({ length: 2 + Math.floor(random() * 8) }, piece).join('\n\n');
      const replacements = blockRanges(text)
        .filter(() => random() < 0.4)
        .map((block) => ({ start: block.start, end: block.end, text: random() < 0.2 ? '' : sentence() }));

      expect(validateEdits(text, replacements)).toBeNull();
      const result = splice(text, replacements);

      expect(removeRanges(result.text, result.ranges)).toBe(removeRanges(text, replacements));
      result.ranges.forEach((range, index) => {
        expect(result.text.slice(range.start, range.end)).toBe(replacements[index].text);
      });
    }
  });
});

describe('shiftRange', () => {
  it('moves a later range by the length change of the replacements before it', () => {
    expect(shiftRange({ start: 27, end: 32 }, [{ start: 9, end: 25, text: 'Short.' }])).toEqual({
      start: 17,
      end: 22,
    });
  });

  it('leaves an earlier range where it is', () => {
    expect(shiftRange({ start: 0, end: 7 }, [{ start: 9, end: 25, text: 'Short.' }])).toEqual({
      start: 0,
      end: 7,
    });
  });
});

describe('cleanReplacement', () => {
  it('drops leading blank lines, trailing whitespace and carriage returns', () => {
    expect(cleanReplacement('\n\n- one\r\n  more  \n\n')).toBe('- one\n  more');
  });

  it('strips only trailing spaces, tabs and newlines and keeps everything else', () => {
    expect(cleanReplacement('text \t\n \t')).toBe('text');
    expect(cleanReplacement('  \ta  \n  b')).toBe('  \ta  \n  b');
    expect(cleanReplacement(' \t\n  \n')).toBe('');
    expect(cleanReplacement('text\u00a0')).toBe('text\u00a0');
    expect(cleanReplacement('text\u00a0 \n')).toBe('text\u00a0');
  });

  it('handles a long interior whitespace run quickly', () => {
    const input = `a${' '.repeat(200_000)}b`;

    const started = performance.now();
    const result = cleanReplacement(input);
    const elapsed = performance.now() - started;

    expect(result).toBe(input);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('storageProblem', () => {
  it('accepts ordinary text', () => {
    expect(storageProblem('# Title\n\nBody.')).toBeNull();
  });

  it('refuses a blank result and one over 200,000 characters', () => {
    expect(storageProblem(' \n ')).toBe('The revised output would be empty.');
    expect(storageProblem('a'.repeat(200_001))).toBe('The revised output is too long.');
  });

  it('refuses text that would be changed by storing it', () => {
    expect(storageProblem('e\u0301')).toBe('The revised output could not be stored as written.');
  });
});

describe('editsDigest and countBy', () => {
  it('gives one digest per set of edits, with no text in it', () => {
    const digest = editsDigest([{ kind: 'comment', start: 0, end: 7, comment: 'secret words' }]);

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain('secret');
  });

  it('counts values', () => {
    expect(countBy(['comment', 'hand', 'comment'])).toEqual({ comment: 2, hand: 1 });
  });
});

describe('parseRevisionInputs', () => {
  it('reads an edits record and drops anything that is not an edit', () => {
    expect(
      parseRevisionInputs({
        kind: 'edits',
        skillMounted: true,
        edits: [
          { id: 'e1', kind: 'comment', start: 0, end: 7, comment: 'Fix.', status: 'applied', resultStart: 0, resultEnd: 9 },
          { nonsense: true },
        ],
      }),
    ).toEqual({
      kind: 'edits',
      skillMounted: true,
      edits: [
        { id: 'e1', kind: 'comment', start: 0, end: 7, comment: 'Fix.', status: 'applied', resultStart: 0, resultEnd: 9 },
      ],
    });
  });

  it('reads a restore record and refuses a run input record', () => {
    expect(parseRevisionInputs({ kind: 'restore', restoredFrom: OTHER })).toEqual({
      kind: 'restore',
      restoredFrom: OTHER,
    });
    expect(parseRevisionInputs({ asOf: '2026-09-30' })).toBeNull();
  });
});

describe('keepsStructure', () => {
  function replaceBlock(doc: string, pick: string, text: string) {
    const block = blockRanges(doc).find((entry) => doc.slice(entry.start, entry.end) === pick);
    if (!block) throw new Error(`no block ${pick}`);
    return [{ start: block.start, end: block.end, text }];
  }

  const LIST = '- alpha\n- bravo\n- charlie';
  const TABLE = '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |';

  it('refuses a list item returned without its marker', () => {
    expect(keepsStructure(LIST, replaceBlock(LIST, '- bravo', 'bravo, corrected'))).toBe(false);
  });

  it('refuses a paragraph returned with an unclosed code fence', () => {
    const doc = 'Intro.\n\nMiddle.\n\nOutro.\n\n- item';

    expect(keepsStructure(doc, replaceBlock(doc, 'Middle.', '```\nMiddle, as code'))).toBe(false);
  });

  it('refuses a table header row returned without pipes', () => {
    const doc = '| a | b |\n| - | - |\n| 1 | 2 |';

    expect(keepsStructure(doc, replaceBlock(doc, '| a | b |', 'Buyer Bid'))).toBe(false);
  });

  it('refuses to empty a middle table row, which pushes the later rows out of the table', () => {
    expect(keepsStructure(TABLE, replaceBlock(TABLE, '| 3 | 4 |', ''))).toBe(false);
  });

  it('refuses a parent item returned without its marker, which lifts its nested items out', () => {
    const doc = '- parent\n  - child one\n  - child two\n- sibling';

    expect(keepsStructure(doc, replaceBlock(doc, '- parent', 'parent'))).toBe(false);
  });

  it('refuses a nested item whose second line starts a top-level item, which takes the items after it', () => {
    const doc = '- parent\n  - child one\n  - child two\n- sibling';

    expect(keepsStructure(doc, replaceBlock(doc, '- child one', '- first\n- second'))).toBe(false);
  });

  it('refuses a parent item returned as two items, which hands its nested items to the new one', () => {
    const doc = '- parent\n  - child one\n- sibling';

    expect(keepsStructure(doc, replaceBlock(doc, '- parent', '- parent\n- new parent'))).toBe(false);
  });

  it('refuses removing one item of a tight list, which spaces the others apart', () => {
    expect(keepsStructure(LIST, replaceBlock(LIST, '- bravo', ''))).toBe(false);
  });

  it('refuses an item returned with a second paragraph, which spaces the others apart', () => {
    expect(keepsStructure(LIST, replaceBlock(LIST, '- bravo', '- bravo\n\n  more'))).toBe(false);
  });

  it('refuses a new number on the first item of an ordered list, which renumbers the others', () => {
    const doc = '1. one\n2. two\n3. three';

    expect(keepsStructure(doc, replaceBlock(doc, '1. one', '3. one'))).toBe(false);
  });

  it('refuses an ordered item returned as two, which renumbers the items after it', () => {
    const doc = '1. one\n2. two\n3. three';

    expect(keepsStructure(doc, replaceBlock(doc, '2. two', '2. two\n3. two more'))).toBe(false);
  });

  it('refuses a lead-in that restarts the numbering of the items after it', () => {
    const doc = '1. a\n1. b\n1. c';

    expect(keepsStructure(doc, replaceBlock(doc, '1. a', 'Lead-in.'))).toBe(false);
  });

  it('refuses removing a paragraph that joins two numbered lists', () => {
    const doc = '1. a\n\n2. b\n\nPara.\n\n1. c\n\n2. d';

    expect(keepsStructure(doc, replaceBlock(doc, 'Para.', ''))).toBe(false);
  });

  it('refuses an item with a new marker, which splits its list in two', () => {
    expect(keepsStructure(LIST, replaceBlock(LIST, '- bravo', '* bravo'))).toBe(false);
  });

  it('refuses a heading turned into an item, which joins the lists around it', () => {
    const doc = '- a\n# H\n- c';

    expect(keepsStructure(doc, replaceBlock(doc, '# H', '- b'))).toBe(false);
  });

  it('refuses a split of a parent item when the passage starts one block earlier', () => {
    const doc = 'Intro.\n\n- parent\n  - child\n- sib';
    const intro = blockRanges(doc)[0];
    const parent = blockRanges(doc)[1];

    expect(
      keepsStructure(doc, [{ start: intro.start, end: parent.end, text: 'Intro.\n\n- parent\n- new parent' }]),
    ).toBe(false);
  });

  it('refuses merging a parent with its child, which lifts the grandchild a level', () => {
    const doc = '- a\n  - b\n    - c\n- e';
    const [a, b] = blockRanges(doc);

    expect(keepsStructure(doc, [{ start: a.start, end: b.end, text: '- a, b merged' }])).toBe(false);
  });

  it('refuses nesting a parent under the item before it, which moves its child', () => {
    const doc = '- s\n- parent\n  - child\n- sib';
    const [s, parent] = blockRanges(doc);

    expect(keepsStructure(doc, [{ start: s.start, end: parent.end, text: '- s\n  - parent' }])).toBe(false);
  });

  it('accepts a lead-in placed before a parent item, which keeps its nested items', () => {
    const doc = '- parent\n  - child\n- sib';

    expect(keepsStructure(doc, replaceBlock(doc, '- parent', 'Lead-in.\n\n- parent'))).toBe(true);
  });

  it('accepts the first item of an ordered list turned into a heading, which keeps the other numbers', () => {
    const doc = '1. one\n2. two\n3. three';

    expect(keepsStructure(doc, replaceBlock(doc, '1. one', '## One'))).toBe(true);
  });

  it('accepts removing the first item of a list, which leaves the others as they were', () => {
    expect(keepsStructure(LIST, replaceBlock(LIST, '- alpha', ''))).toBe(true);
  });

  it('accepts edits to a parent item and its child in one batch, in either order', () => {
    const doc = '- parent\n  - child\n- sib';
    const parent = replaceBlock(doc, '- parent', '- parent, corrected');
    const child = replaceBlock(doc, '- child', '- child, corrected');

    expect(keepsStructure(doc, [...parent, ...child])).toBe(true);
    expect(keepsStructure(doc, [...child, ...parent])).toBe(true);
  });

  it('accepts a parent item rewritten with its marker, which keeps its nested items', () => {
    const doc = '- parent\n  - child one\n  - child two\n- sibling';

    expect(keepsStructure(doc, replaceBlock(doc, '- parent', '- parent, corrected'))).toBe(true);
  });

  it('accepts a nested item given a second line that stays inside it', () => {
    const doc = '- parent\n  - child one\n  - child two\n- sibling';

    expect(keepsStructure(doc, replaceBlock(doc, '- child one', '- child one\nand more'))).toBe(true);
  });

  it('accepts a list item returned as two items in a tight list', () => {
    expect(keepsStructure(LIST, replaceBlock(LIST, '- bravo', '- bravo\n- bravo two'))).toBe(true);
  });

  it('accepts a list item returned with its marker', () => {
    expect(keepsStructure(LIST, replaceBlock(LIST, '- bravo', '- bravo, corrected'))).toBe(true);
  });

  it('accepts a paragraph returned as two paragraphs', () => {
    const doc = 'Intro.\n\nMiddle.\n\nOutro.';

    expect(keepsStructure(doc, replaceBlock(doc, 'Middle.', 'First half.\n\nSecond half.'))).toBe(true);
  });

  it('accepts a nested item returned as two items', () => {
    const doc = '- parent\n  - child one\n  - child two\n- sibling';

    expect(keepsStructure(doc, replaceBlock(doc, '- child one', '- first\n  - second'))).toBe(true);
  });

  it('accepts a table row rewritten as a row', () => {
    expect(keepsStructure(TABLE, replaceBlock(TABLE, '| 3 | 4 |', '| 3 | 40 |'))).toBe(true);
  });

  it('accepts removing a paragraph that sits between paragraphs', () => {
    const doc = 'Intro.\n\nMiddle.\n\nOutro.';

    expect(keepsStructure(doc, replaceBlock(doc, 'Middle.', ''))).toBe(true);
  });

  it('accepts several replacements that each keep the blocks around them', () => {
    const first = replaceBlock(LIST, '- alpha', '- alpha, corrected');
    const last = replaceBlock(LIST, '- charlie', '- charlie, corrected');

    expect(keepsStructure(LIST, [...first, ...last])).toBe(true);
  });
});
