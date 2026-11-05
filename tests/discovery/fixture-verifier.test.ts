// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ReaderCapability } from '@/lib/discovery/source/capability';
import { getFixtureTeamMailboxVerifier } from '@/lib/google/reader';
import { GMAIL_REPLAY_FORMAT } from '@/lib/google/replay/format';

import { fixtureCapability } from './fixtureCapability';

// The fixture Directory check of a team inbox address (#581, design R7): in replay mode the replay folder is the
// Directory. An address the folder holds a mailbox for is a real user mailbox; any other is not found. It is refused
// in production, and it asks for the reader capability before it touches the environment or the disk.

const TENANT = '11111111-1111-4111-8111-111111111111';
const noCapability = {} as ReaderCapability;

let dir: string;
const writeReplay = (name: string, mailbox: string) =>
  writeFileSync(join(dir, `${name}.replay.json`), JSON.stringify({ format: GMAIL_REPLAY_FORMAT, mailbox, synthetic: true, phases: {} }));

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fixture-verifier-'));
  writeReplay('deals', 'deals@bank.example');
  writeReplay('storm', 'storm.duncan@bank.example');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

function verifierOver(replayDir: string) {
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'local');
  vi.stubEnv('DISCOVERY_GMAIL_REPLAY_DIR', replayDir);
  return getFixtureTeamMailboxVerifier(fixtureCapability);
}

describe('an address is checked against the replay manifest', () => {
  it('verifies an address the replay folder holds a mailbox for', async () => {
    const verifier = verifierOver(dir);
    const check = await verifier.verify(TENANT, 'deals@bank.example', null);
    expect(check).toEqual({ status: 'verified', directoryUserId: expect.stringMatching(/^fixture-[0-9a-f]{16}$/) });
  });

  it('gives the same id for the same address on every check, a different one for another, and never the address', async () => {
    const verifier = verifierOver(dir);
    const first = await verifier.verify(TENANT, 'deals@bank.example', null);
    const again = await verifier.verify(TENANT, 'deals@bank.example', 'whatever-was-pinned');
    const other = await verifier.verify(TENANT, 'storm.duncan@bank.example', null);
    expect(again).toEqual(first);
    expect(other).not.toEqual(first);
    expect(JSON.stringify([first, other])).not.toContain('@');
  });

  it('matches without regard to case or surrounding space', async () => {
    const verifier = verifierOver(dir);
    expect(await verifier.verify(TENANT, ' Deals@Bank.Example ', null)).toEqual(await verifier.verify(TENANT, 'deals@bank.example', null));
    expect((await verifier.verify(TENANT, ' Deals@Bank.Example ', null)).status).toBe('verified');
  });

  it('refuses any other address as not found, with a fixed reason and no id', async () => {
    const verifier = verifierOver(dir);
    expect(await verifier.verify(TENANT, 'sales@bank.example', null)).toEqual({ status: 'refused', reason: 'not_found' });
    // A prefix or a different domain is not a match.
    expect(await verifier.verify(TENANT, 'deals@other.example', null)).toEqual({ status: 'refused', reason: 'not_found' });
    expect(await verifier.verify(TENANT, 'deal@bank.example', null)).toEqual({ status: 'refused', reason: 'not_found' });
  });

  it('reads the folder on every check, so a replay added after the verifier was built counts', async () => {
    const verifier = verifierOver(dir);
    expect(await verifier.verify(TENANT, 'late@bank.example', null)).toEqual({ status: 'refused', reason: 'not_found' });
    writeReplay('late', 'late@bank.example');
    expect((await verifier.verify(TENANT, 'late@bank.example', null)).status).toBe('verified');
  });

  it('uses the committed twin folder when no replay folder is named', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'local');
    vi.stubEnv('DISCOVERY_GMAIL_REPLAY_DIR', '');
    const verifier = getFixtureTeamMailboxVerifier(fixtureCapability);
    expect((await verifier.verify(TENANT, 'storm.duncan@bank.example', null)).status).toBe('verified');
    expect(await verifier.verify(TENANT, 'nobody@bank.example', null)).toEqual({ status: 'refused', reason: 'not_found' });
  });
});

describe('the fixture check is refused in production', () => {
  it.each(['prod', ' Production ', 'PROD'])('throws when built under NEXT_PUBLIC_APP_ENV=%j', (appEnv) => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', appEnv);
    vi.stubEnv('DISCOVERY_GMAIL_REPLAY_DIR', dir);
    expect(() => getFixtureTeamMailboxVerifier(fixtureCapability)).toThrow('The fixture team inbox check is refused in production');
  });

  it('asks for the reader capability first: no capability fails with no_capability, whatever the environment', () => {
    for (const appEnv of ['prod', 'local']) {
      vi.stubEnv('NEXT_PUBLIC_APP_ENV', appEnv);
      let error: unknown;
      try {
        getFixtureTeamMailboxVerifier(noCapability);
      } catch (e) {
        error = e;
      }
      expect(error, appEnv).toMatchObject({ name: 'MailboxAccessRefusedError', reason: 'no_capability' });
      expect((error as Error).message).not.toMatch(/production/);
    }
  });
});
