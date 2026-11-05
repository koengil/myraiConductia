'use client';

import * as React from 'react';

import { Markdown } from '@/components/atoms';
import { artifactUrl } from '@/lib/ignatious/client';
import type { RunArtifactRef } from '@/lib/ignatious/types';

/**
 * Parsing multi-megabyte markdown blocks the main thread. The largest known
 * artifact is 51 KB, so this guard costs nothing today and prevents a hang later.
 *
 * Checked twice: once against the artifact's DECLARED size, to skip the fetch
 * entirely, and again against what the control plane actually returned. The
 * declared size is metadata we do not compute, so a wrong or missing `bytes`
 * would otherwise walk the fetched body straight into the parser and undo the
 * guard. The second check measures UTF-16 code units rather than encoded
 * bytes, which is the quantity the parser's cost actually scales with.
 */
export const MAX_PREVIEW_BYTES = 1024 * 1024;

const PREVIEWABLE = /\.(md|markdown|txt)$/i;

export function pickPreviewArtifact(artifacts: RunArtifactRef[]): RunArtifactRef | null {
  return (
    artifacts.find((a) => a.primary && a.kind === 'document' && PREVIEWABLE.test(a.path)) ?? null
  );
}

/**
 * Lazy preview of the primary run artifact. `content-disposition: attachment`
 * on the artifacts route affects navigation only; fetch() ignores it, so no
 * route change is needed. Fetching on <details> open matches the disclosure
 * grammar in PresearchRunner and avoids a round trip for memos nobody expands.
 *
 * The fetched body is cached for the life of the mount. Invalidation is the
 * host's job: it keys this component on the run and artifact, so a re-run
 * mounts a fresh preview rather than re-running an effect against a stale one.
 */
export function ArtifactPreview({
  dealId,
  executionId,
  artifactIndex,
  artifact,
}: {
  dealId: string;
  executionId: string;
  /** The artifact's position in the run's artifact list: the request names it by index, not by path. */
  artifactIndex: number;
  artifact: RunArtifactRef;
}) {
  const [text, setText] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [oversize, setOversize] = React.useState<number | null>(null);
  const loaded = React.useRef(false);

  const tooLarge = oversize ?? (artifact.bytes > MAX_PREVIEW_BYTES ? artifact.bytes : null);
  if (tooLarge !== null) {
    return (
      <p className="mt-2 text-[length:var(--text-xs)] text-[color-mix(in_srgb,var(--ink-on-dark)_66%,transparent)]">
        {(tooLarge / (1024 * 1024)).toFixed(1)} MB. Too large to show inline. Open the artifact
        link above.
      </p>
    );
  }

  async function load() {
    if (loaded.current || pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(artifactUrl(dealId, executionId, artifactIndex), {
        credentials: 'include',
      });
      if (!response.ok) {
        throw new Error(
          response.status === 503
            ? 'Ignatious is not configured in this environment.'
            : `The artifact could not be loaded (${response.status}).`,
        );
      }
      const body = await response.text();
      if (body.length > MAX_PREVIEW_BYTES) {
        setOversize(body.length);
        return;
      }
      loaded.current = true;
      setText(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <details
      className="mt-2 rounded-[var(--radius-input)] border border-[var(--on-dark-stroke-12)] p-[var(--space-3)]"
      onToggle={(event) => {
        if ((event.currentTarget as HTMLDetailsElement).open) void load();
      }}
    >
      <summary className="cursor-pointer text-[length:var(--text-sm)] font-medium">
        Preview {artifact.path}
      </summary>
      {pending ? (
        <p className="mt-2 text-[length:var(--text-sm)] text-[color-mix(in_srgb,var(--ink-on-dark)_70%,transparent)]">
          Loading the brief…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[length:var(--text-sm)] text-[var(--negative)]">
          {error}
        </p>
      ) : null}
      {text ? (
        <Markdown variant="on-dark" className="mt-2 max-h-96 overflow-auto">
          {text}
        </Markdown>
      ) : null}
    </details>
  );
}

export default ArtifactPreview;
