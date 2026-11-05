import { describe, expect, it } from 'vitest';

import { acceptStates } from '@/lib/discovery/propose/read';

/** An accept request as the list reads it. */
const accept = (over: Partial<Parameters<typeof acceptStates>[0][number]> = {}) => ({
  deal_key: 'm:project-heron',
  state: 'pending',
  email_count: 3,
  failure_code: null as string | null,
  requested_at: '2026-10-23T10:00:00+00:00',
  ...over,
});

describe('acceptStates (G-02b, #173)', () => {
  it('is empty when nothing was asked', () => {
    expect(acceptStates([]).size).toBe(0);
  });

  it.each(['pending', 'running', 'storing', 'stored'])('reads a %s request as pending, with its emails', (state) => {
    expect(acceptStates([accept({ state })]).get('m:project-heron')).toEqual({ state: 'pending', requested: 3 });
  });

  it('sums the emails of the live requests of a key, one per source', () => {
    const states = acceptStates([accept({ email_count: 3 }), accept({ state: 'running', email_count: 2 })]);
    expect(states.get('m:project-heron')).toEqual({ state: 'pending', requested: 5 });
  });

  it('reads a failed request with its fixed code', () => {
    for (const code of ['none_readable', 'source_unavailable', 'candidate_closed', 'error']) {
      expect(acceptStates([accept({ state: 'failed', failure_code: code })]).get('m:project-heron')).toEqual({
        state: 'failed',
        code,
      });
    }
  });

  it('reads a code it does not know as error, and never passes it on', () => {
    const state = acceptStates([accept({ state: 'failed', failure_code: 'm:project-heron leaked' })]).get('m:project-heron');
    expect(state).toEqual({ state: 'failed', code: 'error' });
  });

  it('shows the newest failed request, whatever the row order', () => {
    const older = accept({ state: 'failed', failure_code: 'none_readable', requested_at: '2026-10-22T10:00:00+00:00' });
    const newer = accept({ state: 'failed', failure_code: 'source_unavailable', requested_at: '2026-10-23T10:00:00+00:00' });
    for (const rows of [[older, newer], [newer, older]]) {
      expect(acceptStates(rows).get('m:project-heron')).toEqual({ state: 'failed', code: 'source_unavailable' });
    }
  });

  it('shows pending over a failed request of another source of the same key', () => {
    const states = acceptStates([accept({ state: 'failed', failure_code: 'error' }), accept({ state: 'pending' })]);
    expect(states.get('m:project-heron')).toEqual({ state: 'pending', requested: 3 });
  });

  it('keeps each key apart, and ignores a done request', () => {
    const states = acceptStates([
      accept({ deal_key: 'm:project-wren', state: 'failed', failure_code: 'error' }),
      accept({ state: 'done' }),
    ]);
    expect(states.get('m:project-wren')).toEqual({ state: 'failed', code: 'error' });
    expect(states.has('m:project-heron')).toBe(false);
  });
});
