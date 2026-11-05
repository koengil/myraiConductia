// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// The guard builds its own service client, so the seam is the admin-client module: `admin.rpc` answers for every
// mailbox_guard_check and site_guard_check, and records what it was asked (tests/m365-recorder-readiness.test.ts).
const admin = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseAdminClient: () => ({ rpc: admin.rpc }),
}));

// A live Microsoft read goes to the fake Graph tenant when one is wired: the registration's client is swapped for a
// fixed token and the fake (as tests/mailbox-access/readers.test.ts does), so no certificate is read and no token is
// minted. The registrations the guard module built its clients for are kept, to check what the capture authenticated with.
const graphWire = vi.hoisted(() => ({ fetch: null as null | typeof fetch, registrations: [] as unknown[] }));
vi.mock('@/lib/graph/reader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/graph/reader')>();
  return {
    ...actual,
    createGraphReaderContext: (...args: Parameters<typeof actual.createGraphReaderContext>) => {
      if (!graphWire.fetch) return actual.createGraphReaderContext(...args);
      graphWire.registrations.push(args[1]);
      return { http: { getToken: async () => 'fake-token', fetchImpl: graphWire.fetch, sleep: async () => undefined } };
    },
  };
});

import {
  createFakeTenant,
  FAKE_GROUP_ID,
  FAKE_SECOND_SITE_ADDRESS,
  FAKE_SHARED_MAILBOX,
  FAKE_SITE_ADDRESS,
  fakeGroupUsers,
  fakeTenantSources,
  type FakeTenantOptions,
} from '../scripts/m365/cassette/fakeTenant';
import { CassetteLintError } from '../scripts/m365/cassette/lint';
import { assertOutsideRepo, isInside, repoRoots } from '../scripts/m365/cassette/outsideRepo';
import { readinessLines } from '../scripts/m365/cassette/readiness';
import { RecorderRefusal } from '../scripts/m365/cassette/refusal';
import { REPLAY_ORIGIN, ScrubDivergenceError } from '../scripts/m365/cassette/scrub';
import { CassetteMissError, loadCassette, replayReaderFor } from '../scripts/m365/cassette/replayFetch';
import { readCassette, type CassetteSource } from '../scripts/m365/cassette/format';
import { readBackfillThenDelta, RECORD_EXTRACT, sourceRow } from '../scripts/m365/cassette/record';
import {
  assertLiveGates,
  describeFailure,
  gitIn,
  READER_PATHSPEC,
  recordGraph,
  recordGraphLive,
  type LiveRecordOptions,
  type RecordGraphDeps,
} from '../scripts/m365/record-graph';
import { SOURCE_KIND } from '../src/lib/constants/discovery';
import { GraphHttpError } from '../src/lib/graph/http';
import type { ReaderTokenCache } from '../src/lib/graph/reader/token';
import type { MirrorMember, ProviderAllowlistMirror } from '../src/lib/mailboxAccess/mirror';

const UUID1 = '11111111-1111-4111-8111-111111111111';
const UUID2 = '22222222-2222-4222-8222-222222222222';
const UUID3 = '33333333-3333-4333-8333-333333333333';
const SHA = 'a'.repeat(40);

const staticTokens = { forRegistration: () => async () => 'fake-graph-token' } as unknown as ReaderTokenCache;

const baseConfig = () => ({
  tenantId: UUID1,
  msTenantId: UUID2,
  clientId: UUID3,
  certThumbprint: 'ab'.repeat(32),
  certSecretRef: 'env:GRAPH_READER_CERT_PEM',
  status: 'active',
  consentedAt: '2026-10-01T09:00:00Z',
  firmCompany: 'Example Bank',
  mailboxDomains: ['bank.example'],
  sources: fakeTenantSources().map((s) => ({ ...s, ownerEmail: null })),
});

const roots: string[] = [];
const tempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'record-graph-'));
  roots.push(root);
  return root;
};
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

const writeConfig = (config: unknown = baseConfig()) => {
  const path = join(tempRoot(), 'registration.json');
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  return path;
};

const cleanGit = (args: string[]) => (args[0] === 'status' ? '' : SHA);
// The variable the registration's env: certificate names: present for a --live run, and never read by the gates.
const PEM_ENV = { GRAPH_READER_CERT_PEM: 'present, never read' };

const setup = (over: Partial<RecordGraphDeps> = {}) => {
  const tenant = createFakeTenant();
  const lines: string[] = [];
  const deps: RecordGraphDeps = {
    fetchImpl: tenant.fetch,
    tokenCache: staticTokens,
    now: () => new Date('2026-10-02T08:00:00.000Z'),
    git: cleanGit,
    log: (line) => lines.push(line),
    ...over,
  };
  return { tenant, lines, deps };
};

const message = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
};

describe('m365:record-graph guards', () => {
  it('refuses --out inside the repo, and through a symlink into it, before reading anything', async () => {
    const inside = join(process.cwd(), 'tmp-cassette-never-created');
    const link = join(tempRoot(), 'link');
    symlinkSync(process.cwd(), link);
    for (const out of [inside, join(link, 'tmp-cassette-never-created')]) {
      const { tenant, deps } = setup();
      expect(await message(() => recordGraph({ configPath: writeConfig(), out, allowEnvPem: true }, deps))).toMatch(
        /must be outside the repository/,
      );
      expect(tenant.requests).toEqual([]);
    }
    expect(readdirSync(process.cwd())).not.toContain('tmp-cassette-never-created');
  });

  it('refuses a path inside a root, and accepts one outside, without needing the path to exist', () => {
    const root = tempRoot();
    expect(() => assertOutsideRepo(join(root, 'a', 'b', 'c'), [root])).toThrow(/outside the repository/);
    expect(() => assertOutsideRepo(root, [root])).toThrow(/outside the repository/);
    expect(() => assertOutsideRepo(join(tempRoot(), 'new'), [root])).not.toThrow();
    expect(() => assertOutsideRepo(join(root, '..', 'elsewhere'), [root])).not.toThrow();
  });

  it('treats a sibling whose name only starts with two dots as inside, and a real parent segment as outside', () => {
    const root = tempRoot();
    // `..x` is a directory called "..x" under the root, not the parent.
    expect(() => assertOutsideRepo(join(root, '..x'), [root])).toThrow(/outside the repository/);
    expect(() => assertOutsideRepo(join(root, '..x', 'a', 'b'), [root])).toThrow(/outside the repository/);
    expect(() => assertOutsideRepo(join(root, '...'), [root])).toThrow(/outside the repository/);
    expect(() => assertOutsideRepo(join(root, '..', 'elsewhere'), [root])).not.toThrow();
    expect(isInside('/r/root', '/r/root/..x')).toBe(true);
    expect(isInside('/r/root', '/r/root/..')).toBe(false);
    expect(isInside('/r/root', '/r/root/../x')).toBe(false);
    expect(isInside('/r/root', '/r/root')).toBe(true);
    expect(isInside('/r/root', '/r/rootx')).toBe(false);
  });

  it('refuses a config that holds a PEM without echoing it', async () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';
    const { tenant, deps } = setup();
    const out = join(tempRoot(), 'c');
    const text = await message(() =>
      recordGraph({ configPath: writeConfig({ ...baseConfig(), certSecretRef: pem }), out, allowEnvPem: true }, deps),
    );
    expect(text).toContain('key material');
    expect(text).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC');
    expect(tenant.requests).toEqual([]);
  });

  it('refuses a config that is not JSON without quoting it', async () => {
    const path = join(tempRoot(), 'registration.json');
    writeFileSync(path, `{"tenantId": "${UUID1}" oops`);
    const text = await message(() => recordGraph({ configPath: path, out: join(tempRoot(), 'c'), allowEnvPem: true }, setup().deps));
    expect(text).not.toContain(UUID1);
  });

  it('refuses an env: reference without --allow-env-pem, and accepts it with', async () => {
    const out = join(tempRoot(), 'c');
    const denied = setup();
    expect(await message(() => recordGraph({ configPath: writeConfig(), out, allowEnvPem: false }, denied.deps))).toMatch(
      /--allow-env-pem/,
    );
    expect(denied.tenant.requests).toEqual([]);

    const allowed = setup();
    const result = await recordGraph({ configPath: writeConfig(), out, allowEnvPem: true }, allowed.deps);
    expect(result.interactions).toBeGreaterThan(0);
  });

  it('refuses a live recording: no transport handed in means a live tenant, which the mailbox guard cannot yet cover (#262)', async () => {
    const out = join(tempRoot(), 'c');
    const { tenant, deps } = setup({ fetchImpl: undefined, tokenCache: undefined });
    expect(await message(() => recordGraph({ configPath: writeConfig(), out, allowEnvPem: true }, deps))).toMatch(
      /Live recording is not available.*mailbox guard/,
    );
    expect(tenant.requests).toEqual([]);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses an --out that already exists', async () => {
    const out = tempRoot(); // exists
    const { tenant, deps } = setup();
    expect(await message(() => recordGraph({ configPath: writeConfig(), out, allowEnvPem: true }, deps))).toMatch(
      /already exists/,
    );
    expect(tenant.requests).toEqual([]);
  });
});

describe('m365:record-graph reader commit', () => {
  it('refuses a dirty src/lib/graph before any request', async () => {
    const { tenant, deps } = setup({
      git: (args) => (args[0] === 'status' ? ' M src/lib/graph/reader/mail.ts' : SHA),
    });
    const out = join(tempRoot(), 'c');
    expect(await message(() => recordGraph({ configPath: writeConfig(), out, allowEnvPem: true }, deps))).toMatch(
      /uncommitted changes/,
    );
    expect(tenant.requests).toEqual([]);
    expect(() => statSync(out)).toThrow();
  });

  it('asks git only about src/lib/graph, and records the HEAD sha in the manifest', async () => {
    const calls: string[][] = [];
    const { deps } = setup({
      git: (args) => {
        calls.push(args);
        return cleanGit(args);
      },
    });
    const out = join(tempRoot(), 'c');
    const result = await recordGraph({ configPath: writeConfig(), out, allowEnvPem: true }, deps);
    expect(result.readerCommit).toBe(SHA);
    expect(calls).toContainEqual(['status', '--porcelain', '--', ':/src/lib/graph']);
    expect(READER_PATHSPEC).toBe(':/src/lib/graph');
    expect(readCassette(out).manifest.readerCommit).toBe(SHA);
  });

  it('refuses a HEAD that is not a sha', async () => {
    const { tenant, deps } = setup({ git: (args) => (args[0] === 'status' ? '' : 'not-a-sha') });
    expect(
      await message(() => recordGraph({ configPath: writeConfig(), out: join(tempRoot(), 'c'), allowEnvPem: true }, deps)),
    ).toMatch(/commit sha/);
    expect(tenant.requests).toEqual([]);
  });

  it('names the recorded reader commit in a replay miss, and only a well-formed one', async () => {
    const out = join(tempRoot(), 'c');
    await recordGraph({ configPath: writeConfig(), out, allowEnvPem: true }, setup().deps);
    const cassette = loadCassette(out);
    const miss = await cassette.fetch('https://graph.microsoft.com/v1.0/never-recorded').catch((e: Error) => e);
    expect(miss).toBeInstanceOf(CassetteMissError);
    expect((miss as Error).message).toContain(`check out ${SHA} (the reader this cassette was recorded with)`);

    const odd = new CassetteMissError('GET', 'https://graph.microsoft.com/v1.0/x', [], 'x; drop table');
    expect(odd.message).not.toContain('drop table');
    expect(odd.message).not.toContain('check out');
    expect(new CassetteMissError('GET', 'https://graph.microsoft.com/v1.0/x').message).not.toContain('check out');
  });
});

describe('m365:record-graph does not depend on the working directory', () => {
  const repoTop = realpathSync(execFileSync('git', ['-C', __dirname, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
  const cli = join(repoTop, 'scripts', 'm365', 'record-graph.ts');
  const tsx = pathToFileURL(join(repoTop, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href; // absolute: cwd is not the repo

  it('finds this checkout from the script location, from any directory', () => {
    expect(realpathSync(repoRoots()[0])).toBe(repoTop);
    expect(realpathSync(repoRoots(join(repoTop, 'scripts'))[0])).toBe(repoTop);
  });

  it('sees a dirty reader from a subdirectory or an unrelated directory (git -C <root>, :/ pathspec)', () => {
    const repo = realpathSync(tempRoot());
    const run = (args: string[], cwd = repo) =>
      execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    run(['init', '-q']);
    mkdirSync(join(repo, 'src', 'lib', 'graph'), { recursive: true });
    mkdirSync(join(repo, 'scripts'));
    writeFileSync(join(repo, 'src', 'lib', 'graph', 'reader.ts'), 'export {};\n');
    run(['add', '.']);
    run(['commit', '-q', '-m', 'init']);
    const clean = gitIn(repo)(['status', '--porcelain', '--', READER_PATHSPEC]);
    expect(clean).toBe('');

    writeFileSync(join(repo, 'src', 'lib', 'graph', 'reader.ts'), 'export const x = 1;\n');
    // The old check, run from scripts/, finds nothing: the pathspec is relative to the working directory.
    expect(run(['status', '--porcelain', '--', 'src/lib/graph'], join(repo, 'scripts'))).toBe('');
    // The fixed one finds the change from everywhere: the process's own directory is not the repository.
    expect(process.cwd()).not.toBe(repo);
    expect(gitIn(repo)(['status', '--porcelain', '--', READER_PATHSPEC])).toContain('src/lib/graph/reader.ts');
    expect(run(['status', '--porcelain', '--', READER_PATHSPEC], join(repo, 'scripts'))).toContain('src/lib/graph/reader.ts');
    expect(gitIn(repo)(['rev-parse', 'HEAD'])).toMatch(/^[0-9a-f]{40}$/);
  });

  it('the CLI run from an unrelated, non-git directory still checks --out against THIS repository', () => {
    const elsewhere = realpathSync(tempRoot());
    const inside = join(repoTop, 'tmp-cassette-never-created');
    const result = spawnSync(process.execPath, ['--import', tsx, cli, '--config', join(elsewhere, 'registration.json'), '--out', inside], {
      cwd: elsewhere,
      encoding: 'utf8',
      env: { ...process.env, TSX_TSCONFIG_PATH: join(repoTop, 'tsconfig.json') },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--out must be outside the repository/);
    expect(result.stderr).not.toMatch(/git rev-parse failed/); // the old cwd-based lookup failed here, and failed open elsewhere
    expect(readdirSync(repoTop)).not.toContain('tmp-cassette-never-created');
  });

  it('the CLI, with its default git wiring, refuses a dirty reader in the checkout that holds the script, before any network', () => {
    // A throwaway checkout: the script and everything it imports, committed, under a temp directory. The default
    // `gitIn(repoRoots()[0])` finds THAT repository from the script's own location.
    const checkout = realpathSync(tempRoot());
    const git = (args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
        cwd: checkout,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    for (const path of ['scripts/m365', 'src/lib', 'worker']) cpSync(join(repoTop, path), join(checkout, path), { recursive: true });
    cpSync(join(repoTop, 'tsconfig.json'), join(checkout, 'tsconfig.json'));
    symlinkSync(join(repoTop, 'node_modules'), join(checkout, 'node_modules')); // untracked, and outside the reader's pathspec
    git(['init', '-q']);
    git(['add', 'scripts', 'src', 'worker', 'tsconfig.json']);
    git(['commit', '-q', '-m', 'init']);

    const spawnCli = (out: string) =>
      spawnSync(process.execPath, ['--import', tsx, join(checkout, 'scripts', 'm365', 'record-graph.ts'), '--config', join(checkout, 'no-such-registration.json'), '--out', out], {
        cwd: realpathSync(tempRoot()), // not the checkout: nothing may depend on it
        encoding: 'utf8',
        env: { ...process.env, TSX_TSCONFIG_PATH: join(checkout, 'tsconfig.json') },
        timeout: 60_000,
      });
    const dirtyLine = describeFailure(
      new RecorderRefusal('the Graph reader has uncommitted changes; commit or stash them so the cassette names the reader that made it'),
    );

    // Control: the checkout is clean, so the run gets past the reader check to the (missing) config.
    const cleanOut = join(realpathSync(tempRoot()), 'cassette');
    const clean = spawnCli(cleanOut);
    expect(clean.stderr.trim()).toBe(describeFailure(new RecorderRefusal('The registration config could not be read as JSON')));

    // Dirty the reader in the temporary checkout only.
    const target = join(checkout, 'src', 'lib', 'graph', 'http.ts');
    writeFileSync(target, `${readFileSync(target, 'utf8')}\n// dirty\n`);
    expect(git(['status', '--porcelain', '--', READER_PATHSPEC])).toContain('src/lib/graph/http.ts');

    const outDir = join(realpathSync(tempRoot()), 'cassette');
    const dirty = spawnCli(outDir);
    expect(dirty.status).toBe(1);
    expect(dirty.stderr.trim()).toBe(dirtyLine);
    expect(dirty.stdout).toBe('');
    expect(readdirSync(join(outDir, '..'))).toEqual([]); // nothing was written, and no network was reached
    expect(dirty.stderr).not.toMatch(/registration config/); // it stopped before the config was even read
  }, 60_000);
});

describe('m365:record-graph prints fixed, value-free failures', () => {
  const REQUEST_ID = '0f9d1c2e-1111-4222-8333-444455556666';
  const ADDRESS = 'alex.chen@bank.example';

  it('maps a Graph HTTP error to its class and status, without the request id or code', () => {
    const error = new GraphHttpError(403, 'ErrorAccessDenied', REQUEST_ID, 3);
    expect(error.message).toContain(REQUEST_ID); // the raw text is what the CLI must not print
    const line = describeFailure(error);
    expect(line).toBe('GraphHttpError: Graph answered 403');
    expect(line).not.toContain(REQUEST_ID);
  });

  it('prints a lint refusal by rule and location and a divergence by count', () => {
    const lint = describeFailure(new CassetteLintError([{ rule: 'tempauth', where: 'interactions[12].headers.location' }]));
    expect(lint).toContain('tempauth at interactions[12].headers.location');
    expect(describeFailure(new ScrubDivergenceError(2))).toContain('(2 keys)');
  });

  it('prints only the class of an unknown error, whatever its message holds', () => {
    class TenantTroubleError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'TenantTroubleError';
      }
    }
    for (const error of [new TenantTroubleError(`mailbox ${ADDRESS} request-id ${REQUEST_ID} eyJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJmYWtlIn0.c2ln`), new Error(ADDRESS)]) {
      const line = describeFailure(error);
      expect(line).toMatch(/^(TenantTroubleError|Error): /);
      for (const secret of [ADDRESS, REQUEST_ID, 'eyJhbGci', 'request-id']) expect(line).not.toContain(secret);
    }
    expect(describeFailure('a string with ' + ADDRESS)).not.toContain(ADDRESS);
    expect(describeFailure(Object.assign(new Error(ADDRESS), { name: `bad name ${ADDRESS}` }))).not.toContain(ADDRESS);
  });

  it('does not name an address when the config repeats a source', async () => {
    const dup = baseConfig();
    dup.sources = [...dup.sources, { ...dup.sources[0] }];
    const { tenant, deps } = setup();
    let failure: unknown;
    try {
      await recordGraph({ configPath: writeConfig(dup), out: join(tempRoot(), 'c'), allowEnvPem: true }, deps);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RecorderRefusal);
    const line = describeFailure(failure);
    expect(line).toMatch(/sources\[\d+\] repeats an earlier source/);
    expect(line).not.toContain(dup.sources[0].address);
    expect(tenant.requests).toEqual([]);
  });

  it('the CLI prints the fixed line for a refusal and exits 1', () => {
    const inside = join(process.cwd(), 'tmp-cassette-never-created');
    const result = spawnSync(process.execPath, ['--import', 'tsx', join(process.cwd(), 'scripts', 'm365', 'record-graph.ts'), '--config', 'x', '--out', inside], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(describeFailure(new RecorderRefusal('--out must be outside the repository (a path inside a git checkout): a cassette never goes into git')));
  });
});

describe('m365:record-graph happy path', () => {
  it('records the fake tenant into a sealed, clean, owner-only cassette and prints counts only', async () => {
    const { lines, deps } = setup();
    const out = join(tempRoot(), 'cassette');
    const result = await recordGraph({ configPath: writeConfig(), out, allowEnvPem: true }, deps);

    const loaded = loadCassette(out); // the digest verifies and the lint is clean
    expect(loaded.digestSha256).toBe(result.digestSha256);
    expect(result.interactions).toBeGreaterThan(0);
    expect(result.interactions).toBe(loaded.interactions.length);
    expect(result.droppedHeaders).toContain('x-ms-throttle-scope');

    const files = [
      'manifest.json',
      'interactions.jsonl',
      'digest.json',
      ...readdirSync(join(out, 'bodies')).map((name) => join('bodies', name)),
    ];
    for (const file of files) expect(statSync(join(out, file)).mode & 0o777).toBe(0o600);

    const printed = lines.join('\n');
    expect(printed).toContain(`cassette sha256:${result.digestSha256}`);
    expect(printed).toContain(`reader ${SHA}`);
    for (const secret of ['@bank.example', 'Project Falcon', 'fake-graph-token', UUID1, UUID2, UUID3, 'bank.sharepoint.com']) {
      expect(printed).not.toContain(secret);
    }
    // Also nothing about the config reached the cassette.
    const stored = readFileSync(join(out, 'manifest.json'), 'utf8');
    for (const id of [UUID1, UUID2, UUID3, 'ab'.repeat(32)]) expect(stored).not.toContain(id);
  });

  it('writes nothing when the cassette fails its credential check', async () => {
    // A fetch that leaks a bearer token into every folder listing (a repeated key must not diverge): scrub keeps bodies, so lint must refuse the save.
    const inner = createFakeTenant().fetch;
    const leaky = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await inner(input, init);
      if (!String(input).includes('/mailFolders') || res.status !== 200) return res;
      const json = (await res.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...json, note: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789' }), {
        status: 200,
        headers: res.headers,
      });
    }) as typeof fetch;
    const { deps } = setup({ fetchImpl: leaky });
    const out = join(tempRoot(), 'c');
    const text = await message(() => recordGraph({ configPath: writeConfig(), out, allowEnvPem: true }, deps));
    expect(text).toMatch(/bearer at /);
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(() => statSync(out)).toThrow();
    mkdirSync(out); // the directory was never created, so it is still free
  });
});

describe('m365:record-graph --live gates (#318): every refusal comes before any Graph call', () => {
  afterEach(() => vi.unstubAllEnvs());

  const LOCAL = { url: 'http://127.0.0.1:54321', secretKey: 'local-secret-key' };
  const registrationRow = (over: Record<string, unknown> = {}) => ({
    tenant_id: UUID1,
    ms_tenant_id: UUID2,
    client_id: UUID3,
    cert_thumbprint: 'ab'.repeat(32),
    mailbox_domains: ['bank.example'],
    cert_secret_ref: 'env:GRAPH_READER_CERT_PEM',
    scope_group_id: FAKE_GROUP_ID,
    ...over,
  });

  type Chain = {
    select(columns: string): Chain;
    eq(column: string, value: unknown): Chain;
    maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
  };

  /** A database that answers the one query the gates make, and records what was asked. */
  const fakeDb = (row: Record<string, unknown> | null = registrationRow(), error: { message: string } | null = null) => {
    const asked: Array<[string, ...unknown[]]> = [];
    const chain: Chain = {
      select(columns) {
        asked.push(['select', columns]);
        return chain;
      },
      eq(column, value) {
        asked.push(['eq', column, value]);
        return chain;
      },
      maybeSingle: async () => ({ data: row, error }),
    };
    const db = {
      from(table: string) {
        asked.push(['from', table]);
        return chain;
      },
    } as unknown as SupabaseClient;
    return { db, asked };
  };

  const live = (over: Partial<LiveRecordOptions> = {}): LiveRecordOptions => ({
    tenantId: UUID1,
    msTenantId: UUID2,
    confirmDomains: ['bank.example'],
    out: join(tempRoot(), 'cassette'),
    allowEnvPem: true,
    allowRemoteSupabase: null,
    preflight: false,
    ...over,
  });

  const gateSetup = (over: Partial<RecordGraphDeps> & { row?: Record<string, unknown> | null } = {}) => {
    const { row, ...deps } = over;
    const tenant = createFakeTenant();
    const database = fakeDb(row === undefined ? registrationRow() : row);
    return {
      tenant,
      ...database,
      deps: {
        fetchImpl: tenant.fetch,
        tokenCache: staticTokens,
        git: cleanGit,
        db: database.db,
        adminCredentials: () => LOCAL,
        env: PEM_ENV,
        ...deps,
      } satisfies RecordGraphDeps,
    };
  };

  const refusal = async (options: LiveRecordOptions, deps: RecordGraphDeps) => {
    try {
      await assertLiveGates(options, deps);
    } catch (error) {
      expect(error).toBeInstanceOf(RecorderRefusal);
      return (error as Error).message;
    }
    throw new Error('expected a refusal');
  };

  it('passes every gate for the bound registration and returns what it checked', async () => {
    const { deps, asked } = gateSetup();
    const result = await assertLiveGates(live({ confirmDomains: ['Bank.Example'] }), deps);
    expect(result.registration).toEqual({
      tenantId: UUID1,
      msTenantId: UUID2,
      clientId: UUID3,
      certThumbprint: 'ab'.repeat(32),
      mailboxDomains: ['bank.example'],
      certSecretRef: 'env:GRAPH_READER_CERT_PEM',
      scopeGroupId: FAKE_GROUP_ID,
    });
    // The one query: the tenant's ACTIVE registration, and nothing else.
    expect(asked).toEqual([
      ['from', 'graph_reader_registrations'],
      ['select', 'tenant_id, ms_tenant_id, client_id, cert_thumbprint, mailbox_domains, cert_secret_ref, scope_group_id'],
      ['eq', 'tenant_id', UUID1],
      ['eq', 'status', 'active'],
    ]);
  });

  it('refuses a run the readiness check blocks, naming the reason, with no request and nothing written', async () => {
    // A registration with no scope group: readiness ends the run at its first check, so the fake answers nothing more.
    const { tenant, deps } = gateSetup({ row: registrationRow({ scope_group_id: null }), mirror: { listMembers: async () => [] } });
    const options = live();
    expect(await message(() => recordGraphLive(options, deps))).toBe('the run is blocked (no_scope_group); nothing is read');
    expect(tenant.requests).toEqual([]);
    expect(existsSync(options.out!)).toBe(false);
  });

  it('refuses --config: a live run reads its registration from the database', async () => {
    const { tenant, deps, asked } = gateSetup();
    expect(await refusal(live({ configPath: writeConfig() }), deps)).toMatch(/takes no --config/);
    expect(asked).toEqual([]);
    expect(tenant.requests).toEqual([]);
  });

  it('refuses a malformed tenant, Microsoft tenant id or domain list before touching the database', async () => {
    const { tenant, deps, asked } = gateSetup();
    expect(await refusal(live({ tenantId: 'not-a-uuid' }), deps)).toMatch(/--tenant/);
    expect(await refusal(live({ msTenantId: 'common' }), deps)).toMatch(/--ms-tenant-id/);
    for (const confirmDomains of [[], [''], ['md@bank.example'], ['https://bank.example']]) {
      expect(await refusal(live({ confirmDomains }), deps)).toMatch(/--confirm-domains/);
    }
    expect(asked).toEqual([]);
    expect(tenant.requests).toEqual([]);
  });

  it('refuses --out inside the repo or already present, but needs none for --preflight', async () => {
    const { deps, asked } = gateSetup();
    expect(await refusal(live({ out: join(process.cwd(), 'tmp-cassette-never-created') }), deps)).toMatch(/outside the repository/);
    expect(await refusal(live({ out: tempRoot() }), deps)).toMatch(/already exists/);
    expect(await refusal(live({ out: null }), deps)).toMatch(/needs --out/);
    expect(asked).toEqual([]);
    await expect(assertLiveGates(live({ out: null, preflight: true }), deps)).resolves.toBeDefined();
  });

  it('refuses a production environment, however NEXT_PUBLIC_APP_ENV is spelled', async () => {
    for (const NEXT_PUBLIC_APP_ENV of ['prod', 'production', ' PROD ', 'Production']) {
      const { tenant, deps, asked } = gateSetup({ env: { ...PEM_ENV, NEXT_PUBLIC_APP_ENV } });
      expect(await refusal(live(), deps)).toMatch(/production environment/);
      expect(asked).toEqual([]);
      expect(tenant.requests).toEqual([]);
    }
    const { deps } = gateSetup({ env: { ...PEM_ENV, NEXT_PUBLIC_APP_ENV: 'staging' } });
    await expect(assertLiveGates(live(), deps)).resolves.toBeDefined();
  });

  it('refuses any uncommitted change in the whole tree, asking git with no pathspec', async () => {
    const calls: string[][] = [];
    const { tenant, deps, asked } = gateSetup({
      git: (args) => {
        calls.push(args);
        return args[0] === 'status' ? '?? notes.txt' : SHA; // outside src/lib/graph: the injected check would pass it
      },
    });
    expect(await refusal(live(), deps)).toMatch(/uncommitted changes/);
    expect(calls).toEqual([['status', '--porcelain']]);
    expect(asked).toEqual([]);
    expect(tenant.requests).toEqual([]);
  });

  it('refuses when the guard database credentials are missing', async () => {
    const { tenant, deps, asked } = gateSetup({ adminCredentials: () => null });
    expect(await refusal(live(), deps)).toMatch(/NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY/);
    expect(asked).toEqual([]);
    expect(tenant.requests).toEqual([]);
  });

  it('refuses a remote or non-https database, and never echoes the host', async () => {
    const cases: Array<[string, string | null]> = [
      ['https://db.remote.test', null], // remote, not named
      ['https://db.remote.test', 'other.remote.test'], // remote, another host named
      ['http://db.remote.test', 'db.remote.test'], // named, but in the clear
      ['http://127.0.0.1.nip.io', null], // a look-alike of loopback
    ];
    for (const [url, allowRemoteSupabase] of cases) {
      const { tenant, deps, asked } = gateSetup({ adminCredentials: () => ({ url, secretKey: 'k' }) });
      const text = await refusal(live({ allowRemoteSupabase }), deps);
      expect(text).toMatch(/Supabase target/);
      expect(text).not.toMatch(/remote\.test|nip\.io/);
      expect(asked).toEqual([]);
      expect(tenant.requests).toEqual([]);
    }
    const { deps } = gateSetup({ adminCredentials: () => ({ url: 'https://db.remote.test', secretKey: 'k' }) });
    await expect(assertLiveGates(live({ allowRemoteSupabase: 'db.remote.test' }), deps)).resolves.toBeDefined();
  });

  it('checks the URL the guard itself uses (getSupabaseAdminCredentials), not a second reading of the environment', async () => {
    // No credentials injected: the gate reads them as the guard's own client does.
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.remote.test');
    vi.stubEnv('SUPABASE_SECRET_KEY', 'secret-from-env');
    const remote = gateSetup();
    const bare: RecordGraphDeps = { git: cleanGit, db: remote.db, env: PEM_ENV };
    expect(await refusal(live(), bare)).toMatch(/Supabase target/);
    expect(remote.asked).toEqual([]);

    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
    await expect(assertLiveGates(live(), bare)).resolves.toBeDefined();
    vi.stubEnv('SUPABASE_SECRET_KEY', '');
    expect(await refusal(live(), bare)).toMatch(/NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY/);
  });

  it('refuses a tenant with no active registration, and a failed lookup, without echoing the database error', async () => {
    const none = gateSetup({ row: null });
    expect(await refusal(live(), none.deps)).toMatch(/no active Graph reader registration/);
    expect(none.tenant.requests).toEqual([]);

    const failing = fakeDb(null, { message: `relation of ${UUID1} is unavailable` });
    const text = await refusal(live(), { ...none.deps, db: failing.db });
    expect(text).toBe('the registration lookup failed');
  });

  it("refuses a Microsoft tenant id that is not the registration's, and accepts it in any case", async () => {
    const wrong = gateSetup();
    const text = await refusal(live({ msTenantId: UUID3 }), wrong.deps);
    expect(text).toMatch(/--ms-tenant-id does not match/);
    for (const value of [UUID2, UUID3]) expect(text).not.toContain(value);
    expect(wrong.tenant.requests).toEqual([]);

    const replay = gateSetup({ row: registrationRow({ ms_tenant_id: 'replay' }) });
    expect(await refusal(live(), replay.deps)).toMatch(/does not match/);
    await expect(assertLiveGates(live({ msTenantId: UUID2.toUpperCase() }), wrong.deps)).resolves.toBeDefined();
  });

  it("refuses a domain list that is not the registration's full set, in either direction", async () => {
    const two = registrationRow({ mailbox_domains: ['bank.example', 'advisors.example'] });
    const subset = gateSetup({ row: two });
    const text = await refusal(live({ confirmDomains: ['bank.example'] }), subset.deps);
    expect(text).toMatch(/full set of mail domains/);
    expect(text).not.toMatch(/example/);
    expect(await refusal(live({ confirmDomains: ['bank.example', 'advisors.example', 'extra.example'] }), subset.deps)).toMatch(/full set/);
    expect(await refusal(live({ confirmDomains: ['bank.example', 'other.example'] }), subset.deps)).toMatch(/full set/);
    expect(subset.tenant.requests).toEqual([]);

    // Order, case and repeats do not matter; the set does.
    await expect(
      assertLiveGates(live({ confirmDomains: ['ADVISORS.example', 'bank.example', 'bank.example'] }), subset.deps),
    ).resolves.toBeDefined();
    // A stored list that is not a clean domain list never matches.
    expect(await refusal(live(), gateSetup({ row: registrationRow({ mailbox_domains: [] }) }).deps)).toMatch(/full set/);
  });

  it('refuses an env: certificate whose variable is not set, without naming it or reading any value', async () => {
    for (const env of [{}, { GRAPH_READER_CERT_PEM: '' }]) {
      const { tenant, deps } = gateSetup({ env });
      expect(await refusal(live(), deps)).toBe("the environment variable the registration's env: certificate names is not set");
      expect(tenant.requests).toEqual([]);
    }
  });

  it('refuses a certificate that is not an env: reference, and an env: one without --allow-env-pem', async () => {
    for (const cert_secret_ref of ['keyvault:https://vault.vault.azure.net/keys/k/1', null, '']) {
      const { tenant, deps } = gateSetup({ row: registrationRow({ cert_secret_ref }) });
      expect(await refusal(live(), deps)).toMatch(/env: certificate/);
      expect(tenant.requests).toEqual([]);
    }
    const { deps } = gateSetup();
    expect(await refusal(live({ allowEnvPem: false }), deps)).toMatch(/--allow-env-pem/);
  });

  it('prints no tenant value in any refusal', async () => {
    const texts = [
      await refusal(live({ msTenantId: UUID3 }), gateSetup().deps),
      await refusal(live({ confirmDomains: ['other.example'] }), gateSetup().deps),
      await refusal(live({ allowEnvPem: false }), gateSetup().deps),
    ];
    for (const text of texts) for (const value of [UUID1, UUID2, UUID3, 'bank.example', 'other.example']) expect(text).not.toContain(value);
  });
});

describe('m365:record-graph --live capture (#318): the guarded recording ends in the injected path\'s cassette', () => {
  afterEach(() => {
    graphWire.fetch = null;
    graphWire.registrations.length = 0;
  });

  const LOCAL = { url: 'http://127.0.0.1:54321', secretKey: 'local-secret-key' };
  const OWNER = '44444444-4444-4444-8444-444444444444';
  const NOW = '2026-10-02T08:00:00.000Z'; // the same clock as setup(), so the manifests can be compared whole

  type Row = Record<string, unknown>;
  const byAddress = (a: CassetteSource, b: CassetteSource) => (a.address < b.address ? -1 : 1);
  const isMailbox = (source: CassetteSource) => source.kind === SOURCE_KIND.MAILBOX;
  const SECOND_SITE: CassetteSource = { kind: SOURCE_KIND.SHAREPOINT_SITE, address: FAKE_SECOND_SITE_ADDRESS };
  const SHARED: CassetteSource = { kind: SOURCE_KIND.MAILBOX, address: FAKE_SHARED_MAILBOX.mail };
  // The database lists sources in address order; the injected config is given the same order.
  const ONE_SITE = [...fakeTenantSources()].sort(byAddress);
  const TWO_SITES = [...ONE_SITE, SECOND_SITE].sort(byAddress);
  const FIRST_MAILBOX = ONE_SITE.find(isMailbox)!.address;

  const registrationRow = (over: Row = {}): Row => ({
    tenant_id: UUID1,
    ms_tenant_id: UUID2,
    client_id: UUID3,
    cert_thumbprint: 'ab'.repeat(32),
    mailbox_domains: ['bank.example'],
    cert_secret_ref: 'env:GRAPH_READER_CERT_PEM',
    scope_group_id: FAKE_GROUP_ID,
    status: 'active',
    ...over,
  });

  type Builder = {
    select(): Builder;
    eq(column: string, value: unknown): Builder;
    order(column: string, options?: { ascending?: boolean }): Builder;
    range(from: number, to: number): Promise<{ data: Row[]; error: null }>;
    limit(count: number): Promise<{ data: Row[]; error: null }>;
    maybeSingle(): Promise<{ data: Row | null; error: null }>;
    then(resolve: (value: { data: Row[]; error: null }) => unknown): unknown;
  };

  /** An in-memory database holding what the readiness check and the gates read: the registration, the policy, the allowlist, the sources. */
  function fakeDb(sources: CassetteSource[], registration: Row) {
    const tables: Record<string, Row[]> = {
      allowed_mailboxes: sources.filter(isMailbox).map((s) => ({ tenant_id: UUID1, provider: 'microsoft', address: s.address })),
      discovery_exclusion_policies: [{ tenant_id: UUID1, version: 1, rules: [] }],
      content_sources: sources.map((s) => ({
        id: `src-${s.address}`,
        tenant_id: UUID1,
        provider: 'microsoft',
        status: 'active',
        kind: s.kind,
        address: s.address,
        owner_user_id: OWNER,
        last_error: null,
      })),
      graph_reader_registrations: [registration],
    };
    const drift = vi.fn().mockResolvedValue({ data: null, error: null });
    const db = {
      rpc: drift,
      from(table: string): Builder {
        const filters: Array<[string, unknown]> = [];
        let sort: { column: string; ascending: boolean } | null = null;
        const rows = (): Row[] => {
          const matching = (tables[table] ?? []).filter((row) => filters.every(([column, value]) => row[column] === value));
          if (!sort) return matching;
          const { column, ascending } = sort;
          return [...matching].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (ascending ? 1 : -1));
        };
        const builder: Builder = {
          select: () => builder,
          eq: (column, value) => {
            filters.push([column, value]);
            return builder;
          },
          order: (column, options) => {
            sort = { column, ascending: options?.ascending !== false };
            return builder;
          },
          range: async (from, to) => ({ data: rows().slice(from, to + 1), error: null }),
          limit: async (count) => ({ data: rows().slice(0, count), error: null }),
          maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
          then: (resolve) => resolve({ data: rows(), error: null }),
        };
        return builder;
      },
    } as unknown as SupabaseClient;
    return { db, drift };
  }

  /** The provider group as the directory holds it: one object per allowlisted mailbox, the shared mailbox under its own UPN. */
  function groupOf(sources: CassetteSource[]): ProviderAllowlistMirror {
    const wanted = new Set(sources.filter(isMailbox).map((s) => s.address.toLowerCase()));
    const members: MirrorMember[] = fakeGroupUsers()
      .filter((user) => wanted.has(user.mail.toLowerCase()))
      .map((user) => ({ id: user.id, mail: user.mail, upn: user.upn }));
    return { listMembers: async () => members };
  }

  /** The guard allows every ask except those `refuse` names; `ask` counts the asks about one address (readiness is the first). */
  function guard(refuse: (address: string, ask: number) => string | null = () => null) {
    const asks = new Map<string, number>();
    admin.rpc.mockReset();
    admin.rpc.mockImplementation(async (fn: string, args: { p_address: string }) => {
      // #275's read-only verdict, asked before a mailbox's binding requests, answers as the next recorded ask would
      // and is not an ask itself: it records nothing.
      const next = (asks.get(args.p_address) ?? 0) + 1;
      if (fn === 'mailbox_guard_verdict') return { data: refuse(args.p_address, next), error: null };
      asks.set(args.p_address, next);
      return { data: refuse(args.p_address, next), error: null };
    });
    return { asks };
  }

  /** A live run over a fake tenant, with the injected database, group and clock. */
  function liveRun(sources: CassetteSource[], options: { tenant?: FakeTenantOptions; registration?: Row } = {}) {
    const database = fakeDb(sources, registrationRow(options.registration));
    const tenant = createFakeTenant(options.tenant);
    graphWire.fetch = tenant.fetch;
    const lines: string[] = [];
    const out = join(tempRoot(), 'live');
    const deps: RecordGraphDeps = {
      db: database.db,
      adminCredentials: () => LOCAL,
      env: PEM_ENV,
      git: cleanGit,
      mirror: groupOf(sources),
      now: () => new Date(NOW),
      log: (line) => lines.push(line),
    };
    const go = (over: Partial<LiveRecordOptions> = {}) =>
      recordGraphLive(
        { tenantId: UUID1, msTenantId: UUID2, confirmDomains: ['bank.example'], out, allowEnvPem: true, allowRemoteSupabase: null, preflight: false, ...over },
        deps,
      );
    return { tenant, lines, out, go, ...database };
  }

  /** The cassette the injected path (--config over the fake tenant) records for the same sources. */
  async function injected(sources: CassetteSource[], tenant?: FakeTenantOptions) {
    const out = join(tempRoot(), 'injected');
    const { deps } = setup({ fetchImpl: createFakeTenant(tenant).fetch });
    const config = { ...baseConfig(), sources: sources.map((source) => ({ ...source, ownerEmail: null })) };
    const result = await recordGraph({ configPath: writeConfig(config), out, allowEnvPem: true }, deps);
    return { out, result };
  }

  /** Two scrubbed cassettes are the same recording: the manifest, every interaction and every body. */
  function expectSameCassette(liveDir: string, injectedDir: string) {
    const live = readCassette(liveDir);
    const reference = readCassette(injectedDir);
    expect(reference.interactions.length).toBeGreaterThan(0);
    expect(live.manifest).toEqual(reference.manifest);
    expect(live.interactions).toEqual(reference.interactions);
    expect(live.bodies).toEqual(reference.bodies);
  }

  /** Nothing of the guard module's own requests is in a cassette: no binding check, no object-id read, no group read. */
  function expectNoBindingTraffic(dir: string) {
    const urls = readCassette(dir).interactions.map((interaction) => decodeURIComponent(interaction.url));
    expect(urls.some((url) => url.includes('/mailFolders/inbox'))).toBe(false);
    expect(urls.some((url) => /\/users\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(url))).toBe(false);
    expect(urls.some((url) => url.includes('/groups/'))).toBe(false);
  }

  /** No address, subject, UUID, token or URL: fixed words, reason codes, counts, the cassette id and the reader sha. */
  function expectNoTenantValue(lines: string[]) {
    for (const line of lines) {
      expect(line).not.toMatch(/@|https?:|\/\/|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}|eyJ|bearer/i);
      for (const value of ['bank.example', 'sharepoint', 'onmicrosoft', UUID1, UUID2, UUID3, FAKE_GROUP_ID, 'fake-token', FAKE_SITE_ADDRESS]) {
        expect(line).not.toContain(value);
      }
    }
  }

  const bindingRequests = (requests: string[]) => requests.filter((url) => url.includes('/mailFolders/inbox?$select=id'));

  it('records, over one site, the cassette the injected path records: same manifest, interactions and bodies', async () => {
    guard();
    const reference = await injected(ONE_SITE);
    const run = liveRun(ONE_SITE);
    const { readiness, recorded } = await run.go();

    expectSameCassette(run.out, reference.out);
    expect(recorded!.digestSha256).toBe(reference.result.digestSha256);
    expect(recorded!.interactions).toBe(reference.result.interactions);
    expect(recorded!.bodies).toBe(reference.result.bodies);
    // The recording was read through the guard's binding check (the inbox by object id and by UPN, per mailbox, unobserved)...
    expect(bindingRequests(run.tenant.requests).length).toBeGreaterThanOrEqual(2 * ONE_SITE.filter(isMailbox).length);
    // ...and none of it, nor the group, is in the cassette.
    expectNoBindingTraffic(run.out);
    expect(readiness.ready).toHaveLength(ONE_SITE.length);
    expect(readiness.recordedUnderUpn).toBe(0);
    // Every read (a backfill and a delta per source, each with its source's read key) authenticated as the active
    // registration row says (its env: certificate is named, not read here).
    expect(graphWire.registrations).toHaveLength(2 * ONE_SITE.length);
    for (const registration of graphWire.registrations) {
      expect(registration).toEqual({
        tenantId: UUID1,
        msTenantId: UUID2,
        clientId: UUID3,
        certThumbprint: 'ab'.repeat(32),
        certSecretRef: 'env:GRAPH_READER_CERT_PEM',
      });
    }
  });

  it('records, over two sites with different files, the cassette the injected path records (placeholders never collide)', async () => {
    guard();
    const reference = await injected(TWO_SITES, { secondSite: true });
    const run = liveRun(TWO_SITES, { tenant: { secondSite: true } });
    const { recorded } = await run.go();

    expectSameCassette(run.out, reference.out);
    expect(recorded!.digestSha256).toBe(reference.result.digestSha256);
    // Two libraries, three different downloads: each its own replay placeholder, numbered across the whole recording.
    const downloads = readCassette(run.out).interactions.filter((interaction) => interaction.url.startsWith(`${REPLAY_ORIGIN}/content/`));
    expect(new Set(downloads.map((interaction) => interaction.url)).size).toBeGreaterThanOrEqual(3);
    expectNoBindingTraffic(run.out);
  });

  it('prints the readiness counts it acts on, then the cassette counts, and no tenant value', async () => {
    guard();
    const run = liveRun(TWO_SITES, { tenant: { secondSite: true } });
    const { readiness, recorded } = await run.go();
    const announced = readinessLines(readiness);
    expect(run.lines.slice(0, announced.length)).toEqual(announced);
    expect(run.lines.slice(announced.length)).toEqual([
      `sources ${TWO_SITES.length}`,
      `interactions ${recorded!.interactions}`,
      `bodies ${recorded!.bodies} (${recorded!.bodyBytes} bytes)`,
      `orphans dropped ${recorded!.orphansDropped}`,
      `cassette sha256:${recorded!.digestSha256}`,
      `reader ${SHA}`,
      `dropped headers: ${recorded!.droppedHeaders.join(', ') || 'none'}`,
    ]);
    expectNoTenantValue(run.lines);
    expect(readCassette(run.out).manifest.readerCommit).toBe(SHA);
  });

  it('records a shared mailbox under its UPN, and the scrubbed cassette replays with 0 misses and nothing unrequested', async () => {
    guard();
    const sources = [...TWO_SITES, SHARED].sort(byAddress);
    const run = liveRun(sources, { tenant: { secondSite: true } });
    const { readiness, recorded } = await run.go();
    expect(readiness.recordedUnderUpn).toBe(1);
    expect(recorded!.interactions).toBeGreaterThan(0);

    // The manifest names the shared mailbox by the UPN it was read by, and a site by its address; the stored mail is not in it.
    const cassette = loadCassette(run.out); // the digest verifies and the lint is clean
    expect(cassette.manifest.sources).toContainEqual({ kind: SOURCE_KIND.MAILBOX, address: FAKE_SHARED_MAILBOX.upn });
    expect(cassette.manifest.sources.some((source) => source.address === FAKE_SHARED_MAILBOX.mail)).toBe(false);
    expect(cassette.manifest.sources).toContainEqual(SECOND_SITE);
    expect(cassette.manifest.sources).toHaveLength(sources.length);
    expectNoBindingTraffic(run.out);

    // Replay asks the URLs the capture recorded: the real readers, by the manifest's addresses, no binding check.
    const replay = replayReaderFor(cassette, { extract: RECORD_EXTRACT });
    for (const [index, source] of cassette.manifest.sources.entries()) {
      const row = sourceRow(source, index);
      const read = await readBackfillThenDelta(replay({ ...row, backfillCompletedAt: null }), row);
      expect(read.backfill.length, `source ${index}`).toBeGreaterThan(0);
    }
    expect(cassette.fetch.misses).toEqual([]);
    expect(cassette.fetch.unrequested()).toBe(0);
  });

  for (const form of ['path', 'paren'] as const) {
    it(`records paging links Graph gives by object id (${form} form) under the UPN: the cassette the injected path records, replayed clean`, async () => {
      guard();
      const reference = await injected(ONE_SITE);
      const run = liveRun(ONE_SITE, { tenant: { linksByObjectId: form } });
      await run.go();
      // The tenant did hand out object-id links, and the capture sent each under the bound UPN instead.
      expect(run.tenant.requests.some((url) => /\$deltatoken=/.test(url))).toBe(true);
      expect(run.tenant.requests.filter((url) => !url.endsWith('/mailFolders/inbox?$select=id')).some((url) => /\/users(\/|\(')[0-9a-f]{8}-/i.test(decodeURIComponent(url)))).toBe(false);
      // Byte for byte the cassette a UPN-keyed tenant gives, so replay asks for exactly what it holds.
      expectSameCassette(run.out, reference.out);
      const cassette = loadCassette(run.out);
      const replay = replayReaderFor(cassette, { extract: RECORD_EXTRACT });
      for (const [index, source] of cassette.manifest.sources.entries()) {
        const row = sourceRow(source, index);
        await readBackfillThenDelta(replay({ ...row, backfillCompletedAt: null }), row);
      }
      expect(cassette.fetch.misses).toEqual([]);
      expect(cassette.fetch.unrequested()).toBe(0);
    });
  }

  it('reads exactly the sources the readiness check marks ready', async () => {
    // Refused at readiness, every time it is asked: counted there, never read, never asked again by the capture.
    const { asks } = guard((address) => (address === FIRST_MAILBOX ? 'no_consent' : null));
    const rest = ONE_SITE.filter((source) => source.address !== FIRST_MAILBOX);
    const reference = await injected(rest);
    const run = liveRun(ONE_SITE);
    const { readiness } = await run.go();

    expect(readiness.notReady).toEqual({ no_consent: 1 });
    expect(readiness.ready.map(({ row }) => row.address)).toEqual(rest.map((source) => source.address));
    expect(asks.get(FIRST_MAILBOX)).toBe(1);
    expect(run.lines).toContain('  no_consent 1');
    expectSameCassette(run.out, reference.out);
    expect(run.tenant.requests.some((url) => url.includes(encodeURIComponent(FIRST_MAILBOX)))).toBe(false);
  });

  describe('a refusal during the capture', () => {
    it('skips and counts a source refused before its first observed response, and records the others as if it were not there', async () => {
      guard((address, ask) => (address === FIRST_MAILBOX && ask >= 2 ? 'seat_inactive' : null)); // allowed at readiness, refused at the read
      const rest = ONE_SITE.filter((source) => source.address !== FIRST_MAILBOX);
      const reference = await injected(rest);
      const run = liveRun(ONE_SITE);
      const { readiness, recorded } = await run.go();

      expect(readiness.ready).toHaveLength(ONE_SITE.length); // ready at readiness...
      expect(recorded!.interactions).toBeGreaterThan(0);
      expect(run.lines).toContain('sources skipped 1');
      expect(run.lines).toContain('  seat_inactive 1');
      expect(run.lines).toContain(`sources ${rest.length}`); // ...and the cassette counts what it holds
      expectSameCassette(run.out, reference.out);
      // The guard's read-only verdict refused it before its binding check (#275): nothing was asked of Graph for it.
      expect(run.tenant.requests.some((url) => url.includes(encodeURIComponent(FIRST_MAILBOX)))).toBe(false);
      expectNoTenantValue(run.lines);
    });

    it('aborts, and writes nothing, when a source is refused after part of it was recorded', async () => {
      // Allowed at readiness (ask 1) and before the first page (ask 2), refused after the first page (ask 3).
      guard((address, ask) => (address === FIRST_MAILBOX && ask >= 3 ? 'seat_inactive' : null));
      const run = liveRun(ONE_SITE);
      const text = await message(() => run.go());
      expect(text).toBe('the guard refused a source after part of it was recorded; nothing is written');
      expect(text).not.toContain(FIRST_MAILBOX);
      expect(run.tenant.requests.length).toBeGreaterThan(0); // it had begun reading
      expect(existsSync(run.out)).toBe(false);
    });

    it('refuses when every source is refused before it records anything, having made no Graph request', async () => {
      guard((address, ask) => (ask >= 2 ? (address === FAKE_SITE_ADDRESS ? 'site_not_registered' : 'no_consent') : null));
      const run = liveRun(ONE_SITE);
      expect(await message(() => run.go())).toBe('no source was recorded; nothing is written');
      expect(run.lines).toContain(`sources skipped ${ONE_SITE.length}`);
      expect(run.lines).toContain('  no_consent 3');
      expect(run.lines).toContain('  site_not_registered 1');
      expect(run.tenant.requests).toEqual([]);
      expect(existsSync(run.out)).toBe(false);
    });

    it('does not mistake a failure that is not a refusal for a skip', async () => {
      guard();
      const run = liveRun(ONE_SITE);
      // The tenant drops a collection page's `value` (the empty-folder-list case): the recording aborts.
      const inner = graphWire.fetch!;
      graphWire.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const res = await inner(input, init);
        if (!String(input).includes('/mailFolders?') || res.status !== 200) return res;
        return new Response(JSON.stringify({}), { status: 200, headers: res.headers });
      }) as typeof fetch;
      expect(await message(() => run.go())).toBe('a collection page had no value array; nothing is written');
      expect(existsSync(run.out)).toBe(false);
    });
  });

  it('refuses a blocked run before it asks the guard or reads anything', async () => {
    guard();
    const run = liveRun(ONE_SITE, { registration: { scope_group_id: null } });
    expect(await message(() => run.go())).toBe('the run is blocked (no_scope_group); nothing is read');
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(run.tenant.requests).toEqual([]);
    expect(run.lines).toEqual([]);
    expect(existsSync(run.out)).toBe(false);
  });

  it('still needs --out for a capture and none for a preflight, which records nothing', async () => {
    guard();
    const run = liveRun(ONE_SITE);
    expect(await message(() => run.go({ out: null }))).toMatch(/needs --out/);
    const { recorded, readiness } = await run.go({ out: null, preflight: true });
    expect(recorded).toBeNull();
    expect(readiness.ready).toHaveLength(ONE_SITE.length);
    expect(run.tenant.requests).toEqual([]);
  });
});
