import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { REHEARSAL_ENV_NAMES } from '../../scripts/rehearsal/stack';

// #173 phase 1: scripts/rehearsal/rehearse.sh, run from a temporary copy of the worktree with a fake `supabase`
// (and, for the port check, a fake `ss`) first on PATH. Refusals only: no stack, no database, no app, no Playwright.
// HOME is a temporary directory, so the wrapper finds no ~/bin/heavy and no real home is read.

const childEnv = (env: Record<string, string | undefined>) => env as NodeJS.ProcessEnv;

const WRAPPER = path.resolve(__dirname, '../../scripts/rehearsal/rehearse.sh');

const PINNED_STATUS = [
  'API_URL="http://127.0.0.1:57321"',
  'DB_URL="postgresql://postgres:postgres@127.0.0.1:57322/postgres"',
  'ANON_KEY="fake-anon-key"',
  'SERVICE_ROLE_KEY="fake-service-key"',
].join('\n');

/** What a shell profile on this host exports, and the wrapper must keep from every child. */
const HOSTED_SHELL = {
  AI_GATEWAY_API_KEY: 'hosted-gateway-key',
  DATABASE_URL: 'postgresql://postgres:hosted-pw@db.abcdefgh.supabase.co:5432/postgres',
  NEXT_PUBLIC_SUPABASE_URL: 'https://abcdefgh.supabase.co',
  SUPABASE_SECRET_KEY: 'hosted-secret-key',
  SEED_PASSWORD: 'hosted-seed-password',
};

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type Setup = {
  status?: string;
  statusFails?: boolean;
  envFiles?: string[];
  listening?: string;
  /** A fake `node` that prints an address on both streams, records its arguments, and fails when they hold `nodeFails`. */
  fakeNode?: boolean;
  nodeFails?: string;
  /** The app stamp `rehearse.sh serve` writes, under HOME's scratch directory. */
  appStamp?: string;
  /** The body of a fake ~/bin/heavy (sh), run with the wrapper's arguments. */
  heavy?: string;
  /** What the fake node's `next build` writes as .next/static/chunks/a.js; absent, the build writes no chunk. */
  builtChunk?: string;
  buildFails?: boolean;
  /** Files already in the worktree, by relative path. */
  files?: Record<string, string>;
};

/** A fake heavy that runs the command after `--`, as the real one does once it has the memory. */
const HEAVY_RUNS = 'while [ "$1" != "--" ]; do shift; done; shift; exec "$@"';

/** What the fake node prints: an address and a name, which the wrapper must never pass on. */
const SEED_NOISE = 'Seeded deals@bank.example for Storm Duncan';

function setup(opts: Setup = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearse-'));
  temps.push(base);
  const root = path.join(base, 'root');
  const bin = path.join(base, 'bin');
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(root, 'scripts/rehearsal'), { recursive: true });
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.copyFileSync(WRAPPER, path.join(root, 'scripts/rehearsal/rehearse.sh'));
  for (const name of opts.envFiles ?? []) fs.writeFileSync(path.join(root, name), '');
  fs.writeFileSync(path.join(bin, 'status.env'), `${opts.status ?? PINNED_STATUS}\n`);
  if (opts.statusFails) fs.writeFileSync(path.join(bin, 'status.fail'), '');
  // The fake records each call, so a refusal can be shown to come before the status is read.
  fs.writeFileSync(
    path.join(bin, 'supabase'),
    '#!/bin/sh\nhere=$(dirname "$0")\necho "$*" >> "$here/supabase.calls"\n[ -f "$here/status.fail" ] && exit 1\ncat "$here/status.env"\n',
    { mode: 0o755 },
  );
  if (opts.listening !== undefined) {
    fs.writeFileSync(path.join(bin, 'ss.out'), opts.listening);
    fs.writeFileSync(path.join(bin, 'ss'), '#!/bin/sh\ncat "$(dirname "$0")/ss.out"\n', { mode: 0o755 });
  }
  if (opts.fakeNode) {
    if (opts.nodeFails) fs.writeFileSync(path.join(bin, 'node.fail'), opts.nodeFails);
    fs.writeFileSync(
      path.join(bin, 'node'),
      [
        '#!/bin/sh',
        'here=$(dirname "$0")',
        'echo "$*" >> "$here/node.calls"',
        `echo "${SEED_NOISE}"`,
        `echo "${SEED_NOISE}" >&2`,
        'if [ -f "$here/node.fail" ]; then case "$*" in *"$(cat "$here/node.fail")"*) exit 7 ;; esac; fi',
        // `next build` writes a build (and the chunk the test chose); `next start` records its pid and returns.
        'case "$*" in',
        '  *"next build"*) [ -f "$here/build.fail" ] && exit 1; mkdir -p .next/static/chunks; echo b1 > .next/BUILD_ID;',
        '    [ -f "$here/build.js" ] && cp "$here/build.js" .next/static/chunks/a.js; exit 0 ;;',
        '  *"next start"*) echo $$ > "$here/node.pid"; exit 0 ;;',
        'esac',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
  }
  if (opts.builtChunk !== undefined) fs.writeFileSync(path.join(bin, 'build.js'), opts.builtChunk);
  if (opts.buildFails) fs.writeFileSync(path.join(bin, 'build.fail'), '');
  if (opts.heavy !== undefined) {
    fs.mkdirSync(path.join(home, 'bin'));
    fs.writeFileSync(path.join(home, 'bin/heavy'), `#!/bin/sh\necho "$*" >> "${bin}/heavy.calls"\n${opts.heavy}\n`, { mode: 0o755 });
  }
  for (const [name, text] of Object.entries(opts.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  if (opts.appStamp !== undefined) {
    fs.mkdirSync(path.join(home, '.pr-review/scratch/cdt-173'), { recursive: true });
    fs.writeFileSync(path.join(home, '.pr-review/scratch/cdt-173/app.stamp'), opts.appStamp);
  }
  const run = (...args: string[]) =>
    spawnSync('bash', [path.join(root, 'scripts/rehearsal/rehearse.sh'), ...args], {
      cwd: root,
      env: childEnv({ PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: home, W9_WORKDIR: path.join(base, 'w9'), ...HOSTED_SHELL }),
      encoding: 'utf8',
    });
  const supabaseCalls = () => (fs.existsSync(path.join(bin, 'supabase.calls')) ? fs.readFileSync(path.join(bin, 'supabase.calls'), 'utf8') : '');
  const nodeCalls = () => (fs.existsSync(path.join(bin, 'node.calls')) ? fs.readFileSync(path.join(bin, 'node.calls'), 'utf8') : '');
  const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  return {
    run,
    supabaseCalls,
    nodeCalls,
    root,
    stamp: () => read(path.join(home, '.pr-review/scratch/cdt-173/app.stamp')),
    startedPid: () => read(path.join(bin, 'node.pid'))?.trim() ?? null,
    heavyCalls: () => read(path.join(bin, 'heavy.calls')) ?? '',
  };
}

const leaks = (text: string) =>
  ['fake-anon-key', 'fake-service-key', 'hosted-pw', 'hosted-gateway-key', 'hosted-secret-key', 'hosted-seed-password', ':postgres@'].filter((v) =>
    text.includes(v),
  );

describe('rehearse.sh refuses before it reads anything', () => {
  it.each([
    ['no command', []],
    ['an unknown command', ['deploy']],
    ['an argument status does not take', ['status', '--all']],
    ['a seed flag it does not know', ['seed', '--personas', 'all']],
    ['a probe with no name', ['probe']],
  ])('usage: %s', (_, args) => {
    const { run, supabaseCalls } = setup();
    const r = run(...args);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^usage: rehearse\.sh /);
    expect(supabaseCalls()).toBe('');
  });

  it.each([['.env.local'], ['.env'], ['.env.production'], ['.env.snapshot.local']])(
    'env_file_present: %s at the worktree root (existence only, never read)',
    (name) => {
      const { run, supabaseCalls } = setup({ envFiles: ['.env.example', name] });
      const r = run('status');
      expect(r.status).toBe(2);
      expect(r.stderr).toBe('rehearse: refused env_file_present\n');
      expect(r.stdout).toBe('');
      expect(supabaseCalls()).toBe('');
    },
  );

  it('lets .env.example alone through', () => {
    const { run } = setup({ envFiles: ['.env.example'] });
    expect(run('status').status).toBe(0);
  });
});

describe('rehearse.sh pins w9-m365cap from its own worktree\'s status', () => {
  it('reads the status of W9_WORKDIR, never of this worktree', () => {
    const { run, supabaseCalls } = setup();
    expect(run('status').status).toBe(0);
    expect(supabaseCalls()).toMatch(/^status -o env --workdir .*\/w9\n$/);
  });

  it('status prints the pinned host:port pair and nothing else', () => {
    const { run } = setup();
    const r = run('status');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('127.0.0.1:57321 127.0.0.1:57322\n');
    expect(leaks(r.stdout + r.stderr)).toEqual([]);
  });

  const status = (api: string, db: string) =>
    [`API_URL="${api}"`, `DB_URL="${db}"`, 'ANON_KEY="fake-anon-key"', 'SERVICE_ROLE_KEY="fake-service-key"'].join('\n');
  const DB = 'postgresql://postgres:postgres@127.0.0.1:57322/postgres';

  it.each([
    ['the shared stack\'s API', status('http://127.0.0.1:54321', DB), 'api 127.0.0.1:54321'],
    ['the shared stack\'s DB', status('http://127.0.0.1:57321', 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'), 'db 127.0.0.1:54322'],
    ['localhost', status('http://localhost:57321', DB), 'api localhost:57321'],
    ['loopback as userinfo', status('http://127.0.0.1:1@evil.example', DB), 'api evil.example'],
    ['a path on the API', status('http://127.0.0.1:57321/rest', DB), 'api 127.0.0.1:57321'],
    ['a query on the DB', status('http://127.0.0.1:57321', `${DB}?host=evil.example`), 'db 127.0.0.1:57322'],
    ['another DB user', status('http://127.0.0.1:57321', 'postgresql://supabase_admin:postgres@127.0.0.1:57322/postgres'), 'db 127.0.0.1:57322'],
    ['no API at all', 'DB_URL="x"', 'api '],
  ])('stack_mismatch: %s', (_, text, where) => {
    const { run } = setup({ status: text });
    const r = run('status');
    expect(r.status).toBe(2);
    expect(r.stderr).toBe(`rehearse: refused stack_mismatch (${where})\n`);
    expect(r.stdout).toBe('');
    expect(leaks(r.stderr)).toEqual([]);
  });

  it('status_unavailable when the stack cannot be asked', () => {
    const { run } = setup({ statusFails: true });
    const r = run('status');
    expect(r.status).toBe(2);
    expect(r.stderr).toBe('rehearse: refused status_unavailable\n');
  });

  it('stack_keys_missing when the status carries no keys', () => {
    const { run } = setup({ status: status('http://127.0.0.1:57321', DB).split('\n').slice(0, 2).join('\n') });
    const r = run('status');
    expect(r.status).toBe(2);
    expect(r.stderr).toBe('rehearse: refused stack_keys_missing\n');
  });
});

describe('a child gets the allow-list and nothing the shell exported', () => {
  it('names: exactly REHEARSAL_ENV_NAMES (TMPDIR and LANG only when set), never AI_GATEWAY_API_KEY', () => {
    const { run } = setup();
    const r = run('names');
    expect(r.status).toBe(0);
    const names = r.stdout.trim().split('\n');
    expect(names).toEqual(REHEARSAL_ENV_NAMES.filter((n) => n !== 'TMPDIR' && n !== 'LANG').slice().sort());
    expect(names).not.toContain('AI_GATEWAY_API_KEY');
    expect(leaks(r.stdout + r.stderr)).toEqual([]);
  });
});

describe('rehearse.sh e2e refuses a host it could not run hermetically on', () => {
  it.each([
    ['the app port', 'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*\n', ':3000'],
    ['the mail stub port on IPv6', 'LISTEN 0 511 [::]:4310 [::]:*\n', ':4310'],
    ['the publication stub port on every address', 'LISTEN 0 511 *:4311 *:*\n', ':4311'],
  ])('port_bound: %s', (_, listening, port) => {
    const { run } = setup({ listening });
    const r = run('e2e');
    expect(r.status).toBe(2);
    expect(r.stderr).toBe(`rehearse: refused port_bound (${port})\n`);
  });

  it('does not mistake another port for one of its own', () => {
    // :13000 and :43100 end in the digits of the app and stub ports; neither is one. With nothing bound, the next
    // refusal is the missing heavy (HOME is a temporary directory), so Playwright never starts.
    const { run } = setup({ listening: 'LISTEN 0 511 127.0.0.1:13000 0.0.0.0:*\nLISTEN 0 511 127.0.0.1:43100 0.0.0.0:*\n' });
    const r = run('e2e');
    expect(r.status).toBe(2);
    expect(r.stderr).toBe('rehearse: refused heavy_missing\n');
  });

  it('serve: refuses a bound :3000, then a missing heavy, before it builds or starts anything', () => {
    const bound = setup({ listening: 'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:*\n' }).run('serve');
    expect(bound.status).toBe(2);
    expect(bound.stderr).toBe('rehearse: refused port_bound (:3000)\n');
    const noHeavy = setup({ listening: '' }).run('serve');
    expect(noHeavy.status).toBe(2);
    expect(noHeavy.stderr).toBe('rehearse: refused heavy_missing\n');
  });
});

describe('rehearse.sh serve builds the app itself and checks the build (audit item 11)', () => {
  const PINNED_CHUNK = 'self.env={url:"http://127.0.0.1:57321"};const csp=["*.supabase.co","*.supabase.in"];';
  const serve = (opts: Setup) => setup({ listening: '', fakeNode: true, heavy: HEAVY_RUNS, ...opts });

  it('builds under heavy with the pinned env, stamps the started process, and starts it on 127.0.0.1:3000', () => {
    const s = serve({ builtChunk: PINNED_CHUNK, appStamp: 'pid=1 port=3000\n' });
    const r = s.run('serve');
    expect(r.status).toBe(0);
    expect(s.heavyCalls()).toMatch(/^--kind node-build -- env -i .* node node_modules\/next\/dist\/bin\/next build\n$/);
    // The planted hosted values and host, not the bare word: a runner's PATH (/opt/hostedtoolcache/...) holds it.
    for (const v of [...Object.values(HOSTED_SHELL), 'hosted-pw', 'supabase.co']) expect(s.heavyCalls()).not.toContain(v);
    expect(s.nodeCalls()).toMatch(/next build\n(.|\n)*next start --port 3000 --hostname 127\.0\.0\.1\n$/);
    expect(s.stamp()).toBe(`pid=${s.startedPid()} port=3000\n`);
  });

  it.each([
    ['a build that does not carry the pinned API', 'self.env={url:"http://127.0.0.1:54321"};', 'build_mismatch (no 127.0.0.1:57321)'],
    ['a build that names a hosted project', `${PINNED_CHUNK}fetch("https://abcdefghijklmnopqrst.supabase.co/rest")`, 'build_mismatch (hosted project)'],
  ])('refuses %s, removes the old stamp, and starts nothing', (_, chunk, refusal) => {
    const s = serve({ builtChunk: chunk, appStamp: `pid=${process.pid} port=3000\n` });
    const r = s.run('serve');
    expect(r.status).toBe(2);
    expect(r.stderr).toBe(`rehearse: refused ${refusal}\n`);
    expect(s.stamp()).toBeNull();
    expect(s.nodeCalls()).not.toContain('next start');
  });

  it('refuses a failed build, never the build left from before', () => {
    const s = serve({ buildFails: true, files: { '.next/BUILD_ID': 'old\n', '.next/static/chunks/old.js': PINNED_CHUNK } });
    const r = s.run('serve');
    expect(r.status).toBe(2);
    expect(r.stderr).toBe('rehearse: refused build_failed\n');
    expect(s.nodeCalls()).not.toContain('next start');
  });
});

describe('rehearse.sh e2e leaves no report behind, whatever happens (audit item 12)', () => {
  const REPORTS = ['test-results', 'playwright-report', 'e2e-results.json'];
  const STALE = { 'test-results/stale.txt': 'old', 'e2e-results.json': '{"suites":[]}' };
  // The fake heavy notes whether a stale report was still there, then writes this run's reports.
  const writesReports = (results: string, tail: string) =>
    [
      'here=$(dirname "$(dirname "$0")")',
      '[ -e test-results/stale.txt ] && echo stale-seen >> "$here/bin.note"',
      'mkdir -p test-results playwright-report',
      `cat > e2e-results.json <<'JSON'\n${results}\nJSON`,
      tail,
    ].join('\n');
  const gone = (root: string) => REPORTS.filter((name) => fs.existsSync(path.join(root, name)));

  it('deletes stale reports first, prints only the journey\'s own annotation types, and deletes the run\'s', () => {
    const results = JSON.stringify({
      suites: [{ specs: [{ tests: [{ annotations: [
        { type: 'invite-only', description: 'md kestrel assessments=1 ids=2 unresolved=0' },
        { type: 'known-gap', description: 'G-05: no disconnect (409 not_removable)' },
        { type: 'note', description: 'Seeded deals@bank.example' },
      ] }] }] }],
    });
    const s = setup({ listening: '', heavy: writesReports(results, 'exit 1'), files: STALE });
    const r = s.run('e2e');
    expect(r.status).toBe(1);
    expect(r.stdout).toBe(
      'annotation invite-only: md kestrel assessments=1 ids=2 unresolved=0\nannotation known-gap: G-05: no disconnect (409 not_removable)\n',
    );
    expect(fs.existsSync(path.join(s.root, '..', 'home', 'bin.note'))).toBe(false);
    expect(gone(s.root)).toEqual([]);
  });

  it('prints a fixed line, never the parse error or the file, when the results are not JSON', () => {
    const s = setup({ listening: '', heavy: writesReports('{"title":"Project Kestrel: teaser", deals@bank.example', 'exit 0') });
    const r = s.run('e2e');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('rehearse: annotations unreadable\n');
    expect(r.stderr).toBe('');
    expect(gone(s.root)).toEqual([]);
  });

  it('deletes the reports when the run is stopped by TERM', () => {
    const s = setup({ listening: '', heavy: writesReports('{"suites":[]}', 'kill -TERM $PPID; sleep 1; exit 0') });
    const r = s.run('e2e');
    expect(r.status).toBe(143);
    expect(gone(s.root)).toEqual([]);
  });
});

describe('rehearse.sh seed prints fixed lines only (audit item 4)', () => {
  it('prints one ok line per script and nothing the scripts printed', () => {
    const { run, nodeCalls } = setup({ fakeNode: true });
    const r = run('seed');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(
      ['seed seed-flags ok', 'seed enable-flags ok', 'seed seed-users ok', 'seed seed-discovery ok', ''].join('\n'),
    );
    expect(r.stderr).toBe('');
    expect(nodeCalls().trim().split('\n')).toHaveLength(4);
  });

  it('stops at a failing script with a fixed code, its output withheld', () => {
    const { run, nodeCalls } = setup({ fakeNode: true, nodeFails: 'seed-users' });
    const r = run('seed');
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('seed seed-flags ok\nseed enable-flags ok\n');
    expect(r.stderr).toBe('rehearse: seed failed (seed-users, exit 7)\n');
    expect(nodeCalls()).not.toContain('seed-discovery');
  });
});

describe('rehearse.sh probe remove|health calls only the app serve started (audit item 1)', () => {
  const dead = () => spawnSync('true').pid as number;
  const listener = (address: string, pid: number) => `LISTEN 0 511 ${address} 0.0.0.0:* users:(("node",pid=${pid},fd=21))\n`;

  it.each(['remove', 'health'])('%s: refuses with no stamp, before the probe runs', (sub) => {
    const { run, nodeCalls } = setup({ fakeNode: true, listening: listener('127.0.0.1:3000', process.pid) });
    const r = run('probe', sub);
    expect(r.status).toBe(2);
    expect(r.stderr).toBe('rehearse: refused app_not_owned\n');
    expect(nodeCalls()).toBe('');
  });

  it.each([
    ['a stamped process that is gone', () => `pid=${dead()} port=3000\n`, () => listener('127.0.0.1:3000', process.pid)],
    ['another process on :3000', () => `pid=${process.pid} port=3000\n`, () => listener('127.0.0.1:3000', dead())],
    ['the stamped process on another address', () => `pid=${process.pid} port=3000\n`, () => listener('0.0.0.0:3000', process.pid)],
    ['nothing on :3000', () => `pid=${process.pid} port=3000\n`, () => ''],
    ['a stamp for another port', () => `pid=${process.pid} port=3001\n`, () => listener('127.0.0.1:3000', process.pid)],
    ['a stamp that is not one', () => 'pid=1; rm -rf ~ port=3000\n', () => listener('127.0.0.1:3000', process.pid)],
  ])('refuses %s', (_, stamp, listening) => {
    const { run, nodeCalls } = setup({ fakeNode: true, appStamp: stamp(), listening: listening() });
    const r = run('probe', 'remove');
    expect(r.status).toBe(2);
    expect(r.stderr).toBe('rehearse: refused app_not_owned\n');
    expect(nodeCalls()).toBe('');
  });

  it('runs the probe when the stamped process listens on 127.0.0.1:3000', () => {
    const { run, nodeCalls } = setup({
      fakeNode: true,
      appStamp: `pid=${process.pid} port=3000\n`,
      listening: listener('127.0.0.1:3000', process.pid),
    });
    expect(run('probe', 'health').status).toBe(0);
    expect(nodeCalls()).toBe('--import tsx scripts/rehearsal/probes.ts health\n');
  });

  it('needs no app for the probes that read only the stack', () => {
    const { run, nodeCalls } = setup({ fakeNode: true });
    expect(run('probe', 'index').status).toBe(0);
    expect(nodeCalls()).toBe('--import tsx scripts/rehearsal/probes.ts index\n');
  });
});
