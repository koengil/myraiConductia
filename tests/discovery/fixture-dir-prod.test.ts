// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SOURCE_KIND } from '@/lib/constants/discovery';
import { createFixtureContentSource, loadFixtureMailboxes } from '@/lib/graph/reader/fixture';
import { getContentSource } from '@/lib/graph/reader';
import type { ReaderCapability } from '@/lib/discovery/source/capability';

import { fixtureCapability } from './fixtureCapability';

/**
 * DISCOVERY_FIXTURE_DIR through the real entry point (#262 reviewer, E4):
 * refused when NEXT_PUBLIC_APP_ENV=prod, and the capability check still runs
 * first, so a caller without the capability learns nothing about the
 * environment and reads no directory.
 */

const DEMO_DIR = 'tests/fixtures/discovery/demo/graph';
const noCapability = {} as ReaderCapability;

afterEach(() => vi.unstubAllEnvs());

describe('DISCOVERY_FIXTURE_DIR in production', () => {
  it.each(['prod', ' Production ', 'PROD'])('is refused by the reader factory when the capability is held (%j)', (appEnv) => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', appEnv);
    vi.stubEnv('DISCOVERY_FIXTURE_DIR', DEMO_DIR);
    expect(() => getContentSource(fixtureCapability, SOURCE_KIND.MAILBOX, 'fixture')).toThrow(
      'DISCOVERY_FIXTURE_DIR is refused in production',
    );
  });

  it('is still accepted outside production with the capability', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'local');
    vi.stubEnv('DISCOVERY_FIXTURE_DIR', DEMO_DIR);
    expect(() => getContentSource(fixtureCapability, SOURCE_KIND.MAILBOX, 'fixture')).not.toThrow();
  });

  it('runs the capability check first: no capability fails with no_capability, not the production refusal', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'prod');
    vi.stubEnv('DISCOVERY_FIXTURE_DIR', DEMO_DIR);
    for (const mode of ['fixture', undefined] as const) {
      let error: unknown;
      try {
        getContentSource(noCapability, SOURCE_KIND.MAILBOX, mode);
      } catch (e) {
        error = e;
      }
      expect(error, String(mode)).toMatchObject({ name: 'MailboxAccessRefusedError', reason: 'no_capability' });
      expect((error as Error).message).not.toMatch(/DISCOVERY_FIXTURE_DIR/);
    }
    expect(() => createFixtureContentSource(noCapability, { dir: DEMO_DIR })).toThrow(/no_capability/);
    expect(() => loadFixtureMailboxes(noCapability, DEMO_DIR)).toThrow(/no_capability/);
  });

  it('runs the capability check before an outside-the-fixtures directory is judged either', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'local');
    vi.stubEnv('DISCOVERY_FIXTURE_DIR', '/etc');
    expect(() => getContentSource(noCapability, SOURCE_KIND.MAILBOX, 'fixture')).toThrow(/no_capability/);
    expect(() => getContentSource(fixtureCapability, SOURCE_KIND.MAILBOX, 'fixture')).toThrow(/must be under/);
  });
});
