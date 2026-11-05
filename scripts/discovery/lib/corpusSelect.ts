import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

// --corpus / --phase for scripts/seed-discovery.ts, apart from the script so a test can
// load it without claiming the reader capability the script's first import claims.

/** The demo Gmail twin (scripts/google/build-gmail-twin.ts DEMO_TWIN_DIR; tests/discovery/demo-seed-selection.test.ts pins the two). */
export const GMAIL_DEMO_TWIN_DIR = 'tests/fixtures/discovery/demo/gmail-twin';

export type CorpusSelection = { corpus: 'base' | 'demo'; phase: 'seeded' | 'after-imports' };

function argValue(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  if (at < 0) return undefined;
  const value = argv[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
}

/** An env value the operator set must agree with the flags: refuse, never pick one silently. */
function agree(
  env: Record<string, string | undefined>,
  name: string,
  wanted: string,
  same: (a: string, b: string) => boolean,
): void {
  const set = env[name]?.trim();
  if (set && !same(set, wanted)) {
    throw new Error(`${name}=${set} disagrees with --google-replay --corpus demo (${wanted}); unset it`);
  }
}

/** Point the fixture reader (and, with --google-replay, the Gmail replay) at the demo corpus before the worker builds it (E4, D3). */
export function selectCorpus(argv: string[], env: Record<string, string | undefined> = process.env): CorpusSelection {
  const corpus = argValue(argv, '--corpus') ?? 'base';
  const phase = argValue(argv, '--phase') ?? 'seeded';
  if (corpus !== 'base' && corpus !== 'demo') throw new Error('--corpus must be "base" or "demo"');
  if (phase !== 'seeded' && phase !== 'after-imports') throw new Error('--phase must be "seeded" or "after-imports"');
  if (corpus === 'demo') {
    env.DISCOVERY_FIXTURE_DIR =
      phase === 'after-imports'
        ? 'tests/fixtures/discovery/demo/graph-after-imports'
        : 'tests/fixtures/discovery/demo/graph';
    if (argv.includes('--google-replay')) {
      agree(env, 'DISCOVERY_GMAIL_REPLAY_DIR', GMAIL_DEMO_TWIN_DIR, (a, b) => resolve(a) === resolve(b));
      agree(env, 'DISCOVERY_GMAIL_REPLAY_PHASE', phase, (a, b) => a === b);
      env.DISCOVERY_GMAIL_REPLAY_DIR = GMAIL_DEMO_TWIN_DIR;
      env.DISCOVERY_GMAIL_REPLAY_PHASE = phase;
    }
  } else if (phase !== 'seeded') {
    throw new Error('--phase after-imports needs --corpus demo');
  }
  return { corpus, phase };
}

/** The demo team inbox (scripts/google/build-gmail-twin.ts DEMO_TEAM_MAILBOX; tests/discovery/team-inbox-seed.test.ts pins the two). */
export const DEMO_TEAM_INBOX = 'deals@bank.example';

export type TeamInboxSelection = {
  /** Lowercase, as the registry stores it. */
  address: string;
  /** Demo persona names (storm, morgan, alex) to add as members; never a firm admin. */
  memberNames: string[];
};

function listValue(argv: string[], flag: string): string[] | undefined {
  const raw = argValue(argv, flag);
  return raw === undefined ? undefined : raw.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
}

/**
 * `--team-inbox <address> [--team-members storm,...]` for scripts/seed-discovery.ts: register the team inbox, record its
 * Directory check and add its members (#581 phase 12). A team inbox is Gmail only and its replay lives in the demo twin,
 * so it needs `--google-replay --corpus demo`. Refused rather than ignored when it cannot run.
 */
export function selectTeamInbox(argv: string[], selection: CorpusSelection): TeamInboxSelection | null {
  const address = argValue(argv, '--team-inbox')?.trim().toLowerCase();
  const memberNames = listValue(argv, '--team-members');
  if (!address) {
    if (memberNames) throw new Error('--team-members needs --team-inbox');
    return null;
  }
  if (!argv.includes('--google-replay') || selection.corpus !== 'demo') {
    throw new Error('--team-inbox needs --google-replay --corpus demo (a team inbox is Gmail only, and its replay is in the demo twin)');
  }
  return { address, memberNames: memberNames ?? [] };
}

/**
 * `--personas morgan,...`: seed only these demo personas' own mailboxes as sources (default: all of them). The team
 * inbox journey seeds Morgan alone, so Storm has no personal copy of the mail and sees it only as a member.
 */
export function selectPersonas(argv: string[]): string[] | null {
  return listValue(argv, '--personas') ?? null;
}

/**
 * The Directory id the fixture check gives an address (src/lib/google/reader/index.ts getFixtureTeamMailboxVerifier):
 * stable per address and never the address. The seed records the check with it, so the worker's own fixture check
 * later finds the same pin. The reader module cannot be imported here; tests/discovery/team-inbox-seed.test.ts pins
 * the two against each other.
 */
export function fixtureDirectoryUserId(address: string): string {
  return `fixture-${createHash('sha256').update(address.trim().toLowerCase()).digest('hex').slice(0, 16)}`;
}
