import { spawnSync } from 'node:child_process';

import {
  REHEARSAL_ENV_NAMES,
  REHEARSAL_STACK_ID,
  assertRehearsalStack,
  localStatusEnv,
  type RehearsalEnv,
  type RehearsalReaderEnv,
} from '../../scripts/rehearsal/stack';
import { mailPath } from './mailPath';
import { repliesFile } from './recording';

/**
 * The discovery demo's two CLI stages, run as the runbook runs them: seed the
 * mail (classification), then extract milestones from the recorded replies. A
 * CI step cannot do this mid-journey, so the journey spawns the same scripts
 * against the local stack with the environment the job already exports. The
 * replies file is the owner's recording when it exists, else the stub
 * (e2e/support/recording.ts). Both refuse a non-local Supabase URL.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
// The URL parser strips tabs and newlines; anything of the kind is refused before parsing (as scripts/rehearsal/stack.ts).
const UNSAFE = /[\s\u0000-\u001f\u007f]/;

function isLoopbackApi(raw: string): boolean {
  if (!raw || UNSAFE.test(raw)) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' && !url.username && !url.password && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * The stack guard of every discovery helper that reaches the database or spawns a script. The Supabase URL is parsed,
 * not matched as text: plain http on 127.0.0.1 or localhost, no userinfo (so `http://127.0.0.1:1@host` is refused).
 * When REHEARSAL_STACK is set (scripts/rehearsal/rehearse.sh sets it), the stack must be w9-m365cap and nothing else
 * (assertRehearsalStack: the API on 127.0.0.1:57321 and the database on 127.0.0.1:57322). Unset, any local port
 * passes, so the CI workflows keep their own stack on 54321. A refusal never echoes the URL.
 */
export function assertLoopbackStack(who: string, env: RehearsalEnv = process.env): void {
  if (!isLoopbackApi(env.NEXT_PUBLIC_SUPABASE_URL ?? '')) throw new Error(`${who} refuses a non-local Supabase URL`);
  if (env.REHEARSAL_STACK === undefined) return;
  if (env.REHEARSAL_STACK !== REHEARSAL_STACK_ID) throw new Error(`${who} refuses an unknown REHEARSAL_STACK`);
  assertRehearsalStack(who, env);
}

/**
 * The environment for a script a discovery helper spawns, built from scratch after the guard: only the names
 * rehearse.sh hands its children (REHEARSAL_ENV_NAMES: the local stack's values, the fixed seed values, the app env),
 * plus the fixture reader's names. Nothing else the parent holds reaches the child, AI_GATEWAY_API_KEY included.
 * Under the rehearsal it is localStatusEnv, which pins w9-m365cap again.
 */
export function childEnv(who: string, extra: RehearsalReaderEnv = {}, env: RehearsalEnv = process.env): NodeJS.ProcessEnv {
  assertLoopbackStack(who, env);
  if (env.REHEARSAL_STACK !== undefined) return localStatusEnv(env, extra);
  const out: RehearsalEnv = {};
  for (const name of REHEARSAL_ENV_NAMES) {
    if (env[name] !== undefined) out[name] = env[name];
  }
  for (const [name, value] of Object.entries(extra)) {
    if (value !== undefined) out[name] = value;
  }
  return out as NodeJS.ProcessEnv;
}

function run(who: string, args: string[]): void {
  assertLoopbackStack(who);
  const r = spawnSync(process.execPath, args, {
    env: { ...process.env, GRAPH_READER_PROVIDER: 'fixture' },
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`${args[2]} exited ${r.status}`); // exit code only; stderr is not echoed
}

/**
 * `seed-discovery [--google-replay] --corpus demo --phase <p>`, on the project's mail path, at the late-mail
 * superset when `afterImports`. The phase is always named: a Gmail replay read at a phase earlier than the
 * source's checkpoint has no answer for its history (cdt-261-demo-gmail D5).
 */
export function seedDemoMail(who: string, opts: { afterImports?: boolean } = {}): void {
  run(who, [
    '--import', 'tsx', 'scripts/seed-discovery.ts',
    ...(mailPath() === 'gmail-replay' ? ['--google-replay'] : []),
    '--corpus', 'demo', '--phase', opts.afterImports ? 'after-imports' : 'seeded',
  ]);
}

/** `worker/extract --once --strict --replies <recording or stub>`. */
export function extractDemoMail(who: string): void {
  run(who, ['--import', 'tsx', 'worker/extract.ts', '--once', '--strict', '--replies', repliesFile().path]);
}
