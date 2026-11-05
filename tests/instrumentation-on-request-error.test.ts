// @vitest-environment node
import type { Instrumentation } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DbError, OperatorCopyError, UpstreamHttpError, dbFailure } from '@/lib/errors/upstream';
import { onRequestError } from '@/instrumentation';
import { renderConsoleArg } from './helpers/consoleCapture';

/**
 * #474: an error that escapes a route becomes one request_error line, decomposed
 * by class only. A DbError gives its SQLSTATE (a raise token gives only P0001), an
 * upstream error its provider and status, anything else its class name or 'other'.
 * The message, which a library may build from its input, never reaches the line.
 */

const CANARY = 'CANARY-331';
const PG = { message: `${CANARY} invalid input syntax for type uuid: "Project Falcon"` };

// Typed as Next's hook, so tsc fails if the export stops matching what Next calls.
const hook: Instrumentation.onRequestError = onRequestError;

type RouteType = Parameters<Instrumentation.onRequestError>[2]['routeType'];

function fire(err: unknown, method = 'POST', routeType: RouteType = 'route') {
  return hook(
    err,
    { path: '/api/v1/deals/FALCO-2026-123?q=Project%20Falcon', method, headers: { 'x-inbound-secret': CANARY } },
    { routerKind: 'App Router', routePath: '/api/v1/deals/[dealId]', routeType, revalidateReason: undefined },
  );
}

function parseFalcon(): unknown {
  try {
    JSON.parse('Project Falcon');
  } catch (err) {
    return err;
  }
  throw new Error('JSON.parse accepted the canary');
}

let written: Array<{ method: string; text: string }> = [];
beforeEach(() => {
  written = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      written.push({ method, text: args.map(renderConsoleArg).join(' ') });
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

const line = (fields: string) => `{"evt":"request_error","routeType":"route","method":"POST",${fields}}`;

class PostgrestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostgrestError';
  }
}

const CASES: Array<[string, () => unknown, string]> = [
  ['a DbError with a SQLSTATE', () => dbFailure('Deal lookup', { ...PG, code: '22P02' }), line('"errorClass":"db","sqlstate":"22P02"')],
  ['a DbError from a raise, which keeps only P0001', () => dbFailure('Rail save', { code: 'P0001', message: 'name_taken' }), line('"errorClass":"db","sqlstate":"P0001"')],
  ['a DbError with a code outside SQLSTATES', () => dbFailure('Deal lookup', { ...PG, code: '08006' }), line('"errorClass":"db","sqlstate":"invalid"')],
  ['a DbError without a code', () => new DbError('Deal lookup', null), line('"errorClass":"db"')],
  ['an UpstreamHttpError', () => new UpstreamHttpError('box', 'upload', 502, CANARY), line('"errorClass":"upstream","provider":"box","status":502')],
  [
    'a status-carrying provider error, matched by name',
    () => Object.assign(new Error(`${CANARY} Project Falcon`), { name: 'GraphHttpError', status: 429 }),
    line('"errorClass":"upstream","provider":"graph","status":429'),
  ],
  // Next bundles instrumentation apart from the routes, so a route's DbError need not be an
  // instance of the class this file imports: the name decides, as for the provider errors.
  [
    'a DbError from another bundle, matched by name',
    () => Object.assign(new Error(`${CANARY} Project Falcon`), { name: 'DbError', code: '22P02' }),
    line('"errorClass":"db","sqlstate":"22P02"'),
  ],
  [
    'a DbError from another bundle with a raise token',
    () => Object.assign(new Error('Rail save failed'), { name: 'DbError', code: 'name_taken' }),
    line('"errorClass":"db","sqlstate":"P0001"'),
  ],
  [
    'a DbError from another bundle without a string code',
    () => Object.assign(new Error(CANARY), { name: 'DbError', code: { text: CANARY } }),
    line('"errorClass":"db"'),
  ],
  [
    'an UpstreamHttpError from another bundle, matched by name',
    () => Object.assign(new Error(`${CANARY} Project Falcon`), { name: 'UpstreamHttpError', provider: 'box', status: 502 }),
    line('"errorClass":"upstream","provider":"box","status":502'),
  ],
  ['a JSON.parse SyntaxError on mail text', parseFalcon, line('"errorClass":"SyntaxError"')],
  ['a TypeError', () => new TypeError(`${CANARY} Project Falcon is not a function`), line('"errorClass":"TypeError"')],
  ['an OperatorCopyError', () => new OperatorCopyError('Discovery extract is not approved'), line('"errorClass":"OperatorCopyError"')],
  ['a library error class', () => new PostgrestError(`${CANARY} Project Falcon`), line('"errorClass":"other"')],
  ['a thrown string', () => `${CANARY} Project Falcon`, line('"errorClass":"other"')],
  ['a thrown null', () => null, line('"errorClass":"other"')],
];

describe('onRequestError (#474)', () => {
  it.each(CASES)('writes %s as one decomposed line at console.error', async (_label, make, json) => {
    await fire(make());
    expect(written).toEqual([{ method: 'error', text: json }]);
    for (const planted of [CANARY, 'Falcon', 'FALCO', 'name_taken', 'Deal lookup']) {
      expect(written[0].text).not.toContain(planted);
    }
  });

  it.each(['render', 'action', 'proxy'] as const)('carries the %s route type', async (routeType) => {
    await fire(new TypeError('x'), 'GET', routeType);
    expect(written[0].text).toBe(`{"evt":"request_error","routeType":"${routeType}","method":"GET","errorClass":"TypeError"}`);
  });

  it('writes a method outside METHODS as invalid', async () => {
    await fire(new TypeError('x'), 'PROPFIND');
    expect(written[0].text).toBe('{"evt":"request_error","routeType":"route","method":"invalid","errorClass":"TypeError"}');
  });
});
