"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicationRead } from "@/lib/skillPublication/types";
import {
  createPublicationOperations,
  toCommandError,
  type PublicationCommandError,
  type PublicationOperations,
} from "./publicationClient";
import {
  createPublicationSuccessTracker,
  noteCommandPublished,
  noteObservedPublicationTransition,
  publicationFreeze,
  publicationNonterminal,
  publicationOf,
  shouldMergePublication,
  type PublicationFreeze,
} from "./publicationState";
import {
  freshId,
  nonterminal,
  type SkillAuthoringDraft,
} from "./useSkillAuthoringDraft";
import type { DraftRead, Placement } from "./types";

export type { PublicationOperations } from "./publicationClient";

const STALE_REREAD_CODES = new Set([
  "stale_edit_revision",
  "stale_candidate",
  "stale_publication_revision",
]);

const PUBLICATION_POLL_MS = 1000;

function mergePublication(
  draft: DraftRead,
  publication: PublicationRead,
): DraftRead {
  return { ...draft, publication };
}

function isDefinitive(kind: PublicationCommandError["kind"]): boolean {
  return kind !== "network" && kind !== "unknown";
}

type CommandContext = {
  authoring: SkillAuthoringDraft;
  client: PublicationOperations;
  dealId: string;
  live(): boolean;
  markPending(key: string, pending: boolean): void;
  setCommandError(error: PublicationCommandError | null): void;
  tracker: ReturnType<typeof createPublicationSuccessTracker>;
  onPublished?(stepId: string): void;
};

function acceptPublicationResult(
  context: CommandContext,
  result: PublicationRead,
): void {
  const draft = context.authoring.currentDraft();
  if (draft && shouldMergePublication(draft.publication, result)) {
    context.authoring.replaceDraft(mergePublication(draft, result));
  }
}

async function handleFailure(
  context: CommandContext,
  error: unknown,
): Promise<PublicationCommandError> {
  const classified = toCommandError(error);
  context.setCommandError(classified);
  const staleCode = classified.code && STALE_REREAD_CODES.has(classified.code);
  if (staleCode || !isDefinitive(classified.kind)) {
    await context.authoring.refresh();
  }
  return classified;
}

type CommandHandlers = {
  onSuccess?(result: PublicationRead): void;
  onError?(error: PublicationCommandError): void;
};

async function runPublicationCommand(
  context: CommandContext,
  key: string,
  call: () => Promise<PublicationRead>,
  handlers: CommandHandlers = {},
): Promise<boolean> {
  context.setCommandError(null);
  context.markPending(key, true);
  try {
    const result = await call();
    if (!context.live()) return false;
    acceptPublicationResult(context, result);
    handlers.onSuccess?.(result);
    noteCommandPublished(context.tracker, result, context.onPublished);
    return true;
  } catch (error) {
    if (!context.live()) return false;
    const classified = await handleFailure(context, error);
    handlers.onError?.(classified);
    return false;
  } finally {
    context.markPending(key, false);
  }
}

function publishAllowed(draft: DraftRead | null): draft is DraftRead {
  return (
    !!draft &&
    !!draft.candidate &&
    !publicationFreeze(draft).patchDisabled &&
    !nonterminal(draft.activeAttempt)
  );
}

function publishHandlers(
  context: CommandContext,
  requestIdRef: { current: string | null },
): CommandHandlers {
  return {
    onSuccess: () => {
      requestIdRef.current = null;
    },
    onError: (error) => {
      if (isDefinitive(error.kind)) requestIdRef.current = null;
    },
  };
}

function requestPublish(
  context: CommandContext,
  requestIdRef: { current: string | null },
  draft: DraftRead,
) {
  if (!requestIdRef.current) requestIdRef.current = freshId();
  const requestId = requestIdRef.current;
  const candidate = draft.candidate as NonNullable<DraftRead["candidate"]>;
  return runPublicationCommand(
    context,
    "publish",
    () =>
      context.client.publish(context.dealId, draft.id, {
        requestId,
        expectedEditRevision: draft.editRevision,
        candidateId: candidate.id,
        candidateDigest: candidate.digest,
      }),
    publishHandlers(context, requestIdRef),
  );
}

function decideDuplicateCommand(
  context: CommandContext,
  decision: "confirm" | "decline",
) {
  const publication = publicationOf(context.authoring.draft);
  if (
    !publication ||
    publication.state !== "confirmation_required" ||
    publication.assessmentDigest === null
  )
    return Promise.resolve(false);
  const assessmentDigest = publication.assessmentDigest;
  return runPublicationCommand(context, "duplicate-decision", () =>
    context.client.decideDuplicate(context.dealId, publication.id, {
      expectedRevision: publication.revision,
      assessmentDigest,
      decision,
    }),
  );
}

function replacePlacementCommand(
  context: CommandContext,
  placement: Placement,
) {
  const publication = publicationOf(context.authoring.draft);
  if (!publication || publication.state !== "needs_placement")
    return Promise.resolve(false);
  return runPublicationCommand(context, "placement", () =>
    context.client.replacePlacement(context.dealId, publication.id, {
      expectedRevision: publication.revision,
      placement,
    }),
  );
}

export type PublicationCommands = {
  publish(): Promise<boolean>;
  decideDuplicate(decision: "confirm" | "decline"): Promise<boolean>;
  replacePlacement(placement: Placement): Promise<boolean>;
  publicationCommandError: PublicationCommandError | null;
  commandInFlight: boolean;
  publicationFreeze: PublicationFreeze;
};

function usePendingKeys() {
  const [pendingKeys, setPendingKeys] = useState<Record<string, boolean>>({});
  const markPending = useCallback((key: string, pending: boolean) => {
    setPendingKeys((previous) => {
      const next = { ...previous };
      if (pending) next[key] = true;
      else delete next[key];
      return next;
    });
  }, []);
  return { pendingKeys, markPending };
}

function usePublicationPolling(authoring: SkillAuthoringDraft): void {
  const nonterminalNow = publicationNonterminal(authoring.draft);
  const refresh = authoring.refresh;
  useEffect(() => {
    if (!nonterminalNow) return undefined;
    const timer = setInterval(() => {
      void refresh();
    }, PUBLICATION_POLL_MS);
    return () => clearInterval(timer);
  }, [nonterminalNow, refresh]);
}

function usePublicationTransitionTracking(
  authoring: SkillAuthoringDraft,
  tracker: ReturnType<typeof createPublicationSuccessTracker>,
  onPublished?: (stepId: string) => void,
): void {
  const draft = authoring.draft;
  useEffect(() => {
    if (!draft) return;
    noteObservedPublicationTransition(tracker, draft, onPublished);
  }, [draft, tracker, onPublished]);
}

export function useSkillAuthoringPublication(
  dealId: string,
  authoring: SkillAuthoringDraft,
  onPublished?: (stepId: string) => void,
  suppliedClient?: PublicationOperations,
): PublicationCommands {
  const [client] = useState<PublicationOperations>(
    () => suppliedClient ?? createPublicationOperations(fetch),
  );
  const requestIdRef = useRef<string | null>(null);
  const [tracker] = useState(() => createPublicationSuccessTracker());
  const mountedRef = useRef(true);
  const [commandError, setCommandError] =
    useState<PublicationCommandError | null>(null);
  const { pendingKeys, markPending } = usePendingKeys();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  usePublicationPolling(authoring);
  usePublicationTransitionTracking(authoring, tracker, onPublished);

  const live = useCallback(() => mountedRef.current, []);

  const context: CommandContext = {
    authoring,
    client,
    dealId,
    live,
    markPending,
    setCommandError,
    tracker,
    onPublished,
  };

  const publish = async (): Promise<boolean> => {
    if (!publishAllowed(context.authoring.currentDraft())) return false;
    if (!(await context.authoring.flush())) return false;
    const draft = context.authoring.currentDraft();
    if (!publishAllowed(draft)) return false;
    return requestPublish(context, requestIdRef, draft);
  };

  const decideDuplicate = (decision: "confirm" | "decline") =>
    decideDuplicateCommand(context, decision);

  const replacePlacement = (placement: Placement) =>
    replacePlacementCommand(context, placement);

  return {
    publish,
    decideDuplicate,
    replacePlacement,
    publicationCommandError: commandError,
    commandInFlight: Object.keys(pendingKeys).length > 0,
    publicationFreeze: publicationFreeze(authoring.draft),
  };
}
