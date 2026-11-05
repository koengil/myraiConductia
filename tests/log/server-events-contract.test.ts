// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { FIELD_TABLE } from '@/lib/log/fields';
import { FEATURE_OK_LOGGED } from '@/lib/log/values';

// The contract of the server log events (#474, design Q1/Q7), written out by hand: every
// event, every field, whether it is required, and every value a field accepts. A new
// event, field or value is a reviewed edit here, the same diff a slice-2 alarm reads.
const req = (shape: unknown) => ({ required: true, shape });
const opt = (shape: unknown) => ({ required: false, shape });
const UUID = { uuid: true };
const HTTP_STATUS = { int: [100, 599] };
const GATES = { oneOf: ['api', 'api_scoped', 'inbound_webhook'] };
const SQLSTATES = {
  oneOf: ['22023', '22P02', '23502', '23503', '23505', '23514', '40001', '42501', '55000', '55P03', '57014', 'P0001', 'P0002', 'P0003', 'P0004', 'P0409'],
};

const CONTRACT = {
  auth_denied: {
    reason: req({ oneOf: ['no_session', 'mfa_required', 'account_suspended', 'onboarding_incomplete', 'bad_secret', 'work_identity_hook'] }),
    status: req({ oneOf: [401, 403] }),
    gate: req(GATES),
    user: opt(UUID),
    company: opt(UUID),
  },
  auth_unavailable: {
    reason: req({ oneOf: ['misconfigured', 'session_read', 'mfa_level', 'admin_client', 'profile_read'] }),
    status: req({ oneOf: [503] }),
    gate: req(GATES),
  },
  model_outcome: {
    feature: req({ oneOf: ['compliance_screen', 'codename_suggest', 'milestone_extract', 'deal_proposal'] }),
    outcome: req({ oneOf: ['ok', 'no_key', 'timeout', 'http', 'zdr_unavailable'] }),
    failure: opt({ oneOf: ['non_anthropic_model', 'upstream_status', 'malformed_reply', 'network'] }),
    zdrReason: opt({ oneOf: ['no_providers_available', 'permission_denied'] }),
    status: opt(HTTP_STATUS),
    tenant: opt(UUID),
    ms: req({ int: [0, 600_000] }),
  },
  request_error: {
    routeType: req({ oneOf: ['render', 'route', 'action', 'proxy'] }),
    method: req({ oneOf: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] }),
    errorClass: req({ oneOf: ['db', 'upstream', 'OperatorCopyError', 'SyntaxError', 'TypeError', 'RangeError', 'ReferenceError', 'Error', 'other'] }),
    provider: opt({ oneOf: ['box', 'resend', 'graph-mail', 'gmail-token', 'gmail-send', 'anthropic', 'ignatious', 'google', 'google-token', 'graph'] }),
    status: opt(HTTP_STATUS),
    sqlstate: opt(SQLSTATES),
  },
  audit_write_failed: {
    status: req({ int: [0, 599] }),
    sqlstate: opt(SQLSTATES),
  },
};

describe('server log events contract (#474)', () => {
  it('defines exactly these events, fields and values', () => {
    const actual = Object.fromEntries(
      Object.entries(FIELD_TABLE).map(([evt, fields]) => [
        evt,
        Object.fromEntries(Object.entries(fields).map(([key, spec]) => [key, { required: spec.required, shape: spec.clean.shape }])),
      ]),
    );
    expect(actual).toEqual(CONTRACT);
    // Field order is the line's key order.
    for (const [evt, fields] of Object.entries(CONTRACT)) {
      expect(Object.keys(FIELD_TABLE[evt as keyof typeof FIELD_TABLE]), evt).toEqual(Object.keys(fields));
    }
  });

  it("logs a success only for the web features; the worker's are counted by its own summary (Q4)", () => {
    expect(FEATURE_OK_LOGGED).toEqual({ compliance_screen: true, codename_suggest: true, milestone_extract: false, deal_proposal: false });
  });
});
