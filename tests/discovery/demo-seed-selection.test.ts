// @vitest-environment node
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEV_TENANT_ID } from '@/lib/db/tenant';
import { FIXTURE_DIR, fixtureDirFromEnv } from '@/lib/graph/reader/fixture';

import { DEMO_TWIN_DIR } from '../../scripts/google/build-gmail-twin';
import { GMAIL_DEMO_TWIN_DIR, selectCorpus } from '../../scripts/discovery/lib/corpusSelect';
import { DEFAULT_REPLIES, parseExtractArgs } from '../../worker/extract';

describe('fixtureDirFromEnv', () => {
  it('serves the base corpus unless a directory is named', () => {
    expect(fixtureDirFromEnv({})).toBe(FIXTURE_DIR);
    expect(fixtureDirFromEnv({ DISCOVERY_FIXTURE_DIR: '  ' })).toBe(FIXTURE_DIR);
  });

  it('accepts a directory under the fixture directory', () => {
    const env = { DISCOVERY_FIXTURE_DIR: 'tests/fixtures/discovery/demo/graph' };
    expect(fixtureDirFromEnv(env)).toBe(join(FIXTURE_DIR, 'demo', 'graph'));
  });

  it('refuses a directory outside the fixture directory, including a sibling that shares its prefix', () => {
    for (const DISCOVERY_FIXTURE_DIR of ['/etc', '../elsewhere', 'tests/fixtures', 'tests/fixtures/discovery-evil', 'tests/fixtures/discovery/../x']) {
      expect(() => fixtureDirFromEnv({ DISCOVERY_FIXTURE_DIR }), DISCOVERY_FIXTURE_DIR).toThrow(/must be under/);
    }
  });

  it('is refused in production', () => {
    expect(() =>
      fixtureDirFromEnv({ DISCOVERY_FIXTURE_DIR: 'tests/fixtures/discovery/demo/graph', NEXT_PUBLIC_APP_ENV: 'prod' }),
    ).toThrow(/refused in production/);
  });
});

describe('selectCorpus (seed-discovery --corpus / --phase)', () => {
  const pick = (argv: string[]) => {
    const env: Record<string, string | undefined> = {};
    selectCorpus(argv, env);
    return env.DISCOVERY_FIXTURE_DIR;
  };

  it('leaves the base corpus alone by default', () => {
    expect(pick([])).toBeUndefined();
    expect(pick(['--corpus', 'base'])).toBeUndefined();
  });

  it('points at the demo corpus, and at its late-mail superset for after-imports', () => {
    expect(pick(['--corpus', 'demo'])).toBe('tests/fixtures/discovery/demo/graph');
    expect(pick(['--corpus', 'demo', '--phase', 'seeded'])).toBe('tests/fixtures/discovery/demo/graph');
    expect(pick(['--corpus', 'demo', '--phase', 'after-imports'])).toBe('tests/fixtures/discovery/demo/graph-after-imports');
  });

  it('names a directory the fixture reader accepts', () => {
    expect(() => fixtureDirFromEnv({ DISCOVERY_FIXTURE_DIR: pick(['--corpus', 'demo', '--phase', 'after-imports']) })).not.toThrow();
  });

  it('refuses an unknown corpus or phase, and after-imports without the demo corpus', () => {
    expect(() => pick(['--corpus', 'live'])).toThrow(/--corpus/);
    expect(() => pick(['--corpus', 'demo', '--phase', 'later'])).toThrow(/--phase/);
    expect(() => pick(['--phase', 'after-imports'])).toThrow(/needs --corpus demo/);
    expect(() => pick(['--corpus'])).toThrow(/needs a value/);
  });
});

describe('selectCorpus with --google-replay (D3)', () => {
  const pick = (argv: string[], env: Record<string, string | undefined> = {}) => {
    const selection = selectCorpus(argv, env);
    return { selection, dir: env.DISCOVERY_GMAIL_REPLAY_DIR, phase: env.DISCOVERY_GMAIL_REPLAY_PHASE };
  };

  it('reads the demo twin at seeded by default, and at after-imports when asked', () => {
    expect(pick(['--google-replay', '--corpus', 'demo'])).toEqual({
      selection: { corpus: 'demo', phase: 'seeded' },
      dir: GMAIL_DEMO_TWIN_DIR,
      phase: 'seeded',
    });
    expect(pick(['--google-replay', '--corpus', 'demo', '--phase', 'after-imports']).phase).toBe('after-imports');
  });

  it('accepts env values that agree, relative or absolute', () => {
    expect(() =>
      pick(['--google-replay', '--corpus', 'demo'], {
        DISCOVERY_GMAIL_REPLAY_DIR: resolve(GMAIL_DEMO_TWIN_DIR),
        DISCOVERY_GMAIL_REPLAY_PHASE: 'seeded',
      }),
    ).not.toThrow();
  });

  it('refuses env values that disagree, naming both', () => {
    expect(() =>
      pick(['--google-replay', '--corpus', 'demo'], { DISCOVERY_GMAIL_REPLAY_DIR: 'tests/fixtures/discovery/gmail-twin' }),
    ).toThrow(/DISCOVERY_GMAIL_REPLAY_DIR=tests\/fixtures\/discovery\/gmail-twin disagrees .*demo\/gmail-twin/);
    expect(() =>
      pick(['--google-replay', '--corpus', 'demo'], { DISCOVERY_GMAIL_REPLAY_PHASE: 'after-unspam' }),
    ).toThrow(/DISCOVERY_GMAIL_REPLAY_PHASE=after-unspam disagrees .*seeded/);
  });

  it('leaves the replay env alone without --corpus demo, and without --google-replay', () => {
    expect(pick(['--google-replay'])).toMatchObject({ dir: undefined, phase: undefined });
    expect(pick(['--corpus', 'demo'])).toMatchObject({ dir: undefined, phase: undefined });
  });

  it('names the directory the twin builder writes', () => {
    expect(resolve(GMAIL_DEMO_TWIN_DIR)).toBe(DEMO_TWIN_DIR);
  });
});

describe('parseExtractArgs (worker/extract.ts)', () => {
  it('defaults to one recorded pass for the dev tenant', () => {
    expect(parseExtractArgs([])).toEqual({ watch: false, strict: false, transport: 'recorded', replies: null, tenant: DEV_TENANT_ID, estimate: false, rules: false });
    expect(DEFAULT_REPLIES).toBe('tests/fixtures/discovery/demo/model-replies/extract.v1.json');
  });

  it('treats --serve, the worker image\'s flag, as --watch', () => {
    expect(parseExtractArgs(['--serve']).watch).toBe(true);
    expect(() => parseExtractArgs(['--once', '--serve'])).toThrow(/exclude each other/);
  });

  it('reads the flags', () => {
    expect(
      parseExtractArgs(['--watch', '--strict', '--transport', 'gateway', '--replies', 'r.json', '--tenant', '11111111-2222-4333-8444-555555555555']),
    ).toEqual({ watch: true, strict: true, transport: 'gateway', replies: 'r.json', tenant: '11111111-2222-4333-8444-555555555555', estimate: false, rules: false });
  });

  it('refuses an unknown transport, a missing value, and --once with --watch', () => {
    expect(() => parseExtractArgs(['--transport', 'carrier-pigeon'])).toThrow(/--transport/);
    expect(() => parseExtractArgs(['--replies'])).toThrow(/needs a value/);
    expect(() => parseExtractArgs(['--once', '--watch'])).toThrow(/exclude each other/);
  });
});
