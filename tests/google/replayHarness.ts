import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MAILBOX_PROVIDER, SOURCE_KIND } from '@/lib/constants/discovery';
import type { ExclusionContext, ThreadTaint } from '@/lib/discovery/exclusion/types';
import type { MailMessage, SkippedItem, SourceRow } from '@/lib/discovery/source/types';
import { createGmailMailContentSource, parseCheckpoint, serializeCheckpoint } from '@/lib/google/reader/mail';
import { loadGmailReplays, replayFetch } from '@/lib/google/reader/replay';
import { replayKey, type GmailReplay } from '@/lib/google/replay/format';

import { fixtureCapability } from '../discovery/fixtureCapability';
import { NO_EXCLUSION } from './exclusion';

export const TWIN_DIR = join(process.cwd(), 'tests', 'fixtures', 'discovery', 'gmail-twin');
export { DEMO_TWIN_DIR } from '../../scripts/google/build-gmail-twin';
/** The dedicated exclusion twin (#263): labels, classification, markers, counsel and injection messages. Built from ../exclusion/seed.jsonl. */
export const EXCLUSION_TWIN_DIR = join(process.cwd(), 'tests', 'fixtures', 'discovery', 'exclusion', 'gmail-twin');
export const EXCLUSION_SEED_FILE = join(process.cwd(), 'tests', 'fixtures', 'discovery', 'exclusion', 'seed.jsonl');
export const RECORDED_DIR = join(process.cwd(), 'tests', 'fixtures', 'discovery', 'gmail');
export const hasRecording = (): boolean =>
  existsSync(RECORDED_DIR) && readdirSync(RECORDED_DIR).some((name) => name.endsWith('.replay.json'));

/**
 * Domains a trial recording was made on. No committed replay may name one: the
 * recorder rewrites a trial address to its persona address. The owner adds the
 * trial domain here when it is registered (emailmask.uk, the Oct 1 trial); a domain
 * listed as a test domain in .secrets/google/seeding.json (never committed) is
 * added when that file exists, so the owner's own run checks it too. emailmask.uk expired on
 * 2026-10-20 and stays here for its recordings; add the dev Workspace's domain once it is chosen.
 */
export const KNOWN_TEST_DOMAINS: readonly string[] = ['emailmask.uk'];

export function trialDomains(): string[] {
  const path = join(process.cwd(), '.secrets', 'google', 'seeding.json');
  const local = existsSync(path) ? ((JSON.parse(readFileSync(path, 'utf8')) as { testDomains?: string[] }).testDomains ?? []) : [];
  return [...KNOWN_TEST_DOMAINS, ...local].map((d) => d.toLowerCase());
}

/** The credential-shaped strings the recorder's scrubber rejects, assembled from fragments so a grep for key material finds nothing here. */
export const SECRET_PATTERN = new RegExp(
  [String.raw`ya29\.`, String.raw`Bearer\s`, '"private_' + 'key"', '-----' + 'BEGIN'].join('|'),
);

export function sourceFor(mailbox: string): SourceRow {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    tenantId: '11111111-1111-4111-8111-111111111111',
    kind: SOURCE_KIND.MAILBOX,
    provider: MAILBOX_PROVIDER.GOOGLE,
    address: mailbox,
    ownerUserId: '22222222-2222-4222-8222-222222222222',
    deltaCheckpoint: null,
  };
}

/** The real Gmail ContentSource over a replay directory, one persona at a time. */
export async function readReplay(dir: string, phase: string): Promise<ReadResult[]> {
  const replays = loadGmailReplays(fixtureCapability, dir);
  return readLoaded(replays, phase);
}

/** One request the reader made over a replay, in order: its replay key, and the body it was answered with. */
export type ReplayLogEntry = { key: string; body: unknown };

/** A fetch that answers from a replay and logs each request's replay key and response body, in order (#263, G5). */
export function loggedReplayFetch(replays: GmailReplay[], phase: string, log: ReplayLogEntry[]): typeof fetch {
  const inner = replayFetch(replays, phase);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await inner(input, init);
    log.push({ key: replayKey(init?.method ?? 'GET', String(input)), body: await response.clone().json() });
    return response;
  }) as typeof fetch;
}

export type ReadResult = { mailbox: string; items: MailMessage[]; skipped: SkippedItem[]; threadTaints: ThreadTaint[] };

export async function readLoaded(
  replays: GmailReplay[],
  phase: string,
  options: { exclusion?: ExclusionContext; log?: ReplayLogEntry[] } = {},
): Promise<ReadResult[]> {
  const fetchImpl = options.log ? loggedReplayFetch(replays, phase, options.log) : replayFetch(replays, phase);
  const reader = createGmailMailContentSource({
    httpFor: async () => ({ getToken: async () => 'replay', fetchImpl, sleep: async () => undefined }),
    exclusion: options.exclusion ?? NO_EXCLUSION,
  });
  const out: ReadResult[] = [];
  for (const replay of replays) {
    const result: ReadResult = { mailbox: replay.mailbox, items: [], skipped: [], threadTaints: [] };
    for await (const page of reader.backfill(sourceFor(replay.mailbox), null)) {
      result.items.push(...page.items);
      result.skipped.push(...(page.skipped ?? []));
      result.threadTaints.push(...(page.threadTaints ?? []));
    }
    out.push(result);
  }
  return out;
}

/** The history id a replay's profile answers in a phase: what a checkpoint written by a backfill of that phase holds. */
export function profileHistoryId(replay: GmailReplay, phase: string): string {
  const key = Object.keys(replay.phases[phase]).find((k) => /\/profile$/.test(k));
  const id = key ? (replay.phases[phase][key][0].body as { historyId?: string }).historyId : undefined;
  if (!id) throw new Error(`no profile history id in ${replay.mailbox} ${phase}`);
  return id;
}

/** The incremental pass over a replay phase, from the history id a backfill of an earlier phase left. */
export async function readDeltaLoaded(
  replays: GmailReplay[],
  phase: string,
  options: { historyId: string; exclusion?: ExclusionContext; log?: ReplayLogEntry[] },
): Promise<ReadResult[]> {
  const fetchImpl = options.log ? loggedReplayFetch(replays, phase, options.log) : replayFetch(replays, phase);
  const reader = createGmailMailContentSource({
    httpFor: async () => ({ getToken: async () => 'replay', fetchImpl, sleep: async () => undefined }),
    exclusion: options.exclusion ?? NO_EXCLUSION,
  });
  const checkpoint = serializeCheckpoint({
    ...parseCheckpoint(null),
    phase: 'delta',
    startHistoryId: options.historyId,
    historyId: options.historyId,
  });
  const out: ReadResult[] = [];
  for (const replay of replays) {
    const result: ReadResult = { mailbox: replay.mailbox, items: [], skipped: [], threadTaints: [] };
    for await (const page of reader.delta(sourceFor(replay.mailbox), checkpoint)) {
      result.items.push(...page.items);
      result.skipped.push(...(page.skipped ?? []));
      result.threadTaints.push(...(page.threadTaints ?? []));
    }
    out.push(result);
  }
  return out;
}
