// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFixtureTeamMailboxVerifier } from '@/lib/mailboxAccess';

import {
  DEMO_TEAM_INBOX,
  fixtureDirectoryUserId,
  selectCorpus,
  selectPersonas,
  selectTeamInbox,
} from '../../scripts/discovery/lib/corpusSelect';
import { DEMO_TEAM_MAILBOX, DEMO_TWIN_DIR } from '../../scripts/google/build-gmail-twin';
import { replayMailboxes, replayPersonas } from '../../scripts/seed-discovery';

// The seed side of the team inbox journey (#581 phase 12): the flags that register the demo team inbox and leave a
// persona without a personal source, and the demo twin folder the seed and the worker's fixture check both read.
// This file imports the seed, which claims the reader capability, so it reaches the fixture check through
// @/lib/mailboxAccess and never claims the capability itself.

const TENANT = '11111111-1111-4111-8111-111111111111';
const DEMO = ['--google-replay', '--corpus', 'demo'];
const selectionOf = (argv: string[]) => selectCorpus(argv, {});

afterEach(() => vi.unstubAllEnvs());

describe('the demo team inbox in the demo twin folder', () => {
  it('is the address the twin builder writes', () => {
    expect(DEMO_TEAM_INBOX).toBe(DEMO_TEAM_MAILBOX);
  });

  it('is a mailbox of the folder but no persona: the seed gives it no owner and no consent', () => {
    expect(replayMailboxes(DEMO_TWIN_DIR)).toContain(DEMO_TEAM_INBOX);
    expect(replayPersonas(DEMO_TWIN_DIR)).toEqual(['alex.chen@bank.example', 'morgan.vale@bank.example', 'storm.duncan@bank.example']);
  });

  it('is verified by the worker\'s fixture check with the id the seed records, so the pin holds', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_ENV', 'local');
    vi.stubEnv('DISCOVERY_GMAIL_REPLAY_DIR', DEMO_TWIN_DIR);
    const check = await createFixtureTeamMailboxVerifier().verify(TENANT, DEMO_TEAM_INBOX, null);
    expect(check).toEqual({ status: 'verified', directoryUserId: fixtureDirectoryUserId(DEMO_TEAM_INBOX) });
    expect(fixtureDirectoryUserId(` ${DEMO_TEAM_INBOX.toUpperCase()} `)).toBe(fixtureDirectoryUserId(DEMO_TEAM_INBOX));
    expect(fixtureDirectoryUserId(DEMO_TEAM_INBOX)).not.toContain('@');
  });
});

describe('selectTeamInbox (seed-discovery --team-inbox / --team-members)', () => {
  it('is off without --team-inbox', () => {
    expect(selectTeamInbox(DEMO, selectionOf(DEMO))).toBeNull();
  });

  it('reads the address, lowercased, and the member names', () => {
    const argv = [...DEMO, '--team-inbox', ' Deals@Bank.Example ', '--team-members', 'storm, alex'];
    expect(selectTeamInbox(argv, selectionOf(argv))).toEqual({ address: 'deals@bank.example', memberNames: ['storm', 'alex'] });
    const bare = [...DEMO, '--team-inbox', 'deals@bank.example'];
    expect(selectTeamInbox(bare, selectionOf(bare))?.memberNames).toEqual([]);
  });

  it('refuses members without an inbox, and an inbox without the Gmail replay of the demo corpus', () => {
    const members = [...DEMO, '--team-members', 'storm'];
    expect(() => selectTeamInbox(members, selectionOf(members))).toThrow(/--team-members needs --team-inbox/);
    for (const argv of [
      ['--team-inbox', 'deals@bank.example'],
      ['--google-replay', '--team-inbox', 'deals@bank.example'],
      ['--corpus', 'demo', '--team-inbox', 'deals@bank.example'],
    ]) {
      expect(() => selectTeamInbox(argv, selectionOf(argv)), argv.join(' ')).toThrow(/needs --google-replay --corpus demo/);
    }
  });
});

describe('selectPersonas (seed-discovery --personas)', () => {
  it('seeds every persona unless some are named', () => {
    expect(selectPersonas(DEMO)).toBeNull();
    expect(selectPersonas([...DEMO, '--personas', 'Morgan'])).toEqual(['morgan']);
    expect(selectPersonas([...DEMO, '--personas', 'morgan,alex'])).toEqual(['morgan', 'alex']);
  });

  it('needs a value', () => {
    expect(() => selectPersonas([...DEMO, '--personas'])).toThrow(/--personas needs a value/);
  });
});
