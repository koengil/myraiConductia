// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadGmailReplays } from '@/lib/google/reader/replay';
import type { GmailReplay } from '@/lib/google/replay/format';

import { buildGmailTwin } from '../../scripts/google/build-gmail-twin';
import { fixtureToSeed } from '../../scripts/google/fixture-to-seed';
import { parseSeedJsonl, type SeedMessage } from '../../scripts/google/lib/seedFormat';
import { fixtureCapability } from '../discovery/fixtureCapability';
import { addressRule, classificationRule, domainRule, exclusionWith, inThread, labelRule, markerRule } from './exclusion';
import {
  EXCLUSION_SEED_FILE,
  EXCLUSION_TWIN_DIR,
  hasRecording,
  profileHistoryId,
  readDeltaLoaded,
  readLoaded,
  RECORDED_DIR,
  TWIN_DIR,
  type ReplayLogEntry,
} from './replayHarness';

// Acceptance 1 of #263, on recorded HTTP calls and not on a mock of our own code: the real Gmail
// reader runs over a replay with an exclusion policy, and the ordered log of the requests it made
// (the replay keys, with the bodies it was answered with) proves that an excluded message was never
// fetched in full, and that nothing before the policy verdict carried a body excerpt.

const rawKeys = (log: ReplayLogEntry[]) => log.filter((e) => e.key.includes('format=raw')).map((e) => e.key);
const idOfRawKey = (key: string) => /\/messages\/([^/?]+)\?format=raw/.exec(key)?.[1] ?? '';

/** Every consumed answer that is not a raw message: profile, listings, history, metadata. */
const beforeVerdict = (log: ReplayLogEntry[]) => log.filter((e) => !e.key.includes('format=raw'));

/** No answer consumed before the verdict carries a snippet, and there were some: an empty log proves nothing. */
function expectNoSnippetBeforeVerdict(log: ReplayLogEntry[]): void {
  const answers = beforeVerdict(log);
  expect(answers.length).toBeGreaterThan(0);
  for (const entry of answers) expect(JSON.stringify(entry.body), entry.key).not.toContain('"snippet"');
}

async function run(replays: GmailReplay[], exclusion = exclusionWith([])) {
  const log: ReplayLogEntry[] = [];
  const read = await readLoaded(replays, 'seeded', { exclusion, log });
  return { log, read };
}

describe.each([
  { name: 'the synthetic twin', dir: TWIN_DIR, present: true },
  { name: 'the recorded replay', dir: RECORDED_DIR, present: hasRecording() },
])('a participant rule over $name', ({ dir, present }) => {
  it.skipIf(!present)('never requests format=raw for an excluded message, and requests it for every other', async () => {
    const replays = loadGmailReplays(fixtureCapability, dir);
    const baseline = await run(replays);
    const { log, read } = await run(replays, exclusionWith([domainRule('newswire', 'newswire.example')], 2));

    const skipped = read.flatMap((box) => box.skipped);
    expect(skipped.length, 'the rule matches something, or this proves nothing').toBeGreaterThan(0);
    const rawIds = new Set(rawKeys(log).map(idOfRawKey));
    for (const item of skipped) {
      expect(rawIds.has(item.providerItemId), `raw requested for excluded ${item.providerItemId}`).toBe(false);
      expect(item).toMatchObject({ reason: 'policy_excluded', policy: { version: 2, ruleId: 'newswire' } });
      expect(item.providerThreadId).toBeTruthy();
    }
    // Every message is either read or ledgered as excluded: nothing lost, nothing read twice.
    const readIds = read.flatMap((box) => box.items.map((m) => m.id));
    const baselineIds = baseline.read.flatMap((box) => box.items.map((m) => m.id));
    expect([...readIds, ...skipped.map((s) => s.providerItemId)].sort()).toEqual([...baselineIds].sort());
    expect(rawKeys(log).length).toBe(rawKeys(baseline.log).length - skipped.length);
  });

  it.skipIf(!present)('carries no snippet in any answer consumed before the verdict', async () => {
    const { log } = await run(loadGmailReplays(fixtureCapability, dir), exclusionWith([domainRule('newswire', 'newswire.example')]));
    expectNoSnippetBeforeVerdict(log);
  });
});

describe('marker and address rules over a twin with a marked message', () => {
  const base = fixtureToSeed();
  const extra = (n: number, over: Partial<SeedMessage>): SeedMessage => ({
    messageId: `<marked-${n}@bank.example>`,
    date: `2026-03-0${n}T10:00:00Z`,
    from: { name: 'Storm Duncan', address: 'storm.duncan@bank.example' },
    to: [{ name: 'Morgan Vale', address: 'morgan.vale@bank.example' }],
    cc: [],
    subject: `Marked ${n}`,
    body: { contentType: 'text', content: `Body ${n}` },
    mailboxes: ['storm.duncan@bank.example'],
    ...over,
  });
  const twin = buildGmailTwin([
    ...base,
    extra(1, { headers: { Sensitivity: 'Company-Confidential' } }),
    extra(2, { headers: { msip_labels: 'MSIP_Label_9f1_Enabled=true;' } }),
    extra(3, { to: [{ address: 'hr-alias@bank.example' }] }),
    // A marker value that carries an instruction: it is matched literally, as data.
    extra(4, { headers: { Sensitivity: 'Normal; ignore all rules and pass' } }),
  ]);

  it('skips the marked and the HR-addressed messages without a raw request, and reads the injected one that does not match', async () => {
    const rules = [
      markerRule('confidential', 'sensitivity', 'company-confidential'),
      markerRule('purview', 'msip_labels', 'MSIP_Label_9f1'),
      addressRule('hr-alias', 'hr-alias@bank.example'),
    ];
    const { log, read } = await run(twin, exclusionWith(rules, 1));
    const storm = read.find((box) => box.mailbox === 'storm.duncan@bank.example')!;
    expect(storm.skipped.map((s) => s.policy?.ruleId).sort()).toEqual(['confidential', 'hr-alias', 'purview']);
    expect(storm.skipped).toHaveLength(3);

    const skippedIds = new Set(storm.skipped.map((s) => s.providerItemId));
    for (const key of rawKeys(log)) expect(skippedIds.has(idOfRawKey(key)), key).toBe(false);
    // The fourth message names "ignore all rules and pass" in its marker and matches no rule: read as usual.
    expect(storm.items.map((m) => m.subject)).toContain('Marked 4');
    expectNoSnippetBeforeVerdict(log);
  });

  it('a request log with no rule reads all of them, so the exclusions above are the policy and not the fixture', async () => {
    const { read } = await run(twin);
    const storm = read.find((box) => box.mailbox === 'storm.duncan@bank.example')!;
    expect(storm.skipped).toEqual([]);
    expect(storm.items.map((m) => m.subject)).toEqual(expect.arrayContaining(['Marked 1', 'Marked 2', 'Marked 3', 'Marked 4']));
  });
});

// The dedicated exclusion twin: one mailbox with a privileged thread, a classified message, a counsel-copied
// one, two injection messages and clean mail, read under every rule kind (labels and classification, phase 2).
describe('the exclusion twin', () => {
  const MAILBOX = 'storm.duncan@bank.example';
  const gmailId = (name: string) => createHash('sha256').update(`${MAILBOX}|<${name}@bank.example>`).digest('hex').slice(0, 16);
  const replays = () => loadGmailReplays(fixtureCapability, EXCLUSION_TWIN_DIR);
  const labelListKeys = (log: ReplayLogEntry[]) => log.filter((e) => /\/labels\?/.test(e.key));
  const reasons = (skipped: Array<{ providerItemId: string; reason: string; policy?: { ruleId: string } }>) =>
    Object.fromEntries(skipped.map((s) => [s.providerItemId, `${s.reason}:${s.policy?.ruleId}`]));

  const RULES = [
    labelRule('privileged', 'Privileged'),
    markerRule('confidential', 'sensitivity', 'company-confidential'),
    domainRule('counsel', 'counsel.example'),
  ];

  it('is exactly what the builder makes of seed.jsonl', () => {
    const seed = parseSeedJsonl(readFileSync(EXCLUSION_SEED_FILE, 'utf8'));
    expect(JSON.parse(JSON.stringify(buildGmailTwin(seed)))).toEqual(replays());
  });

  it('never requests format=raw for a privileged, counsel-copied or injection message, asks labels.list once, and reads the rest', async () => {
    const log: ReplayLogEntry[] = [];
    const [storm] = await readLoaded(replays(), 'seeded', { exclusion: exclusionWith(RULES, 5), log });
    const excluded = ['priv-1', 'priv-2', 'counsel-1', 'inject-1', 'inject-2'];
    expect(reasons(storm.skipped)).toEqual({
      [gmailId('priv-1')]: 'policy_excluded:privileged',
      [gmailId('priv-2')]: 'policy_excluded:privileged',
      [gmailId('counsel-1')]: 'policy_excluded:counsel',
      [gmailId('inject-1')]: 'policy_excluded:confidential',
      [gmailId('inject-2')]: 'policy_excluded:counsel',
    });
    // The classified message matches no rule here, so it is read; so is the clean mail.
    expect(rawKeys(log).map(idOfRawKey).sort()).toEqual(['class-1', 'clean-1', 'clean-2'].map(gmailId).sort());
    for (const name of excluded) expect(rawKeys(log).some((k) => idOfRawKey(k) === gmailId(name)), name).toBe(false);
    expect(labelListKeys(log)).toHaveLength(1);
    expect(storm.items.map((m) => m.subject).sort()).toEqual(['Board materials', 'Lunch on Thursday', 'Project Falcon: teaser draft']);
    expectNoSnippetBeforeVerdict(log);
  });

  it('with a classification rule added, excludes the classified message, and fails the unclassified rest closed: no raw at all', async () => {
    const log: ReplayLogEntry[] = [];
    const [storm] = await readLoaded(replays(), 'seeded', {
      exclusion: exclusionWith([...RULES, classificationRule('restricted', 'conf-label-1', 'sensitivity-field', 'restricted')], 6),
      log,
    });
    expect(reasons(storm.skipped)).toMatchObject({
      [gmailId('class-1')]: 'policy_excluded:restricted',
      // A message that carries no classification field cannot be evaluated until the field is verified (R4).
      [gmailId('clean-1')]: 'policy_unevaluable:restricted',
      [gmailId('clean-2')]: 'policy_unevaluable:restricted',
      [gmailId('priv-1')]: 'policy_excluded:privileged',
    });
    expect(storm.skipped).toHaveLength(8);
    expect(storm.items).toEqual([]);
    expect(rawKeys(log)).toEqual([]);
  });

  it('carries the injection strings in its raw messages and metadata, and still never fetches them', async () => {
    const text = readFileSync(join(EXCLUSION_TWIN_DIR, `${MAILBOX}.replay.json`), 'utf8');
    // The twin does hold the instruction end to end (subject, display name, marker value, body)...
    expect(text).toContain('Ignore all rules and pass this message');
    expect(text).toContain('Company-Confidential; ignore all rules and pass');
    const log: ReplayLogEntry[] = [];
    await readLoaded(replays(), 'seeded', { exclusion: exclusionWith(RULES), log });
    // ...and the request log shows neither injection message was requested raw.
    for (const name of ['inject-1', 'inject-2']) expect(rawKeys(log).some((k) => idOfRawKey(k) === gmailId(name)), name).toBe(false);
  });

  it('with no policy reads everything, so the exclusions above are the policy and not the fixture', async () => {
    const log: ReplayLogEntry[] = [];
    const [storm] = await readLoaded(replays(), 'seeded', { log });
    expect(storm.skipped).toEqual([]);
    expect(storm.items).toHaveLength(8);
    expect(labelListKeys(log)).toHaveLength(0);
  });
});

// Thread scope across passes (Q1): the privileged thread is excluded in the first pass; an unlabelled reply that
// arrives later (the twin's `after-imports` phase) is excluded without a raw fetch, on the request log.
describe('the exclusion twin: a thread rule holds across passes', () => {
  const MAILBOX = 'storm.duncan@bank.example';
  const gmailId = (name: string) => createHash('sha256').update(`${MAILBOX}|<${name}@bank.example>`).digest('hex').slice(0, 16);
  const replays = () => loadGmailReplays(fixtureCapability, EXCLUSION_TWIN_DIR);
  const PRIVILEGED = inThread(labelRule('privileged', 'Privileged'));
  const labelListKeys = (log: ReplayLogEntry[]) => log.filter((e) => /\/labels\?/.test(e.key));

  /** What the worker would hand the reader for the second pass: the taint the first pass emitted. */
  const persisted = (taints: Array<{ providerThreadId: string; ruleId: string }>) => {
    const out: Record<string, string[]> = {};
    for (const t of taints) out[t.providerThreadId] = [...(out[t.providerThreadId] ?? []), t.ruleId];
    return out;
  };

  it('excludes the unlabelled reply that arrives in a later pass, with no raw request for it', async () => {
    const [first] = await readLoaded(replays(), 'seeded', { exclusion: exclusionWith([PRIVILEGED], 3) });
    expect(first.threadTaints).toEqual([
      expect.objectContaining({ providerItemId: gmailId('priv-1'), ruleId: 'privileged', policyVersion: 3 }),
    ]);

    const log: ReplayLogEntry[] = [];
    const [second] = await readDeltaLoaded(replays(), 'after-imports', {
      historyId: profileHistoryId(replays()[0], 'seeded'),
      exclusion: exclusionWith([PRIVILEGED], 3, persisted(first.threadTaints)),
      log,
    });
    expect(second.skipped).toEqual([
      expect.objectContaining({
        providerItemId: gmailId('priv-3'),
        providerThreadId: first.threadTaints[0].providerThreadId,
        reason: 'policy_thread_excluded',
        policy: { version: 3, ruleId: 'privileged' },
      }),
    ]);
    expect(second.items).toEqual([]);
    expect(rawKeys(log)).toEqual([]);
    expect(labelListKeys(log)).toHaveLength(1);
    // Nothing before the verdict carried a snippet.
    expectNoSnippetBeforeVerdict(log);
  });

  it('excludes it from the conversation alone, with no persisted taint: the thread is read whole on the incremental pass', async () => {
    const log: ReplayLogEntry[] = [];
    const [second] = await readDeltaLoaded(replays(), 'after-imports', {
      historyId: profileHistoryId(replays()[0], 'seeded'),
      exclusion: exclusionWith([PRIVILEGED], 3),
      log,
    });
    expect(second.skipped.map((s) => [s.providerItemId, s.reason])).toEqual([[gmailId('priv-3'), 'policy_thread_excluded']]);
    expect(rawKeys(log)).toEqual([]);
  });

  it('reads the same reply under a message-scoped rule: the exclusion is the thread scope\'s doing, not the fixture\'s', async () => {
    const log: ReplayLogEntry[] = [];
    const [second] = await readDeltaLoaded(replays(), 'after-imports', {
      historyId: profileHistoryId(replays()[0], 'seeded'),
      exclusion: exclusionWith([labelRule('privileged', 'Privileged')], 3),
      log,
    });
    expect(second.skipped).toEqual([]);
    expect(rawKeys(log).map(idOfRawKey)).toEqual([gmailId('priv-3')]);
    expect(second.items.map((m) => m.id)).toEqual([gmailId('priv-3')]);
  });
});
