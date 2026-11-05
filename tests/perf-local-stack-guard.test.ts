import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PERF_STACK_API_PORT,
  PERF_STACK_DB_PORT,
  PERF_STACK_PROJECT_ID,
  PERF_APP_PORT,
  assertLocalBaseUrl,
  assertLocalStack,
  assertRunningStack,
  assertWriteChecked,
} from '../scripts/perf/localStack.mjs';
import { psqlEnv } from '../scripts/perf/pg-stat';

// #162 Phase 1: the rail cold-load harness must be structurally unable to
// reach a hosted database or another developer's stack.

const ROOT = path.resolve(__dirname, '..');
const PRELOAD = path.join(ROOT, 'scripts/perf/assert-local-stack.mjs');
const WRAPPER = path.join(ROOT, 'scripts/perf/with-local-stack.sh');
const RAIL_STACK = path.join(ROOT, 'scripts/perf/rail-stack.sh');
const IDENTITY_CLI = path.join(ROOT, 'scripts/perf/stack-identity.mjs');

/** A child's whole environment: nothing inherited from the test runner. */
const childEnv = (env: Record<string, string | undefined>) => env as NodeJS.ProcessEnv;

const LOCAL = {
  PERF_STACK_PROJECT_ID: 'cdt162-rail',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:56321',
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:56322/postgres',
};

describe('assertLocalStack', () => {
  it('accepts the throwaway stack on loopback', () => {
    expect(assertLocalStack(LOCAL)).toEqual({
      projectId: 'cdt162-rail',
      targets: {
        NEXT_PUBLIC_SUPABASE_URL: '127.0.0.1:56321',
        DATABASE_URL: '127.0.0.1:56322',
      },
    });
    expect(() =>
      assertLocalStack({ ...LOCAL, SUPABASE_URL: 'http://localhost:56321', SUPABASE_DB_URL: 'postgres://u@[::1]:56322/db' }),
    ).not.toThrow();
  });

  it.each([
    ['DATABASE_URL', 'postgresql://postgres:x@db.abcdefgh.supabase.co:5432/postgres', 'db.abcdefgh.supabase.co'],
    ['SUPABASE_DB_URL', 'postgresql://postgres:x@aws-0-us-east-1.pooler.supabase.com:6543/postgres', 'aws-0-us-east-1.pooler.supabase.com'],
    ['NEXT_PUBLIC_SUPABASE_URL', 'https://abcdefgh.supabase.co', 'abcdefgh.supabase.co'],
    ['SUPABASE_URL', 'http://10.0.0.5:56321', '10.0.0.5'],
  ])('refuses a hosted %s', (name, value, host) => {
    expect(() => assertLocalStack({ ...LOCAL, [name]: value })).toThrow(
      `assertLocalStack: refused ${name} host ${host}`,
    );
  });

  it.each(['54321', '54322', '55321', '55322', '55521', '55522', '54801', '54802'])(
    'refuses port %s, which another local stack owns',
    (port) => {
      expect(() =>
        assertLocalStack({ ...LOCAL, NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${port}` }),
      ).toThrow(`assertLocalStack: refused NEXT_PUBLIC_SUPABASE_URL port ${port}`);
    },
  );

  it.each([
    ['NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:56421', '56421'],
    ['SUPABASE_URL', 'http://localhost:3000', '3000'],
    ['DATABASE_URL', 'postgresql://postgres:postgres@127.0.0.1:5432/postgres', '5432'],
    ['SUPABASE_DB_URL', 'postgresql://postgres:postgres@127.0.0.1:56323/postgres', '56323'],
  ])('refuses a loopback %s on a port that is not the throwaway stack port for it', (name, value, port) => {
    expect(() => assertLocalStack({ ...LOCAL, [name]: value })).toThrow(
      `assertLocalStack: refused ${name} port ${port}`,
    );
  });

  it('refuses the API port on a database variable and the DB port on a Supabase URL', () => {
    expect(() =>
      assertLocalStack({ ...LOCAL, DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${PERF_STACK_API_PORT}/postgres` }),
    ).toThrow(`assertLocalStack: refused DATABASE_URL port ${PERF_STACK_API_PORT}`);
    expect(() =>
      assertLocalStack({ ...LOCAL, SUPABASE_DB_URL: `postgres://u@[::1]:${PERF_STACK_API_PORT}/db` }),
    ).toThrow(`assertLocalStack: refused SUPABASE_DB_URL port ${PERF_STACK_API_PORT}`);
    expect(() =>
      assertLocalStack({ ...LOCAL, NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${PERF_STACK_DB_PORT}` }),
    ).toThrow(`assertLocalStack: refused NEXT_PUBLIC_SUPABASE_URL port ${PERF_STACK_DB_PORT}`);
  });

  it('accepts exactly the exported API and DB ports', () => {
    expect([PERF_STACK_PROJECT_ID, PERF_STACK_API_PORT, PERF_STACK_DB_PORT]).toEqual(['cdt162-rail', '56321', '56322']);
    expect(
      assertLocalStack({
        PERF_STACK_PROJECT_ID,
        NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${PERF_STACK_API_PORT}`,
        SUPABASE_URL: `http://localhost:${PERF_STACK_API_PORT}`,
        DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${PERF_STACK_DB_PORT}/postgres`,
        SUPABASE_DB_URL: `postgres://u@[::1]:${PERF_STACK_DB_PORT}/db`,
      }).targets,
    ).toEqual({
      DATABASE_URL: `127.0.0.1:${PERF_STACK_DB_PORT}`,
      SUPABASE_DB_URL: `::1:${PERF_STACK_DB_PORT}`,
      NEXT_PUBLIC_SUPABASE_URL: `127.0.0.1:${PERF_STACK_API_PORT}`,
      SUPABASE_URL: `localhost:${PERF_STACK_API_PORT}`,
    });
  });

  it('refuses a URL with no explicit port', () => {
    expect(() =>
      assertLocalStack({ ...LOCAL, DATABASE_URL: 'postgresql://postgres@localhost/postgres' }),
    ).toThrow('assertLocalStack: refused DATABASE_URL port');
  });

  describe('database URLs libpq could redirect past the pinned authority', () => {
    const BASE = 'postgresql://u:s3cret-pw@127.0.0.1:56322/postgres';

    it('parses the plain URL to the exact host, port and database', () => {
      const url = new URL(BASE);
      expect([url.hostname, url.port, url.pathname]).toEqual(['127.0.0.1', '56322', '/postgres']);
      expect(assertLocalStack({ ...LOCAL, DATABASE_URL: BASE, SUPABASE_DB_URL: BASE }).targets).toMatchObject({
        DATABASE_URL: '127.0.0.1:56322',
        SUPABASE_DB_URL: '127.0.0.1:56322',
      });
    });

    it.each([
      ['?host=evil.com&port=5432', 'query host,port'],
      ['?hostaddr=203.0.113.7', 'query hostaddr'],
      ['?service=prod', 'query service'],
      ['?servicefile=/tmp/x&passfile=/tmp/y', 'query servicefile,passfile'],
      ['?options=-c%20search_path%3Devil', 'query options'],
      ['?sslmode=disable', 'query sslmode'],
      ['?s3cret-pw=1', 'query <other>'],
      ['?', 'query <empty>'],
    ])('refuses any query string: %s', (query, detail) => {
      for (const name of ['DATABASE_URL', 'SUPABASE_DB_URL']) {
        expect(() => assertLocalStack({ ...LOCAL, [name]: `${BASE}${query}` })).toThrow(
          `assertLocalStack: refused ${name} ${detail}`,
        );
      }
    });

    it('refuses a fragment', () => {
      expect(() => assertLocalStack({ ...LOCAL, DATABASE_URL: `${BASE}#x` })).toThrow(
        'assertLocalStack: refused DATABASE_URL fragment',
      );
    });

    it.each([
      'postgresql://u:s3cret-pw@127.0.0.1:56322,evil.com:5432/postgres',
      'postgresql://u:s3cret-pw@127.0.0.1,evil.com:56322/postgres',
      'postgresql://u:s3cret-pw@localhost:56322,127.0.0.1:56322/postgres',
    ])('refuses a multi-host authority: %s', (value) => {
      expect(() => assertLocalStack({ ...LOCAL, DATABASE_URL: value })).toThrow(
        'assertLocalStack: refused DATABASE_URL host <multiple>',
      );
    });

    it('accepts a comma in the password (it is not the host list)', () => {
      expect(() =>
        assertLocalStack({ ...LOCAL, DATABASE_URL: 'postgresql://u:a,b@127.0.0.1:56322/postgres' }),
      ).not.toThrow();
    });

    it.each([
      ['a URI psql -d would expand over -h/-p', 'postgresql://u:p@127.0.0.1:56322/postgresql://evil.com:5432/x'],
      ['a key=value conninfo', 'postgresql://u:p@127.0.0.1:56322/dbname=postgres'],
      ['a percent-encoded conninfo', 'postgresql://u:p@127.0.0.1:56322/host%3Devil.com'],
      ['an empty name', 'postgresql://u:p@127.0.0.1:56322/'],
    ])('refuses %s as the database name', (_label, value) => {
      expect(() => assertLocalStack({ ...LOCAL, DATABASE_URL: value })).toThrow(
        'assertLocalStack: refused DATABASE_URL database <not a plain name>',
      );
    });

    it.each([
      ['a tab the URL parser would strip', 'postgresql://u:p@127.0.0.\t1:56322/postgres', 'whitespace or control character'],
      ['a newline', 'postgresql://u:p@127.0.0.1:56322/postgres\nhost=evil.com', 'whitespace or control character'],
      ['an uppercase scheme libpq does not recognise as a URI', 'POSTGRESQL://u:p@127.0.0.1:56322/postgres', 'scheme'],
      ['a keyword/value conninfo', 'host=127.0.0.1 port=56322 dbname=postgres', 'scheme'],
    ])('refuses %s', (_label, value, detail) => {
      expect(() => assertLocalStack({ ...LOCAL, DATABASE_URL: value })).toThrow(
        `assertLocalStack: refused DATABASE_URL ${detail}`,
      );
    });

    it('never echoes the password in a refusal', () => {
      const hostile = [
        `${BASE}?host=evil.com&port=5432`,
        `${BASE}?s3cret-pw=s3cret-pw`,
        `${BASE}#s3cret-pw`,
        'postgresql://u:s3cret-pw@127.0.0.1:56322,evil.com:5432/postgres',
        'postgresql://u:s3cret-pw@127.0.0.1:56322/s3cret-pw=1',
      ];
      for (const value of hostile) {
        let message = '';
        try {
          assertLocalStack({ ...LOCAL, DATABASE_URL: value });
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toMatch(/^assertLocalStack: refused DATABASE_URL /);
        expect(message).not.toContain('s3cret-pw');
      }
    });
  });

  it.each(['conductia', 'conductia-pl02', 'gmaillive', 'conductia-taskb', 'someone-else'])(
    'refuses stack id %s',
    (projectId) => {
      expect(() => assertLocalStack({ ...LOCAL, PERF_STACK_PROJECT_ID: projectId })).toThrow(
        `assertLocalStack: refused project_id ${projectId}`,
      );
    },
  );

  it('refuses a missing stack id', () => {
    expect(() => assertLocalStack({ ...LOCAL, PERF_STACK_PROJECT_ID: undefined })).toThrow(
      'assertLocalStack: refused project_id <unset>',
    );
  });
});

/** The first `port =` under a `[section]` header of a supabase config.toml. */
function sectionPort(toml: string, section: string): number {
  let inside = false;
  for (const line of toml.split('\n')) {
    if (line.startsWith('[')) inside = line.trim() === `[${section}]`;
    else if (inside) {
      const match = /^\s*port\s*=\s*(\d+)/.exec(line);
      if (match) return Number(match[1]);
    }
  }
  throw new Error(`no port under [${section}]`);
}

describe('stack identity: one source for the project id and ports', () => {
  it('rail-stack.sh shifts the tracked config onto exactly the exported ports', () => {
    const script = fs.readFileSync(RAIL_STACK, 'utf8');
    const shift = Number(/^SHIFT=(\d+)$/m.exec(script)?.[1]);
    expect(shift).toBeGreaterThan(0);
    const tracked = fs.readFileSync(path.join(ROOT, 'supabase/config.toml'), 'utf8');
    expect(String(sectionPort(tracked, 'api') + shift)).toBe(PERF_STACK_API_PORT);
    expect(String(sectionPort(tracked, 'db') + shift)).toBe(PERF_STACK_DB_PORT);
  });

  it('rail-stack.sh reads the project id and ports from localStack.mjs and checks its config against them', () => {
    const script = fs.readFileSync(RAIL_STACK, 'utf8');
    expect(script).toContain('stack-identity.mjs" ports');
    expect(script).toMatch(/^read -r PROJECT_ID API_PORT DB_PORT /m);
    // Nothing restates them: no literal project id assignment or port arithmetic.
    expect(script).not.toMatch(/^PROJECT_ID=/m);
    expect(script).not.toMatch(/5432[12] \+ SHIFT/);
    expect(script).toContain('[[ "$CFG_API_PORT" != "$API_PORT" || "$CFG_DB_PORT" != "$DB_PORT" ]]');

    const result = spawnSync(process.execPath, [IDENTITY_CLI, 'ports'], {
      env: childEnv({ PATH: process.env.PATH }),
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${PERF_STACK_PROJECT_ID} ${PERF_STACK_API_PORT} ${PERF_STACK_DB_PORT}\n`);
  });
});

// `docker ps --format '{{.Names}}\t{{.Ports}}'` as this host prints it.
const dockerPs = (...lines: string[]) => lines.join('\n') + '\n';
const OTHER_STACKS = [
  'supabase_db_conductia\t0.0.0.0:54322->5432/tcp, [::]:54322->5432/tcp',
  'supabase_kong_conductia\t8001/tcp, 8088/tcp, 8443-8444/tcp, 0.0.0.0:54321->8000/tcp, [::]:54321->8000/tcp',
];
const RUNNING = [
  'supabase_kong_cdt162-rail\t8001/tcp, 8088/tcp, 8443-8444/tcp, 0.0.0.0:56321->8000/tcp, [::]:56321->8000/tcp',
  'supabase_auth_cdt162-rail\t9999/tcp',
  'supabase_db_cdt162-rail\t0.0.0.0:56322->5432/tcp, [::]:56322->5432/tcp',
];

describe('assertRunningStack (the --write identity check)', () => {
  it('accepts the cdt162-rail containers on the exported ports, beside other stacks', () => {
    expect(assertRunningStack(dockerPs(...OTHER_STACKS, ...RUNNING))).toEqual({
      projectId: 'cdt162-rail',
      apiPort: '56321',
      dbPort: '56322',
    });
  });

  it('refuses when the stack is stopped', () => {
    expect(() => assertRunningStack(dockerPs(...OTHER_STACKS))).toThrow(
      'assertLocalStack: refused stack cdt162-rail: nothing publishes the API port 56321',
    );
    expect(() => assertRunningStack('')).toThrow('assertLocalStack: refused stack cdt162-rail: nothing publishes');
  });

  it('refuses another project on the expected ports', () => {
    expect(() =>
      assertRunningStack(
        dockerPs(
          RUNNING[0],
          'supabase_db_conductia-taskb\t0.0.0.0:56322->5432/tcp, [::]:56322->5432/tcp',
        ),
      ),
    ).toThrow(
      'assertLocalStack: refused stack DB port 56322 (published by supabase_db_conductia-taskb->5432, expected supabase_db_cdt162-rail->5432)',
    );
    expect(() =>
      assertRunningStack(
        dockerPs(
          'supabase_kong_gmaillive\t0.0.0.0:56321->8000/tcp',
          RUNNING[2],
        ),
      ),
    ).toThrow('assertLocalStack: refused stack API port 56321 (published by supabase_kong_gmaillive->8000');
  });

  it('refuses the cdt162-rail containers on other ports', () => {
    expect(() =>
      assertRunningStack(
        dockerPs(
          'supabase_kong_cdt162-rail\t0.0.0.0:56421->8000/tcp',
          'supabase_db_cdt162-rail\t0.0.0.0:56422->5432/tcp',
        ),
      ),
    ).toThrow('assertLocalStack: refused stack cdt162-rail: nothing publishes the API port 56321');
  });

  it('refuses the right container mapped to the wrong service port, or a port range that swallows ours', () => {
    expect(() =>
      assertRunningStack(dockerPs(RUNNING[0], 'supabase_db_cdt162-rail\t0.0.0.0:56322->6543/tcp')),
    ).toThrow('assertLocalStack: refused stack DB port 56322 (published by supabase_db_cdt162-rail->6543');
    expect(() =>
      assertRunningStack(dockerPs(...RUNNING, 'squatter\t127.0.0.1:56300-56330->56300-56330/tcp')),
    ).toThrow('assertLocalStack: refused stack API port 56321 (published by squatter->56321');
  });

  it('refuses a mismatching project id when asked for a different stack', () => {
    expect(() =>
      assertRunningStack(dockerPs(...RUNNING), { projectId: 'conductia', apiPort: '56321', dbPort: '56322' }),
    ).toThrow('assertLocalStack: refused stack API port 56321 (published by supabase_kong_cdt162-rail->8000, expected supabase_kong_conductia->8000)');
  });
});

describe('assertWriteChecked', () => {
  it('refuses a write unless the wrapper confirmed the running stack', () => {
    expect(() => assertWriteChecked(LOCAL)).toThrow('assertLocalStack: refused write (PERF_STACK_WRITE_CHECKED is unset');
    expect(() => assertWriteChecked({ ...LOCAL, PERF_STACK_WRITE_CHECKED: 'yes' })).toThrow(
      'assertLocalStack: refused write',
    );
    expect(assertWriteChecked({ ...LOCAL, PERF_STACK_WRITE_CHECKED: '1' }).projectId).toBe('cdt162-rail');
  });

  it('still refuses a foreign stack even when the write flag is set', () => {
    expect(() =>
      assertWriteChecked({ ...LOCAL, PERF_STACK_WRITE_CHECKED: '1', DATABASE_URL: 'postgresql://p@127.0.0.1:54322/postgres' }),
    ).toThrow('assertLocalStack: refused DATABASE_URL port 54322');
  });
});

describe('pg-stat psql environment', () => {
  it('strips inherited PG* variables and pins the service and password files to /dev/null', () => {
    const env = psqlEnv(
      childEnv({
        PATH: '/usr/bin',
        HOME: '/home/x',
        PGSERVICE: 'prod',
        PGSERVICEFILE: '/home/x/.pg_service.conf',
        PGPASSFILE: '/home/x/.pgpass',
        PGHOST: 'db.example.com',
      }),
      new URL(LOCAL.DATABASE_URL),
    );
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/x',
      PGSERVICEFILE: '/dev/null',
      PGPASSFILE: '/dev/null',
      PGPASSWORD: 'postgres',
    });
  });
});

describe('assert-local-stack.mjs preload', () => {
  it('exits 1 before the child runs when its own DATABASE_URL is hosted', () => {
    expect(fs.existsSync(PRELOAD)).toBe(true);
    const result = spawnSync(process.execPath, ['--import', PRELOAD, '-e', "console.log('child ran')"], {
      env: childEnv({
        PATH: process.env.PATH,
        ...LOCAL,
        DATABASE_URL: 'postgresql://postgres:hosted-secret@db.abcdefgh.supabase.co:5432/postgres',
      }),
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('assertLocalStack: refused DATABASE_URL host db.abcdefgh.supabase.co');
    expect(result.stderr).not.toContain('hosted-secret');
    expect(result.stdout).not.toContain('child ran');
  });

  it('exits 1 before the child runs when its own DATABASE_URL carries a redirecting query', () => {
    const result = spawnSync(process.execPath, ['--import', PRELOAD, '-e', "console.log('child ran')"], {
      env: childEnv({
        PATH: process.env.PATH,
        ...LOCAL,
        DATABASE_URL: 'postgresql://postgres:query-secret@127.0.0.1:56322/postgres?host=evil.com&port=5432',
      }),
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('assertLocalStack: refused DATABASE_URL query host,port');
    expect(result.stderr).not.toContain('query-secret');
    expect(result.stdout).not.toContain('child ran');
  });

  it('lets the child run on the throwaway stack', () => {
    const result = spawnSync(process.execPath, ['--import', PRELOAD, '-e', "console.log('child ran')"], {
      env: childEnv({ PATH: process.env.PATH, ...LOCAL }),
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('child ran');
  });
});

describe('with-local-stack.sh isolation', () => {
  let dir: string;
  let stackEnv: string;
  const FIXTURE = {
    ...LOCAL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'local-fixture-publishable',
    SUPABASE_SECRET_KEY: 'local-fixture-secret',
    MFA_ENFORCEMENT: 'invite_only',
  };
  // Hosted and integration values the shell profile could export.
  const HOSTILE = {
    SUPABASE_SECRET_KEY: 'hosted-secret-key',
    SUPABASE_SERVICE_ROLE_KEY: 'hosted-service-role',
    BOX_CLIENT_SECRET: 'hosted-box-secret',
    RESEND_API_KEY: 'hosted-resend-key',
    ANTHROPIC_API_KEY: 'hosted-anthropic-key',
    AI_GATEWAY_API_KEY: 'hosted-gateway-key',
    MFA_ENFORCEMENT: 'all',
    EMAIL_FROM: 'ops@hosted.example',
    STORAGE_BUCKET: 'hosted-bucket',
    NEXT_PUBLIC_APP_ENV: 'prod',
    DATABASE_URL: 'postgresql://postgres:hosted@db.abcdefgh.supabase.co:5432/postgres',
    NODE_OPTIONS: '--require /nonexistent/hosted-hook.js',
  };
  const ALLOWLIST = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM', 'PLAYWRIGHT_BROWSERS_PATH', 'CI'];

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdt162-guard-'));
    stackEnv = path.join(dir, 'env');
    fs.writeFileSync(
      stackEnv,
      Object.entries(FIXTURE)
        .map(([name, value]) => `${name}=${value}`)
        .join('\n') + '\n',
      { mode: 0o600 },
    );
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gives the child exactly the allowlist and the stack file's keys", () => {
    const parentEnv: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: os.homedir(),
      LANG: 'C.UTF-8',
      TERM: 'dumb',
      CI: '1',
      ...HOSTILE,
    };
    const result = spawnSync(
      WRAPPER,
      [
        '--stack-env',
        stackEnv,
        process.execPath,
        '-e',
        'process.stdout.write(JSON.stringify(Object.fromEntries(Object.keys(process.env).sort().map((k) => [k, k.endsWith("KEY") || k.endsWith("URL") ? process.env[k] : "-"]))))',
      ],
      { env: childEnv(parentEnv), encoding: 'utf8' },
    );
    expect(result.stderr).toContain('assertLocalStack: ok project_id=cdt162-rail');
    expect(result.status).toBe(0);
    const child = JSON.parse(result.stdout) as Record<string, string>;

    const presentAllowlist = ALLOWLIST.filter((name) => name in parentEnv);
    const expected = new Set([...presentAllowlist, ...Object.keys(FIXTURE), 'NODE_OPTIONS', 'PGSERVICEFILE', 'PGPASSFILE']);
    expect(Object.keys(child).sort()).toEqual([...expected].sort());

    // Same-named variables come from the stack file, never the parent.
    expect(child.SUPABASE_SECRET_KEY).toBe('local-fixture-secret');
    expect(child.DATABASE_URL).toBe(LOCAL.DATABASE_URL);
    for (const name of [
      'SUPABASE_SERVICE_ROLE_KEY',
      'BOX_CLIENT_SECRET',
      'RESEND_API_KEY',
      'ANTHROPIC_API_KEY',
      'AI_GATEWAY_API_KEY',
      'EMAIL_FROM',
      'STORAGE_BUCKET',
      'NEXT_PUBLIC_APP_ENV',
    ]) {
      expect(child).not.toHaveProperty(name);
    }
    expect(result.stdout).not.toContain('hosted');
    // No --write: the child never gets the write flag (and no docker call ran).
    expect(child).not.toHaveProperty('PERF_STACK_WRITE_CHECKED');
  });

  it('refuses a stack file that points at a hosted database, before the command runs', () => {
    const hostile = path.join(dir, 'hostile-env');
    fs.writeFileSync(
      hostile,
      `PERF_STACK_PROJECT_ID=cdt162-rail\nDATABASE_URL=postgresql://postgres:x@db.abcdefgh.supabase.co:5432/postgres\n`,
      { mode: 0o600 },
    );
    const marker = path.join(dir, 'ran');
    const result = spawnSync(WRAPPER, ['--stack-env', hostile, 'touch', marker], {
      env: childEnv({ PATH: process.env.PATH ?? '/usr/bin:/bin' }),
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('assertLocalStack: refused DATABASE_URL host db.abcdefgh.supabase.co');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('refuses a stack file that sets the write flag or the psql files', () => {
    for (const line of ['PERF_STACK_WRITE_CHECKED=1', 'PGPASSFILE=/home/x/.pgpass', 'PGSERVICEFILE=/home/x/.pg_service.conf']) {
      const forged = path.join(dir, 'forged-env');
      fs.writeFileSync(forged, `${fs.readFileSync(stackEnv, 'utf8')}${line}\n`, { mode: 0o600 });
      const result = spawnSync(WRAPPER, ['--stack-env', forged, 'true'], {
        env: childEnv({ PATH: process.env.PATH ?? '/usr/bin:/bin' }),
        encoding: 'utf8',
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`the stack file may not set ${line.split('=')[0]}`);
    }
  });

  // A fake `docker` first on PATH answers `context show` and prints the listing
  // for `ps`; nothing real is queried.
  const withFakeDocker = (listing: string | null, context = 'default') => {
    const bin = fs.mkdtempSync(path.join(dir, 'bin-'));
    const ps =
      listing === null ? 'echo "Cannot connect to the Docker daemon" >&2\nexit 1\n' : `cat <<'EOF'\n${listing}EOF\n`;
    const script = `#!/bin/sh\nif [ "$1" = context ]; then echo ${context}; exit 0; fi\n${ps}`;
    fs.writeFileSync(path.join(bin, 'docker'), script, { mode: 0o755 });
    return `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`;
  };
  const runWrite = (PATH: string, extra: Record<string, string> = {}) =>
    spawnSync(
      WRAPPER,
      ['--stack-env', stackEnv, '--write', process.execPath, '-e', 'process.stdout.write(process.env.PERF_STACK_WRITE_CHECKED ?? "unset")'],
      { env: childEnv({ PATH, ...extra }), encoding: 'utf8' },
    );

  it('--write runs the command with the write flag when the cdt162-rail containers own the ports', () => {
    const result = runWrite(withFakeDocker(dockerPs(...OTHER_STACKS, ...RUNNING)));
    expect(result.stderr).toContain('assertLocalStack: running project_id=cdt162-rail api=56321 db=56322');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('1');
  });

  it.each([
    ['the stack is stopped', dockerPs(...OTHER_STACKS), 'nothing publishes the API port 56321'],
    ['another stack owns the DB port', dockerPs(RUNNING[0], 'supabase_db_conductia\t0.0.0.0:56322->5432/tcp'), 'published by supabase_db_conductia'],
    ['docker is unreachable', null, 'docker ps failed'],
  ])('--write refuses before the command runs when %s', (_label, listing, reason) => {
    const result = runWrite(withFakeDocker(listing));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(reason);
    expect(result.stderr).toContain('refusing a write');
    expect(result.stdout).toBe('');
  });

  it.each([
    ['DOCKER_HOST is set', {}, { DOCKER_HOST: 'tcp://remote.example:2376' }, 'DOCKER_HOST is set'],
    ['DOCKER_CONTEXT names another context', {}, { DOCKER_CONTEXT: 'remote' }, 'DOCKER_CONTEXT is not default'],
    ['the current docker context is not default', { context: 'remote' }, {}, 'the current docker context is not default'],
  ])('--write refuses a non-local docker daemon when %s', (_label, fake, extra, reason) => {
    const listing = dockerPs(...OTHER_STACKS, ...RUNNING);
    const result = runWrite(withFakeDocker(listing, (fake as { context?: string }).context), extra as Record<string, string>);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(reason);
    expect(result.stderr).toContain('refusing a write');
    expect(result.stdout).toBe('');
  });

  it('--write accepts DOCKER_CONTEXT=default', () => {
    const result = runWrite(withFakeDocker(dockerPs(...OTHER_STACKS, ...RUNNING)), { DOCKER_CONTEXT: 'default' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('1');
  });
});

describe('rail-stack.sh checks docker and the running stack before writing', () => {
  const script = fs.readFileSync(RAIL_STACK, 'utf8');
  const at = (needle: string) => {
    const index = script.indexOf(needle);
    expect(index, needle).toBeGreaterThanOrEqual(0);
    return index;
  };

  it('requires the local docker daemon before the first supabase CLI call', () => {
    expect(at('require_local_docker || exit 1')).toBeLessThan(at('cli status'));
    expect(script).not.toMatch(/DOCKER_HOST=/);
  });

  it('confirms the running containers are this stack before db reset and before any write', () => {
    const check = at('require_running_stack ||');
    expect(check).toBeLessThan(at('cli db reset'));
    expect(check).toBeGreaterThan(at('cli start'));
    expect(check).toBeLessThan(at('pg-stat.ts" enable'));
  });
});

describe('assertLocalBaseUrl (the app the harness mints a session for)', () => {
  it('accepts the local next start and returns its origin', () => {
    expect(assertLocalBaseUrl(`http://127.0.0.1:${PERF_APP_PORT}`)).toBe('http://127.0.0.1:3162');
    expect(assertLocalBaseUrl('http://localhost:3162/')).toBe('http://localhost:3162');
    expect(assertLocalBaseUrl('http://[::1]:3162')).toBe('http://[::1]:3162');
  });

  it.each([
    ['https://app.conductia.com', 'scheme https:'],
    ['http://app.conductia.com:3162', 'host app.conductia.com'],
    ['http://127.0.0.1.nip.io:3162', 'host 127.0.0.1.nip.io'],
    ['http://127.0.0.1', 'port <default>'],
    ['http://127.0.0.1:3000', 'port 3000'],
    ['http://u:p@127.0.0.1:3162', 'credentials'],
    ['http://127.0.0.1:3162/x', 'path, query or fragment'],
    ['http://127.0.0.1:3162/?a=1', 'path, query or fragment'],
    ['not a url', '<unparseable>'],
  ])('refuses %s', (raw, reason) => {
    expect(() => assertLocalBaseUrl(raw)).toThrow(`assertLocalStack: refused --base-url ${reason}`);
  });

  it.each(['scripts/perf/rail-cold-load.ts', 'scripts/perf/quiet-probe.ts'])(
    '%s pins its base URL before minting a session',
    (file) => {
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(source).toMatch(/const BASE_URL = assertLocalBaseUrl\(/);
      expect(source.indexOf('const BASE_URL = assertLocalBaseUrl(')).toBeLessThan(source.indexOf('async function'));
    },
  );
});
