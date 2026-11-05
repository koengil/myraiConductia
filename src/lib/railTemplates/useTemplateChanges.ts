"use client";

import * as React from "react";

import { useFlag } from "@/lib/flags/FlagsContext";

import {
  SKILL_STEP_NOT_ADDED,
  pendingChanges,
  type TemplateChange,
  type TemplateChangeDecision,
  type TemplateChangeSet,
} from "./changeReview";

const STALE_TEXT =
  "The template or this decision changed. The list now shows the latest state.";
const FAILED_TEXT = "The decision could not be saved. Try again.";

async function refusedSentence(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return null;
    const { code, error } = body as { code?: unknown; error?: unknown };
    return code === SKILL_STEP_NOT_ADDED && typeof error === "string" && error !== ""
      ? error
      : null;
  } catch {
    return null;
  }
}

export type TemplateChangesState = {
  changeSet: TemplateChangeSet | null;
  pending: TemplateChange[];
  busy: boolean;
  error: string | null;
  decide: (changeId: string, decision: TemplateChangeDecision) => Promise<void>;
  reopen: (changeId: string) => Promise<void>;
  refresh: () => Promise<void>;
};

type Loaded = { projectId: string; changeSet: TemplateChangeSet | null };

function changesUrl(projectId: string): string {
  return `/api/v1/deals/${encodeURIComponent(projectId)}/rail/template-changes`;
}

function decisionUrl(projectId: string, changeId: string): string {
  return `${changesUrl(projectId)}/${encodeURIComponent(changeId)}/decision`;
}

async function changeSetFrom(response: Response): Promise<TemplateChangeSet | null> {
  const body = (await response.json()) as { changeSet?: TemplateChangeSet | null };
  return body.changeSet ?? null;
}

export function useTemplateChanges(
  projectId: string,
  options: { onApplied?: () => void } = {},
): TemplateChangesState {
  const enabled = useFlag("template_change_review");
  const { onApplied } = options;
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const read = React.useCallback(async (): Promise<TemplateChangeSet | null> => {
    const response = await fetch(changesUrl(projectId), {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    return response.ok ? changeSetFrom(response) : null;
  }, [projectId]);

  React.useEffect(() => {
    if (!enabled) return;
    let active = true;
    read().then(
      (changeSet) => {
        if (active) setLoaded({ projectId, changeSet });
      },
      () => {
        if (active) setLoaded({ projectId, changeSet: null });
      },
    );
    return () => {
      active = false;
    };
  }, [enabled, projectId, read]);

  const send = React.useCallback(
    async (changeId: string, init: RequestInit) => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(decisionUrl(projectId, changeId), {
          credentials: "include",
          ...init,
        });
        if (response.ok) {
          setLoaded({ projectId, changeSet: await changeSetFrom(response) });
          onApplied?.();
          return;
        }
        const sentence = await refusedSentence(response);
        if (sentence) {
          setError(sentence);
          return;
        }
        if (response.status === 409) {
          setError(STALE_TEXT);
          setLoaded({ projectId, changeSet: await read() });
          onApplied?.();
          return;
        }
        setError(FAILED_TEXT);
      } catch {
        setError(FAILED_TEXT);
      } finally {
        setBusy(false);
      }
    },
    [projectId, read, onApplied],
  );

  const changeSet =
    enabled && loaded?.projectId === projectId ? loaded.changeSet : null;
  const revisionId = changeSet?.currentRevision.id ?? null;

  const decide = React.useCallback(
    async (changeId: string, decision: TemplateChangeDecision) => {
      if (!revisionId) return;
      await send(changeId, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, revisionId }),
      });
    },
    [send, revisionId],
  );

  const reopen = React.useCallback(
    (changeId: string) => send(changeId, { method: "DELETE" }),
    [send],
  );

  const refresh = React.useCallback(async () => {
    if (!enabled) return;
    try {
      setLoaded({ projectId, changeSet: await read() });
    } catch {
      setLoaded({ projectId, changeSet: null });
    }
  }, [enabled, projectId, read]);

  const pending = React.useMemo(
    () => (changeSet ? pendingChanges(changeSet) : []),
    [changeSet],
  );

  return { changeSet, pending, busy, error, decide, reopen, refresh };
}
