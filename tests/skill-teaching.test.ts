// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { chainOf, type RevisionRow } from '@/lib/skillRun/revisionStore';
import {
  COMPOSER_LIMIT,
  TEACHING_EXCERPT_LENGTH,
  promptRoom,
  teachableComments,
  teachingPrompt,
  type TeachableComment,
} from '@/lib/skillRun/teaching';
import type { EditRecord } from '@/lib/skillRun/types';

const HEADER =
  'Update this skill with lessons from reviews of its output.\n\n' +
  'Keep the lessons in a section titled "Learned from reviews". Merge these with any lessons already in that section: drop duplicates, and where two conflict, keep the newer one. Write each lesson as a short standing rule. State each lesson in general terms: do not name the company, any party, codename or person, and do not repeat a figure from the comments or excerpts below. Leave every other part of the skill unchanged.';

function edit(overrides: Partial<EditRecord>): EditRecord {
  return {
    id: 'e1',
    kind: 'comment',
    start: 0,
    end: 5,
    comment: 'Be direct',
    status: 'applied',
    resultStart: 0,
    resultEnd: 6,
    teach: true,
    ...overrides,
  };
}

function row(overrides: Partial<RevisionRow>): RevisionRow {
  return {
    id: 'rev',
    outcome: 'succeeded',
    inputs: { kind: 'edits', edits: [] },
    resultText: 'Direct opening.',
    errorMessage: null,
    actorId: 'user-1',
    parentId: 'root',
    rootId: 'root',
    createdAt: '2026-10-13T10:00:01.000Z',
    ...overrides,
  };
}

function comment(overrides: Partial<TeachableComment> = {}): TeachableComment {
  return { revisionId: 'v2', editId: 'e1', comment: 'Be direct', passage: 'Hello', became: 'Hi', ...overrides };
}

describe('teachableComments', () => {
  it('lists applied, taught comments oldest first with their passage and what it became', () => {
    const root = { id: 'root', text: 'Hello there world.' };
    const second = row({
      id: 'v2',
      resultText: 'Hi there world.',
      inputs: { kind: 'edits', edits: [edit({ id: 'a', start: 0, end: 5, comment: 'First', resultStart: 0, resultEnd: 2 })] },
    });
    const third = row({
      id: 'v3',
      parentId: 'v2',
      resultText: 'Hi there planet.',
      createdAt: '2026-10-13T10:00:02.000Z',
      inputs: { kind: 'edits', edits: [edit({ id: 'b', start: 9, end: 15, comment: 'Second', resultStart: 9, resultEnd: 15 })] },
    });

    expect(teachableComments(chainOf(root, [second, third]), new Set())).toEqual([
      { revisionId: 'v2', editId: 'a', comment: 'First', passage: 'Hello', became: 'Hi' },
      { revisionId: 'v3', editId: 'b', comment: 'Second', passage: 'world.', became: 'planet' },
    ]);
  });

  it('leaves out an untaught comment, an unresolved one, a hand edit, and any comment in a failed revision', () => {
    const root = { id: 'root', text: 'Hello there world.' };
    const good = row({
      id: 'v2',
      resultText: 'Hi there world.',
      inputs: {
        kind: 'edits',
        edits: [
          edit({ id: 'untaught', teach: undefined }),
          edit({ id: 'unresolved', status: 'unresolved' }),
          edit({ id: 'hand', kind: 'hand' }),
          edit({ id: 'kept', resultStart: 0, resultEnd: 2 }),
        ],
      },
    });
    const failed = row({
      id: 'v3',
      outcome: 'failed',
      resultText: null,
      parentId: 'v2',
      inputs: { kind: 'edits', edits: [edit({ id: 'inFailed' })] },
    });

    expect(teachableComments(chainOf(root, [good, failed]), new Set()).map((item) => item.editId)).toEqual(['kept']);
  });

  it('leaves out a comment that was already sent', () => {
    const root = { id: 'root', text: 'Hello there world.' };
    const second = row({
      id: 'v2',
      resultText: 'Hi there world.',
      inputs: { kind: 'edits', edits: [edit({ id: 'a' }), edit({ id: 'b' })] },
    });

    expect(teachableComments(chainOf(root, [second]), new Set(['a'])).map((item) => item.editId)).toEqual(['b']);
  });
});

describe('teachingPrompt', () => {
  it('writes the header and one numbered entry per comment, keeping the comment verbatim', () => {
    const result = teachingPrompt([comment({ comment: 'Be direct.\nNo hedging.', passage: 'Hello\n  there' })], 10_000);

    expect(result.text).toBe(
      `${HEADER}\n\n1. Comment: "Be direct.\nNo hedging."\n   Written on: "Hello there"\n   Became: "Hi"`,
    );
    expect(result.included).toHaveLength(1);
  });

  it('tells the model to keep deal facts out of the lessons', () => {
    const result = teachingPrompt([comment({})], 10_000);

    expect(result.text).toContain(
      'State each lesson in general terms: do not name the company, any party, codename or person, and do not repeat a figure from the comments or excerpts below.',
    );
  });

  it('numbers entries from 1 and separates them with a blank line', () => {
    const result = teachingPrompt([comment({ editId: 'a' }), comment({ editId: 'b' })], 10_000);

    expect(result.text).toContain('Became: "Hi"\n\n2. Comment: "Be direct"');
  });

  it('cuts a long passage to an excerpt but never the comment', () => {
    const long = 'x'.repeat(700);
    const result = teachingPrompt([comment({ comment: long, passage: long })], 10_000);

    expect(result.text).toContain(`Comment: "${long}"`);
    expect(result.text).toContain(`Written on: "${'x'.repeat(TEACHING_EXCERPT_LENGTH)}..."`);
    expect(result.text).not.toContain('x'.repeat(TEACHING_EXCERPT_LENGTH + 1) + '..."\n   Became');
  });

  it('stops at the first comment that does not fit and reports what it included', () => {
    const one = teachingPrompt([comment({ editId: 'a' })], 10_000).text;
    const result = teachingPrompt(
      [comment({ editId: 'a' }), comment({ editId: 'b', comment: 'x'.repeat(500) }), comment({ editId: 'c' })],
      one.length + 100,
    );

    expect(result.text).toBe(one);
    expect(result.included.map((item) => item.editId)).toEqual(['a']);
  });

  it('never leaves half an astral character at the end of an excerpt', () => {
    const passage = `${'x'.repeat(TEACHING_EXCERPT_LENGTH - 1)}\u{1F600} tail`;
    const result = teachingPrompt([comment({ passage })], 10_000);

    expect(result.text).toContain(`Written on: "${'x'.repeat(TEACHING_EXCERPT_LENGTH - 1)}..."`);
    expect(result.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('includes nothing when the first comment does not fit', () => {
    expect(teachingPrompt([comment()], 10)).toEqual({ text: '', included: [] });
  });
});

describe('promptRoom', () => {
  it('leaves room for the separator when the composer has text', () => {
    expect(COMPOSER_LIMIT).toBe(20_000);
    expect(promptRoom('')).toBe(20_000);
    expect(promptRoom('abc')).toBe(19_995);
  });
});
