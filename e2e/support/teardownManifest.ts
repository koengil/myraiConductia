import fs from 'node:fs';
import path from 'node:path';

export const TEARDOWN_MANIFEST = path.join(__dirname, '..', 'auth', '.state', 'invite-teardown.json');

export function writeTeardownManifest(emails: Array<string | undefined>) {
  const addresses = emails.filter((email): email is string => Boolean(email));
  fs.mkdirSync(path.dirname(TEARDOWN_MANIFEST), { recursive: true });

  // The union with whatever is already on disk is deliberate, not just
  // defensive: a manifest left behind by an earlier run that crashed before
  // reaching teardown is folded into this run's list and swept up the next
  // time a journey passes. That recovery is intentional (design D12) — a
  // stranded manifest is not lost, it is just deferred.
  //
  // The read+parse is guarded because a manifest can be corrupted by exactly
  // the kind of crash that leaves one stranded (a process killed mid-write).
  // An unguarded JSON.parse would throw here, AFTER every journey assertion
  // has already passed, turning an unrelated leftover file into a failure
  // reason for an otherwise-green run. Treat anything unreadable as "nothing
  // to union" rather than let it fail the run that is trying to clean up.
  let existing: string[] = [];
  try {
    if (fs.existsSync(TEARDOWN_MANIFEST)) {
      existing = JSON.parse(fs.readFileSync(TEARDOWN_MANIFEST, 'utf8')) as string[];
    }
  } catch {
    existing = [];
  }

  fs.writeFileSync(
    TEARDOWN_MANIFEST,
    JSON.stringify([...new Set([...existing, ...addresses])], null, 2),
  );
}
