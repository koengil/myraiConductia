// First import, on purpose: it claims the reader capability before any other module loads
// (tests/mailbox-access/boot-claim.test.ts pins the order). The Google primitives come through
// the operator door, never from a reader module (tests/mailbox-access-pins.test.ts).
import { googleOperatorKit } from '../../src/lib/mailboxAccess/readers';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  GMAIL_HISTORY_FIELDS,
  GMAIL_METADATA_QUERY,
  GMAIL_READER_SCOPE,
  GMAIL_THREAD_LIST_FIELDS,
  GMAIL_THREAD_METADATA_QUERY,
} from '../../src/lib/constants/googleReader';
import { GMAIL_REPLAY_FORMAT, replayKey, type GmailReplay, type ReplayResponse } from '../../src/lib/google/replay/format';
import type { GetGoogleToken } from '../../src/lib/google/reader/http';
import { announceLiveRun, argValue, assertOutsideRepo, assertSecretsFolderKeyless, requireLiveRun } from './lib/live';
import { scrubReplay } from './lib/scrub';
import { loadSeedingConfig, trialDomain } from './lib/seedConfig';

export { scrubReplay } from './lib/scrub';

const { GoogleHttpError, createCallerTokenSource, createDelegatedTokenCache, googleFetch } = googleOperatorKit();

// The generic recorder (#259 R15). Records what the real Gmail reader path
// would see for a mailbox, in one phase of its state (seeded, after-imports,
// after-unspam), as conductia.gmail-replay/v1. It reads with a gmail.readonly
// token minted through the DWD service account (the reader's own identity), so
// the recording proves the real path. Announce the run to the owner first.
//
//   npm run google:record-replay -- --live --confirm-domain <trial domain> \
//     --phase seeded|after-imports|after-unspam --mailboxes <persona,...> \
//     --registration .secrets/google/registration.json --out <dir outside the repo>
//
// One file per mailbox and phase, <out>/<persona>.<phase>.json, mode 0600, never
// overwritten. Request headers and response headers are never recorded.
//
// Synthetic trial domain only. It records the raw body of every message it lists
// (format=raw), with no exclusion policy in front of it: it captures what the reader
// could see, not what a policy lets it read. Never point it at a bank's or any real
// mailbox. requireLiveRun enforces this (--live, and --confirm-domain must equal the
// trial domain named in the seeding config), and recordings stay outside the repo.

// The recorder asks exactly what the reader asks (src/lib/constants/googleReader.ts: the header list and the `fields`
// masks, which keep Gmail's snippet out of every listing and metadata answer), so a recording has the reader's keys.

/** Recordings stay outside the repo, except under evals/out/. */
export function assertRecordingTarget(outDir: string, repoRoot: string = process.cwd()): string {
  return assertOutsideRepo(outDir, repoRoot, ['evals/out']);
}

export type RecordDeps = {
  /** Performs one GET against the trial address and returns the recorded response. */
  get: (url: string) => Promise<ReplayResponse>;
  /** The address in request paths as Google sees it. */
  trialAddress: string;
  /** The address in the recording (the persona). */
  persona: string;
  phase: string;
  /** history.list start: the historyId of the seeded profile, for the later phases. */
  startHistoryId?: string;
};

type Page = { nextPageToken?: string };

/** Records the superset of requests the reader could make for one mailbox in one phase. */
export async function recordMailbox(deps: RecordDeps): Promise<GmailReplay> {
  const recorded: Record<string, ReplayResponse[]> = {};
  const base = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(deps.trialAddress)}`;
  const personaUrl = (url: string): string => url.split(encodeURIComponent(deps.trialAddress)).join(encodeURIComponent(deps.persona));
  const record = async (url: string): Promise<ReplayResponse> => {
    const response = await deps.get(url);
    const key = replayKey('GET', personaUrl(url));
    (recorded[key] ??= []).push(response);
    return response;
  };
  const pages = async (path: string, extra: string, listKey: string): Promise<Array<Record<string, unknown>>> => {
    const items: Array<Record<string, unknown>> = [];
    let pageToken: string | undefined;
    do {
      const response = await record(`${base}${path}?${extra}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
      const body = (response.body ?? {}) as Page & Record<string, unknown>;
      items.push(...(((body[listKey] as Array<Record<string, unknown>> | undefined) ?? [])));
      pageToken = body.nextPageToken;
    } while (pageToken);
    return items;
  };

  await record(`${base}/profile`);
  const threads = await pages('/threads', `includeSpamTrash=false&maxResults=100&fields=${GMAIL_THREAD_LIST_FIELDS}`, 'threads');
  for (const thread of threads) {
    await record(`${base}/threads/${encodeURIComponent(String(thread.id))}?${GMAIL_THREAD_METADATA_QUERY}`);
  }
  const messages = await pages('/messages', 'includeSpamTrash=false&maxResults=100', 'messages');
  for (const message of messages) {
    const id = encodeURIComponent(String(message.id));
    await record(`${base}/messages/${id}?${GMAIL_METADATA_QUERY}`);
    await record(`${base}/messages/${id}?format=raw`);
  }
  if (deps.startHistoryId) {
    await pages(
      '/history',
      `historyTypes=messageAdded&historyTypes=labelRemoved&maxResults=100&startHistoryId=${encodeURIComponent(deps.startHistoryId)}&fields=${GMAIL_HISTORY_FIELDS}`,
      'history',
    );
  }

  return {
    format: GMAIL_REPLAY_FORMAT,
    mailbox: deps.persona,
    synthetic: false,
    phases: { [deps.phase]: recorded },
  };
}

/** The historyId of a phase's recorded profile, for history.list in later phases. */
export function historyIdFromReplay(replay: GmailReplay, phase: string): string | undefined {
  const bucket = replay.phases[phase] ?? {};
  const key = Object.keys(bucket).find((k) => /\/profile$/.test(k));
  const body = key ? (bucket[key][0]?.body as { historyId?: string } | undefined) : undefined;
  return body?.historyId;
}

async function main(): Promise<void> {
  const argv = process.argv;
  const phase = argValue(argv, '--phase');
  const mailboxes = argValue(argv, '--mailboxes')?.split(',').map((m) => m.trim().toLowerCase()).filter(Boolean);
  const out = argValue(argv, '--out');
  if (!phase || !/^[a-z0-9-]+$/.test(phase)) throw new Error('--phase <name> is required (for example seeded)');
  if (!mailboxes || mailboxes.length === 0) throw new Error('--mailboxes <persona,...> is required');
  if (!out) throw new Error('--out <dir outside the repo> is required');
  const outDir = assertRecordingTarget(out);

  assertSecretsFolderKeyless(resolve('.secrets'));
  const seeding = loadSeedingConfig(argValue(argv, '--seeding-config') ?? '.secrets/google/seeding.json');
  const domain = trialDomain(seeding);
  requireLiveRun(argv, domain, { testDomains: seeding.testDomains });
  const registration = JSON.parse(
    readFileSync(argValue(argv, '--registration') ?? '.secrets/google/registration.json', 'utf8'),
  ) as { tenantId: string; serviceAccountEmail: string };

  announceLiveRun('google:record-replay', domain, registration.serviceAccountEmail);
  const tokens = createDelegatedTokenCache({ callerToken: createCallerTokenSource() });
  mkdirSync(outDir, { recursive: true, mode: 0o700 });

  for (const persona of mailboxes) {
    const trialAddress = seeding.personas[persona];
    if (!trialAddress) throw new Error(`No trial address for persona ${persona} in seeding.json`);
    const file = join(outDir, `${persona}.${phase}.json`);
    if (existsSync(file)) throw new Error(`Refusing to overwrite ${file}`);

    const getToken: GetGoogleToken = tokens.forSubject(
      { tenantId: registration.tenantId, serviceAccountEmail: registration.serviceAccountEmail },
      trialAddress,
      GMAIL_READER_SCOPE.READONLY,
    );
    const get = async (url: string): Promise<ReplayResponse> => {
      try {
        const res = await googleFetch(url, {}, { getToken });
        return { status: res.status, body: await res.json() };
      } catch (error) {
        // A refusal is part of the mailbox's behavior; keep the status and reason, never a body.
        if (error instanceof GoogleHttpError) {
          return { status: error.status, body: { error: { code: error.status, status: error.reason } } };
        }
        throw error;
      }
    };

    const seededFile = join(outDir, `${persona}.seeded.json`);
    const startHistoryId =
      phase !== 'seeded' && existsSync(seededFile)
        ? historyIdFromReplay(JSON.parse(readFileSync(seededFile, 'utf8')) as GmailReplay, 'seeded')
        : undefined;
    const replay = scrubReplay(await recordMailbox({ get, trialAddress, persona, phase, startHistoryId }), {
      [trialAddress]: persona,
    });
    writeFileSync(file, JSON.stringify(replay, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(`recorded ${persona} (${phase}): ${Object.keys(replay.phases[phase]).length} request keys -> ${file}`);
  }
}

if (process.argv[1]?.endsWith('record-replay.ts')) {
  main().catch((error: unknown) => {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
