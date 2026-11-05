// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * worker/entrypoint.sh turns the two injected workload identity configs into
 * files before node starts (#344, design R6). It runs here under sh with a stub
 * `node` first on PATH: the stub records its arguments and environment, so the
 * test sees exactly what the worker process would hold.
 */

const ENTRYPOINT = join(process.cwd(), 'worker/entrypoint.sh');
const DWD_CONFIG = JSON.stringify({ type: 'external_account', audience: 'dwd-canary-audience' });
const DIRECTORY_CONFIG = JSON.stringify({
  type: 'external_account',
  service_account_impersonation_url: 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/dir-canary:generateAccessToken',
});

let root: string;
let binDir: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'worker-entrypoint-'));
  binDir = join(root, 'bin');
  mkdirSync(binDir);
  const stub = join(binDir, 'node');
  writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$STUB_OUT.args"\nenv > "$STUB_OUT.env"\n');
  chmodSync(stub, 0o755);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A child environment holding only what the test names (no runner variable leaks in). */
const only = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

let run = 0;
function entrypoint(args: string[], extraEnv: Record<string, string>) {
  run += 1;
  const configDir = join(root, `run-${run}`, 'google');
  const out = join(root, `run-${run}`, 'node');
  mkdirSync(join(root, `run-${run}`), { recursive: true });
  // Under a fully open umask, so the 0600 and 0700 below are the entrypoint's doing, not the runner's.
  const result = spawnSync('sh', ['-c', 'umask 000; exec sh "$0" "$@"', ENTRYPOINT, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: only({
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: root,
      STUB_OUT: out,
      WORKER_GOOGLE_CONFIG_DIR: configDir,
      ...extraEnv,
    }),
  });
  const childEnv = existsSync(`${out}.env`) ? readFileSync(`${out}.env`, 'utf8') : '';
  const childArgs = existsSync(`${out}.args`) ? readFileSync(`${out}.args`, 'utf8').trim().split('\n') : [];
  const envMap = new Map(
    childEnv
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const),
  );
  return { result, configDir, childEnv, envMap, childArgs };
}

const modeOf = (path: string) => statSync(path).mode & 0o777;

describe('worker/entrypoint.sh writes the workload identity configs (#344, R6)', () => {
  it('writes both configs 0600 in a 0700 directory, exports the paths and drops the raw variables', () => {
    const { result, configDir, childEnv, envMap, childArgs } = entrypoint(['classify'], {
      GOOGLE_WIF_DWD_CONFIG: DWD_CONFIG,
      GOOGLE_WIF_DIRECTORY_CONFIG: DIRECTORY_CONFIG,
    });
    expect(result.status).toBe(0);
    expect(childArgs).toEqual(['dist/worker/classify.mjs', '--serve']);
    const dwd = join(configDir, 'dwd.json');
    const directory = join(configDir, 'directory.json');
    expect(readFileSync(dwd, 'utf8')).toBe(DWD_CONFIG);
    expect(readFileSync(directory, 'utf8')).toBe(DIRECTORY_CONFIG);
    expect(modeOf(dwd)).toBe(0o600);
    expect(modeOf(directory)).toBe(0o600);
    expect(modeOf(configDir)).toBe(0o700);
    expect(envMap.get('GOOGLE_APPLICATION_CREDENTIALS')).toBe(dwd);
    expect(envMap.get('GOOGLE_DIRECTORY_CREDENTIALS')).toBe(directory);
    expect(envMap.has('GOOGLE_WIF_DWD_CONFIG')).toBe(false);
    expect(envMap.has('GOOGLE_WIF_DIRECTORY_CONFIG')).toBe(false);
    // Neither config's content reaches the process environment under any name.
    expect(childEnv).not.toContain('dwd-canary-audience');
    expect(childEnv).not.toContain('dir-canary');
    // Nor any output.
    expect(result.stdout + result.stderr).not.toContain('canary');
  });

  it('passes the remaining arguments through to the entry', () => {
    const { result, childArgs } = entrypoint(['classify-once', '--tenant', 't-1'], { GOOGLE_WIF_DWD_CONFIG: DWD_CONFIG });
    expect(result.status).toBe(0);
    expect(childArgs).toEqual(['dist/worker/classify.mjs', '--tenant', 't-1']);
  });

  it('runs the connection probe with its fixed command, the configs written first (#344, R15)', () => {
    const { result, childArgs, envMap } = entrypoint(
      ['probe', '--live', '--confirm-domain', 'bank.example', '--tenant', 't-1', '--allow-remote-db', '--out', '/tmp/probe'],
      { GOOGLE_WIF_DWD_CONFIG: DWD_CONFIG, GOOGLE_WIF_DIRECTORY_CONFIG: DIRECTORY_CONFIG },
    );
    expect(result.status).toBe(0);
    expect(childArgs).toEqual([
      'dist/worker/probe.mjs',
      '--live',
      '--confirm-domain',
      'bank.example',
      '--tenant',
      't-1',
      '--allow-remote-db',
      '--out',
      '/tmp/probe',
    ]);
    expect(envMap.has('GOOGLE_APPLICATION_CREDENTIALS')).toBe(true);
    expect(envMap.has('GOOGLE_DIRECTORY_CREDENTIALS')).toBe(true);
    expect(envMap.has('GOOGLE_WIF_DWD_CONFIG')).toBe(false);
  });

  it('runs the extractor dry run as extract.mjs --estimate, with the task arguments after it (#261)', () => {
    const bundle = join(root, 'dist/worker');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, 'extract.mjs'), '');
    try {
      const { result, childArgs } = entrypoint(['estimate', '--tenant', 't-1'], {});
      expect(result.status).toBe(0);
      expect(childArgs).toEqual(['dist/worker/extract.mjs', '--estimate', '--tenant', 't-1']);
    } finally {
      rmSync(join(root, 'dist'), { recursive: true, force: true });
    }
  });

  it('exits 64 for the estimate entry while the extractor bundle is absent', () => {
    const { result, childArgs } = entrypoint(['estimate'], {});
    expect(result.status).toBe(64);
    expect(childArgs).toEqual([]);
  });

  it('runs the rule detector as extract.mjs --rules, with the task arguments after it (#173 G-07)', () => {
    const bundle = join(root, 'dist/worker');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, 'extract.mjs'), '');
    try {
      const { result, childArgs } = entrypoint(['detect', '--tenant', 't-1'], {});
      expect(result.status).toBe(0);
      expect(childArgs).toEqual(['dist/worker/extract.mjs', '--rules', '--tenant', 't-1']);
    } finally {
      rmSync(join(root, 'dist'), { recursive: true, force: true });
    }
  });

  it('exits 64 for the detect entry while the extractor bundle is absent', () => {
    const { result, childArgs } = entrypoint(['detect'], {});
    expect(result.status).toBe(64);
    expect(childArgs).toEqual([]);
  });

  it('replaces a stale file and its mode rather than writing through it', () => {
    const first = entrypoint(['classify'], { GOOGLE_WIF_DWD_CONFIG: DWD_CONFIG });
    const dwd = join(first.configDir, 'dwd.json');
    chmodSync(dwd, 0o644);
    const result = spawnSync('sh', [ENTRYPOINT, 'self-check'], {
      cwd: root,
      encoding: 'utf8',
      env: only({
        PATH: `${binDir}:/usr/bin:/bin`,
        WORKER_GOOGLE_CONFIG_DIR: first.configDir,
        GOOGLE_WIF_DWD_CONFIG: '{"type":"external_account","v":2}',
      }),
    });
    expect(result.status).toBe(0);
    expect(readFileSync(dwd, 'utf8')).toBe('{"type":"external_account","v":2}');
    expect(modeOf(dwd)).toBe(0o600);
  });

  it('with no injected config, writes nothing and passes GOOGLE_APPLICATION_CREDENTIALS through (a laptop run)', () => {
    const { result, configDir, envMap } = entrypoint(['classify'], { GOOGLE_APPLICATION_CREDENTIALS: '/home/dev/adc.json' });
    expect(result.status).toBe(0);
    expect(existsSync(configDir)).toBe(false);
    expect(envMap.get('GOOGLE_APPLICATION_CREDENTIALS')).toBe('/home/dev/adc.json');
    expect(envMap.has('GOOGLE_DIRECTORY_CREDENTIALS')).toBe(false);
  });

  it('an empty injected variable writes nothing and is still dropped', () => {
    const { result, configDir, envMap } = entrypoint(['classify'], { GOOGLE_WIF_DWD_CONFIG: '' });
    expect(result.status).toBe(0);
    expect(existsSync(configDir)).toBe(false);
    expect(envMap.has('GOOGLE_WIF_DWD_CONFIG')).toBe(false);
    expect(envMap.has('GOOGLE_APPLICATION_CREDENTIALS')).toBe(false);
  });

  it('fails closed, with no content in the message, when the config directory is not writable', () => {
    const blocked = join(root, 'blocked');
    mkdirSync(blocked, { mode: 0o500 });
    const result = spawnSync('sh', [ENTRYPOINT, 'classify'], {
      cwd: root,
      encoding: 'utf8',
      env: only({
        PATH: `${binDir}:/usr/bin:/bin`,
        STUB_OUT: join(root, 'blocked-node'),
        WORKER_GOOGLE_CONFIG_DIR: join(blocked, 'google'),
        GOOGLE_WIF_DWD_CONFIG: DWD_CONFIG,
      }),
    });
    chmodSync(blocked, 0o700);
    // Root ignores directory modes, so the refusal is only observable as another user.
    if (process.getuid?.() === 0) return;
    expect(result.status).toBe(70);
    expect(result.stderr).toMatch(/is not writable by uid/);
    expect(result.stderr + result.stdout).not.toContain('canary');
    expect(existsSync(join(root, 'blocked-node.args'))).toBe(false);
  });

  it('self-check prints the uid and both file modes, never the content, and exits 0', () => {
    const { result, childArgs } = entrypoint(['self-check'], {
      GOOGLE_WIF_DWD_CONFIG: DWD_CONFIG,
      GOOGLE_WIF_DIRECTORY_CONFIG: DIRECTORY_CONFIG,
    });
    expect(result.status).toBe(0);
    expect(childArgs).toEqual([]);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toEqual([`uid ${process.getuid?.()}`, 'dwd.json 600', 'directory.json 600']);
    expect(result.stdout + result.stderr).not.toContain('canary');
  });

  it('self-check reports a config that was not injected as absent', () => {
    const { result } = entrypoint(['self-check'], { GOOGLE_WIF_DWD_CONFIG: DWD_CONFIG });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('dwd.json 600');
    expect(result.stdout).toContain('directory.json absent');
  });

  it('refuses an unknown entry with the usage line', () => {
    const { result } = entrypoint(['shell'], {});
    expect(result.status).toBe(64);
    expect(result.stderr).toMatch(/usage: classify \| classify-once \| extract \| estimate \| detect \| probe \| self-check/);
  });
});
