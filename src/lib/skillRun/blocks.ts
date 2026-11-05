import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

export type BlockKind = 'heading' | 'paragraph' | 'listItem' | 'tableRow' | 'blockquote' | 'code';

export type Range = { start: number; end: number };

export type Block = Range & { kind: BlockKind };

export type ListShape = { key: number; number: number | null; loose: boolean };

export type BlockShape = Block & { parent: Range | null; depth: number; list: ListShape | null };

type Place = { parent: Range | null; depth: number; list: ListShape | null };

type MarkdownNode = {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
  ordered?: boolean | null;
  start?: number | null;
  spread?: boolean | null;
};

const TOP: Place = { parent: null, depth: 0, list: null };

const LEAF_KINDS: Record<string, BlockKind> = {
  heading: 'heading',
  paragraph: 'paragraph',
  blockquote: 'blockquote',
  code: 'code',
};

const parser = unified().use(remarkParse).use(remarkGfm);

function rangeOf(node: MarkdownNode): Range | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return typeof start === 'number' && typeof end === 'number' ? { start, end } : null;
}

function push(into: BlockShape[], kind: BlockKind, range: Range | null, place: Place): void {
  if (range && range.end > range.start) into.push({ kind, ...range, ...place });
}

function itemLoose(item: MarkdownNode): boolean {
  return item.spread ?? (item.children ?? []).length > 1;
}

function collectItem(item: MarkdownNode, place: Place, into: BlockShape[]): void {
  const children = item.children ?? [];
  const firstList = children.findIndex((child) => child.type === 'list');
  const whole = rangeOf(item);
  if (firstList === -1) {
    push(into, 'listItem', whole, place);
    return;
  }
  const lastHead = firstList > 0 ? rangeOf(children[firstList - 1]) : null;
  const head = whole && lastHead ? { start: whole.start, end: lastHead.end } : null;
  push(into, 'listItem', head, place);
  collect(children.slice(firstList), { parent: head, depth: place.depth + 1, list: null }, into);
}

function collect(nodes: MarkdownNode[], place: Place, into: BlockShape[]): void {
  for (const node of nodes) {
    if (node.type === 'list') {
      const items = node.children ?? [];
      const key = node.position?.start.offset ?? -1;
      const loose = Boolean(node.spread) || items.some(itemLoose);
      const first = node.ordered ? (node.start ?? 1) : null;
      items.forEach((item, index) => {
        const list = { key, number: first === null ? null : first + index, loose };
        collectItem(item, { ...place, list }, into);
      });
    } else if (node.type === 'table') {
      for (const row of node.children ?? []) push(into, 'tableRow', rangeOf(row), place);
    } else if (LEAF_KINDS[node.type]) {
      push(into, LEAF_KINDS[node.type], rangeOf(node), place);
    }
  }
}

export function sourceShift(text: string): number {
  return text.charCodeAt(0) === 0xfeff ? 1 : 0;
}

function moved(range: Range, shift: number): Range {
  return { start: range.start + shift, end: range.end + shift };
}

export function blockShapes(text: string): BlockShape[] {
  const shapes: BlockShape[] = [];
  collect((parser.parse(text) as MarkdownNode).children ?? [], TOP, shapes);
  const shift = sourceShift(text);
  return shapes.map((shape) => ({
    ...shape,
    ...moved(shape, shift),
    parent: shape.parent ? moved(shape.parent, shift) : null,
  }));
}

export function blockRanges(text: string): Block[] {
  return blockShapes(text).map(({ kind, start, end }) => ({ kind, start, end }));
}

export function isAligned(blocks: readonly Block[], range: Range): boolean {
  const first = blocks.findIndex((block) => block.start === range.start);
  return first !== -1 && blocks.slice(first).some((block) => block.end === range.end);
}

export function blocksWithin(blocks: readonly Block[], range: Range): Block[] {
  return blocks.filter((block) => block.start >= range.start && block.end <= range.end);
}
