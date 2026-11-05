'use client';

import * as React from 'react';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { stepTitle, type ProjectRailStep } from '@/lib/rail/projectRail';
import type { RenderStepCard } from './RailBoard';

/**
 * Pointer drag for one phase's stack of step cards, the Preview reorder
 * (handoff E1, docs/03-engineering/walkthrough-handoff-2026-10-22.md): the
 * new order lives in this browser only. A press has to travel a few pixels
 * before it becomes a drag, so a click still zooms into the step. There is
 * no keyboard sensor: "Move to…" in the card menu is the keyboard path, and
 * the board's arrow keys keep moving focus.
 */
export const DRAG_ACTIVATION_DISTANCE_PX = 6;

/**
 * The move a drop makes, or null when the step stays where it was: dropped on
 * itself, outside the stack, or ahead of a step that cannot move. The drag's
 * end announcement reads from the same answer, so it never says "moved" for a
 * step that stayed.
 */
export function dropTarget(
  steps: readonly ProjectRailStep[],
  activeId: string | number,
  overId: string | number | undefined | null,
  canMoveTo: (step: ProjectRailStep, toIndex: number) => boolean = () => true,
): { step: ProjectRailStep; toIndex: number } | null {
  if (overId === undefined || overId === null || activeId === overId) return null;
  const step = steps.find((s) => s.id === activeId);
  const toIndex = steps.findIndex((s) => s.id === String(overId));
  if (!step || toIndex < 0 || !canMoveTo(step, toIndex)) return null;
  return { step, toIndex };
}

export function SortableStack({
  steps,
  renderCard,
  canDrag,
  canMoveTo = () => true,
  onMove,
}: {
  steps: readonly ProjectRailStep[];
  renderCard: RenderStepCard;
  /** Steps that cannot move (done, required, before the deal opened) stay put. */
  canDrag: (step: ProjectRailStep) => boolean;
  /** Whether a drop at this index is a place a saved move would allow. */
  canMoveTo?: (step: ProjectRailStep, toIndex: number) => boolean;
  /** The dragged step and the index it was dropped at in `steps`. */
  onMove: (step: ProjectRailStep, toIndex: number) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE_PX } }),
  );
  const ids = React.useMemo(() => steps.map((s) => s.id), [steps]);
  const titleOf = (id: string | number) => {
    const step = steps.find((s) => s.id === id);
    return step ? stepTitle(step) : 'Step';
  };
  const dropFor = (activeId: string | number, overId: string | number | undefined) =>
    dropTarget(steps, activeId, overId, canMoveTo);
  const onDragEnd = (event: DragEndEvent) => {
    const drop = dropFor(event.active.id, event.over?.id);
    if (drop) onMove(drop.step, drop.toIndex);
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => `Moving ${titleOf(active.id)}.`,
          onDragOver: ({ active, over }) =>
            over ? `${titleOf(active.id)} is over ${titleOf(over.id)}.` : `${titleOf(active.id)} is not over a step.`,
          onDragEnd: ({ active, over }) =>
            dropFor(active.id, over?.id)
              ? `${titleOf(active.id)} moved. Preview only, not saved.`
              : `${titleOf(active.id)} stayed where it was.`,
          onDragCancel: ({ active }) => `${titleOf(active.id)} stayed where it was.`,
        },
        // Intentionally inert: the card button keeps its own name and does
        // not spread dnd-kit's attributes, so nothing points at this text.
        // Replacing dnd-kit's default keeps its hidden text truthful.
        screenReaderInstructions: {
          draggable: 'Use Move to in the step menu to move this step with the keyboard.',
        },
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {steps.map((step) => (
          <SortableCard key={step.id} step={step} renderCard={renderCard} disabled={!canDrag(step)} />
        ))}
      </SortableContext>
    </DndContext>
  );
}

function SortableCard({
  step,
  renderCard,
  disabled,
}: {
  step: ProjectRailStep;
  renderCard: RenderStepCard;
  disabled: boolean;
}) {
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id: step.id,
    disabled,
  });
  return renderCard(step, {
    ref: setNodeRef,
    style: {
      // A phase is one vertical list: the card follows the pointer up and down only.
      transform: CSS.Translate.toString(transform ? { ...transform, x: 0 } : null),
      transition,
      position: 'relative',
      zIndex: isDragging ? 20 : undefined,
      opacity: isDragging ? 0.92 : undefined,
      touchAction: disabled ? undefined : 'manipulation',
    },
    // The card button keeps its own name, role and roving tab index:
    // dnd-kit's button attributes would rename it "sortable" and offer
    // keyboard pickup the board does not have.
    handle: { attributes: {}, listeners: disabled ? undefined : listeners, setActivatorNodeRef },
  });
}

export default SortableStack;
