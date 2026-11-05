import fs from 'node:fs';
import { test as teardown } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { recycleInvitee } from '../../scripts/lib/recycleInvitee';
import { TEARDOWN_MANIFEST } from './teardownManifest';

/**
 * Delete this run's invitations and the identities it created (design D12).
 *
 * The MD spine leaves everything it creates, which is survivable for ordinary
 * tenant data. This journey creates two things it does not: each acceptance
 * mints a real auth.users row, its mirror, and an enrolled TOTP factor — a
 * GLOBAL identity namespace rather than deal-scoped data — and a run that dies
 * mid-flight strands a pending invitation permanently. Neither blocks a later
 * run, because every address carries the run id, but both grow without bound
 * where reuseExistingServer is on and nothing resets.
 *
 * It runs only when the journey passed: the manifest is written by the spec
 * after its last assertion. A failing run leaves no manifest, so this is a
 * no-op and the rows survive for diagnosis.
 *
 * Scope: this journey's own rows. Retrospective cleanup of what the foundation
 * and the MD spine already leave behind is issue #15, which should converge on
 * this mechanism rather than inventing a second one.
 */
teardown('recycle the invite journey rows', async () => {
  if (!fs.existsSync(TEARDOWN_MANIFEST)) {
    console.log('no teardown manifest; the journey did not pass. Rows left intact.');
    return;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) {
    throw new Error(
      'E2E teardown needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY.',
    );
  }
  const admin = createClient(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const emails = JSON.parse(fs.readFileSync(TEARDOWN_MANIFEST, 'utf8')) as string[];
  for (const email of emails) {
    const result = await recycleInvitee(admin, email);
    console.log(
      `recycled ${email}: ${result.invitesRemoved} invite(s), ${result.seatsRemoved} seat(s)` +
        (result.tombstone ? `, identity -> ${result.tombstone}` : ', no identity'),
    );
  }

  fs.rmSync(TEARDOWN_MANIFEST);
});
