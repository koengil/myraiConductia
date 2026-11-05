import { execFileSync } from 'node:child_process';

// Two open PRs can each add a migration with the same YYYYMMDDHHMMSS prefix.
// Each passes on its own branch, and the second to merge breaks develop
// (#562 vs #553). This compares the migrations a PR adds with those every
// other open PR adds. It runs from check-migration-prefixes.ts.

const MIGRATION_PATH = /^supabase\/migrations\/((\d{14})_[^/]*\.sql)$/;
const API = 'https://api.github.com';
// The files endpoint returns at most 3000 entries (30 pages of 100).
const MAX_FILE_PAGES = 30;
const CONCURRENCY = 6;

export type Migration = { name: string; prefix: string; sha: string };
export type OtherPr = { number: number; author: string; migrations: Migration[] };
export type PrFile = { filename: string; status: string; sha: string };

export function addedMigrations(files: readonly PrFile[]): Migration[] {
  const out: Migration[] = [];
  for (const file of files) {
    // A rename into the directory is a new migration too; a modified or removed
    // file is either already merged (the merged-files check owns it) or gone.
    if (file.status !== 'added' && file.status !== 'renamed' && file.status !== 'copied') continue;
    const match = MIGRATION_PATH.exec(file.filename);
    if (match) out.push({ name: match[1], prefix: match[2], sha: file.sha });
  }
  return out;
}

// A stacked slice that targets develop carries its parent's commits, so the
// same file (same name, same blob) shows up in both PRs. That is one
// migration, not a collision. Same prefix with another name, or the same name
// with other content, is a collision.
export function findOpenPrCollisions(own: readonly Migration[], others: readonly OtherPr[]): string[] {
  const problems: string[] = [];
  for (const mine of [...own].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const pr of others) {
      for (const theirs of pr.migrations) {
        if (theirs.prefix !== mine.prefix) continue;
        if (theirs.name === mine.name && theirs.sha === mine.sha) continue;
        const why = theirs.name === mine.name ? 'same name, different content' : 'same prefix';
        problems.push(`${mine.name} vs ${theirs.name} in #${pr.number} by @${pr.author} (${why})`);
      }
    }
  }
  return problems;
}

export type Fetcher = (url: string, init: { headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export class ApiError extends Error {}

export type Ctx = { repo: string; token: string; fetcher: Fetcher };

export async function get(ctx: Ctx, path: string): Promise<unknown> {
  const res = await ctx.fetcher(`${API}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${ctx.token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) throw new ApiError(`GET ${path} returned ${res.status}`);
  return res.json();
}

export async function listPrFiles(ctx: Ctx, pr: number): Promise<{ files: PrFile[]; truncated: boolean }> {
  const files: PrFile[] = [];
  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const batch = (await get(ctx, `/repos/${ctx.repo}/pulls/${pr}/files?per_page=100&page=${page}`)) as PrFile[];
    files.push(...batch);
    if (batch.length < 100) return { files, truncated: false };
  }
  return { files, truncated: true };
}

type PullSummary = { number: number; user: { login: string } | null };

export async function listOpenPrs(ctx: Ctx): Promise<PullSummary[]> {
  const pulls: PullSummary[] = [];
  for (let page = 1; ; page++) {
    const batch = (await get(ctx, `/repos/${ctx.repo}/pulls?state=open&per_page=100&page=${page}`)) as PullSummary[];
    pulls.push(...batch);
    if (batch.length < 100) return pulls;
  }
}

export type OpenPrCheckInput = {
  repo: string;
  token: string;
  // This PR, when there is one: it is excluded, and its files come from the API.
  pr?: number;
  // Without a PR number: the migrations this branch adds, read from git.
  own?: Migration[];
  fetcher?: Fetcher;
  log?: (line: string) => void;
};

// Returns the collisions. An API failure is a warning, never a failure: an
// outage must not block merges, and the merged-files check still runs.
export async function checkOpenPrs(input: OpenPrCheckInput): Promise<string[]> {
  const log = input.log ?? console.log;
  const ctx: Ctx = { repo: input.repo, token: input.token, fetcher: input.fetcher ?? (fetch as Fetcher) };
  try {
    let own = input.own ?? [];
    if (input.pr !== undefined) {
      const mine = await listPrFiles(ctx, input.pr);
      own = addedMigrations(mine.files);
      if (mine.truncated) {
        log(`⚠️  This PR changes ${MAX_FILE_PAGES * 100}+ files, past what the API lists; migrations beyond that were not compared.`);
      }
    }
    if (own.length === 0) {
      log('✅ This branch adds no migration file, so no open PR can collide with it.');
      return [];
    }

    const pulls = (await listOpenPrs(ctx)).filter((p) => p.number !== input.pr);
    const others: OtherPr[] = [];
    const skipped: number[] = [];
    for (let i = 0; i < pulls.length; i += CONCURRENCY) {
      await Promise.all(
        pulls.slice(i, i + CONCURRENCY).map(async (p) => {
          const { files, truncated } = await listPrFiles(ctx, p.number);
          // A truncated list is still compared: what the API returned can collide.
          if (truncated) skipped.push(p.number);
          others.push({ number: p.number, author: p.user?.login ?? 'unknown', migrations: addedMigrations(files) });
        }),
      );
    }
    others.sort((a, b) => a.number - b.number);
    for (const n of skipped.sort((a, b) => a - b)) {
      log(`⚠️  #${n} changes ${MAX_FILE_PAGES * 100}+ files, past what the API lists; only its first ${MAX_FILE_PAGES * 100} were compared.`);
    }

    const problems = findOpenPrCollisions(own, others);
    if (problems.length === 0) {
      log(`✅ The ${own.length} migration file(s) this branch adds share no prefix with the ${others.length} other open PR(s).`);
    }
    return problems;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`⚠️  Open-PR migration check skipped, the GitHub API failed (${reason}). Merged files were still checked.`);
    return [];
  }
}

// Local runs without a PR number: files under supabase/migrations/ added since
// the merge-base with the base branch.
export function branchAddedMigrations(base: string): Migration[] {
  const git = (args: string[]) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const mergeBase = git(['merge-base', base, 'HEAD']);
  const names = git(['diff', '--name-only', '--diff-filter=ACR', mergeBase, '--', 'supabase/migrations/'])
    .split('\n')
    .filter(Boolean);
  const files = names.filter((n) => MIGRATION_PATH.test(n));
  if (files.length === 0) return [];
  const shas = git(['hash-object', '--', ...files]).split('\n');
  return addedMigrations(files.map((filename, i) => ({ filename, status: 'added', sha: shas[i] })));
}

export type OpenPrPlan =
  | { run: false; notice: string }
  | { run: true; repo: string; token: string; pr?: number; base: string };

// CI (pull_request with GITHUB_TOKEN) always runs the check. Locally it runs
// only with --open-prs, and takes a token from GITHUB_TOKEN or `gh auth token`.
export function planOpenPrCheck(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  ghToken: () => string | undefined = readGhToken,
  originRepo: () => string | undefined = readOriginRepo,
): OpenPrPlan {
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const inCi = env.GITHUB_EVENT_NAME === 'pull_request';
  const optedIn = argv.includes('--open-prs');
  if (!inCi && !optedIn) {
    return { run: false, notice: 'ℹ️  Open-PR migration check skipped (runs on pull_request in CI; locally pass --open-prs).' };
  }
  const token = env.GITHUB_TOKEN || (inCi ? undefined : ghToken());
  const repo = flag('--repo') ?? env.GITHUB_REPOSITORY ?? (inCi ? undefined : originRepo());
  if (!token || !repo) {
    return { run: false, notice: `⚠️  Open-PR migration check skipped: no ${token ? 'repository (GITHUB_REPOSITORY or --repo)' : 'GITHUB_TOKEN or gh login'}.` };
  }
  const prText = flag('--pr') ?? env.PR_NUMBER;
  const pr = prText ? Number(prText) : undefined;
  if (pr !== undefined && !Number.isInteger(pr)) return { run: false, notice: `⚠️  Open-PR migration check skipped: bad PR number ${prText}.` };
  return { run: true, repo, token, pr, base: flag('--base') ?? 'origin/develop' };
}

function readGhToken(): string | undefined {
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function readOriginRepo(): string | undefined {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\s*$/.exec(url)?.[1];
  } catch {
    return undefined;
  }
}
