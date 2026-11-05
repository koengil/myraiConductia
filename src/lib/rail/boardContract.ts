/**
 * Board hooks contract: the seam between the rail board and the features
 * that plug into it (reorder, owner and activity chips). Types only, no UI.
 * Reorder is Preview until engineers wire saving (handoff entry E1, "Save a
 * step reorder (deal rail and rail templates)").
 */

/** Handle props a row spreads on its drag grip. */
export type SortableHandle = {
  attributes: Record<string, unknown>;
  listeners: Record<string, unknown> | undefined;
  setActivatorNodeRef?: (el: HTMLElement | null) => void;
};

export type StepActivityKind = 'draft_saved' | 'assigned' | 'completed';

/** A step's owner, keyed by user id: two people who share a name stay two people. */
export type StepOwner = { id: string; name: string; initials: string };

export type StepOwnerSummary = {
  stepId: string;
  owner?: StepOwner;
  activity?: { kind: StepActivityKind; actorName: string; at: string };
};
