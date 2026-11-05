import { blockRanges, type Range } from '@/lib/skillRun/blocks';

/**
 * The span one comment must cover to ask for a change to the whole output:
 * from the first passage's start to the last passage's end. The revisions API
 * takes a comment only over whole passages (`validateEdits`), so a literal
 * 0..length is refused whenever the output starts or ends with blank space;
 * this span is the whole output in the API's own terms. Null when the output
 * has no passage at all.
 */
export function wholeOutputRange(text: string): Range | null {
  const blocks = blockRanges(text);
  if (blocks.length === 0) return null;
  const start = blocks[0].start;
  const end = Math.max(...blocks.map((block) => block.end));
  return end > start ? { start, end } : null;
}
