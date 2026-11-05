'use client';

/**
 * Audit trail — a functional, client-side compliance event log.
 *
 * The compliance thesis (Blueprint/Compliance Build Plan): every material
 * action is tracked, stored, and reviewable. This is the front-end projection
 * of that: a persisted, append-only log of what the MD does — prompts typed,
 * step actions taken, files and folders opened, data-room views, skills run.
 *
 * Persisted in localStorage (append-only in the app: no update/delete API),
 * mirrors the deals.ts pattern (storage + a window event so open surfaces
 * refresh live). This is the demo/fixture projection; the real system writes
 * the same shape to the append-only AuditEvent store server-side.
 */

export type AuditKind =
  | 'chat' // a prompt typed into the chat / composer
  | 'step' // a step action on a deal rail (run / complete / skip / approve)
  | 'file' // a file opened / previewed
  | 'folder' // a folder opened
  | 'dataroom' // a data-room document viewed
  | 'skill' // a skill run
  | 'nav' // navigation to a surface
  | 'platform'; // a platform-spine event (create / grant / attest / notify …)

export interface AuditEvent {
  id: string;
  ts: number; // epoch ms
  kind: AuditKind;
  action: string; // human-readable ("Opened", "Typed", "Ran", "Completed")
  /** The stored action key on a server row (e.g. "skill_authoring.draft_created").
   *  The export carries it as `action`; the screen shows the label. */
  actionKey?: string;
  target: string; // what was acted on
  deal?: string; // deal code name, if scoped
  detail?: string; // optional extra context
  /** Who acted, for the Person column. Server rows always set it (a name, or
   *  "Conductia" for a service or model row); browser-local rows never do,
   *  because only the signed-in person writes them, so they read "You". */
  person?: string;
  /** The acting user's id on a server row, so the view can show the signed-in
   *  person's own rows as "You". Absent on service, model and local rows. */
  personId?: string;
  /** A server row's stored detail payload, as the audit read returned it
   *  (recipients, override outcome, verdicts). The export carries it as
   *  `detail`; the screen never prints it. Absent on local rows. */
  serverDetail?: Record<string, unknown> | null;
}

const KEY = 'ib-audit-log';
const EVENT = 'ib:audit-changed';
const MAX = 500; // keep the log bounded

function read(): AuditEvent[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    // Guard against schema drift / partial writes: a valid-JSON but non-array
    // value would otherwise pass here and throw later on the `[evt, ...read()]`
    // spread in logAudit. Mirrors the sibling store in src/lib/rail/deals.ts.
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AuditEvent[]) : [];
  } catch {
    return [];
  }
}

function write(events: AuditEvent[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(events.slice(0, MAX)));
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    // localStorage unavailable — the log just won't persist this session.
  }
}

let counter = 0;

/** Append an audit event. Newest-first. Safe to call from any surface. */
export function logAudit(
  kind: AuditKind,
  action: string,
  target: string,
  opts: { deal?: string; detail?: string } = {},
): void {
  if (typeof window === 'undefined') return;
  const evt: AuditEvent = {
    // id is monotonic within a session; ts carries the wall clock for display.
    id: `${Date.now().toString(36)}-${(counter++).toString(36)}`,
    ts: Date.now(),
    kind,
    action,
    target,
    deal: opts.deal,
    detail: opts.detail,
  };
  const next = [evt, ...read()];
  write(next);
}

/** True when a local event is stamped for this deal (codename, code, or id). */
export function eventBelongsToDeal(
  event: Pick<AuditEvent, 'deal'>,
  deal: { id: string; codename: string; code?: string },
): boolean {
  if (event.deal == null) return false;
  return (
    event.deal === deal.codename ||
    event.deal === deal.code ||
    event.deal === deal.id
  );
}

/** Read the current log (newest-first). */
export function readAudit(): AuditEvent[] {
  return read();
}

/** Clear the log (a real system would never delete; this is a demo affordance). */
export function clearAudit(): void {
  write([]);
}

export const AUDIT_EVENT = EVENT;
