// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { ServerLine } from '@/lib/log';

// tsc includes tests/ (ci.yml), and an @ts-expect-error with nothing to report fails it. Each line
// below puts a wide `string` (or `number`) into one closed field, so widening that field in
// src/lib/log/values.ts or fields.ts breaks the typecheck. Never called: the check is the compile.
const accept = (line: ServerLine): ServerLine => line;

function wideValues(s: string, n: number): void {
  accept({ evt: 'auth_denied', reason: 'no_session', status: 401, gate: 'inbound_webhook', user: s, company: s });
  // @ts-expect-error auth_denied.reason is AUTH_DENY_REASONS
  accept({ evt: 'auth_denied', reason: s, status: 401, gate: 'api' });
  // @ts-expect-error auth_denied.status is 401 | 403
  accept({ evt: 'auth_denied', reason: 'no_session', status: n, gate: 'api' });
  // @ts-expect-error auth_denied.gate is GATES
  accept({ evt: 'auth_denied', reason: 'no_session', status: 401, gate: s });
  // @ts-expect-error auth_denied.user is an id, not a number
  accept({ evt: 'auth_denied', reason: 'no_session', status: 401, gate: 'api', user: n });
  // @ts-expect-error auth_unavailable.reason is AUTH_OUTAGE_REASONS
  accept({ evt: 'auth_unavailable', reason: s, status: 503, gate: 'api' });
  // @ts-expect-error auth_unavailable.status is 503
  accept({ evt: 'auth_unavailable', reason: 'session_read', status: n, gate: 'api' });
  // @ts-expect-error auth_unavailable.gate is GATES
  accept({ evt: 'auth_unavailable', reason: 'session_read', status: 503, gate: s });
  // @ts-expect-error model_outcome.feature is FEATURES
  accept({ evt: 'model_outcome', feature: s, outcome: 'ok', ms: 1 });
  // @ts-expect-error model_outcome.outcome is MODEL_OUTCOMES
  accept({ evt: 'model_outcome', feature: 'compliance_screen', outcome: s, ms: 1 });
  // @ts-expect-error model_outcome.failure is MODEL_FAILURES
  accept({ evt: 'model_outcome', feature: 'compliance_screen', outcome: 'http', failure: s, ms: 1 });
  // @ts-expect-error model_outcome.zdrReason is ZDR_REASONS
  accept({ evt: 'model_outcome', feature: 'compliance_screen', outcome: 'zdr_unavailable', zdrReason: s, ms: 1 });
  // @ts-expect-error model_outcome.status is a number
  accept({ evt: 'model_outcome', feature: 'compliance_screen', outcome: 'http', status: s, ms: 1 });
  // @ts-expect-error model_outcome.tenant is an id, not a number
  accept({ evt: 'model_outcome', feature: 'compliance_screen', outcome: 'ok', tenant: n, ms: 1 });
  // @ts-expect-error model_outcome.ms is a number
  accept({ evt: 'model_outcome', feature: 'compliance_screen', outcome: 'ok', ms: s });
  // @ts-expect-error request_error.routeType is ROUTE_TYPES
  accept({ evt: 'request_error', routeType: s, method: 'GET', errorClass: 'db' });
  // @ts-expect-error request_error.method is METHODS
  accept({ evt: 'request_error', routeType: 'route', method: s, errorClass: 'db' });
  // @ts-expect-error request_error.errorClass is ERROR_CLASSES
  accept({ evt: 'request_error', routeType: 'route', method: 'GET', errorClass: s });
  // @ts-expect-error request_error.provider is PROVIDERS
  accept({ evt: 'request_error', routeType: 'route', method: 'GET', errorClass: 'upstream', provider: s });
  // @ts-expect-error request_error.status is a number
  accept({ evt: 'request_error', routeType: 'route', method: 'GET', errorClass: 'upstream', status: s });
  // @ts-expect-error request_error.sqlstate is SQLSTATES
  accept({ evt: 'request_error', routeType: 'route', method: 'GET', errorClass: 'db', sqlstate: s });
  // @ts-expect-error audit_write_failed.status is a number
  accept({ evt: 'audit_write_failed', status: s });
  // @ts-expect-error audit_write_failed.sqlstate is SQLSTATES
  accept({ evt: 'audit_write_failed', status: 500, sqlstate: s });
  // @ts-expect-error 'invalid' is what the cleaner writes, never what a caller passes
  accept({ evt: 'auth_denied', reason: 'invalid', status: 401, gate: 'api' });
  // @ts-expect-error an extra key on a fresh literal (the cleaner drops one that arrives another way)
  accept({ evt: 'audit_write_failed', status: 500, subject: s });
  // @ts-expect-error a missing required field
  accept({ evt: 'audit_write_failed' });
  // @ts-expect-error an event the table does not define
  accept({ evt: 'mail_read', status: 500 });
}

describe('ServerLine types (#474)', () => {
  it('is checked by tsc, not at run time', () => {
    expect(wideValues).toBeTypeOf('function');
  });
});
