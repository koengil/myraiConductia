// @vitest-environment node
import { describe, expect, it } from 'vitest';

// The demo-only proposal hook in syncSource (#460, classify-once --propose; delete with #459). A propose step forces
// the full re-read of sync-reread.test.ts, and it receives exactly each page's unrouted messages, in memory: never a
// routed entry, a document or a skipped item. The items come from the real Gmail reader and the real normalizeMessage
// (the sync-reread.test.ts harness), so a message's unset `kind` is what the filter sees; the document case passes a
// reader page's documents through the real normalizeDocument. The real routeByFirmRules and persistItems run over an
// in-memory client that records every content_sources patch. The step reads a person's own mailbox only (ADR-0026
// exclusion 4): a team inbox or an ownerless source is re-read, routed and stored, and the step is never called,
// unless the inbox's firm is in the step's teamFirms (G-01 #173, the last describe).

import { MAILBOX_PROVIDER, SOURCE_KIND } from '@/lib/constants/discovery';
import { SourceArchivedError } from '@/lib/discovery/persist';
import type { PassOutcome, ProposeAt, ProposeStep } from '@/lib/discovery/propose/step';
import type { RoutedItem } from '@/lib/discovery/route/firmRules';
import { CheckpointExpiredError } from '@/lib/discovery/source/checkpoint';
import type { ContentSource, MailMessage, SourceItemPage } from '@/lib/discovery/source/types';
import { createGmailMailContentSource } from '@/lib/google/reader/mail';
import type { GraphDocument } from '@/lib/graph/reader';
import { passOutcomeOfError, RoutingContext, syncSource, type SyncSource } from '../../worker/sync';
import { domainRule, exclusionWith } from '../google/exclusion';
import { fakeGmail, type FakeThread } from '../google/fakeGmail';
import { memoryPersistDb } from './memoryPersistDb';

const ADDRESS = 'storm.duncan@bank.example';
const runId = '22222222-2222-4222-8222-222222222222';
/** The mailbox's owner: the step reads a person's own mailbox only (ADR-0026 exclusion 4), so the default has one. */
const OWNER = '44444444-4444-4444-8444-444444444444';
const TEAM_MAILBOX = '55555555-5555-4555-8555-555555555555';
const FIRM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_FIRM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXCLUDE_COUNSEL = exclusionWith([domainRule('outside-counsel', 'counsel.example')]);

/** Eleven one-message threads over two pages (THREADS_PER_CHUNK is 10): three carry a codename, t4 is excluded. */
function mailbox(): FakeThread[] {
  const subjects = ['Project Falcon: kickoff', 'Project Falcon: buyer list', 'Project Cobra: NDA'];
  return Array.from({ length: 11 }, (_, i) => ({
    id: `t${i + 1}`,
    messages: [
      {
        id: `t${i + 1}-m1`,
        internalDate: 1_700_000_000_000 + i * 60_000,
        subject: subjects[i] ?? `Weekly note ${i + 1}`,
        ...(i === 3 ? { to: [{ address: 'partner@counsel.example' }] } : {}),
      },
    ],
  }));
}

const freshSource = (over: Partial<SyncSource> = {}): SyncSource => ({
  id: '33333333-3333-4333-8333-333333333333',
  tenantId: '11111111-1111-4111-8111-111111111111',
  kind: SOURCE_KIND.MAILBOX,
  provider: MAILBOX_PROVIDER.GOOGLE,
  address: ADDRESS,
  ownerUserId: OWNER,
  deltaCheckpoint: null,
  backfillCompletedAt: null,
  ...over,
});

/**
 * A step that records what each page handed it, and can be told to throw. `teamFirms` is the step's approved firm
 * list (G-01 #173): empty as shipped. It also records the sources it was told were skipped and each end it was sent.
 */
function recordingStep(opts: { throwOnCall?: number; teamFirms?: string[] } = {}) {
  const calls: Array<{ entries: RoutedItem[]; at: ProposeAt }> = [];
  const ended: Array<{ at: { sourceId: string; runId: string }; outcome: PassOutcome }> = [];
  const skipped: string[] = [];
  const step: ProposeStep = {
    path: 'recorded',
    tally: { called: 0, deal: 0, newNames: 0, notDeal: 0, failed: 0, invalid: 0, skippedNotSynthetic: 0, costUsd: 0 },
    stopped: false,
    teamFirms: new Set(opts.teamFirms ?? []),
    sources: { skipped: 0, refused: 0 },
    noteSkipped(sourceId) {
      skipped.push(sourceId);
    },
    async endSource(at, outcome) {
      ended.push({ at, outcome });
    },
    async closeLapsedPasses() {},
    async run(entries, at) {
      calls.push({ entries: [...entries], at });
      if (calls.length === opts.throwOnCall) throw new Error('discovery propose: record model proposal failed (XX000)');
    },
  };
  return { step, calls, ended, skipped };
}

/** A plain pass to completion over the Gmail mailbox, then the row it left: a completed source. */
async function completedSource() {
  const gmail = fakeGmail({ address: ADDRESS, threads: mailbox() });
  const memory = memoryPersistDb();
  const reader = () => createGmailMailContentSource({ httpFor: async () => gmail.http, exclusion: EXCLUDE_COUNSEL });
  const first = await syncSource(memory.db, { source: freshSource(), reader: reader(), runId, context: new RoutingContext() });
  const completed = freshSource();
  for (const patch of memory.patches) {
    if ('delta_checkpoint' in patch) completed.deltaCheckpoint = patch.delta_checkpoint as string | null;
    if ('backfill_completed_at' in patch) completed.backfillCompletedAt = patch.backfill_completed_at as string | null;
  }
  gmail.log.length = 0;
  memory.patches.length = 0;
  return { gmail, memory, reader, first, completed };
}

/** A --propose re-read of a fresh copy of the Gmail mailbox, with a recording step. */
async function proposeRun(over: Partial<SyncSource>, step: { teamFirms?: string[] } = {}) {
  const gmail = fakeGmail({ address: ADDRESS, threads: mailbox() });
  const memory = memoryPersistDb();
  const reader = createGmailMailContentSource({ httpFor: async () => gmail.http, exclusion: EXCLUDE_COUNSEL });
  const recorded = recordingStep(step);
  const result = await syncSource(memory.db, {
    source: freshSource(over),
    reader,
    runId,
    context: new RoutingContext(),
    propose: recorded.step,
  });
  return { result, calls: recorded.calls, ended: recorded.ended, skipped: recorded.skipped, memory };
}

describe('syncSource hands each page\'s messages to a propose step (#460, #623)', () => {
  it('forces the full re-read of a completed source, and the step sees each page\'s messages, the unrouted ones exactly once', async () => {
    const { gmail, memory, reader, first, completed } = await completedSource();
    expect(first).toMatchObject({ mode: 'backfill', status: 'complete' });
    expect(JSON.parse(completed.deltaCheckpoint!)).toMatchObject({ phase: 'delta' });
    const before = structuredClone(completed);
    const { step, calls } = recordingStep();

    // No reread flag: the step alone makes it a re-read.
    const result = await syncSource(memory.db, { source: completed, reader: reader(), runId, context: new RoutingContext(), propose: step });

    expect(result).toMatchObject({ mode: 'backfill', status: 'complete', fullRead: true, checkpointAdvanced: false, pages: 2 });
    expect(gmail.log[0]).toBe('profile');
    expect(gmail.log).toContain('list');
    expect(memory.patches).toEqual([]);
    expect(completed).toEqual(before);

    // One call per page. The unrouted messages are the ones the step asks about: the seven weekly notes. The routed
    // ones ride along so their subjects can name their deals' parties (#623); the step never asks about them.
    expect(calls).toHaveLength(2);
    const handed = calls.flatMap((c) => c.entries);
    expect(handed.every((e) => e.item.kind === undefined)).toBe(true);
    const sent = handed.filter((e) => e.routes.length === 0);
    expect(sent.length).toBe(result.routing.unrouted);
    expect(sent.map((e) => e.item.subject).sort()).toEqual(
      [5, 6, 7, 8, 9, 10, 11].map((n) => `Weekly note ${n}`).sort(),
    );
    // The excluded thread is a skip, never sent; the codename mail routed and stayed out.
    expect(sent.some((e) => /Project|counsel/.test(e.item.subject))).toBe(false);
    expect(calls.every((c) => c.at.sourceId === completed.id && c.at.runId === runId)).toBe(true);
  });

  it('never hands it a document or a skipped item; a routed message rides along unasked', async () => {
    const message = (id: string, subject: string): MailMessage => ({
      id,
      internetMessageId: `<${id}@bank.example>`,
      conversationId: `conv-${id}`,
      subject,
      sentDateTime: '2026-03-02T09:00:00Z',
      from: { emailAddress: { name: 'Storm Duncan', address: 'storm.duncan@bank.example' } },
      toRecipients: [{ emailAddress: { name: 'Casey Buyer', address: 'casey@osprey-capital.example' } }],
      ccRecipients: [],
      body: { contentType: 'text', content: `Body of ${id}.` },
    });
    const document = (key: string, name: string): GraphDocument => ({
      driveItemKey: key,
      providerItemId: `item-${key}`,
      name,
      drivePath: `/Shared/${name}`,
      lastModifiedDateTime: '2026-03-02T10:00:00Z',
      authors: [{ address: 'storm.duncan@bank.example', name: 'Storm Duncan' }],
      text: `${name}, notes for the team.`,
      cTag: null,
    });
    const page: SourceItemPage = {
      items: [message('m1', 'Project Falcon: kickoff'), message('m2', 'Lunch on Friday')],
      // An unrouted document and a routed one: neither is a message.
      documents: [document('drive-1:item-1', 'Office seating plan'), document('drive-1:item-2', 'Project Falcon teaser')],
      skipped: [{ providerItemId: 'att-1', itemHash: 'a'.repeat(64), reason: 'unsupported_type' }],
      nextCheckpoint: 'cp-1',
    };
    const reader: ContentSource = {
      kind: SOURCE_KIND.MAILBOX,
      backfill: async function* () {
        yield page;
      },
      delta: async function* () {
        yield page;
      },
    };
    const { step, calls } = recordingStep();
    const result = await syncSource(memoryPersistDb().db, {
      source: freshSource({ provider: MAILBOX_PROVIDER.MICROSOFT }),
      reader,
      runId,
      context: new RoutingContext(),
      propose: step,
    });

    // Not vacuous: the page held an unrouted document, which routing counts as unrouted.
    expect(result.routing.unrouted).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].entries.map((e) => e.item.internetMessageId)).toEqual(['<m1@bank.example>', '<m2@bank.example>']);
    expect(calls[0].entries.filter((e) => e.routes.length === 0).map((e) => e.item.internetMessageId)).toEqual(['<m2@bank.example>']);
  });

  it('a throw inside the step leaves zero content_sources patches, and the stored checkpoint untouched', async () => {
    const { memory, reader, completed } = await completedSource();
    const before = structuredClone(completed);
    const { step, calls } = recordingStep({ throwOnCall: 2 });
    await expect(
      syncSource(memory.db, { source: completed, reader: reader(), runId, context: new RoutingContext(), propose: step }),
    ).rejects.toThrow('XX000');
    expect(calls).toHaveLength(2);
    // No checkpoint, no completion and no last_error: the serve loop owns the source's state.
    expect(memory.patches).toEqual([]);
    expect(completed).toEqual(before);
  });

  it.each([
    ['a team inbox', { teamMailboxId: TEAM_MAILBOX, ownerUserId: null }],
    // The team-mailbox half of the guard on its own: a team source that still names an owner.
    ['a team inbox that names an owner', { teamMailboxId: TEAM_MAILBOX }],
    ['an ownerless personal mailbox', { ownerUserId: null }],
  ] as Array<[string, Partial<SyncSource>]>)(
    'never hands %s to the step (ADR-0026 exclusion 4); its mail is read, routed and stored as on any re-read',
    async (_label, over) => {
      const owned = await proposeRun({});
      const excluded = await proposeRun(over);

      // Not vacuous: the same mailbox, owned by a person, reaches the step.
      expect(owned.calls.length).toBeGreaterThan(0);
      // No entries handed over, so the step's run (its only way to a model) is never called.
      expect(excluded.calls).toHaveLength(0);

      // Still a full re-read that moves no checkpoint, and it reads, routes and stores what the owned run did.
      expect(excluded.result).toMatchObject({ mode: 'backfill', status: 'complete', fullRead: true, checkpointAdvanced: false, pages: 2 });
      expect(excluded.memory.patches).toEqual([]);
      expect(excluded.result.storedKeys.size).toBeGreaterThan(0);
      expect([...excluded.result.storedKeys].sort()).toEqual([...owned.result.storedKeys].sort());
      expect([...excluded.memory.items.keys()].sort()).toEqual([...owned.memory.items.keys()].sort());
      expect(excluded.result.itemsRead).toBe(owned.result.itemsRead);
      expect(excluded.result.routing).toEqual(owned.result.routing);
    },
  );

  it('without a step, the patch sequence is the one it has always been', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads: mailbox() });
    const memory = memoryPersistDb();
    const reader = createGmailMailContentSource({ httpFor: async () => gmail.http, exclusion: EXCLUDE_COUNSEL });
    await syncSource(memory.db, { source: freshSource(), reader, runId, context: new RoutingContext(), propose: undefined });
    expect(memory.patches.map((patch) => Object.keys(patch).sort())).toEqual([
      ['backfill_started_at', 'checkpoint_updated_at', 'delta_checkpoint', 'send_census_from', 'table'],
      ['checkpoint_updated_at', 'delta_checkpoint', 'table'],
      ['backfill_completed_at', 'last_error', 'last_error_at', 'last_synced_at', 'table'],
    ]);
  });
});

// G-01 (#173), slice 5: a team inbox reaches the step only when its firm company is in the step's teamFirms (both
// halves of the switch, worked out by runOnce). Everything else is #683's rule, unchanged, and is counted as skipped.
describe('syncSource hands a team inbox to the step only for an approved firm (G-01 #173)', () => {
  const TEAM = { teamMailboxId: TEAM_MAILBOX, ownerUserId: null, teamFirmCompanyId: FIRM } as Partial<SyncSource>;

  it('a person\'s mailbox reaches the step as a personal source, and the end is sent once with how the read ended', async () => {
    const run = await proposeRun({});
    expect(run.calls.length).toBeGreaterThan(0);
    // The hand-off carries no claim about the source's kind: SQL decides it at begin (review F7).
    expect(run.calls.every((c) => Object.keys(c.at).sort().join() === 'runId,sourceId')).toBe(true);
    expect(run.ended).toEqual([{ at: { sourceId: '33333333-3333-4333-8333-333333333333', runId }, outcome: 'complete' }]);
    expect(run.skipped).toEqual([]);
  });

  it('a team inbox whose firm is approved reaches the step as a team source, page by page', async () => {
    const owned = await proposeRun({});
    const team = await proposeRun(TEAM, { teamFirms: [FIRM] });
    expect(team.calls).toHaveLength(owned.calls.length);
    expect(team.calls.every((c) => Object.keys(c.at).sort().join() === 'runId,sourceId')).toBe(true);
    expect(team.calls.every((c) => c.at.runId === runId)).toBe(true);
    // The same mail is read, routed and stored as for an owned mailbox, and no resume state moves.
    expect([...team.result.storedKeys].sort()).toEqual([...owned.result.storedKeys].sort());
    expect(team.memory.patches).toEqual([]);
    expect(team.skipped).toEqual([]);
    expect(team.ended).toMatchObject([{ outcome: 'complete' }]);
  });

  it.each([
    ['a firm that is not approved', { ...TEAM, teamFirmCompanyId: OTHER_FIRM }],
    ['an inbox whose firm was not read', { ...TEAM, teamFirmCompanyId: null }],
    ['an inbox with no firm field at all', { teamMailboxId: TEAM_MAILBOX, ownerUserId: null }],
  ] as Array<[string, Partial<SyncSource>]>)('never hands %s to the step, and counts it skipped once', async (_label, over) => {
    const run = await proposeRun(over, { teamFirms: [FIRM] });
    expect(run.calls).toHaveLength(0);
    expect(run.skipped).toEqual(['33333333-3333-4333-8333-333333333333']);
    // Nothing was handed over, so no pass is closed.
    expect(run.ended).toEqual([]);
    expect(run.result).toMatchObject({ status: 'complete', fullRead: true, checkpointAdvanced: false });
  });

  it('a person\'s mailbox is not affected by the approved firms', async () => {
    const run = await proposeRun({}, { teamFirms: [FIRM] });
    expect(run.calls.length).toBeGreaterThan(0);
    expect(run.skipped).toEqual([]);
  });

  it('an expired delta cursor ends the pass as paused, not as an error (review F10)', () => {
    // A propose run is always a re-read from nothing, so it reads in backfill mode and this cannot happen today; the
    // mapping is pinned so a delta propose run could not close a team pass as `error` for a cursor reset.
    const expired = new CheckpointExpiredError('google');
    expect(passOutcomeOfError(expired, 'delta')).toBe('paused');
    expect(passOutcomeOfError(expired, 'backfill')).toBe('error');
    expect(passOutcomeOfError(new SourceArchivedError(), 'delta')).toBe('archived');
    expect(passOutcomeOfError(new Error('XX000'), 'delta')).toBe('error');
  });

  it('closes the pass with the page limit, the pause, or the error that ended the read', async () => {
    const limited = await (async () => {
      const gmail = fakeGmail({ address: ADDRESS, threads: mailbox() });
      const reader = createGmailMailContentSource({ httpFor: async () => gmail.http, exclusion: EXCLUDE_COUNSEL });
      const recorded = recordingStep({ teamFirms: [FIRM] });
      const result = await syncSource(memoryPersistDb().db, {
        source: freshSource(TEAM),
        reader,
        runId,
        context: new RoutingContext(),
        propose: recorded.step,
        maxPages: 1,
      });
      return { result, ended: recorded.ended };
    })();
    expect(limited.result.status).toBe('page_limit');
    expect(limited.ended.map((e) => e.outcome)).toEqual(['page_limit']);

    const paused = await (async () => {
      const gmail = fakeGmail({ address: ADDRESS, threads: mailbox() });
      const reader = createGmailMailContentSource({ httpFor: async () => gmail.http, exclusion: EXCLUDE_COUNSEL });
      const recorded = recordingStep({ teamFirms: [FIRM] });
      const result = await syncSource(memoryPersistDb().db, {
        source: freshSource(TEAM),
        reader,
        runId,
        context: new RoutingContext(),
        propose: recorded.step,
        shouldContinue: async () => false,
      });
      return { result, ended: recorded.ended };
    })();
    expect(paused.result.status).toBe('paused');
    expect(paused.ended.map((e) => e.outcome)).toEqual(['paused']);
  });

  it('closes the pass in finally when the step throws, and when the source was archived mid-read', async () => {
    const { memory, reader, completed } = await completedSource();
    const throwing = recordingStep({ throwOnCall: 1, teamFirms: [FIRM] });
    await expect(
      syncSource(memory.db, {
        source: { ...completed, ...TEAM },
        reader: reader(),
        runId,
        context: new RoutingContext(),
        propose: throwing.step,
      }),
    ).rejects.toThrow('XX000');
    expect(throwing.ended.map((e) => e.outcome)).toEqual(['error']);

    const archived = recordingStep({ teamFirms: [FIRM] });
    const gone: ContentSource = {
      kind: SOURCE_KIND.MAILBOX,
      backfill: async function* () {
        yield* [];
        throw new SourceArchivedError();
      },
      delta: async function* () {
        yield* [];
        throw new SourceArchivedError();
      },
    };
    await expect(
      syncSource(memoryPersistDb().db, { source: freshSource(TEAM), reader: gone, runId, context: new RoutingContext(), propose: archived.step }),
    ).rejects.toBeInstanceOf(SourceArchivedError);
    expect(archived.ended.map((e) => e.outcome)).toEqual(['archived']);
  });

  it('a failed close does not fail the sync', async () => {
    const gmail = fakeGmail({ address: ADDRESS, threads: mailbox() });
    const reader = createGmailMailContentSource({ httpFor: async () => gmail.http, exclusion: EXCLUDE_COUNSEL });
    const recorded = recordingStep({ teamFirms: [FIRM] });
    recorded.step.endSource = async () => {
      throw new Error('socket hang up');
    };
    const result = await syncSource(memoryPersistDb().db, {
      source: freshSource(TEAM),
      reader,
      runId,
      context: new RoutingContext(),
      propose: recorded.step,
    });
    expect(result.status).toBe('complete');
  });
});
