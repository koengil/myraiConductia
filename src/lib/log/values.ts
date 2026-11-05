// The closed value sets of the server logger (#474, design Q1/Q7). Every string a
// line carries is a member of one of these, so nothing typed by a person or read
// from mail can ride in a field. A value outside its set is logged as 'invalid'.

/** Model features. okLogged: a success is logged too (web callers); the worker's successes are counted elsewhere (Q4). */
export const FEATURES = ['compliance_screen', 'codename_suggest', 'milestone_extract', 'deal_proposal'] as const;
export type Feature = (typeof FEATURES)[number];
export const FEATURE_OK_LOGGED: { readonly [F in Feature]: boolean } = {
  compliance_screen: true,
  codename_suggest: true,
  milestone_extract: false,
  deal_proposal: false,
};

/** 401/403 refusals: the caller is not let in. */
export const AUTH_DENY_REASONS = [
  'no_session', 'mfa_required', 'account_suspended', 'onboarding_incomplete', 'bad_secret', 'work_identity_hook',
] as const;
/** 503s: the gate could not decide. */
export const AUTH_OUTAGE_REASONS = ['misconfigured', 'session_read', 'mfa_level', 'admin_client', 'profile_read'] as const;
export const AUTH_DENY_STATUSES = [401, 403] as const;
export const AUTH_OUTAGE_STATUSES = [503] as const;
export const GATES = ['api', 'api_scoped', 'inbound_webhook'] as const;

export const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
/** Next's own RequestErrorContext['routeType'] union. */
export const ROUTE_TYPES = ['render', 'route', 'action', 'proxy'] as const;
/** DbError -> 'db', UpstreamHttpError and the status-carrying provider errors -> 'upstream', else the class name or 'other'. */
export const ERROR_CLASSES = ['db', 'upstream', 'OperatorCopyError', 'SyntaxError', 'TypeError', 'RangeError', 'ReferenceError', 'Error', 'other'] as const;
/** UpstreamProvider (src/lib/errors/upstream.ts) plus the providers errorCodeOf names by class. */
export const PROVIDERS = ['box', 'resend', 'graph-mail', 'gmail-token', 'gmail-send', 'anthropic', 'ignatious', 'google', 'google-token', 'graph'] as const;

// Every errcode the migrations raise (`errcode = '…'`) or src branches on (`code === '…'`), grepped 2026-10-21,
// plus the platform codes the API paths surface. A P0001 raise token is never logged, only 'P0001'.
export const SQLSTATES = [
  '22023', '22P02', '23502', '23503', '23505', '23514', '40001', '42501',
  '55000', '55P03', '57014', 'P0001', 'P0002', 'P0003', 'P0004', 'P0409',
] as const;

export const MODEL_OUTCOMES = ['ok', 'no_key', 'timeout', 'http', 'zdr_unavailable'] as const;
export const MODEL_FAILURES = ['non_anthropic_model', 'upstream_status', 'malformed_reply', 'network'] as const;
/** ZdrReason (src/lib/modelGateway/gatewayClient.ts), restated: the logger imports nothing from the gateway. */
export const ZDR_REASONS = ['no_providers_available', 'permission_denied'] as const;
