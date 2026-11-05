"use client";

import * as React from "react";

import { RailTemplateRequestError, saveRail } from "./client";
import type { SaveRailCommand, TemplateSummary } from "./types";

export type SaveRailState =
  | "editing"
  | "saving"
  | "retryable"
  | "saved"
  | "conflict";

export type SaveRailHook = {
  state: SaveRailState;
  error: string | null;
  summary: TemplateSummary | null;
  save: (command: SaveRailCommand) => Promise<void>;
};

type SaveRailStatus = Pick<SaveRailHook, "state" | "error" | "summary">;

const EDITING: SaveRailStatus = { state: "editing", error: null, summary: null };
const UNSAVED = "This rail could not be saved.";

function sameSave(a: SaveRailCommand, b: SaveRailCommand): boolean {
  return (
    a.sourceDealId === b.sourceDealId &&
    a.description === b.description &&
    JSON.stringify(a.target) === JSON.stringify(b.target)
  );
}

function outcomeOf(error: unknown): SaveRailStatus {
  const failure = error instanceof RailTemplateRequestError ? error : null;
  const message = failure === null ? UNSAVED : failure.message;
  if (failure === null || failure.retryable) {
    return { state: "retryable", error: message, summary: null };
  }
  if (failure.code === "stale_template") {
    return { state: "conflict", error: message, summary: null };
  }
  return { state: "editing", error: message, summary: null };
}

export function useSaveRail(): SaveRailHook {
  const [status, setStatus] = React.useState<SaveRailStatus>(EDITING);
  const unsettledRef = React.useRef<SaveRailCommand | null>(null);

  const save = React.useCallback(async (command: SaveRailCommand) => {
    const unsettled = unsettledRef.current;
    const sent =
      unsettled !== null && sameSave(unsettled, command)
        ? { ...command, requestId: unsettled.requestId }
        : command;
    setStatus({ state: "saving", error: null, summary: null });
    try {
      const summary = await saveRail(sent);
      unsettledRef.current = null;
      setStatus({ state: "saved", error: null, summary });
    } catch (error) {
      const next = outcomeOf(error);
      unsettledRef.current = next.state === "retryable" ? sent : null;
      setStatus(next);
    }
  }, []);

  return { ...status, save };
}
