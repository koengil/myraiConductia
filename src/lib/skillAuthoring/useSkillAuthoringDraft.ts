"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createSkillAuthoringClient,
  SkillAuthoringHttpError,
  type DraftBasisRequest,
  type DraftFields,
  type SkillAuthoringClient,
} from "./client";
import type { SkillReference } from "@/lib/skillRun/types";
import type { AttemptRead, DraftRead } from "./types";

export type { DraftFields } from "./client";
export type LocalDraft = DraftRead;

const FIELDS = ["name", "placement", "composerText"] as const;
type Field = (typeof FIELDS)[number];

export type OpenedBasis = {
  basis: SkillReference | null;
  seedRunId: string | null;
};

export type SkillAuthoringDraft = {
  status: "loading" | "ready" | "forbidden" | "error";
  draft: LocalDraft | null;
  currentDraft: () => LocalDraft | null;
  openedBasis: OpenedBasis | null;
  saveState: "saved" | "saving" | "error";
  sending: boolean;
  updateFields: (fields: DraftFields) => void;
  send: () => Promise<boolean>;
  retry: (messageId: string) => Promise<void>;
  discard: () => Promise<boolean>;
  flush: () => Promise<boolean>;
  refresh: () => Promise<void>;
  replaceDraft: (next: DraftRead) => void;
};

export function nonterminal(
  attempt: { status: string } | null | undefined,
): boolean {
  return attempt?.status === "running";
}

export function freshId(): string {
  return crypto.randomUUID();
}

function fieldEquals(
  field: Field,
  draft: DraftRead,
  snapshot: DraftFields,
): boolean {
  if (field === "placement") {
    return (
      JSON.stringify(draft.placement) ===
      JSON.stringify(snapshot.placement ?? null)
    );
  }
  return draft[field] === snapshot[field];
}

function applyField(target: DraftRead, field: Field, source: DraftRead): void {
  if (field === "name") target.name = source.name;
  else if (field === "placement") target.placement = source.placement;
  else target.composerText = source.composerText;
}

function isForbidden(error: unknown): boolean {
  return error instanceof SkillAuthoringHttpError && error.status === 403;
}

type SaveOutcome = "saved" | "retry-conflict" | "error";

export function useSkillAuthoringDraft(
  projectId: string,
  suppliedClient?: SkillAuthoringClient,
  requestedBasis?: DraftBasisRequest,
  onSent?: () => void,
): SkillAuthoringDraft {
  const [client] = useState<SkillAuthoringClient>(
    () => suppliedClient ?? createSkillAuthoringClient(),
  );
  const [status, setStatus] =
    useState<SkillAuthoringDraft["status"]>("loading");
  const [draft, setDraft] = useState<DraftRead | null>(null);
  const [openedBasis, setOpenedBasis] = useState<OpenedBasis | null>(null);
  const [saveState, setSaveState] =
    useState<SkillAuthoringDraft["saveState"]>("saved");
  const [sending, setSending] = useState(false);

  const draftRef = useRef<DraftRead | null>(null);
  const dirtyRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushPromiseRef = useRef<Promise<boolean> | null>(null);
  const sendingRef = useRef(false);
  const forbiddenPollsRef = useRef(0);

  const currentDraft = useCallback(() => draftRef.current, []);

  const replaceDraft = useCallback((next: DraftRead) => {
    const localCurrent = draftRef.current;
    let merged = next;
    if (dirtyRef.current && localCurrent) {
      merged = { ...next };
      for (const field of FIELDS) applyField(merged, field, localCurrent);
    }
    draftRef.current = merged;
    setDraft(merged);
  }, []);

  const settle = useCallback(
    (serverDraft: DraftRead, snapshot: DraftFields, isConflict: boolean) => {
      const localCurrent = draftRef.current;
      const overlay = new Set<Field>();
      for (const field of FIELDS) {
        if (isConflict) {
          overlay.add(field);
          continue;
        }
        if (localCurrent && !fieldEquals(field, localCurrent, snapshot))
          overlay.add(field);
      }
      const merged: DraftRead = { ...serverDraft };
      const source = localCurrent ?? serverDraft;
      for (const field of overlay) applyField(merged, field, source);
      draftRef.current = merged;
      setDraft(merged);
      dirtyRef.current = overlay.size > 0;
      setSaveState(dirtyRef.current ? "saving" : "saved");
    },
    [],
  );

  const performOneSave = useCallback(
    async (allowConflictRetry: boolean): Promise<SaveOutcome> => {
      const current = draftRef.current;
      if (!current) return "error";
      const snapshot: DraftFields = {
        name: current.name,
        placement: current.placement,
        composerText: current.composerText,
      };
      try {
        const saved = await client.patch(projectId, current.id, {
          expectedEditRevision: current.editRevision,
          ...snapshot,
        });
        settle(saved, snapshot, false);
        return "saved";
      } catch (error) {
        if (
          error instanceof SkillAuthoringHttpError &&
          error.status === 409 &&
          error.draft &&
          allowConflictRetry
        ) {
          settle(error.draft, snapshot, true);
          return "retry-conflict";
        }
        setSaveState("error");
        return "error";
      }
    },
    [client, projectId, settle],
  );

  const flush = useCallback((): Promise<boolean> => {
    if (flushPromiseRef.current) return flushPromiseRef.current;
    if (!dirtyRef.current) return Promise.resolve(true);
    const promise = (async () => {
      let conflictRetryUsed = false;
      while (dirtyRef.current) {
        const outcome = await performOneSave(!conflictRetryUsed);
        if (outcome === "error") return false;
        conflictRetryUsed = outcome === "retry-conflict";
      }
      return true;
    })().finally(() => {
      flushPromiseRef.current = null;
    });
    flushPromiseRef.current = promise;
    return promise;
  }, [performOneSave]);

  const updateFields = useCallback(
    (fields: DraftFields) => {
      const current = draftRef.current;
      if (!current) return;
      const next = { ...current, ...fields };
      draftRef.current = next;
      setDraft(next);
      dirtyRef.current = true;
      setSaveState("saving");
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        void flush();
      }, 500);
    },
    [flush],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const current = draftRef.current;
    if (!current) return;
    try {
      const latest = await client.read(projectId, current.id);
      replaceDraft(latest);
      setStatus("ready");
    } catch (error) {
      if (isForbidden(error)) setStatus("forbidden");
    }
  }, [client, projectId, replaceDraft]);

  const send = useCallback(async (): Promise<boolean> => {
    if (sendingRef.current) return false;
    sendingRef.current = true;
    setSending(true);
    try {
      const flushed = await flush();
      if (!flushed) return false;
      const current = draftRef.current;
      if (!current || current.composerText.trim().length === 0) return false;
      const text = current.composerText;
      const clientMessageId = freshId();
      try {
        await client.send(projectId, current.id, {
          clientMessageId,
          expectedEditRevision: current.editRevision,
          text,
        });
      } catch {
        return false;
      }
      onSent?.();
      const latest = draftRef.current ?? current;
      const cleared = {
        ...latest,
        composerText: latest.composerText === text ? "" : latest.composerText,
      };
      draftRef.current = cleared;
      setDraft(cleared);
      await refresh();
      return true;
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [flush, client, projectId, refresh, onSent]);

  const retry = useCallback(
    async (messageId: string): Promise<void> => {
      const current = draftRef.current;
      if (!current) return;
      const retryRequestId = freshId();
      try {
        await client.retry(projectId, current.id, messageId, {
          retryRequestId,
        });
      } catch {
        return;
      }
      await refresh();
    },
    [client, projectId, refresh],
  );

  const discard = useCallback(async (): Promise<boolean> => {
    const flushed = await flush();
    if (!flushed) return false;
    const current = draftRef.current;
    if (!current) return false;
    try {
      await client.discard(projectId, current.id, current.editRevision);
      return true;
    } catch {
      return false;
    }
  }, [flush, client, projectId]);

  const basisStepId = requestedBasis?.basisStepId;
  const requestedSeedRunId = requestedBasis?.seedRunId;
  const requestedTeach = requestedBasis?.teach;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const opened = await client.open(projectId, {
          ...(basisStepId ? { basisStepId } : {}),
          ...(requestedSeedRunId ? { seedRunId: requestedSeedRunId } : {}),
          ...(requestedTeach ? { teach: true } : {}),
        });
        if (!alive) return;
        draftRef.current = opened.draft;
        dirtyRef.current = false;
        setDraft(opened.draft);
        setOpenedBasis({ basis: opened.basis, seedRunId: opened.seedRunId });
        setSaveState("saved");
        setStatus("ready");
      } catch (error) {
        if (!alive) return;
        setStatus(isForbidden(error) ? "forbidden" : "error");
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, projectId, basisStepId, requestedSeedRunId, requestedTeach]);

  const draftId = draft?.id ?? null;
  const hasActiveAttempt = draft ? nonterminal(draft.activeAttempt) : false;

  useEffect(() => {
    if (!draftId || status !== "ready") return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const scheduleNext = () => {
      const activeAttempt: AttemptRead | null =
        draftRef.current?.activeAttempt ?? null;
      const delay = nonterminal(activeAttempt) ? 1000 : 10000;
      timer = setTimeout(tick, delay);
    };

    const tick = async () => {
      if (cancelled) return;
      const id = draftRef.current?.id;
      if (!id) return;
      try {
        const latest = await client.read(projectId, id);
        if (cancelled) return;
        forbiddenPollsRef.current = 0;
        replaceDraft(latest);
      } catch (error) {
        if (cancelled) return;
        if (isForbidden(error)) {
          forbiddenPollsRef.current += 1;
          if (forbiddenPollsRef.current >= 2) {
            setStatus("forbidden");
            cancelled = true;
            return;
          }
        }
      }
      if (!cancelled) scheduleNext();
    };

    scheduleNext();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [draftId, hasActiveAttempt, status, client, projectId, replaceDraft]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return {
    status,
    draft,
    currentDraft,
    openedBasis,
    saveState,
    sending,
    updateFields,
    send,
    retry,
    discard,
    flush,
    refresh,
    replaceDraft,
  };
}
