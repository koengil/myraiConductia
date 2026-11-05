"use client";

import * as React from "react";

import { listRailTemplates } from "./client";
import type { TemplateSummary } from "./types";

export type RailTemplatesHook = {
  templates: TemplateSummary[];
  loading: boolean;
  error: string | null;
  reload: () => void;
};

export const RAIL_TEMPLATES_ERROR =
  "Your company's saved rails could not be loaded.";

export function useRailTemplates(): RailTemplatesHook {
  const [templates, setTemplates] = React.useState<TemplateSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [nonce, setNonce] = React.useState(0);

  const reload = React.useCallback(() => {
    setLoading(true);
    setError(null);
    setNonce((value) => value + 1);
  }, []);

  React.useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const loaded = await listRailTemplates("use");
        if (!active) return;
        setTemplates(loaded);
        setError(null);
      } catch {
        if (!active) return;
        setTemplates([]);
        setError(RAIL_TEMPLATES_ERROR);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [nonce]);

  return { templates, loading, error, reload };
}
