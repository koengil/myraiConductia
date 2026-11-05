import { describe, expect, it } from 'vitest';

import { excerptAround, EXCERPT_RADIUS } from '@/lib/discovery/excerpt';

const SENTENCE = 'The letter of intent for Project Kestrel was signed on 18 September 2026.';

function bodyWith(before: string, after: string) {
  const body = `${before}${SENTENCE}${after}`;
  return { body, start: before.length, end: before.length + SENTENCE.length };
}

describe('excerptAround', () => {
  it('returns the whole body when it is shorter than the window', () => {
    const { body, start, end } = bodyWith('Hi all. ', ' Regards.');
    const excerpt = excerptAround(body, start, end)!;
    expect(excerpt.text).toBe(body);
    expect(excerpt.highlight).toEqual([start, end]);
  });

  it('highlights the cited span relative to the excerpt, not to the body', () => {
    const before = 'word '.repeat(80); // 400 chars
    const { body, start, end } = bodyWith(before, ' tail '.repeat(80));
    const excerpt = excerptAround(body, start, end)!;
    const [from, to] = excerpt.highlight;
    expect(excerpt.text.slice(from, to)).toBe(SENTENCE);
    expect(from).toBeLessThanOrEqual(EXCERPT_RADIUS);
    expect(excerpt.text.length).toBeLessThan(body.length);
  });

  it('never cuts a word at either edge', () => {
    const before = 'alphabetical '.repeat(40);
    const after = ' zzzzzzzzzzzzzz'.repeat(40);
    const { body, start, end } = bodyWith(before, after);
    const { text } = excerptAround(body, start, end)!;
    const words = text.split(/\s+/);
    expect(words[0]).toBe('alphabetical');
    expect(words.at(-1)).toBe('zzzzzzzzzzzzzz');
  });

  it('keeps the cited span whole when the window edge falls inside it', () => {
    const { body, start, end } = bodyWith('', '');
    const excerpt = excerptAround(body, start + 4, end - 4, 3)!;
    expect(excerpt.text.slice(excerpt.highlight[0], excerpt.highlight[1])).toBe(body.slice(start + 4, end - 4));
  });

  it('honours a custom radius', () => {
    const { body, start, end } = bodyWith('a '.repeat(50), ' b'.repeat(50));
    const narrow = excerptAround(body, start, end, 10)!;
    expect(narrow.text.length).toBeLessThan(SENTENCE.length + 25);
  });

  it('answers null for a span that is not inside the body', () => {
    expect(excerptAround('short', 0, 99)).toBeNull();
    expect(excerptAround('short', 3, 3)).toBeNull();
    expect(excerptAround('short', -1, 2)).toBeNull();
    expect(excerptAround('short', 1.5, 3)).toBeNull();
  });
});
