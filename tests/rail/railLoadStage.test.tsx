import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import * as React from 'react';

import { readGeneration } from '@/lib/api/inflightRead';

import {
  RAIL_LOAD_DEADLINE_MS,
  RAIL_LOAD_SLOW_MS,
  railLoadCopy,
  retryDealReads,
  useRailLoadStage,
  type RailLoadPending,
} from '@/lib/rail/railLoadStage';

/*
 * #162 Phase 3: the closed rail gate names the dependency it waits for and,
 * past the slow threshold from the local baseline, says it is still waiting.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('thresholds', () => {
  it('come from the Phase 1 record: slow 7 s, deadline three times that', () => {
    expect(RAIL_LOAD_SLOW_MS).toBe(7000);
    expect(RAIL_LOAD_DEADLINE_MS).toBe(21000);
  });
});

describe('railLoadCopy', () => {
  it('names the pending dependency, then says it is still waiting', () => {
    expect(railLoadCopy({ pending: 'deals', slow: false })).toBe('Loading your deal list…');
    expect(railLoadCopy({ pending: 'rail', slow: false })).toBe('Loading the deal rail…');
    expect(railLoadCopy({ pending: 'deals', slow: true })).toBe(
      'Still loading your deal list. This is taking longer than usual.',
    );
    expect(railLoadCopy({ pending: 'rail', slow: true })).toBe(
      'Still loading the deal rail. This is taking longer than usual.',
    );
  });
});

/** The rail's loading view in miniature: mounted while the gate is closed. */
function Gate({ pending }: { pending: RailLoadPending | null }) {
  return pending ? <Waiting pending={pending} /> : <p>ready</p>;
}
function Waiting({ pending }: { pending: RailLoadPending }) {
  const stage = useRailLoadStage(pending);
  return (
    <p role="status" aria-live="polite">
      {railLoadCopy(stage)}
    </p>
  );
}

describe('useRailLoadStage', () => {
  it('deals, then rail, then ready; the copy changes in one live region', () => {
    vi.useFakeTimers();
    const { rerender } = render(<Gate pending="deals" />);
    const region = screen.getByRole('status');
    expect(region).toHaveTextContent('Loading your deal list…');

    rerender(<Gate pending="rail" />);
    // The same node: the text changes in place, so a screen reader hears one
    // polite update, not a new region.
    expect(screen.getByRole('status')).toBe(region);
    expect(region).toHaveTextContent('Loading the deal rail…');

    rerender(<Gate pending={null} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('ready')).toBeInTheDocument();
  });

  it('flips to slow exactly at RAIL_LOAD_SLOW_MS, once, whichever dependency is pending', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ pending }) => useRailLoadStage(pending), {
      initialProps: { pending: 'deals' as RailLoadPending },
    });
    expect(result.current).toEqual({ pending: 'deals', slow: false });

    act(() => {
      vi.advanceTimersByTime(RAIL_LOAD_SLOW_MS - 1);
    });
    expect(result.current.slow).toBe(false);

    // The deal list lands; the clock is the banker's wait, not per stage.
    rerender({ pending: 'rail' });
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toEqual({ pending: 'rail', slow: true });

    act(() => {
      vi.advanceTimersByTime(RAIL_LOAD_SLOW_MS * 2);
    });
    expect(result.current).toEqual({ pending: 'rail', slow: true });
  });

  it('a new wait starts a new clock', () => {
    vi.useFakeTimers();
    const { rerender } = render(<Gate pending="rail" />);
    act(() => {
      vi.advanceTimersByTime(RAIL_LOAD_SLOW_MS);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Still loading the deal rail.');

    rerender(<Gate pending={null} />);
    rerender(<Gate pending="rail" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading the deal rail…');
  });
});

describe('retryDealReads: the one Try again refresh the rail and the shell share', () => {
  function gens(projectId: string) {
    return [
      readGeneration('deals'),
      readGeneration(`rail:${projectId}`),
      readGeneration(`step-records:${projectId}`),
      readGeneration('rail:other'),
    ];
  }

  it('on a project route: the deal list, that rail and its step records, nothing else', () => {
    const [deals, rail, records, other] = gens('MESAX-2026-462');
    retryDealReads('MESAX-2026-462');
    expect(gens('MESAX-2026-462')).toEqual([deals + 1, rail + 1, records + 1, other]);
  });

  it('off a project route: the deal list only', () => {
    const [deals, rail, records, other] = gens('MESAX-2026-462');
    retryDealReads(null);
    expect(gens('MESAX-2026-462')).toEqual([deals + 1, rail, records, other]);
  });
});
