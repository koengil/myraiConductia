// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadGmailReplays, replayFetch, ReplayMissError } from '@/lib/google/reader/replay';
import { GMAIL_REPLAY_FORMAT, type GmailReplay } from '@/lib/google/replay/format';

import { buildGmailTwin, twinFileName, STALE_HISTORY_ID, TWIN_PHASES } from '../../scripts/google/build-gmail-twin';
import { fixtureToSeed } from '../../scripts/google/fixture-to-seed';
import { mergeReplays } from '../../scripts/google/merge-replay';
import { fixtureCapability } from '../discovery/fixtureCapability';
import { readLoaded, TWIN_DIR } from './replayHarness';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'gmail-replay-'));
  dirs.push(dir);
  return dir;
};

const A = 'a@bank.example';
const B = 'b@bank.example';
const replayOf = (mailbox: string, keys: GmailReplay['phases'][string], phase = 'seeded'): GmailReplay => ({
  format: GMAIL_REPLAY_FORMAT,
  mailbox,
  synthetic: true,
  phases: { [phase]: keys },
});
const profileKey = (mailbox: string) => `GET /gmail/v1/users/${mailbox}/profile`;
const profileUrl = (mailbox: string) => `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(mailbox)}/profile`;

describe('replayFetch', () => {
  it('answers from the mailbox and phase the request names', async () => {
    const fetchImpl = replayFetch(
      [replayOf(A, { [profileKey(A)]: [{ status: 200, body: { historyId: '1' } }] }), replayOf(B, { [profileKey(B)]: [{ status: 200, body: { historyId: '2' } }] })],
      'seeded',
    );
    expect(await (await fetchImpl(profileUrl(B))).json()).toEqual({ historyId: '2' });
    expect(await (await fetchImpl(profileUrl(A))).json()).toEqual({ historyId: '1' });
  });

  it('consumes an ordered list in order and repeats the last answer', async () => {
    const fetchImpl = replayFetch(
      [replayOf(A, { [profileKey(A)]: [{ status: 429, body: {}, synthetic: true }, { status: 200, body: { historyId: '1' } }] })],
      'seeded',
    );
    expect((await fetchImpl(profileUrl(A))).status).toBe(429);
    expect((await fetchImpl(profileUrl(A))).status).toBe(200);
    expect((await fetchImpl(profileUrl(A))).status).toBe(200);
  });

  it('fails loudly, naming the request without its query, for a request the replay lacks', async () => {
    const fetchImpl = replayFetch([replayOf(A, {})], 'seeded');
    const error = await fetchImpl(`${profileUrl(A)}?pageToken=SECRET-TOKEN`).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReplayMissError);
    expect((error as Error).message).toContain(`/users/${A}/profile`);
    expect((error as Error).message).not.toContain('SECRET-TOKEN');
  });

  it('misses a phase the mailbox has no answers for, and a mailbox it does not hold', async () => {
    const fetchImpl = replayFetch([replayOf(A, { [profileKey(A)]: [{ status: 200, body: {} }] })], 'after-imports');
    await expect(fetchImpl(profileUrl(A))).rejects.toBeInstanceOf(ReplayMissError);
    await expect(replayFetch([replayOf(A, {})], 'seeded')(profileUrl(B))).rejects.toBeInstanceOf(ReplayMissError);
  });
});

describe('loadGmailReplays', () => {
  it('demands the reader capability before it reads the directory', () => {
    expect(() => loadGmailReplays({} as never, '/does/not/exist')).toThrow(expect.objectContaining({ reason: 'no_capability' }));
  });

  it('loads *.replay.json files in name order and ignores everything else', () => {
    const dir = tempDir();
    writeFileSync(join(dir, `${B}.replay.json`), JSON.stringify(replayOf(B, {})));
    writeFileSync(join(dir, `${A}.replay.json`), JSON.stringify(replayOf(A, {})));
    writeFileSync(join(dir, `${A}.seeded.json`), 'not a replay');
    expect(loadGmailReplays(fixtureCapability, dir).map((r) => r.mailbox)).toEqual([A, B]);
  });

  it('refuses a file in another format', () => {
    const dir = tempDir();
    writeFileSync(join(dir, `${A}.replay.json`), JSON.stringify({ ...replayOf(A, {}), format: 'other/v9' }));
    expect(() => loadGmailReplays(fixtureCapability, dir)).toThrow(/Unknown replay format/);
  });
});

describe('the synthetic twin', () => {
  const twin = buildGmailTwin(fixtureToSeed());
  const byMailbox = Object.fromEntries(twin.map((r) => [r.mailbox, r]));
  const storm = byMailbox['storm.duncan@bank.example'];
  const keysOf = (r: GmailReplay, phase: string) => Object.keys(r.phases[phase]);

  it('is deterministic, and the committed files are exactly what the generator writes', () => {
    expect(buildGmailTwin(fixtureToSeed())).toEqual(twin);
    for (const replay of twin) {
      expect(readFileSync(join(TWIN_DIR, twinFileName(replay.mailbox)), 'utf8')).toBe(`${JSON.stringify(replay, null, 2)}\n`);
    }
  });

  it('holds one synthetic replay per persona, with the three phases', () => {
    expect(twin.map((r) => r.mailbox)).toEqual(['alex.chen@bank.example', 'morgan.vale@bank.example', 'storm.duncan@bank.example']);
    for (const replay of twin) {
      expect(replay.synthetic).toBe(true);
      expect(Object.keys(replay.phases)).toEqual([...TWIN_PHASES]);
    }
  });

  it('gives two mailboxes different Gmail message and thread ids for the same message (R18)', () => {
    const morgan = byMailbox['morgan.vale@bank.example'];
    const raws = (r: GmailReplay) => keysOf(r, 'seeded').filter((k) => k.includes('format=raw'));
    const shared = raws(storm).map((k) => k.split('/messages/')[1]).filter((k) => raws(morgan).some((m) => m.split('/messages/')[1] === k));
    expect(shared).toEqual([]);
  });

  it('mirrors the mailbox state: SPAM at first, both imports later, back in the inbox last', () => {
    const raw = (phase: string) => keysOf(storm, phase).filter((k) => k.includes('format=raw')).length;
    expect(raw('after-imports')).toBe(raw('seeded') + 1); // falcon-006 arrives in Storm's mailbox
    expect(raw('after-unspam')).toBe(raw('after-imports'));
    const spamLabels = (phase: string) =>
      Object.values(storm.phases[phase])
        .flatMap((list) => list.map((r) => r.body as { labelIds?: string[] }))
        .filter((b) => b?.labelIds?.includes('SPAM')).length;
    expect(spamLabels('seeded')).toBeGreaterThan(0);
    expect(spamLabels('after-imports')).toBeGreaterThan(0);
    expect(spamLabels('after-unspam')).toBe(0);
  });

  it('answers history.list from every id a reader may hold, and 404 for a stale start in every phase', () => {
    const history = (phase: string) => keysOf(storm, phase).filter((k) => k.includes('/history?'));
    const startOf = (key: string) => Number(key.split('startHistoryId=')[1]);
    const real = (phase: string) => history(phase).filter((k) => !k.endsWith(`startHistoryId=${STALE_HISTORY_ID}`));
    // One key per id a checkpoint of this phase or an earlier one may hold, the stale start beside them.
    expect(real('seeded')).toHaveLength(1);
    expect(real('after-imports')).toHaveLength(2);
    expect(real('after-unspam')).toHaveLength(3);
    for (const phase of TWIN_PHASES) {
      expect(history(phase)).toHaveLength(real(phase).length + 1);
      const stale = storm.phases[phase][history(phase).find((k) => k.endsWith(`startHistoryId=${STALE_HISTORY_ID}`)) as string];
      expect(stale).toEqual([expect.objectContaining({ status: 404, synthetic: true })]);
    }
    type Answer = { history?: Array<{ id: string; messagesAdded?: unknown; labelsRemoved?: unknown }>; historyId: string };
    const answer = (phase: string, key: string) => storm.phases[phase][key][0].body as Answer;
    // A poll from the phase's own id has nothing new, and says so without a history key.
    for (const phase of TWIN_PHASES) {
      const own = real(phase).sort((a, b) => startOf(b) - startOf(a))[0];
      expect(answer(phase, own).history).toBeUndefined();
      expect(String(startOf(own))).toBe(answer(phase, own).historyId);
    }
    // From the seeded id, the last phase holds the import and the un-spam; from the imports' id, only the un-spam.
    const [fromSeeded, fromImports] = real('after-unspam').sort((a, b) => startOf(a) - startOf(b));
    expect(answer('after-unspam', fromSeeded).history?.some((h) => h.messagesAdded)).toBe(true);
    expect(answer('after-unspam', fromSeeded).history?.some((h) => h.labelsRemoved)).toBe(true);
    expect(answer('after-unspam', fromImports).history?.every((h) => h.labelsRemoved && !h.messagesAdded)).toBe(true);
    // Record ids are sequential and each poll answers only the records after its start.
    for (const key of [fromSeeded, fromImports]) {
      const ids = (answer('after-unspam', key).history ?? []).map((h) => Number(h.id));
      expect(ids.every((id) => id > startOf(key))).toBe(true);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
    }
  });

  it('answers each message\'s metadata in every phase (the recorder\'s superset: the incremental pass reads a whole thread with threads.get since #263)', () => {
    for (const phase of TWIN_PHASES) {
      const raws = keysOf(storm, phase).filter((k) => k.includes('format=raw'));
      const metadata = keysOf(storm, phase).filter((k) => /\/messages\/[^/?]+\?fields=[^&]+&format=metadata/.test(k));
      expect(metadata.map((k) => k.split('/messages/')[1].split('?')[0]).sort()).toEqual(
        raws.map((k) => k.split('/messages/')[1].split('?')[0]).sort(),
      );
    }
  });

  it('marks its hand-written responses synthetic: one 429 then 200 per mailbox and phase', () => {
    for (const replay of twin) {
      for (const phase of TWIN_PHASES) {
        const throttled = Object.entries(replay.phases[phase]).filter(([, list]) => list[0].status === 429);
        expect(throttled).toHaveLength(1);
        expect(throttled[0][1].map((r) => r.status)).toEqual([429, 200]);
        expect(throttled[0][1][0].synthetic).toBe(true);
      }
    }
  });

  it('reads through the real reader: the throttled message is read after the back-off, none is lost', async () => {
    const boxes = await readLoaded(twin, 'seeded');
    const expected = fixtureToSeed()
      .filter((m) => m.phase === 'seeded' && !m.labels?.includes('SPAM'))
      .flatMap((m) => m.mailboxes.map((mailbox) => `${mailbox}|${m.messageId}`))
      .sort();
    const read = boxes.flatMap((b) => b.items.map((m) => `${b.mailbox}|${m.internetMessageId}`)).sort();
    // The SPAM message and the two imports are absent; every other copy is read, including each mailbox's throttled first message.
    expect(read).toEqual(expected);
  });
});

describe('mergeReplays', () => {
  const phase = (mailbox: string, name: string): GmailReplay => ({ ...replayOf(mailbox, { [profileKey(mailbox)]: [{ status: 200, body: { historyId: name } }] }, name), synthetic: false });

  it('joins the recorder per-phase files into one replay per mailbox', () => {
    const merged = mergeReplays([
      { name: 'x', replay: phase(A, 'seeded') },
      { name: 'y', replay: phase(A, 'after-imports') },
      { name: 'z', replay: phase(B, 'seeded') },
    ]);
    expect(merged.map((r) => [r.mailbox, Object.keys(r.phases)])).toEqual([[A, ['seeded', 'after-imports']], [B, ['seeded']]]);
    expect(merged[0].synthetic).toBe(false);
  });

  it('refuses the same phase twice, another format, and a secret-shaped string', () => {
    expect(() => mergeReplays([{ name: 'x', replay: phase(A, 'seeded') }, { name: 'y', replay: phase(A, 'seeded') }])).toThrow(/more than one file/);
    expect(() => mergeReplays([{ name: 'x', replay: { ...phase(A, 'seeded'), format: 'other' as never } }])).toThrow(/not a conductia/);
    const leaky = phase(A, 'seeded');
    leaky.phases.seeded[profileKey(A)] = [{ status: 200, body: { note: 'Bearer abc' } }];
    expect(() => mergeReplays([{ name: 'x', replay: leaky }])).toThrow(/secret-shaped/);
  });
});
