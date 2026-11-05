import { execFileSync } from 'node:child_process';

import {
  addedMigrations,
  branchAddedMigrations,
  get,
  listPrFiles,
  type Ctx,
  type Fetcher,
  type Migration,
} from './check-migration-open-prs';

// A PR that adds a migration dated before one already merged on its base
// splits the two orders that apply it: a hosted database applies it after
// everything it already has (the ledger), a fresh replay applies it in
// filename order, and `db push` may skip it (#292). So every migration a PR
// adds must sort after the newest migration on the branch it merges into:
// develop, or the parent branch of a stacked slice. It runs from
// check-migration-prefixes.ts.

const MIGRATIONS_DIR = 'supabase/migrations';
const MIGRATION_NAME = /^(\d{14})_[^/]*\.sql$/;

export type OrderPlan =
  | { run: false; notice: string }
  | { run: true; base: string; pr?: number; repo?: string; token?: string };

// CI runs it on pull_request against `origin/<github.base_ref>`, with the PR's
// files from the API (the checkout is a shallow merge commit). Locally it runs
// from git against --base, default origin/develop.
export function planOrderCheck(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): OrderPlan {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const event = env.GITHUB_EVENT_NAME;
  if (event && event !== 'pull_request') {
    return { run: false, notice: `ℹ️  Migration order check skipped on ${event} (it compares a pull request with its base).` };
  }
  const base = flag('--base') ?? (env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : 'origin/develop');
  if (event !== 'pull_request') return { run: true, base };
  const prText = flag('--pr') ?? env.PR_NUMBER;
  const pr = prText && Number.isInteger(Number(prText)) ? Number(prText) : undefined;
  return { run: true, base, pr, repo: flag('--repo') ?? env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN || undefined };
}

// A YYYYMMDDHHMMSS prefix that sorts after `newest`: now in UTC, or one second
// after `newest` when the clock is behind it.
export function suggestPrefix(newest: string, now: Date): string {
  const fmt = (d: Date) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const stamp = fmt(now);
  if (stamp > newest) return stamp;
  const p = newest.slice(0, 14);
  const at = Date.UTC(+p.slice(0, 4), +p.slice(4, 6) - 1, +p.slice(6, 8), +p.slice(8, 10), +p.slice(10, 12), +p.slice(12, 14));
  return fmt(new Date(at + 1000));
}

// Migrations the PR adds that do not sort after the base's newest. A file the
// base already holds under the same name is merged, not added (a stacked slice
// whose parent was squash-merged still lists it); the other checks own it.
export function findOrderProblems(own: readonly Migration[], baseNames: readonly string[], base: string): { problems: string[]; newest?: string } {
  const migrations = baseNames.filter((n) => MIGRATION_NAME.test(n)).sort();
  const newest = migrations.at(-1);
  if (!newest) return { problems: [] };
  const onBase = new Set(migrations);
  const problems = [...own]
    .filter((m) => !onBase.has(m.name) && m.name.slice(0, 14) <= newest.slice(0, 14))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m) => `${m.name} sorts before ${newest}, the newest migration on ${base}`);
  return { problems, newest };
}

// The migrations a PR adds: from the API in CI (the checkout is a shallow
// merge commit), else from git since the merge-base with `base`. Undefined
// when neither is available; `check` names the caller in the warning.
export async function prAddedMigrations(
  input: { base: string; pr?: number; ctx?: Ctx; readOwn?: (base: string) => Migration[]; log: (line: string) => void },
  check: string,
): Promise<Migration[] | undefined> {
  const reason = (e: unknown) => (e instanceof Error ? e.message.split('\n')[0] : String(e));
  if (input.ctx && input.pr !== undefined) {
    try {
      return addedMigrations((await listPrFiles(input.ctx, input.pr)).files);
    } catch (error) {
      input.log(`⚠️  The GitHub API failed listing this PR's files (${reason(error)}); reading them from git.`);
    }
  }
  try {
    return (input.readOwn ?? branchAddedMigrations)(input.base);
  } catch {
    input.log(`⚠️  ${check} skipped: no merge-base with ${input.base}. Run: git fetch origin ${input.base.replace(/^origin\//, '')}`);
    return undefined;
  }
}

export type OrderCheckInput = {
  base: string;
  pr?: number;
  repo?: string;
  token?: string;
  fetcher?: Fetcher;
  // Basenames under supabase/migrations on the base; throws when the ref is missing.
  readBaseNames?: (base: string) => string[];
  // Migrations this branch adds since the merge-base; throws without history.
  readOwn?: (base: string) => Migration[];
  log?: (line: string) => void;
};

// Returns the out-of-order files and the base's newest. Missing data (API
// down, base ref not fetched, shallow history) is a warning, never a failure.
export async function checkMigrationOrder(input: OrderCheckInput): Promise<{ problems: string[]; newest?: string }> {
  const log = input.log ?? console.log;
  const readOwn = input.readOwn ?? branchAddedMigrations;
  const readBaseNames = input.readBaseNames ?? gitBaseNames;
  const ctx: Ctx | undefined =
    input.repo && input.token ? { repo: input.repo, token: input.token, fetcher: input.fetcher ?? (fetch as Fetcher) } : undefined;
  const reason = (e: unknown) => (e instanceof Error ? e.message.split('\n')[0] : String(e));

  const own = await prAddedMigrations({ ...input, ctx, readOwn, log }, 'Migration order check');
  if (!own || own.length === 0) return { problems: [] };

  let baseNames: string[] | undefined;
  try {
    baseNames = readBaseNames(input.base);
  } catch {
    if (ctx) {
      try {
        baseNames = await apiBaseNames(ctx, input.base.replace(/^origin\//, ''));
      } catch (error) {
        log(`⚠️  Migration order check skipped: ${input.base} is not fetched and the GitHub API failed (${reason(error)}).`);
        return { problems: [] };
      }
    } else {
      log(`⚠️  Migration order check skipped: ${input.base} is not available. Run: git fetch origin ${input.base.replace(/^origin\//, '')}`);
      return { problems: [] };
    }
  }

  const result = findOrderProblems(own, baseNames, input.base);
  if (result.problems.length === 0 && result.newest) {
    log(`✅ The ${own.length} migration file(s) this branch adds sort after ${result.newest}, the newest on ${input.base}.`);
  }
  return result;
}

function gitBaseNames(base: string): string[] {
  const out = execFileSync('git', ['ls-tree', '--name-only', base, `${MIGRATIONS_DIR}/`], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.split('\n').filter(Boolean).map((p) => p.slice(p.lastIndexOf('/') + 1));
}

// The contents endpoint lists up to 1000 entries of a directory.
async function apiBaseNames(ctx: Ctx, branch: string): Promise<string[]> {
  const entries = (await get(ctx, `/repos/${ctx.repo}/contents/${MIGRATIONS_DIR}?ref=${encodeURIComponent(branch)}`)) as Array<{
    name: string;
    type: string;
  }>;
  return entries.filter((e) => e.type === 'file').map((e) => e.name);
}
