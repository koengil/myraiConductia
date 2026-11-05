// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadGmailReplays, ReplayMissError } from '@/lib/google/reader/replay';
import type { GmailReplay } from '@/lib/google/replay/format';
import { loadFixtureMailboxes } from '@/lib/graph/reader/fixture';

import { fixtureCapability } from '../discovery/fixtureCapability';
import {
  DEMO_TWIN_DIR,
  hasRecording,
  profileHistoryId,
  readDeltaLoaded,
  readLoaded,
  RECORDED_DIR,
  SECRET_PATTERN,
  trialDomains,
  TWIN_DIR,
} from './replayHarness';

/** The Graph-shaped corpus each replay was generated from or recorded against: its addresses are the allowed ones. */
const DEMO_CORPUS_DIR = join(process.cwd(), 'tests', 'fixtures', 'discovery', 'demo', 'graph-after-imports');

// R15: the coverage check. The real Gmail ContentSource runs over each
// committed replay, through backfill, in phase `seeded`. If the reader ever asks
// for something a replay lacks, this fails with the list of requests, instead of
// the demo failing on the day.

const REPLAYS = [
  { name: 'the synthetic twin', dir: TWIN_DIR, present: true, corpusDir: undefined },
  { name: 'the demo twin', dir: DEMO_TWIN_DIR, present: true, corpusDir: DEMO_CORPUS_DIR },
  { name: 'the recorded replay', dir: RECORDED_DIR, present: hasRecording(), corpusDir: undefined },
];

/** Missing requests, listed once each, from a replay run that tolerates misses. */
async function missesOf(replays: GmailReplay[]): Promise<string[]> {
  const misses = new Set<string>();
  try {
    await readLoaded(replays, 'seeded');
  } catch (error) {
    if (!(error instanceof ReplayMissError)) throw error;
    misses.add(error.key);
  }
  return [...misses];
}

describe.each(REPLAYS)('$name covers what the reader asks for', ({ dir, present, name, corpusDir }) => {
  it.skipIf(!present)('answers every request of a full backfill in phase seeded', async () => {
    const replays = loadGmailReplays(fixtureCapability, dir);
    expect(replays.length).toBeGreaterThan(0);
    expect(await missesOf(replays)).toEqual([]);
  });

  // The incremental pass reads each thread history names with threads.get (the same request a backfill makes), so a
  // replay that answers a full backfill in a phase must answer the delta that names its messages.
  it.skipIf(!present)('answers every request of an incremental pass, from each earlier phase\'s history id', async () => {
    const replays = loadGmailReplays(fixtureCapability, dir);
    let polls = 0;
    for (const replay of replays) {
      const phases = Object.keys(replay.phases);
      for (const [at, phase] of phases.entries()) {
        for (const earlier of phases.slice(0, at)) {
          // The recorder asks history.list from the seeded id only; the twin answers every id a reader may hold.
          const historyId = profileHistoryId(replay, earlier);
          const holdsHistory = Object.keys(replay.phases[phase]).some((key) => new RegExp(`/history\\?.*startHistoryId=${historyId}(&|$)`).test(key));
          if (!holdsHistory) continue;
          polls += 1;
          // A miss throws ReplayMissError, naming the request.
          await readDeltaLoaded([replay], phase, { historyId });
        }
      }
    }
    expect(polls).toBeGreaterThan(0);
  });

  it.skipIf(!present)('holds no credential-shaped string and no trial-domain address', () => {
    const offenders: string[] = [];
    const trial = trialDomains();
    const allowedDomains = new Set(
      loadFixtureMailboxes(fixtureCapability, corpusDir).flatMap((box) =>
        box.messages.flatMap((m) =>
          [m.from, ...m.toRecipients, ...m.ccRecipients].map((r) => r?.emailAddress.address.split('@')[1].toLowerCase()),
        ),
      ),
    );
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const text = readFileSync(join(dir, file), 'utf8');
      // The MIME the reader parses is base64url inside the JSON: scan what it decodes to as well.
      const decoded = [...text.matchAll(/"raw":\s*"([A-Za-z0-9_-]+)"/g)].map((m) => Buffer.from(m[1], 'base64url').toString('utf8'));
      for (const body of [text, ...decoded]) {
        if (SECRET_PATTERN.test(body)) offenders.push(`${file}: credential-shaped string`);
        for (const domain of trial) if (body.toLowerCase().includes(`@${domain}`)) offenders.push(`${file}: trial domain ${domain}`);
        for (const [address] of body.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
          const domain = address.split('@')[1].toLowerCase();
          if (!allowedDomains.has(domain)) offenders.push(`${file}: address outside the fixture corpus (${domain})`);
        }
      }
    }
    expect([...new Set(offenders)], `${name} must be scrubbed`).toEqual([]);
  });
});

describe('the replay reader is not silently lenient', () => {
  it('names the missing request when a replay lacks one', async () => {
    const [first] = loadGmailReplays(fixtureCapability, TWIN_DIR);
    const damaged: GmailReplay = {
      ...first,
      phases: {
        seeded: Object.fromEntries(Object.entries(first.phases.seeded).filter(([key]) => !key.includes('format=raw'))),
      },
    };
    const misses = await missesOf([damaged]);
    expect(misses).toHaveLength(1);
    expect(misses[0]).toContain('format=raw');
  });
});
