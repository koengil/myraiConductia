'use client';

import * as React from 'react';

import { getApi } from '@/lib/api';
import { useProjectId } from '@/lib/project/useProjectId';
import type {
  CultureFaultline,
  CultureFaultlineClass,
  CultureMatrix,
} from '@/lib/api/types';
import { Badge, Card } from '@/components/atoms';

/**
 * Culture matrix — Bain four-fault-lines panel for the `/acquirers/[id]`
 * deep-dive (Phase D of the sandbox merge, 2026-05-20). Ported from
 * `intelibank-sandbox/components/scenes/CultureClient.tsx`.
 *
 * Scope decision (Phase D): the sandbox version exposes a Salesforce ↔
 * Anthropic toggle that switched the matrix between two acquirer readings on
 * one surface. In A's platform model `/acquirers/[id]` already scopes to a
 * single acquirer per route, so the toggle is dropped here and the panel
 * renders only the current acquirer's reading. A future polish phase may
 * restore inline cross-acquirer comparison; out of scope for Phase D.
 *
 * Self-fetching: mounts, calls `getApi().getCultureMatrix(acquirerId)`, and
 * manages a `loading | ready | error` state with the same unmount-safe
 * `active` flag the `/acquirers/[id]` route uses. A `reqToken` ref also
 * guards against late responses when `acquirerId` changes mid-flight — the
 * acquirer switcher in the chrome above can realistically navigate before a
 * previous fetch resolves, and a stale response must not paint over the
 * newer one.
 *
 * Verdict pill tone mapping (CultureFaultlineClass → Badge tone):
 *   strong → positive   watch → hold   risk → negative
 *
 * Loading state: 4 skeleton fault-line cards mirroring the ready-state
 * structure (heading slot, pill slot, body lines, footer line) so the panel
 * does not pop into a different layout.
 *
 * Visible prose is em-dash-free per the brand voice; en-dashes are reserved
 * for numerical ranges (none in this panel).
 */

type LoadState = 'loading' | 'ready' | 'error';

export type CultureMatrixPanelProps = {
  acquirerId: string;
};

const VERDICT_TONE: Record<
  CultureFaultlineClass,
  'positive' | 'hold' | 'negative'
> = {
  strong: 'positive',
  watch: 'hold',
  risk: 'negative',
};

function FaultlineCard({ f }: { f: CultureFaultline }) {
  return (
    <Card aria-label={`Fault line: ${f.name}`}>
      <div className="flex flex-col gap-[var(--space-4)]">
        <div className="flex flex-wrap items-start justify-between gap-[var(--space-3)]">
          <h4 className="font-sans text-[length:var(--text-lg)] font-semibold leading-tight text-[var(--ink)]">
            {f.name}
          </h4>
          <Badge tone={VERDICT_TONE[f.vClass]}>{f.verdict}</Badge>
        </div>

        <p className="font-sans text-[length:var(--text-sm)] leading-relaxed text-[var(--ink)]">
          {f.desc}
        </p>

        <p className="border-t border-[var(--stroke)] pt-[var(--space-3)] font-mono text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
          {f.signal}
        </p>
      </div>
    </Card>
  );
}

function FaultlineSkeleton({ i }: { i: number }) {
  return (
    <Card aria-busy="true" aria-label={`Fault line ${i + 1} loading`}>
      <div className="flex flex-col gap-[var(--space-4)]">
        <div className="flex flex-wrap items-start justify-between gap-[var(--space-3)]">
          <span className="font-sans text-[length:var(--text-lg)] font-semibold leading-tight text-[var(--ink-quiet)]">
            …
          </span>
          <span className="inline-flex h-[20px] w-[64px] items-center rounded-[var(--radius-control)] bg-[var(--surface-subtle)]" />
        </div>
        <span className="block h-[12px] w-full rounded-[var(--radius-control)] bg-[var(--surface-subtle)]" />
        <span className="block h-[12px] w-3/4 rounded-[var(--radius-control)] bg-[var(--surface-subtle)]" />
        <span className="mt-[var(--space-1)] block h-[10px] w-1/2 rounded-[var(--radius-control)] bg-[var(--surface-subtle)]" />
      </div>
    </Card>
  );
}

export function CultureMatrixPanel({ acquirerId }: CultureMatrixPanelProps) {
  const dealId = useProjectId();
  const [matrix, setMatrix] = React.useState<CultureMatrix | null>(null);
  const [loadState, setLoadState] = React.useState<LoadState>('loading');

  // reqToken guards against late responses when acquirerId changes mid-flight:
  // increment on every effect run, capture into a local, and drop any response
  // whose token no longer matches the latest. Pattern carried from the
  // sandbox CultureClient where acquirer-switching could realistically race.
  const reqToken = React.useRef(0);

  // React-docs "adjusting state when a prop changes" pattern — set
  // loadState/matrix back to the initial loading state when acquirerId
  // changes, during render rather than inside an effect (avoids the
  // setState-in-effect cascade lint and saves a re-render).
  const [loadingAcquirerId, setLoadingAcquirerId] =
    React.useState<string>(acquirerId);
  if (loadingAcquirerId !== acquirerId) {
    setLoadingAcquirerId(acquirerId);
    setLoadState('loading');
    setMatrix(null);
  }

  React.useEffect(() => {
    let active = true;
    const myToken = ++reqToken.current;
    const api = getApi();

    async function load() {
      try {
        const m = await api.getCultureMatrix(dealId, acquirerId);
        if (!active || myToken !== reqToken.current) return;
        setMatrix(m);
        setLoadState('ready');
      } catch (err) {
        if (!active || myToken !== reqToken.current) return;
        console.error(
          '[CultureMatrixPanel] failed to load culture matrix',
          { err, acquirerId },
        );
        setLoadState('error');
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [dealId, acquirerId]);

  const titleName = matrix?.acquirerName ?? '…';

  return (
    <Card aria-label="Culture matrix">
      <div className="flex flex-col gap-[var(--space-1)]">
        <span className="eyebrow">
          Cultural alignment · Bain fault lines
        </span>
        <h3 className="display-1 text-[var(--ink)]">
          Culture matrix · {titleName}
        </h3>
        <p className="font-sans text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          Where the two cultures clash, read on four proven fault lines.
        </p>
      </div>

      {loadState === 'error' ? (
        <p
          role="status"
          className="mt-[var(--space-6)] font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
        >
          The culture matrix could not be loaded right now.
        </p>
      ) : null}

      {loadState === 'loading' ? (
        <div
          className="mt-[var(--space-6)] grid grid-cols-1 gap-[var(--space-5)] md:grid-cols-2"
          aria-live="polite"
        >
          {Array.from({ length: 4 }).map((_, i) => (
            <FaultlineSkeleton key={`skel-${i}`} i={i} />
          ))}
        </div>
      ) : null}

      {loadState === 'ready' && matrix ? (
        <div className="mt-[var(--space-6)] grid grid-cols-1 gap-[var(--space-5)] md:grid-cols-2">
          {matrix.faultlines.map((f) => (
            <FaultlineCard key={f.name} f={f} />
          ))}
        </div>
      ) : null}
    </Card>
  );
}

export default CultureMatrixPanel;
