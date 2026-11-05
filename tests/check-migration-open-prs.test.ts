import { describe, expect, it } from 'vitest';
import {
  addedMigrations,
  checkOpenPrs,
  findOpenPrCollisions,
  planOpenPrCheck,
  type Fetcher,
  type PrFile,
} from '../scripts/check-migration-open-prs';

const dir = 'supabase/migrations';
const added = (name: string, sha: string): PrFile => ({ filename: `${dir}/${name}`, status: 'added', sha });

// A fake GitHub API: open PRs with their authors and files.
function fakeApi(prs: Record<number, { author: string; files: PrFile[] }>, opts: { failWith?: number } = {}) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    if (opts.failWith) return { ok: false, status: opts.failWith, json: async () => ({}) };
    const path = new URL(url).pathname;
    const files = /\/pulls\/(\d+)\/files$/.exec(path);
    const body = files
      ? prs[Number(files[1])].files
      : Object.entries(prs).map(([n, p]) => ({ number: Number(n), user: { login: p.author } }));
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetcher, calls };
}

async function run(prs: Parameters<typeof fakeApi>[0], pr: number, opts?: { failWith?: number }) {
  const api = fakeApi(prs, opts);
  const log: string[] = [];
  const problems = await checkOpenPrs({ repo: 'o/r', token: 't', pr, fetcher: api.fetcher, log: (l) => log.push(l) });
  return { problems, log, calls: api.calls };
}

describe('open-PR migration prefix check', () => {
  it('fails on another open PR adding a different file with the same prefix, naming PR and author', async () => {
    const { problems } = await run(
      {
        562: { author: 'alice', files: [added('20261015120000_mailbox_rules.sql', 'a1')] },
        553: { author: 'bob', files: [added('20261015120000_ai_costs.sql', 'b2'), added('20261016000000_other.sql', 'b3')] },
      },
      562,
    );
    expect(problems).toEqual([
      '20261015120000_mailbox_rules.sql vs 20261015120000_ai_costs.sql in #553 by @bob (same prefix)',
    ]);
  });

  it('passes the same file (name and blob) seen through a stacked slice', async () => {
    const { problems } = await run(
      {
        600: { author: 'alice', files: [added('20261015120000_parent.sql', 'p1')] },
        601: { author: 'alice', files: [added('20261015120000_parent.sql', 'p1'), added('20261017000000_child.sql', 'c1')] },
      },
      601,
    );
    expect(problems).toEqual([]);
  });

  it('still compares what the API returned for a PR past the 3000-file cap, and says so', async () => {
    const big: PrFile[] = [added('20261015120000_big.sql', 'g1')];
    for (let i = 0; i < 3100; i++) big.push({ filename: `src/f${i}.ts`, status: 'modified', sha: `s${i}` });
    const prs: Record<number, PrFile[]> = { 700: big, 701: [added('20261015120000_mine.sql', 'm1')] };
    const fetcher: Fetcher = async (url) => {
      const u = new URL(url);
      const m = /\/pulls\/(\d+)\/files$/.exec(u.pathname);
      const page = Number(u.searchParams.get('page') ?? '1');
      const body = m
        ? prs[Number(m[1])].slice((page - 1) * 100, page * 100)
        : page === 1 ? [{ number: 700, user: { login: 'carol' } }, { number: 701, user: { login: 'alice' } }] : [];
      return { ok: true, status: 200, json: async () => body };
    };
    const log: string[] = [];
    const problems = await checkOpenPrs({ repo: 'o/r', token: 't', pr: 701, fetcher, log: (l) => log.push(l) });
    expect(problems).toEqual(['20261015120000_mine.sql vs 20261015120000_big.sql in #700 by @carol (same prefix)']);
    expect(log.some((l) => l.includes('#700') && l.includes('only its first 3000 were compared'))).toBe(true);
  });

  it('fails the same name with different content', async () => {
    const { problems } = await run(
      {
        600: { author: 'alice', files: [added('20261015120000_parent.sql', 'p1')] },
        601: { author: 'carol', files: [added('20261015120000_parent.sql', 'p2')] },
      },
      601,
    );
    expect(problems).toEqual([
      '20261015120000_parent.sql vs 20261015120000_parent.sql in #600 by @alice (same name, different content)',
    ]);
  });

  it('excludes its own PR and ignores modified, removed and non-migration files', async () => {
    const { problems, log } = await run(
      {
        700: { author: 'alice', files: [added('20261015120000_mine.sql', 'm1')] },
        701: {
          author: 'bob',
          files: [
            { filename: `${dir}/20261015120000_mine_old.sql`, status: 'modified', sha: 'x' },
            { filename: `${dir}/20261015120000_gone.sql`, status: 'removed', sha: 'y' },
            added('docs/20261015120000_notes.sql', 'z'),
          ],
        },
      },
      700,
    );
    expect(problems).toEqual([]);
    expect(log.at(-1)).toContain('share no prefix with the 1 other open PR(s)');
  });

  it('warns and passes when the API fails', async () => {
    const { problems, log } = await run({ 1: { author: 'a', files: [] } }, 1, { failWith: 503 });
    expect(problems).toEqual([]);
    expect(log).toEqual([
      '⚠️  Open-PR migration check skipped, the GitHub API failed (GET /repos/o/r/pulls/1/files?per_page=100&page=1 returned 503). Merged files were still checked.',
    ]);
  });

  it('makes no further calls when the PR adds no migration', async () => {
    const { problems, calls } = await run({ 5: { author: 'a', files: [added('src/x.ts', 's')] }, 6: { author: 'b', files: [] } }, 5);
    expect(problems).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});

describe('collision rules', () => {
  it('reads added and renamed migrations only', () => {
    expect(
      addedMigrations([
        added('20261015120000_a.sql', 'a'),
        { filename: `${dir}/20261015130000_b.sql`, status: 'renamed', sha: 'b' },
        { filename: `${dir}/20261015140000_c.sql`, status: 'modified', sha: 'c' },
        added('20261015150000_d.md', 'd'),
      ]).map((m) => m.name),
    ).toEqual(['20261015120000_a.sql', '20261015130000_b.sql']);
  });

  it('passes distinct prefixes', () => {
    expect(
      findOpenPrCollisions(
        [{ name: '20261015120000_a.sql', prefix: '20261015120000', sha: 'a' }],
        [{ number: 2, author: 'b', migrations: [{ name: '20261015120001_b.sql', prefix: '20261015120001', sha: 'b' }] }],
      ),
    ).toEqual([]);
  });
});

describe('when the open-PR check runs', () => {
  const noGh = () => undefined;
  const origin = () => 'Conductia/Conductia';

  it('is skipped locally with a one-line notice unless --open-prs is passed', () => {
    expect(planOpenPrCheck([], {}, noGh, origin)).toEqual({
      run: false,
      notice: 'ℹ️  Open-PR migration check skipped (runs on pull_request in CI; locally pass --open-prs).',
    });
  });

  it('is skipped on a push event', () => {
    expect(planOpenPrCheck([], { GITHUB_EVENT_NAME: 'push', GITHUB_TOKEN: 't' }, noGh, origin).run).toBe(false);
  });

  it('is skipped with a notice when there is no token', () => {
    expect(planOpenPrCheck([], { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'o/r' }, noGh, origin)).toEqual({
      run: false,
      notice: '⚠️  Open-PR migration check skipped: no GITHUB_TOKEN or gh login.',
    });
    expect(planOpenPrCheck(['--open-prs'], {}, noGh, origin).run).toBe(false);
  });

  it('runs on pull_request with the token, repository and PR number', () => {
    expect(
      planOpenPrCheck([], { GITHUB_EVENT_NAME: 'pull_request', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', PR_NUMBER: '562' }, noGh, origin),
    ).toEqual({ run: true, repo: 'o/r', token: 't', pr: 562, base: 'origin/develop' });
  });

  it('runs locally with --open-prs, a gh token and the origin repository', () => {
    expect(planOpenPrCheck(['--open-prs', '--pr', '9'], {}, () => 'gh', origin)).toEqual({
      run: true,
      repo: 'Conductia/Conductia',
      token: 'gh',
      pr: 9,
      base: 'origin/develop',
    });
  });
});
