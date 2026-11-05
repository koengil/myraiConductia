'use client';

import * as React from 'react';

import { Markdown } from '@/components/atoms';
import { blockRanges, type Block, type Range } from '@/lib/skillRun/blocks';

import { REVIEW_COPY } from './reviewCopy';

type Props = {
  text: string;
  readOnly: boolean;
  marks: ReadonlyMap<number, string>;
  labels: ReadonlyMap<number, string>;
  selection: Range | null;
  onSelect: (range: Range) => void;
  children?: React.ReactNode;
};

const COMPOSER_GAP = 8;
const COMPOSER_ROOM = 320;

function elementOf(node: EventTarget | Node | null): Element | null {
  if (node instanceof Element) return node;
  return node instanceof Node ? node.parentElement : null;
}

export function ReviewDocument({
  text,
  readOnly,
  marks,
  labels,
  selection,
  onSelect,
  children,
}: Props) {
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const hintId = React.useId();
  const blocks = React.useMemo(() => blockRanges(text), [text]);
  const composerRef = React.useRef<HTMLDivElement | null>(null);
  const [cursor, setCursor] = React.useState<number | null>(null);

  const tabStop = blocks.some((block) => block.start === cursor)
    ? cursor
    : (blocks[0]?.start ?? null);

  React.useLayoutEffect(() => {
    const root = rootRef.current;
    const composer = composerRef.current;
    if (!root || !composer || !selection) return;
    const last = root.querySelector(`[data-block-end="${String(selection.end)}"]`);
    if (!last) return;
    const top = last.getBoundingClientRect().bottom - root.getBoundingClientRect().top + COMPOSER_GAP;
    composer.style.top = `${String(top)}px`;
    composer.scrollIntoView?.({ block: 'nearest' });
  }, [selection, text, readOnly]);

  function blockAt(target: EventTarget | Node | null): Block | null {
    const element = elementOf(target)?.closest('[data-block-start]');
    if (!element || !rootRef.current?.contains(element)) return null;
    const start = Number(element.getAttribute('data-block-start'));
    return blocks.find((block) => block.start === start) ?? null;
  }

  function select(block: Block, extend: boolean) {
    setCursor(block.start);
    onSelect(
      extend && selection
        ? {
            start: Math.min(selection.start, block.start),
            end: Math.max(selection.end, block.end),
          }
        : { start: block.start, end: block.end },
    );
  }

  function handleClick(event: React.MouseEvent) {
    if (readOnly || elementOf(event.target)?.closest('a')) return;
    const dragged = window.getSelection();
    const from = dragged && !dragged.isCollapsed ? blockAt(dragged.anchorNode) : null;
    const to = dragged && !dragged.isCollapsed ? blockAt(dragged.focusNode) : null;
    if (from && to) {
      setCursor(to.start);
      onSelect({ start: Math.min(from.start, to.start), end: Math.max(from.end, to.end) });
      return;
    }
    const clicked = blockAt(event.target);
    if (clicked) select(clicked, event.shiftKey);
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (readOnly) return;
    const focused =
      event.target instanceof Element && event.target.hasAttribute('data-block-start')
        ? blockAt(event.target)
        : null;
    if (!focused) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const next = blocks[blocks.indexOf(focused) + (event.key === 'ArrowDown' ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      setCursor(next.start);
      rootRef.current
        ?.querySelector<HTMLElement>(`[data-block-start="${String(next.start)}"]`)
        ?.focus();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select(focused, event.shiftKey);
    }
  }

  const composing = selection !== null && !readOnly;

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={REVIEW_COPY.document}
      aria-describedby={readOnly ? undefined : hintId}
      data-readonly={readOnly ? 'true' : undefined}
      className="review-doc relative mx-auto max-w-[72ch] pl-[var(--space-6)]"
      style={composing ? { paddingBottom: COMPOSER_ROOM } : undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <p id={hintId} className="sr-only">
        {REVIEW_COPY.keyboardHint}
      </p>
      <Markdown
        anchors={{ marks, labels, selected: selection, tabStop: readOnly ? undefined : tabStop }}
      >
        {text}
      </Markdown>
      {composing ? (
        <div
          ref={composerRef}
          className="absolute inset-x-0 top-0 z-10 pl-[var(--space-6)]"
          onClick={(event) => event.stopPropagation()}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
