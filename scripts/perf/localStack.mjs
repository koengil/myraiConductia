// @ts-check
/**
 * The throwaway-stack guard for the rail cold-load harness (#162).
 *
 * Every process the harness starts (seed scripts, `next build`/`next start`,
 * the Playwright harness, psql via runPsql) checks its OWN effective
 * environment with this function before any of its code runs: the
 * `assert-local-stack.mjs` preload calls it at import. A hosted Supabase or
 * database URL, any port but the throwaway stack's own (API port for the
 * Supabase URLs, DB port for the database URLs), a foreign stack id or a
 * missing stack id all refuse.
 *
 * This module is the single source of the stack's identity: rail-stack.sh
 * reads the project id and ports from it (through stack-identity.mjs) and
 * checks its shifted config agrees. Writes additionally need
 * assertRunningStack (the containers on those ports are this stack's) and
 * assertWriteChecked (the wrapper ran that check: `with-local-stack.sh --write`).
 *
 * Plain JavaScript on purpose: the preload rides in NODE_OPTIONS, and this
 * host's node has no native TypeScript support. A TypeScript preload there
 * needs tsx's hooks, and Node also runs NODE_OPTIONS imports inside the hooks
 * thread, where loading a .ts file deadlocks.
 */

/** @typedef {Record<string, string | undefined>} StackEnvironment */
/** @typedef {{ projectId: string, targets: Record<string, string> }} LocalStackCheck */

/** The only stack id the harness may run against. */
export const PERF_STACK_PROJECT_ID = 'cdt162-rail';

/** Env var naming the stack the process belongs to (written by rail-stack.sh). */
export const PERF_STACK_ID_VAR = 'PERF_STACK_PROJECT_ID';

/**
 * The throwaway stack's host ports: the tracked supabase/config.toml ports
 * ([api] 54321, [db] 54322) shifted by rail-stack.sh's SHIFT (+2000). The
 * guard test pins that arithmetic against both files.
 */
export const PERF_STACK_API_PORT = '56321';
export const PERF_STACK_DB_PORT = '56322';

/** Every variable that can carry a database or Supabase URL, and the one port it may use. */
export const EXPECTED_PORTS = Object.freeze({
  DATABASE_URL: PERF_STACK_DB_PORT,
  SUPABASE_DB_URL: PERF_STACK_DB_PORT,
  NEXT_PUBLIC_SUPABASE_URL: PERF_STACK_API_PORT,
  SUPABASE_URL: PERF_STACK_API_PORT,
});

/** Every variable that can carry a database or Supabase URL. */
export const URL_BEARING_VARS = Object.freeze(
  /** @type {Array<keyof typeof EXPECTED_PORTS>} */ (Object.keys(EXPECTED_PORTS)),
);

/** The port the measured `next start` listens on (127.0.0.1 only). */
export const PERF_APP_PORT = '3162';

/**
 * Set to 1 by `with-local-stack.sh --write` only after assertRunningStack
 * passed; the stack file may not set it. Write paths require it.
 */
export const PERF_STACK_WRITE_VAR = 'PERF_STACK_WRITE_CHECKED';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** The libpq connection-URL variables: these get the stricter shape checks. */
const DATABASE_URL_VARS = new Set(['DATABASE_URL', 'SUPABASE_DB_URL']);

/**
 * libpq parameter names a refusal may echo. Any other query key is reported as
 * `<other>`, so a refusal message can never carry a credential.
 */
const NAMED_QUERY_PARAMS = new Set([
  'host', 'hostaddr', 'port', 'service', 'servicefile', 'passfile', 'options',
  'dbname', 'user', 'password', 'sslmode', 'target_session_attrs', 'load_balance_hosts',
]);

/** A plain database name: no URI, no `key=value` conninfo, nothing psql -d would expand. */
const PLAIN_DATABASE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * libpq lets a connection URL redirect itself past the authority the guard
 * pins: query parameters (`?host=`, `?hostaddr=`, `?port=`, `?service=`,
 * `?options=`, `?passfile=`, `?servicefile=` …) override it, the authority may
 * list several hosts (`h1:p1,h2:p2`), and pg-stat hands the path to `psql -d`,
 * which expands a URI or `key=value` string there over `-h`/`-p`. The
 * children (seed scripts, `next start`) read the variable directly, so the
 * guard requires the plain shape: the exact `postgres://`/`postgresql://`
 * prefix libpq recognises, no whitespace or control character (the WHATWG
 * parser strips tabs and newlines that libpq would keep), a single host, no
 * query string or fragment at all, and a plain database name.
 *
 * This half runs on the raw string, before WHATWG parsing (which rejects a
 * `h1:p1,h2:p2` authority outright).
 *
 * @param {string} name
 * @param {string} raw
 */
function assertPlainDatabaseUrlShape(name, raw) {
  const prefix = /^postgres(?:ql)?:\/\//.exec(raw);
  if (!prefix) refuse(`${name} scheme (postgres:// or postgresql:// is required)`);
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) refuse(`${name} whitespace or control character`);
  const rest = raw.slice(prefix[0].length);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  // The password may hold a comma; only the part after the last @ is the host list.
  if (authority.slice(authority.lastIndexOf('@') + 1).includes(',')) {
    refuse(`${name} host <multiple> (a single host is required)`);
  }
  if (rest.includes('?')) refuse(`${name} query ${queryKeys(rest)} (no query parameters are allowed: libpq lets them redirect the connection)`);
  if (rest.includes('#')) refuse(`${name} fragment`);
}

/**
 * The query keys a refusal may name: known libpq parameters, `<other>` for
 * anything else (never a value, so never a credential).
 *
 * @param {string} rest
 */
function queryKeys(rest) {
  const query = rest.slice(rest.indexOf('?') + 1).split('#')[0];
  const keys = [...new URLSearchParams(query).keys()].map((key) =>
    NAMED_QUERY_PARAMS.has(key.toLowerCase()) ? key.toLowerCase() : '<other>',
  );
  return [...new Set(keys)].join(',') || '<empty>';
}

/**
 * The parsed half: the database name `psql -d` receives is a plain name.
 *
 * @param {string} name
 * @param {URL} parsed
 */
function assertPlainDatabaseName(name, parsed) {
  if (parsed.search || parsed.hash) refuse(`${name} query <present>`);
  if (!PLAIN_DATABASE_NAME.test(parsed.pathname.slice(1))) {
    refuse(`${name} database <not a plain name> (letters, digits, _ and - only)`);
  }
}

/** Stack ids that belong to someone else, never to the harness. */
export const REFUSED_PROJECT_IDS = new Set([
  'conductia',
  'conductia-pl02',
  'gmaillive',
  'conductia-taskb',
]);

/**
 * @param {string} detail
 * @returns {never}
 */
function refuse(detail) {
  throw new Error(`assertLocalStack: refused ${detail}`);
}

/**
 * Throws `assertLocalStack: refused <VAR> host <host>` (or `… port …`,
 * `… project_id …`) unless every URL-bearing variable that is set points at a
 * loopback host on exactly the throwaway stack's port for that variable, and
 * the stack id is the harness's own.
 *
 * @param {StackEnvironment} env
 * @returns {LocalStackCheck}
 */
export function assertLocalStack(env) {
  const projectId = env[PERF_STACK_ID_VAR]?.trim() ?? '';
  if (!projectId) refuse(`project_id <unset> (${PERF_STACK_ID_VAR} is required)`);
  if (REFUSED_PROJECT_IDS.has(projectId) || projectId !== PERF_STACK_PROJECT_ID) {
    refuse(`project_id ${projectId}`);
  }

  /** @type {Record<string, string>} */
  const targets = {};
  for (const name of URL_BEARING_VARS) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    const database = DATABASE_URL_VARS.has(name);
    if (database) assertPlainDatabaseUrlShape(name, raw);
    /** @type {URL | null} */
    let parsed = null;
    try {
      parsed = new URL(raw);
    } catch {
      parsed = null;
    }
    if (!parsed) return refuse(`${name} host <unparseable>`);
    if (database) assertPlainDatabaseName(name, parsed);
    const bracketed = parsed.hostname;
    const host =
      bracketed.startsWith('[') && bracketed.endsWith(']') ? bracketed.slice(1, -1) : bracketed;
    if (!LOOPBACK_HOSTS.has(host)) refuse(`${name} host ${host || '<empty>'}`);
    if (!parsed.port) refuse(`${name} port <default> (an explicit throwaway-stack port is required)`);
    if (parsed.port !== EXPECTED_PORTS[name]) refuse(`${name} port ${parsed.port}`);
    targets[name] = `${host}:${parsed.port}`;
  }
  return { projectId, targets };
}

/**
 * Refuses a write unless the environment is the throwaway stack's AND
 * `with-local-stack.sh --write` confirmed the running containers first.
 *
 * @param {StackEnvironment} env
 * @returns {LocalStackCheck}
 */
export function assertWriteChecked(env) {
  const check = assertLocalStack(env);
  if (env[PERF_STACK_WRITE_VAR] !== '1') {
    refuse(
      `write (${PERF_STACK_WRITE_VAR} is unset: run under scripts/perf/with-local-stack.sh --write, which confirms the running stack first)`,
    );
  }
  return check;
}

/**
 * The app the harness signs in to and loads: it receives the session cookie
 * the harness mints, so it must be the local `next start` on PERF_APP_PORT.
 * Accepts only `http://<loopback>:<PERF_APP_PORT>` with no credentials, path,
 * query or fragment, and returns its origin. Throws
 * `assertLocalStack: refused --base-url …` otherwise.
 *
 * @param {string} raw
 * @returns {string}
 */
export function assertLocalBaseUrl(raw) {
  /** @type {URL | null} */
  let url = null;
  try {
    url = new URL(raw);
  } catch {
    url = null;
  }
  if (!url) return refuse('--base-url <unparseable>');
  if (url.protocol !== 'http:') refuse(`--base-url scheme ${url.protocol}`);
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (!LOOPBACK_HOSTS.has(host)) refuse(`--base-url host ${host || '<empty>'}`);
  if (url.port !== PERF_APP_PORT) refuse(`--base-url port ${url.port || '<default>'} (expected ${PERF_APP_PORT})`);
  if (url.username || url.password) refuse('--base-url credentials');
  if (url.pathname !== '/' || url.search || url.hash) refuse('--base-url path, query or fragment');
  return url.origin;
}

/** @typedef {{ projectId: string, apiPort: string, dbPort: string }} ExpectedStack */

/**
 * Checks `docker ps --format '{{.Names}}\t{{.Ports}}'` output: the API port
 * must be published only by supabase_kong_<project id> (container port 8000)
 * and the DB port only by supabase_db_<project id> (container port 5432).
 * Throws `assertLocalStack: refused stack …` when the stack is not running,
 * runs on other ports, or another container owns either port.
 *
 * @param {string} dockerPs
 * @param {ExpectedStack} [expected]
 * @returns {ExpectedStack}
 */
export function assertRunningStack(
  dockerPs,
  expected = { projectId: PERF_STACK_PROJECT_ID, apiPort: PERF_STACK_API_PORT, dbPort: PERF_STACK_DB_PORT },
) {
  const wants = [
    { label: 'API', port: expected.apiPort, container: `supabase_kong_${expected.projectId}`, target: '8000' },
    { label: 'DB', port: expected.dbPort, container: `supabase_db_${expected.projectId}`, target: '5432' },
  ];
  /** @type {Map<string, Array<{ container: string, target: string }>>} */
  const publishers = new Map(wants.map((want) => [want.port, []]));
  for (const line of dockerPs.split('\n')) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    const container = (tab === -1 ? line : line.slice(0, tab)).trim();
    const ports = tab === -1 ? '' : line.slice(tab + 1);
    for (const mapping of ports.split(',')) {
      // 0.0.0.0:56322->5432/tcp, [::]:56322->5432/tcp, 0.0.0.0:8000-8001->8000-8001/tcp
      const match = /:(\d+)(?:-(\d+))?->(\d+)(?:-\d+)?\/tcp$/.exec(mapping.trim());
      if (!match) continue;
      const first = Number(match[1]);
      const last = match[2] ? Number(match[2]) : first;
      for (const want of wants) {
        const port = Number(want.port);
        if (port < first || port > last) continue;
        publishers.get(want.port)?.push({ container, target: String(Number(match[3]) + port - first) });
      }
    }
  }
  for (const want of wants) {
    const owners = publishers.get(want.port) ?? [];
    if (owners.length === 0) {
      refuse(
        `stack ${expected.projectId}: nothing publishes the ${want.label} port ${want.port} (is the stack running? scripts/perf/rail-stack.sh)`,
      );
    }
    const foreign = owners.find((owner) => owner.container !== want.container || owner.target !== want.target);
    if (foreign) {
      refuse(
        `stack ${want.label} port ${want.port} (published by ${foreign.container}->${foreign.target}, expected ${want.container}->${want.target})`,
      );
    }
  }
  return expected;
}
