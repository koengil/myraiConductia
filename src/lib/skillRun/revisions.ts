import { createHash } from 'node:crypto';

import { canonicalizeText } from '@/lib/conductia/documents';
import { isUuid } from '@/lib/skillPublication/parse';

import { blockRanges, blockShapes, isAligned, type BlockShape, type Range } from './blocks';
import {
  REVISION_LIMITS,
  type EditRecord,
  type EditRequest,
  type RevisionInputs,
} from './types';

export type RevisionRequest =
  | { kind: 'edits'; parentId: string; edits: EditRequest[] }
  | { kind: 'restore'; parentId: string; restoreOf: string };

export type Replacement = Range & { text: string };

export const STRUCTURE_PROBLEM =
  'That change would alter the passages around it. To add or remove an item or a row, select the whole list or table and edit it as one passage.';
export const STRUCTURE_REASON = 'The rewrite would have changed the passages around it.';

const RAW_COMMENT_FACTOR = 4;

function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseEdit(value: unknown): EditRequest | string {
  if (!value || typeof value !== 'object') return 'Each edit must be an object';
  const rec = value as Record<string, unknown>;
  if (rec.teach !== undefined && typeof rec.teach !== 'boolean') return 'teach must be true or false';
  if (!isOffset(rec.start) || !isOffset(rec.end) || rec.end <= rec.start) {
    return 'Each edit needs a start and a later end';
  }
  if (rec.kind === 'comment') {
    if (typeof rec.comment === 'string' && rec.comment.length > REVISION_LIMITS.comment * RAW_COMMENT_FACTOR) {
      return 'A comment is too long';
    }
    const comment = typeof rec.comment === 'string' ? canonicalizeText(rec.comment).trim() : '';
    if (comment === '') return 'A comment cannot be empty';
    if (comment.length > REVISION_LIMITS.comment) return 'A comment is too long';
    return { kind: 'comment', start: rec.start, end: rec.end, comment, ...(rec.teach === true ? { teach: true as const } : {}) };
  }
  if (rec.kind === 'hand') {
    if (rec.teach === true) return 'Only a comment can teach the skill';
    if (typeof rec.text !== 'string') return 'A hand edit needs its text';
    if (rec.text.length > REVISION_LIMITS.text) return 'A hand edit is too long';
    return { kind: 'hand', start: rec.start, end: rec.end, text: rec.text };
  }
  return 'Each edit is a comment or a hand edit';
}

export function parseRevisionRequest(body: unknown): RevisionRequest | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Invalid JSON body' };
  const rec = body as Record<string, unknown>;
  const parentId = typeof rec.parentId === 'string' ? rec.parentId.trim() : '';
  if (!isUuid(parentId)) return { error: 'parentId must be a UUID' };

  if (rec.restoreOf !== undefined) {
    if (rec.edits !== undefined) return { error: 'Send edits or restoreOf, not both' };
    const restoreOf = typeof rec.restoreOf === 'string' ? rec.restoreOf.trim() : '';
    if (!isUuid(restoreOf)) return { error: 'restoreOf must be a UUID' };
    return { kind: 'restore', parentId, restoreOf };
  }

  if (!Array.isArray(rec.edits) || rec.edits.length === 0) {
    return { error: 'edits must list at least one edit' };
  }
  if (rec.edits.length > REVISION_LIMITS.edits) {
    return { error: `At most ${String(REVISION_LIMITS.edits)} edits can be applied at once` };
  }
  const edits: EditRequest[] = [];
  let handLength = 0;
  for (const raw of rec.edits) {
    const edit = parseEdit(raw);
    if (typeof edit === 'string') return { error: edit };
    if (edit.kind === 'hand') handLength += edit.text.length;
    edits.push(edit);
  }
  if (handLength > REVISION_LIMITS.text) return { error: 'The hand edits together are too long' };
  return { kind: 'edits', parentId, edits };
}

export function validateEdits(text: string, edits: readonly Range[]): string | null {
  const blocks = blockRanges(text);
  let cursor = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    if (edit.end > text.length) return 'An edit lies outside the output';
    if (edit.start < cursor) return 'Two edits cover the same passage';
    if (!isAligned(blocks, edit)) return 'An edit does not cover whole passages';
    cursor = edit.end;
  }
  return null;
}

export function cleanReplacement(raw: string): string {
  const text = canonicalizeText(raw).replace(/^\n+/, '');
  let end = text.length;
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t' || text[end - 1] === '\n')) {
    end -= 1;
  }
  return text.slice(0, end);
}

export function shiftRange(range: Range, replacements: readonly Replacement[]): Range {
  const delta = replacements
    .filter((replacement) => replacement.end <= range.start)
    .reduce(
      (sum, replacement) => sum + replacement.text.length - (replacement.end - replacement.start),
      0,
    );
  return { start: range.start + delta, end: range.end + delta };
}

export function splice(
  text: string,
  replacements: readonly Replacement[],
): { text: string; ranges: Range[] } {
  let out = '';
  let cursor = 0;
  for (const replacement of [...replacements].sort((a, b) => a.start - b.start)) {
    out += text.slice(cursor, replacement.start) + replacement.text;
    cursor = replacement.end;
  }
  out += text.slice(cursor);

  const ranges = replacements.map((replacement) => {
    const start = shiftRange(replacement, replacements).start;
    return { start, end: start + replacement.text.length };
  });
  return { text: out, ranges };
}

type Comparison = {
  before: readonly BlockShape[];
  after: readonly BlockShape[];
  replacements: readonly Replacement[];
  results: readonly Range[];
};

function overlaps(range: Range, replacement: Range): boolean {
  return range.end > replacement.start && range.start < replacement.end;
}

function within(range: Range, region: Range): boolean {
  return range.start >= region.start && range.end <= region.end;
}

function sameRange(first: Range, second: Range): boolean {
  return first.start === second.start && first.end === second.end;
}

function sameParent(before: BlockShape, after: BlockShape, comparison: Comparison): boolean {
  if (!before.parent || !after.parent) return before.parent === after.parent;
  const parent = before.parent;
  const { replacements, results } = comparison;
  const touched = replacements.findIndex((replacement) => overlaps(parent, replacement));
  if (touched === -1) return sameRange(after.parent, shiftRange(parent, replacements));
  const itemsIn = (shapes: readonly BlockShape[], region: Range) =>
    shapes.filter(
      (shape) => shape.kind === 'listItem' && shape.depth === before.depth - 1 && within(shape, region),
    );
  const itemsBefore = itemsIn(comparison.before, replacements[touched]);
  const itemsAfter = itemsIn(comparison.after, results[touched]);
  const index = itemsBefore.findIndex((shape) => sameRange(shape, parent));
  return (
    index !== -1 &&
    itemsBefore.length === itemsAfter.length &&
    sameRange(after.parent, itemsAfter[index])
  );
}

function keepsLists(pairs: readonly [BlockShape, BlockShape][]): boolean {
  const forward = new Map<number, number>();
  const backward = new Map<number, number>();
  for (const [before, after] of pairs) {
    if (!before.list || !after.list) {
      if (before.list !== after.list) return false;
      continue;
    }
    if (before.list.number !== after.list.number || before.list.loose !== after.list.loose) {
      return false;
    }
    const mapped = forward.get(before.list.key);
    const reverse = backward.get(after.list.key);
    if (mapped !== undefined && mapped !== after.list.key) return false;
    if (reverse !== undefined && reverse !== before.list.key) return false;
    forward.set(before.list.key, after.list.key);
    backward.set(after.list.key, before.list.key);
  }
  return true;
}

export function keepsStructure(parentText: string, replacements: readonly Replacement[]): boolean {
  const result = splice(parentText, replacements);
  const comparison: Comparison = {
    before: blockShapes(parentText),
    after: blockShapes(result.text),
    replacements,
    results: result.ranges,
  };
  const pairs: [BlockShape, BlockShape][] = [];
  for (const block of comparison.before) {
    if (replacements.some((replacement) => overlaps(block, replacement))) continue;
    const shifted = shiftRange(block, replacements);
    const entry = comparison.after.find(
      (candidate) => candidate.kind === block.kind && sameRange(candidate, shifted),
    );
    if (!entry || entry.depth !== block.depth || !sameParent(block, entry, comparison)) return false;
    pairs.push([block, entry]);
  }
  if (!keepsLists(pairs)) return false;
  return replacements.every(
    (replacement, index) =>
      replacement.text === '' || isAligned(comparison.after, result.ranges[index]),
  );
}

export function storageProblem(text: string): string | null {
  if (text.trim() === '') return 'The revised output would be empty.';
  if (text.length > REVISION_LIMITS.text) return 'The revised output is too long.';
  if (canonicalizeText(text) !== text) return 'The revised output could not be stored as written.';
  return null;
}

export function digestOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function editsDigest(edits: readonly EditRequest[]): string {
  return digestOf(JSON.stringify(edits));
}

export function countBy<T extends string>(values: readonly T[]): Partial<Record<T, number>> {
  const counts: Partial<Record<T, number>> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function isEditRecord(value: unknown): value is EditRecord {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.id === 'string' &&
    (rec.kind === 'comment' || rec.kind === 'hand') &&
    isOffset(rec.start) &&
    isOffset(rec.end) &&
    (rec.status === 'applied' || rec.status === 'unresolved' || rec.status === 'failed')
  );
}

export function parseRevisionInputs(value: unknown): RevisionInputs | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (rec.kind === 'restore' && typeof rec.restoredFrom === 'string') {
    return { kind: 'restore', restoredFrom: rec.restoredFrom };
  }
  if (rec.kind !== 'edits' || !Array.isArray(rec.edits)) return null;
  return {
    kind: 'edits',
    edits: rec.edits.filter(isEditRecord),
    ...(typeof rec.skillMounted === 'boolean' ? { skillMounted: rec.skillMounted } : {}),
  };
}
