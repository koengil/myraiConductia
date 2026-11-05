// The worker's half of the team inbox check (#581, design R7): before a team source is read, ask the database whether
// the Google Directory check of its address is due, run it when it is, and record the outcome. Both worker entry
// points reach this through readOneSource, ahead of the guarded reader (tests/discovery/reader-pass-pins.test.ts).
// A pass that outlives the confirmation's freshness renews it once, mid-pass, through recheckTeamMailbox.
//
// It reads no mail and builds no reader. The database decides when a check is due (its own clock, so two workers and
// a skewed host agree) and what a recorded outcome does to the registration (supabase/migrations/
// 20261019130000_team_mailbox_check.sql). What the check changes is the registry only: the guard, not this module,
// decides whether the source may be read (supabase/migrations/20261019140000_team_mailbox_guard.sql), page by page.
//
// Nothing here logs. The address is read from the registry only to hand to the verifier, and never leaves it.

import type { SupabaseClient } from '@supabase/supabase-js';

import { TEAM_MAILBOX_CHECK_ERROR } from '@/lib/constants/discovery';
import { errorCodeOf } from '@/lib/errors/upstream';
import type { TeamMailboxCheck, TeamMailboxVerifier } from '@/lib/mailboxAccess';

/** What discovery_team_mailbox_check_due answers: whether the check is due, and what to verify when it is. */
type CheckDue = { due: boolean; teamMailboxId: string | null; address: string | null; pinnedId: string | null };

function parseDue(data: unknown): CheckDue {
  const row = (data ?? {}) as Partial<CheckDue>;
  return {
    due: row.due === true,
    teamMailboxId: typeof row.teamMailboxId === 'string' ? row.teamMailboxId : null,
    address: typeof row.address === 'string' ? row.address : null,
    pinnedId: typeof row.pinnedId === 'string' ? row.pinnedId : null,
  };
}

/**
 * Asks the database for the registration behind a source, runs the Directory check on it, and records the answer. `due`
 * decides whether the check runs only when the database says it is due; a forced check runs whenever there is a
 * registration to check.
 *
 * - No verifier for this mode, not due (unless forced), or no open registration: nothing happens. A source with no
 *   verifier is not even asked about, so it stays as it is (pending): never read, never shown Ready.
 * - A verifier that throws counts as a transient `directory_error`, recorded beside the status (it never flips Ready
 *   to Refused). Its message is dropped: it could carry an address.
 * - A failure of the database itself (the due lookup, or recording the answer) throws: the pass fails and is retried,
 *   rather than read on a check nobody could record.
 */
async function runCheck(
  db: SupabaseClient,
  source: { id: string; tenantId: string },
  verifier: TeamMailboxVerifier | null,
  force: boolean,
): Promise<void> {
  if (!verifier) return;
  const { data, error } = await db.rpc('discovery_team_mailbox_check_due', { p_source_id: source.id });
  if (error) throw new Error(`team mailbox check lookup failed (${errorCodeOf(error)})`);
  const due = parseDue(data);
  if (!(force || due.due) || !due.teamMailboxId || !due.address) return;

  let result: TeamMailboxCheck;
  try {
    result = await verifier.verify(source.tenantId, due.address, due.pinnedId);
  } catch {
    result = { status: 'error', reason: TEAM_MAILBOX_CHECK_ERROR.DIRECTORY_ERROR };
  }

  const { error: recordError } = await db.rpc('discovery_record_team_mailbox_check', {
    p_id: due.teamMailboxId,
    p_status: result.status,
    p_reason: result.status === 'verified' ? null : result.reason,
    p_directory_user_id: result.status === 'verified' ? result.directoryUserId : null,
  });
  if (recordError) throw new Error(`team mailbox check could not be recorded (${errorCodeOf(recordError)})`);
}

/**
 * Runs the Directory check of a team source's address when the database says it is due, and records the answer. The
 * start of every pass, from both entry points (readOneSource).
 */
export async function checkTeamMailbox(
  db: SupabaseClient,
  source: { id: string; tenantId: string },
  verifier: TeamMailboxVerifier | null,
): Promise<void> {
  return runCheck(db, source, verifier, false);
}

/**
 * Runs the Directory check now, whether or not it is due, and records the answer. The guarded reader calls it once,
 * mid-pass, when the guard says the last confirmation aged out between two pages (GuardedReaderContext.recheckTeam).
 * It only writes the registry: whether the read continues is the guard's answer to the question asked right after.
 * Same fail-closed rules as checkTeamMailbox, and no verifier means nothing is renewed, so the guard refuses again.
 */
export async function recheckTeamMailbox(
  db: SupabaseClient,
  source: { id: string; tenantId: string },
  verifier: TeamMailboxVerifier | null,
): Promise<void> {
  return runCheck(db, source, verifier, true);
}
