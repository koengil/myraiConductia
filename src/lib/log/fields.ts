// The one definition of every server log event (#474, design Q1). The ServerLine type
// is derived from FIELD_TABLE, cleanLine() walks it, and
// tests/log/server-events-contract.test.ts pins it: a field cannot exist in one and
// not the others. Every field is a closed set, a UUID or a ranged integer.

import { int, oneOf, uuid, type Cleaner, type Invalid } from './clean';
import {
  AUTH_DENY_REASONS, AUTH_DENY_STATUSES, AUTH_OUTAGE_REASONS, AUTH_OUTAGE_STATUSES, ERROR_CLASSES, FEATURES, GATES,
  METHODS, MODEL_FAILURES, MODEL_OUTCOMES, PROVIDERS, ROUTE_TYPES, SQLSTATES, ZDR_REASONS,
} from './values';

const f = <C extends Cleaner<unknown>>(clean: C) => ({ clean, required: true }) as const;
const opt = <C extends Cleaner<unknown>>(clean: C) => ({ clean, required: false }) as const;

const HTTP_STATUS = int(100, 599);

export const FIELD_TABLE = {
  auth_denied: {
    reason: f(oneOf(AUTH_DENY_REASONS)), status: f(oneOf(AUTH_DENY_STATUSES)), gate: f(oneOf(GATES)),
    user: opt(uuid), company: opt(uuid),
  },
  auth_unavailable: { reason: f(oneOf(AUTH_OUTAGE_REASONS)), status: f(oneOf(AUTH_OUTAGE_STATUSES)), gate: f(oneOf(GATES)) },
  model_outcome: {
    feature: f(oneOf(FEATURES)), outcome: f(oneOf(MODEL_OUTCOMES)), failure: opt(oneOf(MODEL_FAILURES)),
    zdrReason: opt(oneOf(ZDR_REASONS)), status: opt(HTTP_STATUS), tenant: opt(uuid), ms: f(int(0, 600_000)),
  },
  request_error: {
    routeType: f(oneOf(ROUTE_TYPES)), method: f(oneOf(METHODS)), errorClass: f(oneOf(ERROR_CLASSES)),
    provider: opt(oneOf(PROVIDERS)), status: opt(HTTP_STATUS), sqlstate: opt(oneOf(SQLSTATES)),
  },
  // status 0: the database was unreachable (the fetch rejected).
  audit_write_failed: { status: f(int(0, 599)), sqlstate: opt(oneOf(SQLSTATES)) },
} as const;

export type Evt = keyof typeof FIELD_TABLE;

// Derived, never hand-written: what a caller may pass for each field ('invalid' is the cleaner's, not the caller's).
type ValueOf<S> = S extends { readonly clean: (value: unknown) => infer R } ? Exclude<R, Invalid> : never;
type IsRequired<S> = S extends { readonly required: true } ? true : false;
type LineOf<T> = { -readonly [K in keyof T as IsRequired<T[K]> extends true ? K : never]: ValueOf<T[K]> } & {
  -readonly [K in keyof T as IsRequired<T[K]> extends true ? never : K]?: ValueOf<T[K]>;
};
type Simplify<T> = { [K in keyof T]: T[K] };

export type ServerLine = { [E in Evt]: Simplify<{ evt: E } & LineOf<(typeof FIELD_TABLE)[E]>> }[Evt];
export type LineFor<E extends Evt> = Extract<ServerLine, { evt: E }>;
