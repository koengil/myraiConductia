import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useWarningOutcomes, WARNING_OUTCOMES_URL } from '@/components/mail/useWarningOutcomes';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubNetwork() {
  const fetcher = vi.fn(async (...call: [string, RequestInit?]) => (void call, new Response(null, { status: 204 })));
  vi.stubGlobal('fetch', fetcher);
  const beacon = vi.fn((...call: [string, BodyInit?]) => (void call, true));
  Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
  return { fetcher, beacon };
}

const sentBody = (fetcher: ReturnType<typeof stubNetwork>['fetcher']) => JSON.parse(String(fetcher.mock.calls[0][1]?.body));

describe('useWarningOutcomes', () => {
  it('reports nothing when no warning was shown', () => {
    const { fetcher } = stubNetwork();
    const { result } = renderHook(() => useWarningOutcomes());
    result.current.settle();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports each warning kind once as sent after a warning', () => {
    const { fetcher } = stubNetwork();
    const { result } = renderHook(() => useWarningOutcomes());
    result.current.noteWarning('risk_issues');
    result.current.noteWarning('risk_issues');
    result.current.noteWarning('recipient_review');
    result.current.settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(WARNING_OUTCOMES_URL);
    expect(fetcher.mock.calls[0][1]?.keepalive).toBe(true);
    expect(sentBody(fetcher)).toEqual({
      outcomes: [
        { kind: 'risk_issues', outcome: 'sent_after_warning' },
        { kind: 'recipient_review', outcome: 'sent_after_warning' },
      ],
    });
    // Settled once: a second settle has nothing left to report.
    result.current.settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  // D80 (Storm, Oct 5): no record of an email that was not sent.
  it('reports nothing when a warned draft is closed or the page is left', () => {
    const { fetcher, beacon } = stubNetwork();
    const { result, unmount } = renderHook(() => useWarningOutcomes());
    result.current.noteWarning('recipient_review');
    window.dispatchEvent(new Event('pagehide'));
    unmount();
    expect(fetcher).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
  });

  it('forgets the warnings on clear, so a later send reports nothing for a discarded draft', () => {
    const { fetcher } = stubNetwork();
    const { result } = renderHook(() => useWarningOutcomes());
    result.current.noteWarning('risk_issues');
    result.current.clear();
    result.current.settle();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('never throws when the report fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const { result } = renderHook(() => useWarningOutcomes());
    result.current.noteWarning('risk_issues');
    expect(() => result.current.settle()).not.toThrow();
  });
});
