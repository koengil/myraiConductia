// The excerpt around a cited span of the viewer's own mail. Pure: the body, the
// span the extractor verified, and a window on each side. The window never cuts
// a word, and the highlight is relative to the returned text, so the page can
// mark the cited sentence without knowing the body.

export const EXCERPT_RADIUS = 140;

export type Excerpt = { text: string; highlight: [number, number] };

const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);

/**
 * `null` when the span is not a range inside the body (an edited or truncated
 * body): the page then shows the evidence without a quote.
 */
export function excerptAround(
  body: string,
  spanStart: number,
  spanEnd: number,
  radius: number = EXCERPT_RADIUS,
): Excerpt | null {
  if (!Number.isInteger(spanStart) || !Number.isInteger(spanEnd)) return null;
  if (spanStart < 0 || spanEnd <= spanStart || spanEnd > body.length) return null;

  let start = Math.max(0, spanStart - radius);
  let end = Math.min(body.length, spanEnd + radius);
  // A cut inside a word moves inward to the next gap, never into the cited span.
  if (start > 0 && !isSpace(body[start - 1]) && !isSpace(body[start])) {
    while (start < spanStart && !isSpace(body[start])) start++;
    while (start < spanStart && isSpace(body[start])) start++;
  }
  if (end < body.length && !isSpace(body[end - 1]) && !isSpace(body[end])) {
    while (end > spanEnd && !isSpace(body[end - 1])) end--;
    while (end > spanEnd && isSpace(body[end - 1])) end--;
  }
  return { text: body.slice(start, end), highlight: [spanStart - start, spanEnd - start] };
}
