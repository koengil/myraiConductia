import type {
  PublicationRead,
  PublicationState,
} from "@/lib/skillPublication/types";
import type { DraftRead } from "./types";

const PUBLICATION_NONTERMINAL_STATES: readonly PublicationState[] = [
  "preparing",
  "confirmation_required",
  "publishing",
  "attaching",
  "reconciling",
  "needs_placement",
];

export type PublicationFreeze = {
  patchDisabled: boolean;
  sendDisabled: boolean;
  retryDisabled: boolean;
  discardDisabled: boolean;
  duplicateDecisionOnly: boolean;
  placementReplacementOnly: boolean;
  readOnly: boolean;
};

export function publicationOf(draft: DraftRead | null): PublicationRead | null {
  return draft && draft.publication.available ? draft.publication : null;
}

export function publicationNonterminal(draft: DraftRead | null): boolean {
  const publication = publicationOf(draft);
  return (
    publication !== null &&
    PUBLICATION_NONTERMINAL_STATES.includes(publication.state)
  );
}

export function activePollDelay(
  draft: DraftRead | null,
  attemptNonterminal: boolean,
  idleMs: number,
): number {
  return attemptNonterminal || publicationNonterminal(draft) ? 1000 : idleMs;
}

export function publicationFreeze(draft: DraftRead | null): PublicationFreeze {
  const publication = publicationOf(draft);
  const nonterminal = publicationNonterminal(draft);
  const readOnly = publication?.state === "published";
  const frozen = nonterminal || readOnly;
  return {
    patchDisabled: frozen,
    sendDisabled: frozen,
    retryDisabled: frozen,
    discardDisabled: frozen,
    duplicateDecisionOnly: publication?.state === "confirmation_required",
    placementReplacementOnly: publication?.state === "needs_placement",
    readOnly,
  };
}

export type PublicationMemo = { id: string; state: PublicationState } | null;

export type PublicationSuccessTracker = {
  previous: PublicationMemo;
  fired: Set<string>;
};

export function createPublicationSuccessTracker(): PublicationSuccessTracker {
  return { previous: null, fired: new Set() };
}

function fireOnce(
  tracker: PublicationSuccessTracker,
  publication: PublicationRead,
  onPublished?: (stepId: string) => void,
): void {
  if (tracker.fired.has(publication.id) || !publication.result) return;
  tracker.fired.add(publication.id);
  onPublished?.(publication.result.stepId);
}

export function noteObservedPublicationTransition(
  tracker: PublicationSuccessTracker,
  next: DraftRead,
  onPublished?: (stepId: string) => void,
): void {
  const publication = publicationOf(next);
  const previous = tracker.previous;
  if (
    publication &&
    publication.state === "published" &&
    previous &&
    previous.id === publication.id &&
    previous.state !== "published"
  ) {
    fireOnce(tracker, publication, onPublished);
  }
  tracker.previous = publication
    ? { id: publication.id, state: publication.state }
    : null;
}

export function noteCommandPublished(
  tracker: PublicationSuccessTracker,
  publication: PublicationRead,
  onPublished?: (stepId: string) => void,
): void {
  if (publication.state !== "published") return;
  fireOnce(tracker, publication, onPublished);
}

export function shouldMergePublication(
  current: DraftRead["publication"],
  incoming: PublicationRead,
): boolean {
  if (!current.available) return true;
  if (current.id !== incoming.id) return true;
  return current.revision < incoming.revision;
}
