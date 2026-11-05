import { describe, expect, it, vi } from 'vitest';

import {
  PROBES,
  ProbeError,
  main,
  probeExit,
  probeLine,
  proposeRunCode,
  removeTeamInbox,
  type ProbeLine,
} from '../../scripts/rehearsal/probes';

// #173 phase 1: a probe prints one JSON line of integers and fixed codes. The printer is the redaction boundary.

const line = (fields: Record<string, unknown>) => ({ probe: 'index', ...fields }) as unknown as ProbeLine;
const SHA = '953e0692e0b5175a7436e3810782f649bd4f8a72';

describe('probeLine (only integers and [a-z_]+ codes reach the terminal)', () => {
  it('prints one JSON line with the probe first', () => {
    expect(probeLine(line({ rows: 16, hmac: 16 }))).toBe('{"probe":"index","rows":16,"hmac":16}');
    expect(probeLine({ probe: 'remove', status: 409, code: 'not_removable' })).toBe('{"probe":"remove","status":409,"code":"not_removable"}');
    expect(probeLine({ probe: 'health', code: 'up_to_date', waitingFor: 'none' })).not.toContain('\n');
  });

  it('knows every probe the wrapper can name', () => {
    expect(PROBES).toEqual(['index', 'window', 'remove', 'propose-recorded', 'health']);
    for (const probe of PROBES) expect(() => probeLine({ probe, code: 'ok' })).not.toThrow();
    expect(() => probeLine(line({ probe: 'dump' }))).toThrow('probeLine: unknown probe');
  });

  it.each([
    ['zero', 0],
    ['a count', 271],
    ['a negative delta', -3],
  ])('accepts an integer: %s', (_, value) => {
    expect(() => probeLine(line({ n: value }))).not.toThrow();
  });

  it.each([
    ['a fraction', 0.5],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['an unsafe integer', 2 ** 60],
    ['an empty string', ''],
    ['a subject', 'Project Kestrel: teaser'],
    ['an address', 'deals@bank.example'],
    ['a name', 'Storm Duncan'],
    ['a code with digits', 'lexicon_7'],
    ['an uppercase code', 'Not_Removable'],
    ['a code with a dash', 'not-removable'],
    ['a code with a newline', 'ok\nleak'],
    ['a boolean', true],
    ['null', null],
    ['an object', { code: 'ok' }],
    ['an array', [1, 2]],
  ])('refuses %s, naming the key and never the value', (_, value) => {
    let message = '';
    try {
      probeLine(line({ field: value }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('probeLine: field is not an integer or a code');
  });

  it('accepts a 40-hex commit id under the key sha, and nowhere else', () => {
    expect(probeLine({ probe: 'propose-recorded', code: 'ran', sha: SHA })).toContain(`"sha":"${SHA}"`);
    expect(() => probeLine({ probe: 'propose-recorded', code: SHA })).toThrow('probeLine: code is not an integer or a code');
    expect(() => probeLine({ probe: 'propose-recorded', sha: SHA.slice(0, 8) })).toThrow('probeLine: sha is not an integer or a code');
    expect(() => probeLine({ probe: 'propose-recorded', sha: 'deals@bank.example' })).toThrow('probeLine: sha is not an integer or a code');
  });

  it('refuses a key that is not a plain name', () => {
    expect(() => probeLine(line({ 'deals@bank.example': 1 }))).toThrow('probeLine: a key is not a plain name');
    expect(() => probeLine(line({ 'Project Kestrel': 1 }))).toThrow('probeLine: a key is not a plain name');
  });
});

describe('proposeRunCode (the worker\'s summary line as a code; its text is never printed)', () => {
  it.each([
    ['a run', 0, 'Tenant t: read 81 items ... Run r. Proposed: called 12, deal 3, new names 1, not deal 8, failed 0, invalid 1, cost $0.0000.', 'ran', 12],
    ['a refused run', 0, 'Tenant t: propose refused (flag_off).', 'flag_off', 0],
    ['a skipped tenant', 0, 'Tenant t: skipped (no_registration).', 'no_registration', 0],
    ['a ZDR stop', 1, 'Proposed: called 1, deal 0, new names 0, not deal 0, failed 1, invalid 0, cost $0.0000. Stopped: the AI Gateway refused zero data retention, so AI is off; nothing after it was asked.', 'zdr_unavailable', 1],
    ['a crash with a fixed reason', 1, '{"evt":"fatal","reason":"missing_env"}', 'missing_env', 0],
    ['a crash without one', 1, 'Error: something about deals@bank.example', 'worker_failed', 0],
    ['a pass with no propose tally', 0, 'Tenant t: read 3 items from 1 sources.', 'no_propose_tally', 0],
  ])('%s', (_, status, stdout, code, called) => {
    expect(proposeRunCode(status, stdout)).toEqual({ code, called });
  });
});

describe('main (refusals print a fixed code and touch nothing)', () => {
  it('refuses an unknown probe with usage, before anything else', async () => {
    expect(await main(['dump'], {})).toBe(2);
  });

  it('refuses a stack that is not w9-m365cap before it builds a client', async () => {
    const out: string[] = [];
    const log = console.log;
    const err = console.error;
    console.log = (text: string) => out.push(text);
    console.error = () => undefined;
    try {
      const code = await main(['index'], {
        NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
        DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
        SUPABASE_SECRET_KEY: 's3cret-key',
      });
      expect(code).toBe(2);
    } finally {
      console.log = log;
      console.error = err;
    }
    expect(out).toEqual(['{"probe":"index","code":"stack_mismatch"}']);
  });
});

const PINNED = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:57321',
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:57322/postgres',
};

describe('probeExit (a printed failure code is a failed probe; audit item 3)', () => {
  it.each([
    [{ probe: 'index', rows: 8, hmac: 8 }, 0],
    [{ probe: 'window', matches: 1, code: 'window_locked' }, 0],
    [{ probe: 'window', matches: 1, code: 'unexpected' }, 1],
    [{ probe: 'remove', status: 409, code: 'not_removable' }, 0],
    [{ probe: 'remove', status: 204, code: 'removed' }, 1],
    [{ probe: 'remove', status: 404, code: 'not_found' }, 1],
    [{ probe: 'remove', status: 500, code: 'unexpected' }, 1],
    [{ probe: 'propose-recorded', called: 7, code: 'ran' }, 0],
    [{ probe: 'propose-recorded', called: 0, code: 'flag_off' }, 1],
    [{ probe: 'propose-recorded', called: 1, code: 'zdr_unavailable' }, 1],
    [{ probe: 'propose-recorded', called: 0, code: 'no_propose_tally' }, 1],
    [{ probe: 'health', code: 'up_to_date', waitingFor: 'none' }, 0],
    [{ probe: 'health', status: 500, code: 'health_unavailable' }, 1],
    [{ probe: 'health', status: 200, code: 'no_team_row' }, 1],
    [{ probe: 'health', code: 'no_state', waitingFor: 'none' }, 1],
    [{ probe: 'health', code: 'up_to_date', waitingFor: 'unexpected' }, 1],
  ] as Array<[ProbeLine, number]>)('%j exits %i', (line, exit) => {
    expect(probeExit(line)).toBe(exit);
  });

  it('main prints the line and exits non-zero on a failure code', async () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((text: string) => void out.push(text));
    try {
      const failed = await main(['propose-recorded'], PINNED, {
        'propose-recorded': async () => ({ probe: 'propose-recorded', called: 0, code: 'flag_off' }),
      });
      expect(failed).toBe(1);
      const passed = await main(['propose-recorded'], PINNED, {
        'propose-recorded': async () => ({ probe: 'propose-recorded', called: 7, code: 'ran' }),
      });
      expect(passed).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
    expect(out).toEqual(['{"probe":"propose-recorded","called":0,"code":"flag_off"}', '{"probe":"propose-recorded","called":7,"code":"ran"}']);
  });
});

describe('removeTeamInbox (audit item 2: DELETE only a team inbox that holds mail)', () => {
  const json = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status });

  it('refuses to send the DELETE when the team source holds no indexed mail', async () => {
    const del = vi.fn(async () => json(204, {}));
    await expect(removeTeamInbox(0, del)).rejects.toEqual(new ProbeError('no_mail'));
    expect(del).not.toHaveBeenCalled();
  });

  it.each([
    [json(409, { error: 'not_removable' }), 409, 'not_removable', 0],
    [json(409, { error: 'conflict' }), 409, 'unexpected', 1],
    [json(204, {}), 204, 'removed', 1],
    [json(404, {}), 404, 'not_found', 1],
    [json(500, {}), 500, 'unexpected', 1],
  ])('answers %#: status %i is code %s, exit %i', async (res, status, code, exit) => {
    const line = await removeTeamInbox(8, async () => res);
    expect(line).toEqual({ probe: 'remove', status, code });
    expect(probeExit(line)).toBe(exit);
  });
});
