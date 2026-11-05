// The content-free server logger (#474). One JSON line per event, built only from
// FIELD_TABLE's fields and closed values. It imports no Node built-in, so the Edge
// runtime can call it too.

import { cleanLine } from './clean';
import { FIELD_TABLE, type Evt, type ServerLine } from './fields';
import { writeLine, type Level } from './sink';

export type { Evt, LineFor, ServerLine } from './fields';

/** What a line that names no event becomes: the event alone, nothing from the input. */
const REJECTED = { evt: 'log_line_rejected' } as const;

// Denials are expected traffic (warn); outages, failures and errors are errors.
const LEVEL: { readonly [E in Evt]: Level } = {
  auth_denied: 'warn',
  auth_unavailable: 'error',
  model_outcome: 'error',
  request_error: 'error',
  audit_write_failed: 'error',
};

function levelOf(line: Readonly<Record<string, unknown>>): Level {
  if (line.evt === 'model_outcome' && line.outcome === 'ok') return 'info';
  return LEVEL[line.evt as Evt];
}

/** Writes one line. Never throws: a line that cannot be read is logged as log_line_rejected. */
export function logServerEvent(line: ServerLine): void {
  let cleaned: Record<string, unknown> | null;
  try {
    cleaned = cleanLine(FIELD_TABLE, line);
  } catch {
    cleaned = null;
  }
  if (cleaned) writeLine(levelOf(cleaned), cleaned);
  else writeLine('error', REJECTED);
}
