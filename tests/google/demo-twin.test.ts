// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { MailMessage } from '@/lib/discovery/source/types';
import { createGmailMailContentSource } from '@/lib/google/reader/mail';
import { replayFetch } from '@/lib/google/reader/replay';
import type { GmailReplay } from '@/lib/google/replay/format';

import {
  buildGmailTwin,
  DEMO_TEAM_MAILBOX,
  DEMO_TEAM_MESSAGE_IDS,
  demoGmailSeed,
  demoTwinSeed,
  twinFileName,
  TWIN_PHASES,
  withDemoTeamMailbox,
} from '../../scripts/google/build-gmail-twin';
import { DEMO_TWIN_DIR, readLoaded, sourceFor } from './replayHarness';
import { NO_EXCLUSION } from './exclusion';

// The demo Gmail twin (cdt-261-demo-gmail D1, D2): generated from the base fixture mail (flattened to seeded)
// and demo/gmail-seed.jsonl, plus the demo team inbox's copies of eight of those messages (#581 phase 12).
// Regenerate with `npm run discovery:build-demo-corpus && npm run discovery:build-demo-twin`.

const REGENERATE = 'stale: run npm run discovery:build-demo-twin and commit';
const STORM = 'storm.duncan@bank.example';
const LATE = ['<kestrel-017@bank.example>', '<kestrel-018@aldermoor.example>'];

const twin = buildGmailTwin(demoTwinSeed());
const TEAM = DEMO_TEAM_MAILBOX;
const idsIn = (boxes: Array<{ mailbox: string; items: MailMessage[] }>) =>
  new Set(boxes.flatMap((b) => b.items.map((m) => `${b.mailbox}|${m.internetMessageId}`)));

describe('the demo Gmail twin', () => {
  it('is deterministic, and the committed files are exactly what the generator writes', () => {
    expect(buildGmailTwin(demoTwinSeed())).toEqual(twin);
    for (const replay of twin) {
      expect(readFileSync(join(DEMO_TWIN_DIR, twinFileName(replay.mailbox)), 'utf8'), REGENERATE).toBe(
        `${JSON.stringify(replay, null, 2)}\n`,
      );
    }
  });

  it('holds no file the generator does not write', () => {
    const expected = new Set(twin.map((r) => twinFileName(r.mailbox)));
    expect(readdirSync(DEMO_TWIN_DIR).filter((f) => !expected.has(f)), 'stray files: delete them, then regenerate').toEqual([]);
  });

  it('holds one synthetic replay per persona and one for the team inbox, with the three phases', () => {
    expect(twin.map((r) => r.mailbox)).toEqual(['alex.chen@bank.example', TEAM, 'morgan.vale@bank.example', STORM]);
    for (const replay of twin) {
      expect(replay.synthetic).toBe(true);
      expect(Object.keys(replay.phases)).toEqual([...TWIN_PHASES]);
    }
  });

  it('serves the base mail flattened: seeded holds Falcon-006/007 and Dinner-005, and only Kestrel arrives late', async () => {
    const seeded = idsIn(await readLoaded(twin, 'seeded'));
    const later = idsIn(await readLoaded(twin, 'after-imports'));
    const seededIds = new Set([...seeded].map((k) => k.split('|')[1]));
    for (const id of ['<falcon-006@bank.example>', '<falcon-007@bank.example>', '<dinner-005@heliotrope.example>']) {
      expect(seededIds.has(id), id).toBe(true);
    }
    expect([...later].filter((k) => !seeded.has(k)).sort()).toEqual(LATE.map((id) => `${STORM}|${id}`).sort());
  });

  it('carries no SPAM label in any phase', () => {
    expect(JSON.stringify(twin)).not.toContain('"SPAM"');
  });

  it('answers the late-mail delta: a seeded backfill, then after-imports, reads exactly the Kestrel late mail', async () => {
    const late: string[] = [];
    for (const replay of twin) {
      const source = sourceFor(replay.mailbox);
      let checkpoint: string | null = null;
      for await (const page of gmailReader(replay, 'seeded').backfill(source, null)) checkpoint = page.nextCheckpoint ?? checkpoint;
      expect(checkpoint, replay.mailbox).not.toBeNull();
      for await (const page of gmailReader(replay, 'after-imports').delta(source, checkpoint as string)) {
        late.push(...page.items.map((m) => `${replay.mailbox}|${m.internetMessageId}`));
      }
    }
    expect(late.sort()).toEqual(LATE.map((id) => `${STORM}|${id}`).sort());
  });

  // The demo team inbox (#581 phase 12): copies of demo mail, so the pipeline reads one item with two provenance rows.
  it('gives the team inbox exactly its listed messages, as copies of the demo mail, in every phase', async () => {
    for (const phase of TWIN_PHASES) {
      const read = (await readLoaded(twin, phase)).find((box) => box.mailbox === TEAM);
      expect(read?.items.map((m) => m.internetMessageId).sort(), phase).toEqual([...DEMO_TEAM_MESSAGE_IDS].sort());
    }
  });

  it('adds no message to a personal mailbox: their replays are what the demo seed alone writes', () => {
    const without = buildGmailTwin(demoGmailSeed()).filter((r) => r.mailbox !== TEAM);
    expect(twin.filter((r) => r.mailbox !== TEAM)).toEqual(without);
  });

  it('holds the Kestrel messages only Storm has, so they are team-only once he has no personal source', async () => {
    const team = (await readLoaded(twin, 'seeded')).find((box) => box.mailbox === TEAM);
    const morgan = (await readLoaded(twin, 'seeded')).find((box) => box.mailbox === 'morgan.vale@bank.example');
    const teamIds = new Set(team?.items.map((m) => m.internetMessageId));
    const morganIds = new Set(morgan?.items.map((m) => m.internetMessageId));
    const shared = [...teamIds].filter((id) => morganIds.has(id));
    expect(teamIds.has('<kestrel-005@bank.example>') && teamIds.has('<kestrel-015@bank.example>')).toBe(true);
    expect(morganIds.has('<kestrel-005@bank.example>') || morganIds.has('<kestrel-015@bank.example>')).toBe(false);
    expect(shared, 'the mixed candidate needs a Kestrel message both hold').toContain('<kestrel-004@bank.example>');
  });

  it('refuses a list that names a message the demo mail lacks, or one in the late phase', () => {
    expect(() => withDemoTeamMailbox(demoGmailSeed().filter((m) => m.messageId !== DEMO_TEAM_MESSAGE_IDS[0]))).toThrow(/demo team inbox/);
    const late = demoGmailSeed().map((m) => (m.messageId === DEMO_TEAM_MESSAGE_IDS[0] ? { ...m, phase: 'after-imports' as const } : m));
    expect(() => withDemoTeamMailbox(late)).toThrow(/demo team inbox/);
  });
});

/** The one place this file builds the Gmail reader, with no exclusion rules (the demo twin carries none). */
function gmailReader(replay: GmailReplay, phase: string) {
  return createGmailMailContentSource({
    httpFor: async () => ({ getToken: async () => 'replay', fetchImpl: replayFetch([replay], phase), sleep: async () => undefined }),
    exclusion: NO_EXCLUSION,
  });
}
