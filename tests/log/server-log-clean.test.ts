// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logServerEvent, type ServerLine } from '@/lib/log';
import { FIELD_TABLE } from '@/lib/log/fields';
import { refuse } from '@/lib/log/gate';

import { ID, LINES, type Method } from './lines';

let written: Array<{ method: Method; text: string }> = [];
beforeEach(() => {
  written = [];
  for (const method of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      written.push({ method, text: args.map(String).join(' ') });
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

const asLine = (value: unknown) => value as ServerLine;
const REJECTED = [{ method: 'error', text: '{"evt":"log_line_rejected"}' }];

// Keys a caller might add by mistake, each carrying something a line must never hold.
const EXTRAS = {
  subject: 'Re: Project Falcon LOI',
  email: 'jane@bank.example',
  message: 'CANARY-331 mailbox text',
  err: new Error('CANARY-331 thrown'),
  body: { text: 'CANARY-331 nested body' },
};

describe('logServerEvent (#474)', () => {
  it.each(LINES)('writes $line.evt as one exact line at console.$method', ({ line, method, json }) => {
    logServerEvent(line);
    expect(written).toEqual([{ method, text: json }]);
  });

  it.each(LINES)('copies only the table keys of $line.evt, never an extra key', ({ line, json }) => {
    logServerEvent(asLine({ ...line, ...EXTRAS }));
    expect(written).toHaveLength(1);
    expect(written[0].text).toBe(json);
    const keys = Object.keys(JSON.parse(written[0].text));
    expect(['evt', ...Object.keys(FIELD_TABLE[line.evt])]).toEqual(expect.arrayContaining(keys));
    for (const planted of ['CANARY-331', 'Falcon', 'jane@']) expect(written[0].text).not.toContain(planted);
  });

  it('writes a missing required field as invalid and leaves a missing optional one out', () => {
    logServerEvent(asLine({ evt: 'auth_denied', gate: 'api' }));
    expect(written[0].text).toBe('{"evt":"auth_denied","reason":"invalid","status":"invalid","gate":"api"}');
  });

  it.each([
    ['status 600', { evt: 'audit_write_failed', status: 600 }],
    ['status -1', { evt: 'audit_write_failed', status: -1 }],
    ['status 1.5', { evt: 'audit_write_failed', status: 1.5 }],
    ['status NaN', { evt: 'audit_write_failed', status: Number.NaN }],
    ["status '500'", { evt: 'audit_write_failed', status: '500' }],
  ])('writes an out-of-range integer (%s) as invalid', (_label, line) => {
    logServerEvent(asLine(line));
    expect(written[0].text).toBe('{"evt":"audit_write_failed","status":"invalid"}');
  });

  it('writes a non-UUID id and an out-of-range duration as invalid', () => {
    logServerEvent(asLine({ evt: 'model_outcome', feature: 'deal_proposal', outcome: 'timeout', tenant: `${ID}x`, ms: 600_001 }));
    expect(written[0].text).toBe('{"evt":"model_outcome","feature":"deal_proposal","outcome":"timeout","tenant":"invalid","ms":"invalid"}');
  });

  it.each([
    ['an unknown evt', { evt: 'mail_read', status: 500 }],
    ['an inherited key as evt', { evt: 'toString' }],
    ['__proto__ as evt', { evt: '__proto__' }],
    ['no evt', { status: 500 }],
    ['a string', 'Project Falcon'],
    ['null', null],
  ])('writes only log_line_rejected for %s', (_label, line) => {
    logServerEvent(asLine(line));
    expect(written).toEqual(REJECTED);
  });

  it('never throws, even when reading the line throws', () => {
    const line = { evt: 'audit_write_failed', get status(): number { throw new Error('CANARY-331'); } };
    expect(() => logServerEvent(asLine(line))).not.toThrow();
    expect(written).toEqual(REJECTED);
  });
});

describe('refuse (#474)', () => {
  it("logs the gate's line and hands back the gate's own response", () => {
    const response = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const result = refuse(response, { evt: 'auth_denied', reason: 'no_session', status: 401, gate: 'api' });
    expect(result).toEqual({ ok: false, response });
    expect(result.response).toBe(response);
    expect(written).toEqual([{ method: 'warn', text: '{"evt":"auth_denied","reason":"no_session","status":401,"gate":"api"}' }]);
  });
});

describe('the sink is the only console caller (design Q8)', () => {
  it('has no console call in src/lib/log outside sink.ts', () => {
    const dir = join(process.cwd(), 'src/lib/log');
    const callers = readdirSync(dir).filter((name) => /console\./.test(readFileSync(join(dir, name), 'utf8')));
    expect(callers).toEqual(['sink.ts']);
  });
});
