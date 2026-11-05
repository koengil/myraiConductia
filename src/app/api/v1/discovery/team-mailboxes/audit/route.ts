import { NextResponse } from 'next/server';

import { jsonError } from '@/lib/api/v1/http';
import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import {
  TEAM_MAILBOX_AUDIT_DEFAULT_LIMIT,
  TEAM_MAILBOX_AUDIT_MAX_LIMIT,
  TEAM_MAILBOX_AUDIT_VIEW,
  TEAM_MAILBOX_AUDIT_VIEWS,
} from '@/lib/constants/discovery';
import {
  listTeamMailboxAudit,
  type TeamMailboxAuditCursor,
  type TeamMailboxAuditView,
} from '@/lib/discovery/api';

export const dynamic = 'force-dynamic';

// The keyset is passed back as the RPC gave it: a timestamp with microseconds and an offset (Z or ±HH:MM, as
// Postgres writes it), then the row id.
const CURSOR_TS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(Z|[+-](\d{2}):(\d{2}))$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTEGER = /^-?\d{1,12}$/;

type Query = { view: TeamMailboxAuditView; before: TeamMailboxAuditCursor | null; limit: number };

/**
 * A cursor timestamp that names a real instant. Date.parse rolls 2026-02-31 over to March, which Postgres then
 * refuses (a 500), so the calendar day, the clock and the offset are each checked here and a bad one is a 400.
 */
function isCursorTimestamp(ts: string): boolean {
  const m = CURSOR_TS.exec(ts);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (m[8] !== 'Z' && (Number(m[9]) > 15 || Number(m[10]) > 59)) return false;
  return true;
}

/** `?view=&before=<ts>,<id>&limit=`, or null when any of them is malformed. */
function parseQuery(params: URLSearchParams): Query | null {
  const rawView = params.get('view');
  const view = rawView === null ? TEAM_MAILBOX_AUDIT_VIEW.ACCESS : TEAM_MAILBOX_AUDIT_VIEWS.find((v) => v === rawView);
  if (view === undefined) return null;

  let before: TeamMailboxAuditCursor | null = null;
  const rawBefore = params.get('before');
  if (rawBefore !== null) {
    const parts = rawBefore.split(',');
    if (parts.length !== 2) return null;
    const [ts, id] = parts;
    if (!isCursorTimestamp(ts) || !UUID.test(id)) return null;
    before = { ts, id };
  }

  let limit = TEAM_MAILBOX_AUDIT_DEFAULT_LIMIT;
  const rawLimit = params.get('limit');
  if (rawLimit !== null) {
    if (!INTEGER.test(rawLimit)) return null;
    limit = Math.min(Math.max(Number(rawLimit), 1), TEAM_MAILBOX_AUDIT_MAX_LIMIT);
  }
  return { view, before, limit };
}

/**
 * GET /api/v1/discovery/team-mailboxes/audit (#173 G-03): the audit trail of the caller's firm's team inboxes, for
 * the firm's admin and its CCO. Runs under the caller's own session; the security definer RPC decides from
 * auth.uid() and scopes every row to the caller's own firm company. No admin client is built here.
 *
 * `view` is access (the default), reads or reads_notable; `before` is the previous page's `next` as `<ts>,<id>`;
 * `limit` is clamped to 1..200. Anyone who is not an active, internal admin or CCO of a firm holding a team inbox,
 * open or closed, gets the same 404 as when deal_discovery is off. Ids, fixed codes, counts and names only, never mail.
 */
export async function GET(request: Request) {
  const gate = await requireFlag('deal_discovery');
  if (gate) return gate;
  const auth = await requireApiUserScoped();
  if (!auth.ok) return auth.response;

  const query = parseQuery(new URL(request.url).searchParams);
  if (!query) return jsonError('Bad request', 400);

  const result = await listTeamMailboxAudit(auth.db, query);
  if (result.ok) return NextResponse.json(result.page);
  if (result.reason === 'not_available') return jsonError('Not found', 404);
  if (result.reason === 'bad_request') return jsonError('Bad request', 400);
  return jsonError('Could not load the team inbox audit trail', 500);
}
