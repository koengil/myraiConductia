// A caller-chosen value (a header, a query parameter, a route segment) may carry
// anything: a person's name, mail text, a path. A log line keeps it only when it
// is identifier-shaped, and otherwise records that it was not (#331, ADR-0017 O3).
// Anything that reaches a console from a header, query or route param passes
// through here; the L2 rule in tests/content-egress-guard.test.ts fails on a
// value that does not.

const LOG_ID_SHAPE = /^[A-Za-z0-9_.:-]{1,64}$/;

export function safeLogId(value: string | null | undefined): string {
  return typeof value === 'string' && LOG_ID_SHAPE.test(value) ? value : 'invalid';
}
