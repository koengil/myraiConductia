/**
 * The one stack the #173 demo rehearsal may touch: the exclusive local stack w9-m365cap, its API on
 * 127.0.0.1:57321 and its database on 127.0.0.1:57322 (design R14). scripts/rehearsal/rehearse.sh holds the same
 * pin in shell before every command; this is its TypeScript twin, which every probe runs before anything else.
 *
 * Both URLs are parsed, not matched as text: no userinfo on the API, no query or fragment on either (libpq reads
 * host, hostaddr and service from a query string, so a query could move the connection past the pinned authority),
 * no whitespace or control character the URL parser would quietly strip. A refusal names host and port only, never
 * a key or a password.
 */

/** An environment to check or copy from: process.env, or a plain record in a test. */
export type RehearsalEnv = Record<string, string | undefined>;

export const REHEARSAL_STACK_ID = 'w9-m365cap';
export const REHEARSAL_API = 'http://127.0.0.1:57321';
export const REHEARSAL_DB = { host: '127.0.0.1', port: '57322', user: 'postgres', database: 'postgres' } as const;

// The URL parser strips tabs and newlines; anything of the kind is refused before parsing.
const UNSAFE = /[\s\u0000-\u001f\u007f]/;

function parse(value: string): URL | null {
  if (UNSAFE.test(value)) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Why a Supabase API URL is not the rehearsal stack's, as host:port or a fixed detail; null when it is. */
export function rehearsalApiRefusal(value: string | undefined): string | null {
  if (!value) return 'unset';
  const api = parse(value);
  if (!api) return '<not a URL>';
  if (api.username || api.password) return '<userinfo>';
  if (api.protocol !== 'http:') return '<scheme>';
  if (api.host !== '127.0.0.1:57321') return api.host || '<no host>';
  if (api.pathname !== '/' || /[?#]/.test(value)) return `${api.host} <path, query or fragment>`;
  return null;
}

/** Why a database URL is not the rehearsal stack's, as host:port or a fixed detail; null when it is. */
export function rehearsalDbRefusal(value: string | undefined): string | null {
  if (!value) return 'unset';
  // libpq recognises only the lowercase schemes; the URL parser would lowercase an uppercase one.
  if (!/^postgres(?:ql)?:\/\//.test(value)) return '<scheme>';
  if (/[?#]/.test(value)) return '<query or fragment>';
  const db = parse(value);
  if (!db) return '<not a URL>';
  if (db.hostname !== REHEARSAL_DB.host || db.port !== REHEARSAL_DB.port) {
    return `${db.hostname || '<no host>'}:${db.port || '<no port>'}`;
  }
  if (db.username !== REHEARSAL_DB.user) return `${db.hostname}:${db.port} <user>`;
  if (db.pathname !== `/${REHEARSAL_DB.database}`) return `${db.hostname}:${db.port} <database>`;
  return null;
}

/**
 * Throws unless the environment points at w9-m365cap and nothing else: NEXT_PUBLIC_SUPABASE_URL and DATABASE_URL
 * must both be set and pinned, and SUPABASE_URL and SUPABASE_DB_URL, when set, must be pinned too.
 */
export function assertRehearsalStack(who: string, env: RehearsalEnv = process.env): void {
  const api = rehearsalApiRefusal(env.NEXT_PUBLIC_SUPABASE_URL);
  if (api) throw new Error(`${who}: refuses Supabase API ${api}`);
  const apiAlias = env.SUPABASE_URL ? rehearsalApiRefusal(env.SUPABASE_URL) : null;
  if (apiAlias) throw new Error(`${who}: refuses SUPABASE_URL ${apiAlias}`);
  const db = rehearsalDbRefusal(env.DATABASE_URL);
  if (db) throw new Error(`${who}: refuses database ${db}`);
  const dbAlias = env.SUPABASE_DB_URL ? rehearsalDbRefusal(env.SUPABASE_DB_URL) : null;
  if (dbAlias) throw new Error(`${who}: refuses SUPABASE_DB_URL ${dbAlias}`);
}

/**
 * The names rehearse.sh hands a child (its env -i allow-list), less the per-command ones: the local values from
 * `supabase status`, the fixed local seed values, and the rehearsal marker. AI_GATEWAY_API_KEY is not one of them,
 * so no child can reach the gateway.
 */
export const REHEARSAL_ENV_NAMES = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SECRET_KEY',
  'DATABASE_URL',
  'SEED_PASSWORD',
  'INVITE_VERIFICATION_PEPPER',
  'NEXT_PUBLIC_APP_ENV',
  'NEXT_TELEMETRY_DISABLED',
  'REHEARSAL_STACK',
  'PGSERVICEFILE',
  'PGPASSFILE',
] as const;

/** The per-command names a TypeScript caller may add: the fixture reader's, for a worker pass over the demo twin. */
export type RehearsalReaderEnv = Partial<
  Record<'DISCOVERY_READER_MODE' | 'DISCOVERY_GMAIL_REPLAY_DIR' | 'DISCOVERY_GMAIL_REPLAY_PHASE', string>
>;
const READER_ENV_NAMES = new Set(['DISCOVERY_READER_MODE', 'DISCOVERY_GMAIL_REPLAY_DIR', 'DISCOVERY_GMAIL_REPLAY_PHASE']);

/**
 * The environment for a child a rehearsal script spawns, built from scratch: the stack is asserted first, then only
 * REHEARSAL_ENV_NAMES are copied from `env` (so the local status values the wrapper loaded travel on, and nothing
 * the caller's shell exported does), plus the fixture reader's names. Anything else in `extra` is refused.
 */
export function localStatusEnv(
  env: RehearsalEnv = process.env,
  extra: RehearsalReaderEnv = {},
): NodeJS.ProcessEnv {
  assertRehearsalStack('localStatusEnv', env);
  const out = {} as NodeJS.ProcessEnv;
  for (const name of REHEARSAL_ENV_NAMES) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (!READER_ENV_NAMES.has(name)) throw new Error(`localStatusEnv: refuses ${name}`);
    if (value !== undefined) out[name] = value;
  }
  return out;
}
