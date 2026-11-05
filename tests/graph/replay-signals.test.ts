// @vitest-environment node
import { EventEmitter } from 'node:events';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { withActiveReplayRegistration } from '../../scripts/m365/replay-discovery';

const TENANT = '11111111-1111-4111-8111-111111111111';

/**
 * A stand-in for the one query replay-discovery makes on the registration:
 * from(table).update({status}).eq('tenant_id').eq('ms_tenant_id').select('tenant_id'). Every status written is
 * logged in order, together with the events the test adds (`exit`), so the order is what is asserted.
 */
function fakeDb(log: string[], options: { failStatus?: string; held?: () => Promise<void> } = {}) {
  return {
    from: (table: string) => ({
      // The read-back the cleanup after a failed activation makes: this stand-in's registration is never active.
      select: () => {
        const read = { eq: () => read, abortSignal: () => read, maybeSingle: async () => ({ data: { status: 'disabled' }, error: null }) };
        return read;
      },
      update: (values: { status: string }) => {
        const chain = {
          eq: () => chain,
          abortSignal: () => chain,
          select: async () => {
            if (values.status === 'active') await options.held?.();
            log.push(`${table}:${values.status}`);
            if (values.status === options.failStatus) return { data: null, error: { message: 'boom' } };
            return { data: [{ tenant_id: TENANT }], error: null };
          },
        };
        return chain;
      },
    }),
  } as unknown as SupabaseClient;
}

const listeners = (signals: EventEmitter) => signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM');

afterEach(() => vi.restoreAllMocks());

describe('withActiveReplayRegistration: signals while the replay registration is active', () => {
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ])('%s sets it back to disabled, then exits %i', async (signal, code) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log: string[] = [];
    const signals = new EventEmitter();
    const exited = new Promise<number>((resolve) => {
      const exit = (c: number) => {
        log.push(`exit:${c}`);
        resolve(c);
      };
      // The work never finishes: the process is killed in the middle of the runs.
      void withActiveReplayRegistration(
        fakeDb(log),
        TENANT,
        () => {
          expect(listeners(signals)).toBe(2); // installed while it is active
          signals.emit(signal);
          signals.emit(signal); // a second signal does not disable, or exit, twice
          return new Promise<never>(() => undefined);
        },
        { signals, exit },
      );
    });
    expect(await exited).toBe(code);
    expect(log).toEqual(['graph_reader_registrations:active', 'graph_reader_registrations:disabled', `exit:${code}`]);
  });

  it('a signal that lands while the activation is in flight disables after it, never before', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log: string[] = [];
    const signals = new EventEmitter();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const exited = new Promise<number>((resolve) => {
      void withActiveReplayRegistration(fakeDb(log, { held: () => held }), TENANT, () => new Promise<never>(() => undefined), {
        signals,
        exit: (c) => {
          log.push(`exit:${c}`);
          resolve(c);
        },
      });
    });
    signals.emit('SIGTERM'); // the activation is still waiting on the database
    expect(log).toEqual([]);
    release();
    expect(await exited).toBe(143);
    expect(log).toEqual(['graph_reader_registrations:active', 'graph_reader_registrations:disabled', 'exit:143']);
  });

  it('exits with the signal code even when the registration cannot be disabled, and says how to fix it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log: string[] = [];
    const signals = new EventEmitter();
    const exited = new Promise<number>((resolve) => {
      void withActiveReplayRegistration(
        fakeDb(log, { failStatus: 'disabled' }),
        TENANT,
        () => {
          signals.emit('SIGINT');
          return new Promise<never>(() => undefined);
        },
        { signals, exit: resolve },
      );
    });
    expect(await exited).toBe(130);
    expect(error.mock.calls.flat().join('\n')).toContain('README.md');
    expect(error.mock.calls.flat().join('\n')).not.toContain(TENANT);
  });

  it('removes its handlers when the work finishes, fails, or the activation fails', async () => {
    const signals = new EventEmitter();
    const exit = vi.fn();

    await expect(withActiveReplayRegistration(fakeDb([]), TENANT, async () => 'done', { signals, exit })).resolves.toBe('done');
    expect(listeners(signals)).toBe(0);

    const log: string[] = [];
    await expect(
      withActiveReplayRegistration(fakeDb(log), TENANT, async () => Promise.reject(new Error('the run failed')), { signals, exit }),
    ).rejects.toThrow('the run failed');
    expect(listeners(signals)).toBe(0);
    expect(log).toEqual(['graph_reader_registrations:active', 'graph_reader_registrations:disabled']); // still paused

    await expect(
      withActiveReplayRegistration(fakeDb([], { failStatus: 'active' }), TENANT, async () => 'x', { signals, exit }),
    ).rejects.toThrow(/registration active failed/);
    expect(listeners(signals)).toBe(0);
    expect(exit).not.toHaveBeenCalled();
  });

  it('does not touch the real process listeners unless it is asked to', async () => {
    const before = process.listenerCount('SIGINT') + process.listenerCount('SIGTERM');
    await withActiveReplayRegistration(fakeDb([]), TENANT, async () => {
      expect(process.listenerCount('SIGINT') + process.listenerCount('SIGTERM')).toBe(before + 2); // the default source is process
    });
    expect(process.listenerCount('SIGINT') + process.listenerCount('SIGTERM')).toBe(before);
  });
});
