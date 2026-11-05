import { execFileSync, spawnSync } from 'node:child_process';

import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { TABLE } from '../../src/lib/constants/tables';
import { DEV_TENANT_ID } from '../../src/lib/db/tenant';
import { GMAIL_DEMO_TWIN_DIR } from '../discovery/lib/corpusSelect';
import { seedEmail } from '../seed-data';
import { assertRehearsalStack, localStatusEnv, type RehearsalEnv } from './stack';

/**
 * The #173 rehearsal's probes (outline phase 1): each reads one fact of the demo flow off w9-m365cap and prints
 * exactly one JSON line of integers and fixed codes. Run through the wrapper only:
 *
 *   scripts/rehearsal/rehearse.sh probe index              2a  the team source's message index rows, and how many are HMAC'd
 *   scripts/rehearsal/rehearse.sh probe window [--since D]  2b  the stored window matches the admin's date; set-window is locked
 *   scripts/rehearsal/rehearse.sh probe remove             2c  the admin's Remove of a team inbox that holds mail
 *   scripts/rehearsal/rehearse.sh probe propose-recorded   3a  classify-once --propose on the recorded replies, team rows by outcome
 *   scripts/rehearsal/rehearse.sh probe health             7b  the CCO's ingestion health row for the team source
 *
 * Every probe asserts the stack first (stack.ts). The printer, probeLine, is the redaction boundary: a value that is
 * not an integer or a [a-z_]+ code throws instead of printing, so no subject, address, name or message reaches the
 * line. A failure prints the probe's name and a fixed code, never an error message or a stack, and so does a result
 * whose code is a failure (probeExit): either way the probe exits non-zero. `remove` and `health` call the app on
 * 127.0.0.1:3000, and the wrapper runs them only when the process listening there is the one `rehearse.sh serve`
 * started (its app stamp); the rest need only the stack.
 */

export const PROBES = ['index', 'window', 'remove', 'propose-recorded', 'health'] as const;
export type ProbeName = (typeof PROBES)[number];
export type ProbeLine = { probe: ProbeName } & Record<string, number | string>;

/** The app `rehearse.sh serve` starts, bound to 127.0.0.1; the wrapper checks its stamp before remove and health. */
const APP_ORIGIN = 'http://127.0.0.1:3000';
/** The journey's first-read date (e2e/steps/teamInbox.ts FIRST_READ): 365 days back, UTC. */
const JOURNEY_WINDOW_DAYS = 365;

const CODE = /^[a-z_]+$/;
const SHA = /^[0-9a-f]{40}$/;
const KEY = /^[A-Za-z_]+$/;
const isProbe = (name: string | undefined): name is ProbeName => (PROBES as readonly string[]).includes(name ?? '');

/**
 * The one line a probe prints. Values are integers or [a-z_]+ codes; the one exception is `sha`, a 40-hex commit id
 * (which develop commit the run tested). Anything else throws, naming the key and never the value.
 */
export function probeLine(line: ProbeLine): string {
  if (!isProbe(line.probe)) throw new Error('probeLine: unknown probe');
  const out: Record<string, number | string> = { probe: line.probe };
  for (const [key, value] of Object.entries(line)) {
    if (key === 'probe') continue;
    if (!KEY.test(key)) throw new Error('probeLine: a key is not a plain name');
    const ok =
      typeof value === 'number'
        ? Number.isSafeInteger(value)
        : typeof value === 'string' && (key === 'sha' ? SHA.test(value) : CODE.test(value));
    if (!ok) throw new Error(`probeLine: ${key} is not an integer or a code`);
    out[key] = value;
  }
  return JSON.stringify(out);
}

/** A probe failure with a fixed code: the only thing about it that is printed. */
export class ProbeError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** A value as a code for the line, or the fallback when it is not one (an unknown state is not printed raw). */
const asCode = (value: unknown, fallback: string): string => (typeof value === 'string' && CODE.test(value) ? value : fallback);

function serviceClient(env: RehearsalEnv): SupabaseClient {
  const key = env.SUPABASE_SECRET_KEY;
  if (!key) throw new ProbeError('no_secret_key');
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL as string, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

type Session = { db: SupabaseClient; cookie: string; signOut: () => Promise<void> };

/**
 * A seeded persona's session by password, as e2e/auth/session.ts mints it: a client that acts as the user under RLS,
 * and the cookie header the app's routes read.
 */
async function signIn(env: RehearsalEnv, slug: 'admin' | 'cco'): Promise<Session> {
  const publishable = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const password = env.SEED_PASSWORD;
  if (!publishable || !password) throw new ProbeError('no_session_env');
  const jar = new Map<string, string>();
  const db = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL as string, publishable, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const { name, value } of cookies) {
          if (value) jar.set(name, value);
          else jar.delete(name);
        }
      },
    },
  }) as unknown as SupabaseClient;
  const { error } = await db.auth.signInWithPassword({ email: seedEmail(slug), password });
  if (error || jar.size === 0) throw new ProbeError('sign_in_failed');
  return {
    db,
    cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
    signOut: async () => {
      await db.auth.signOut({ scope: 'local' }).catch(() => undefined);
    },
  };
}

type TeamSource = { id: string; teamMailboxId: string; backfillSince: string | null };

/** The tenant's one live team-inbox source (the journey and `seed --team-inbox` each connect exactly one). */
async function teamSource(db: SupabaseClient): Promise<TeamSource> {
  const { data, error } = await db
    .from(TABLE.CONTENT_SOURCES)
    .select('id, team_mailbox_id, backfill_since')
    .eq('tenant_id', DEV_TENANT_ID)
    .not('team_mailbox_id', 'is', null)
    .is('archived_at', null);
  if (error) throw new ProbeError('read_failed');
  const rows = (data ?? []) as Array<{ id: string; team_mailbox_id: string; backfill_since: string | null }>;
  if (rows.length !== 1) throw new ProbeError(rows.length === 0 ? 'no_team_source' : 'many_team_sources');
  return { id: rows[0].id, teamMailboxId: rows[0].team_mailbox_id, backfillSince: rows[0].backfill_since };
}

/** A head count; a failed read is a fixed code. */
async function count(query: PromiseLike<{ count: number | null; error: unknown }>): Promise<number> {
  const { count: n, error } = await query;
  if (error || n === null) throw new ProbeError('read_failed');
  return n;
}

async function appFetch(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${APP_ORIGIN}${path}`, { ...init, redirect: 'manual' });
  } catch {
    throw new ProbeError('app_unreachable');
  }
}

/** 2a: the team source's discovery_message_index rows, and how many carry an HMAC digest. */
async function probeIndex(env: RehearsalEnv): Promise<ProbeLine> {
  const db = serviceClient(env);
  const source = await teamSource(db);
  const rows = (filter?: string) => {
    let query = db
      .from(TABLE.DISCOVERY_MESSAGE_INDEX)
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', DEV_TENANT_ID)
      .eq('content_source_id', source.id);
    if (filter) query = query.like('content_digest', filter);
    return count(query);
  };
  return { probe: 'index', rows: await rows(), hmac: await rows('hmac-sha256:%') };
}

const SINCE = /^\d{4}-\d{2}-\d{2}$/;
const WINDOW_CODES = new Set(['window_locked', 'not_available', 'out_of_range']);

/**
 * 2b: the stored first-read date equals the admin's (by default the journey's, 365 days back), and the admin's
 * set-window call is refused as window_locked once reading has started. The call re-sends the stored date, so a
 * window that is still open is not changed: the RPC answers `changed: false` and writes nothing (window_open).
 */
async function probeWindow(env: RehearsalEnv, args: string[]): Promise<ProbeLine> {
  const at = args.indexOf('--since');
  const since = at === -1 ? new Date(Date.now() - JOURNEY_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10) : args[at + 1];
  if (!since || !SINCE.test(since)) throw new ProbeError('usage');
  const source = await teamSource(serviceClient(env));
  const admin = await signIn(env, 'admin');
  try {
    const { error } = await admin.db.rpc('discovery_set_mailbox_source_window', {
      p_source_id: source.id,
      p_since: source.backfillSince,
    });
    const code = error ? (WINDOW_CODES.has(error.message) ? error.message : 'unexpected') : 'window_open';
    return { probe: 'window', matches: source.backfillSince === since ? 1 : 0, code };
  } finally {
    await admin.signOut();
  }
}

/**
 * The admin's Remove of a team inbox, sent only when its source holds indexed mail (`indexRows`): an empty inbox would
 * really be removed. Anything but 409 not_removable is a failure code (probeExit).
 */
export async function removeTeamInbox(indexRows: number, del: () => Promise<Response>): Promise<ProbeLine> {
  if (indexRows === 0) throw new ProbeError('no_mail');
  const res = await del();
  let code = 'unexpected';
  if (res.status === 204) code = 'removed';
  else if (res.status === 404) code = 'not_found';
  else if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    code = body?.error === 'not_removable' ? 'not_removable' : 'unexpected';
  }
  return { probe: 'remove', status: res.status, code };
}

/** 2c: the admin removes the team inbox through the app. One that holds mail answers 409 not_removable (G-05). */
async function probeRemove(env: RehearsalEnv): Promise<ProbeLine> {
  const db = serviceClient(env);
  const source = await teamSource(db);
  const indexRows = await count(
    db
      .from(TABLE.DISCOVERY_MESSAGE_INDEX)
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', DEV_TENANT_ID)
      .eq('content_source_id', source.id),
  );
  if (indexRows === 0) throw new ProbeError('no_mail');
  const admin = await signIn(env, 'admin');
  try {
    return await removeTeamInbox(indexRows, () =>
      appFetch(`/api/v1/discovery/team-mailboxes/${source.teamMailboxId}`, {
        method: 'DELETE',
        headers: { cookie: admin.cookie },
      }),
    );
  } finally {
    await admin.signOut();
  }
}

/** The worker's propose run as a code, read from its fixed summary line; its output is never printed. */
export function proposeRunCode(status: number | null, stdout: string): { code: string; called: number } {
  const called = Number(/Proposed: called (\d+),/.exec(stdout)?.[1] ?? 0);
  const refused = /propose refused \(([a-z0-9_]+)\)/.exec(stdout)?.[1];
  if (refused) return { code: asCode(refused, 'propose_refused'), called };
  const skipped = /: skipped \(([a-z0-9_]+)\)/.exec(stdout)?.[1];
  if (skipped) return { code: asCode(skipped, 'skipped'), called };
  if (/Stopped: the AI Gateway refused zero data retention/.test(stdout)) return { code: 'zdr_unavailable', called };
  if (status !== 0) return { code: asCode(/"reason":"([a-z0-9_]+)"/.exec(stdout)?.[1], 'worker_failed'), called };
  return { code: /Proposed: called/.test(stdout) ? 'ran' : 'no_propose_tally', called };
}

/** The develop commit the tested tree contains (its merge base with origin/develop), else HEAD; omitted if neither. */
function developSha(env: RehearsalEnv): string | undefined {
  const gitEnv: RehearsalEnv = { PATH: env.PATH, HOME: env.HOME };
  const git = (args: string[]) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: gitEnv as NodeJS.ProcessEnv }).trim();
  for (const args of [['merge-base', 'HEAD', 'origin/develop'], ['rev-parse', 'HEAD']]) {
    try {
      const sha = git(args);
      if (SHA.test(sha)) return sha;
    } catch {
      // try the next
    }
  }
  return undefined;
}

/**
 * 3a: one classify-once --propose pass on the recorded replies (DISCOVERY_PROPOSE_TRANSPORT unset, no gateway key:
 * the wrapper never passes one), then the team source's proposal rows by outcome (service role) and how many of
 * them the CCO's session can read. The CCO read is the table the GET /model-proposals route reads, under the same
 * RLS, without the app. Expected 0: proposals are owner-scoped and a team source has no owner (G-01).
 */
async function probeProposeRecorded(env: RehearsalEnv): Promise<ProbeLine> {
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'worker/classify.ts', '--tenant', DEV_TENANT_ID, '--propose'], {
    env: localStatusEnv(env, {
      DISCOVERY_READER_MODE: 'fixture',
      DISCOVERY_GMAIL_REPLAY_DIR: GMAIL_DEMO_TWIN_DIR,
      DISCOVERY_GMAIL_REPLAY_PHASE: 'seeded',
    }),
    stdio: 'pipe',
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const { code, called } = proposeRunCode(run.status, `${run.stdout ?? ''}\n${run.stderr ?? ''}`);

  const db = serviceClient(env);
  const source = await teamSource(db);
  const byOutcome = (outcome: string) =>
    count(
      db
        .from(TABLE.DISCOVERY_MODEL_PROPOSALS)
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', DEV_TENANT_ID)
        .eq('content_source_id', source.id)
        .eq('outcome', outcome),
    );
  const cco = await signIn(env, 'cco');
  let ccoVisible: number;
  try {
    ccoVisible = await count(
      cco.db.from(TABLE.DISCOVERY_MODEL_PROPOSALS).select('id', { count: 'exact', head: true }).eq('content_source_id', source.id),
    );
  } finally {
    await cco.signOut();
  }
  const sha = developSha(env);
  return {
    probe: 'propose-recorded',
    called,
    deal: await byOutcome('deal'),
    not_deal: await byOutcome('not_deal'),
    invalid: await byOutcome('invalid'),
    ccoVisible,
    code,
    ...(sha ? { sha } : {}),
  };
}

/** 7b: the CCO's GET /api/v1/discovery/health, the team source's row: its state and what it waits for. */
async function probeHealth(env: RehearsalEnv): Promise<ProbeLine> {
  const source = await teamSource(serviceClient(env));
  const cco = await signIn(env, 'cco');
  try {
    const res = await appFetch('/api/v1/discovery/health', { headers: { cookie: cco.cookie } });
    if (res.status !== 200) return { probe: 'health', status: res.status, code: 'health_unavailable' };
    const body = (await res.json().catch(() => null)) as { health?: { sources?: Array<Record<string, unknown>> } } | null;
    const row = body?.health?.sources?.find((s) => s.id === source.id);
    if (!row) return { probe: 'health', status: res.status, code: 'no_team_row' };
    return { probe: 'health', code: asCode(row.state, 'no_state'), waitingFor: row.waitingFor === null || row.waitingFor === undefined ? 'none' : asCode(row.waitingFor, 'unexpected') };
  } finally {
    await cco.signOut();
  }
}

type Runner = (env: RehearsalEnv, args: string[]) => Promise<ProbeLine>;

const RUN: Record<ProbeName, Runner> = {
  index: probeIndex,
  window: probeWindow,
  remove: probeRemove,
  'propose-recorded': probeProposeRecorded,
  health: probeHealth,
};

/** The codes that are a failed result wherever they appear: an unknown answer, or a read the probe could not make. */
const FAILED_CODES = new Set(['unexpected', 'health_unavailable', 'no_team_row', 'no_state']);

/**
 * A printed line's exit status: 0 only for the answer the demo flow expects. propose-recorded must have run, remove
 * must have been refused as not_removable, and no field may hold a failure code.
 */
export function probeExit(line: ProbeLine): 0 | 1 {
  if (Object.values(line).some((value) => typeof value === 'string' && FAILED_CODES.has(value))) return 1;
  if (line.probe === 'propose-recorded' && line.code !== 'ran') return 1;
  if (line.probe === 'remove' && line.code !== 'not_removable') return 1;
  return 0;
}

/**
 * Runs one probe and prints its line. 0 on the expected result, 1 on a probe failure or a failure code (probeExit),
 * 2 on a refusal or bad usage. `run` is for tests.
 */
export async function main(
  argv: string[],
  env: RehearsalEnv = process.env,
  run: Partial<Record<ProbeName, Runner>> = RUN,
): Promise<number> {
  const [sub, ...args] = argv;
  if (!isProbe(sub)) {
    console.error(`usage: probes.ts ${PROBES.join(' | ')} [--since YYYY-MM-DD for window]`);
    return 2;
  }
  try {
    assertRehearsalStack(`probe ${sub}`, env);
  } catch (error) {
    // The guard's message names host:port only (stack.ts).
    console.error(error instanceof Error ? error.message : 'refused');
    console.log(probeLine({ probe: sub, code: 'stack_mismatch' }));
    return 2;
  }
  let line: ProbeLine;
  try {
    const runner = run[sub];
    if (!runner) throw new ProbeError('no_runner');
    line = await runner(env, args);
  } catch (error) {
    console.log(probeLine({ probe: sub, code: error instanceof ProbeError ? asCode(error.code, 'probe_failed') : 'probe_failed' }));
    return 1;
  }
  let printed: string;
  try {
    printed = probeLine(line);
  } catch {
    // A value that is not an integer or a code never reaches the terminal: the fixed code does.
    console.log(probeLine({ probe: sub, code: 'unprintable' }));
    return 1;
  }
  console.log(printed);
  return probeExit(line);
}

if (process.argv[1]?.endsWith('probes.ts')) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
