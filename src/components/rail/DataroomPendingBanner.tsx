"use client";

import * as React from "react";

import { Button } from "@/components/atoms/Button";

type Phase = "pending" | "retrying" | "failed" | "ready";

const COPY: Record<Phase, { label: string; body: string }> = {
  pending: {
    label: "Data room pending",
    body: "The Box folders for this deal were not created. Uploads to its data rooms fail until setup completes.",
  },
  retrying: {
    label: "Data room pending",
    body: "Setting up the Box folders for this deal.",
  },
  failed: {
    label: "Data room pending",
    body: "Setup did not complete. Box may be unavailable. Try again in a few minutes.",
  },
  ready: {
    label: "Data room ready",
    body: "The Box folders for this deal are in place.",
  },
};

function dataroomUrl(dealCode: string): string {
  return `/api/v1/deals/${encodeURIComponent(dealCode)}/dataroom`;
}

async function readStatus(dealCode: string): Promise<string | null> {
  const response = await fetch(dataroomUrl(dealCode), {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { status?: unknown };
  return typeof body.status === "string" ? body.status : null;
}

export function DataroomPendingBanner({ dealCode }: { dealCode: string }) {
  const [shown, setShown] = React.useState<{ dealCode: string; phase: Phase } | null>(null);
  const inFlight = React.useRef(false);

  React.useEffect(() => {
    let active = true;
    readStatus(dealCode)
      .catch(() => null)
      .then((status) => {
        if (active && status === "pending") setShown({ dealCode, phase: "pending" });
      });
    return () => {
      active = false;
    };
  }, [dealCode]);

  const retry = React.useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setShown({ dealCode, phase: "retrying" });
    try {
      const response = await fetch(dataroomUrl(dealCode), {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      setShown({ dealCode, phase: response.ok ? "ready" : "failed" });
    } catch {
      setShown({ dealCode, phase: "failed" });
    } finally {
      inFlight.current = false;
    }
  }, [dealCode]);

  if (!shown || shown.dealCode !== dealCode) return null;
  const { label, body } = COPY[shown.phase];

  return (
    <div
      role="status"
      aria-label={label}
      className="mb-[var(--space-4)] flex flex-wrap items-center justify-between gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface-raised)] px-[var(--space-4)] py-[var(--space-3)]"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-mono text-[length:var(--text-xs)] uppercase tracking-[0.04em] text-[var(--ink-tertiary)]">
          {label}
        </p>
        <p className="text-[length:var(--text-sm)] text-[var(--ink)]">{body}</p>
      </div>
      {shown.phase === "ready" ? null : (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void retry()}
          disabled={shown.phase === "retrying"}
        >
          {shown.phase === "retrying" ? "Retrying setup" : "Retry setup"}
        </Button>
      )}
    </div>
  );
}
