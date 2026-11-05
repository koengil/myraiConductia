"use client";

import * as React from "react";

export type FlushedHandlers = {
  focusHandler: ((dealStepId: string) => void) | undefined;
  restoreHandler: ((dealStepId: string) => Promise<boolean>) | undefined;
  flushFailed: boolean;
  errorRef: React.RefObject<HTMLParagraphElement | null>;
};

function useFlushGuard(
  flush: () => Promise<boolean>,
  errorRef: React.RefObject<HTMLParagraphElement | null>,
  setFlushFailed: (value: boolean) => void,
): () => Promise<boolean> {
  return React.useCallback(async () => {
    setFlushFailed(false);
    const ok = await flush();
    if (!ok) {
      setFlushFailed(true);
      window.requestAnimationFrame(() => errorRef.current?.focus());
    }
    return ok;
  }, [flush, errorRef, setFlushFailed]);
}

export function useFlushedHandlers(
  flush: () => Promise<boolean>,
  onFocusStep?: (dealStepId: string) => void,
  onRestoreStep?: (dealStepId: string) => Promise<boolean>,
): FlushedHandlers {
  const [flushFailed, setFlushFailed] = React.useState(false);
  const errorRef = React.useRef<HTMLParagraphElement | null>(null);
  const guardedFlush = useFlushGuard(flush, errorRef, setFlushFailed);

  const focusHandler = onFocusStep
    ? (dealStepId: string) => {
        void guardedFlush().then((ok) => {
          if (ok) onFocusStep(dealStepId);
        });
      }
    : undefined;

  const restoreHandler = onRestoreStep
    ? async (dealStepId: string) =>
        (await guardedFlush()) ? onRestoreStep(dealStepId) : false
    : undefined;

  return { focusHandler, restoreHandler, flushFailed, errorRef };
}
