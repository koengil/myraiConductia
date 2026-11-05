import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';

/*
 * Deal discovery over ANY recorded Graph cassette ([318 2/6]): the same offline pass as discovery-replay.test.ts
 * (the real mail reader, the worker's runOnce, the mailbox guard, a REAL database), but the cassette is an input
 * and nothing in this file names one cassette's people. The owners, the mailboxes, the sites and the mail domains
 * are read from the cassette's manifest.sources at runtime (support/replayCassette.ts), so a cassette recorded from
 * a live tenant replays here without a single address in code.
 *
 * Two cases, one body:
 *  - synthetic (always): the committed cassette. The counts must equal discovery-replay.test.ts's EXPECTED; do not
 *    change them to make this pass.
 *  - tidewell (when M365_REPLAY_CASSETTE_DIR is set): the owner's out-of-repo capture (#277 Q1: it never enters git).
 *    CI does not set it and the case is skipped with a message. The owner runs it on a local throwaway stack and
 *    pastes the printed counts and cassette digest id into [318 6/6]. It prints counts and the digest id only: never
 *    an address, a subject or a text.
 *
 * For every cassette: no request misses, every recorded interaction is asked for, the pass finds at least one
 * candidate and stores items, a second pass adds no candidate, and a finished replay leaves its registration
 * disabled (the worker selects only 'active' ones).
 */

import { loadCassette, type Cassette } from '../../scripts/m365/cassette/replayFetch';
import { SYNTHETIC_CASSETTE_DIR } from '../../scripts/m365/build-synthetic-cassette';
import { assertSupabaseTarget } from '../../scripts/m365/cassette/target';
import { replayDiscovery, seedReplayTenant } from '../../scripts/m365/replay-discovery';
import { createGuardedTenant, dropGuardedTenant, enableDiscoveryFlag, type GuardedTenant, type GuardedTenantEnv } from './support/guardedTenant';
import {
  admitReplayTenant,
  EXPECTED_SYNTHETIC,
  ownersFor,
  planFromManifest,
  registrationStatus,
  replayedCounts,
} from './support/replayCassette';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  throw new Error('The cassette replay test needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (local stack).');
}
// The loopback-only guard the replay script applies: this file writes fixtures too, and never to a hosted project.
assertSupabaseTarget(url, null);
const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!publishable) {
  throw new Error('The cassette replay test needs NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (local stack).');
}
const db = createClient(url, secret, { auth: { persistSession: false } });

const RUN = Date.now().toString(36);
const env: GuardedTenantEnv = { db, url, publishableKey: publishable, run: RUN, password: `Replay-${RUN}-x9!` };

/** Where the owner's out-of-repo cassette is. Read when a case runs, not when the file loads. */
const CASSETTE_DIR_ENV = 'M365_REPLAY_CASSETTE_DIR';
const TIDEWELL_SKIPPED =
  `Tidewell replay skipped: set ${CASSETTE_DIR_ENV} to an out-of-repo cassette (scripts/m365/README.md, "Record and replay")`;

/** A large capture reads many pages: the default 90 s is for the synthetic one. */
const TIDEWELL_TIMEOUT_MS = 900_000;

const tenants: GuardedTenant[] = [];
let restoreFlag: () => Promise<void> = async () => undefined;

beforeAll(async () => {
  restoreFlag = await enableDiscoveryFlag(db);
});

// A large capture leaves many rows to drop: the default 90 s hook limit is for the synthetic one.
afterAll(async () => {
  for (const tenant of tenants) await dropGuardedTenant(env, tenant);
  await restoreFlag();
}, 300_000);

/**
 * Seeds a guarded tenant for the cassette, replays it twice, and checks what holds for every cassette. Returns the
 * counts and the cassette id so a case can add its own assertions or print them.
 */
async function replayAndCheck(label: string, cassette: Cassette, report: boolean) {
  const plan = planFromManifest(cassette.manifest);
  const tenant = await createGuardedTenant(env, label, plan.people);
  tenants.push(tenant);
  await seedReplayTenant(db, {
    tenantId: tenant.id,
    cassette,
    owners: ownersFor(tenant, plan),
    firmCompany: tenant.companyId,
    mailboxDomains: plan.domains,
  });
  await admitReplayTenant(db, tenant, plan);

  const { first, second } = await replayDiscovery(db, { tenantId: tenant.id, cassette });
  const counts = await replayedCounts(db, tenant.id);
  const created = second.candidates.filter((c) => c.created).length;
  const status = await registrationStatus(db, tenant.id);
  const misses = cassette.fetch.misses.length; // a length: a failed assertion prints a number, not the lines
  const unrequested = cassette.fetch.unrequested();

  if (report) {
    // Counts and the digest id, so they can be pasted into the PR. No address, subject or text is in any of them.
    console.log(`cassette sha256:${cassette.digestSha256}`);
    console.log(
      JSON.stringify({
        sources: cassette.manifest.sources.length,
        mailboxes: plan.mailboxes.length,
        sites: plan.sites.length,
        domains: plan.domains.length,
        run1: { read: first.itemsRead, stored: first.itemsStored, candidates: first.candidates.length, refused: first.refused.length },
        run2: { read: second.itemsRead, stored: second.itemsStored, candidates: second.candidates.length, newCandidates: created, refused: second.refused.length },
        counts,
        misses,
        unrequested,
        registration: status,
      }),
    );
  }

  expect(misses).toBe(0);
  expect(unrequested).toBe(0); // every recorded interaction was asked for: a reader that stops asking is drift too
  expect(counts.candidates).toBeGreaterThanOrEqual(1);
  expect(counts.items).toBeGreaterThan(0);
  expect(created).toBe(0); // the second pass is a delta: it finds nothing the first did not
  expect(status).toBe('disabled');
  return { counts };
}

describe('discovery over a recorded Graph cassette, whichever cassette it is', () => {
  it('synthetic: the committed cassette gives the expected totals', async () => {
    const cassette = loadCassette(SYNTHETIC_CASSETTE_DIR);
    const { counts } = await replayAndCheck('cassette-synthetic', cassette, false);
    expect(counts).toEqual(EXPECTED_SYNTHETIC);
  });

  it(
    'tidewell: the owner\'s out-of-repo capture replays with no miss and nothing unrequested',
    async (ctx) => {
      const dir = process.env[CASSETTE_DIR_ENV]?.trim();
      if (!dir) {
        console.info(TIDEWELL_SKIPPED); // the default reporter hides a skip note
        ctx.skip(TIDEWELL_SKIPPED);
        return;
      }
      await replayAndCheck('cassette-tidewell', loadCassette(dir), true);
    },
    TIDEWELL_TIMEOUT_MS,
  );
});
