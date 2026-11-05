import { describe, expect, it } from 'vitest';
import type { Fetcher, Migration, PrFile } from '../scripts/check-migration-open-prs';
import {
  checkMigrationOrder,
  findOrderProblems,
  planOrderCheck,
  suggestPrefix,
} from '../scripts/check-migration-order';

const dir = 'supabase/migrations';
const mig = (name: string): Migration => ({ name, prefix: name.slice(0, 14), sha: 's' });
const added = (name: string): PrFile => ({ filename: `${dir}/${name}`, status: 'added', sha: 's' });
const developNames = ['20261015000000_a.sql', '20261019120000_team_mailbox_list.sql', 'README.md'];

// A fake GitHub API: the PR's files, and the migrations directory per branch.
function fakeApi(prFiles: PrFile[], dirs: Record<string, string[]>, failWith?: number) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    if (failWith) return { ok: false, status: failWith, json: async () => ({}) };
    const u = new URL(url);
    const body = u.pathname.endsWith('/files')
      ? prFiles
      : (dirs[u.searchParams.get('ref') ?? ''] ?? []).map((name) => ({ name, type: 'file' }));
    return { ok: true, status: 200, json: async () => body };
  };
  return { fetcher, calls };
}

const noGit = () => {
  throw new Error('fatal: not a valid object name');
};

describe('migrations a PR adds sort after its base', () => {
  it('fails a file dated before the newest on the base, and names it', () => {
    expect(
      findOrderProblems([mig('20261018000000_late_rebase.sql'), mig('20261020000000_fine.sql')], developNames, 'origin/develop'),
    ).toEqual({
      problems: ['20261018000000_late_rebase.sql sorts before 20261019120000_team_mailbox_list.sql, the newest migration on origin/develop'],
      newest: '20261019120000_team_mailbox_list.sql',
    });
  });

  it('fails a prefix equal to the newest', () => {
    expect(findOrderProblems([mig('20261019120000_other.sql')], developNames, 'origin/develop').problems).toHaveLength(1);
  });

  it('passes a file the base already holds (a squash-merged parent seen through a stack)', () => {
    expect(findOrderProblems([mig('20261015000000_a.sql')], developNames, 'origin/develop').problems).toEqual([]);
  });

  it('compares a stacked slice with its parent branch, not develop', async () => {
    const parent = [...developNames, '20261021000000_parent.sql'];
    const { problems } = await checkMigrationOrder({
      base: 'origin/feat/parent',
      readOwn: () => [mig('20261020120000_child.sql')],
      readBaseNames: (base) => (base === 'origin/feat/parent' ? parent : developNames),
      log: () => {},
    });
    expect(problems).toEqual([
      '20261020120000_child.sql sorts before 20261021000000_parent.sql, the newest migration on origin/feat/parent',
    ]);
  });

  it('suggests now in UTC, or one second after the newest when the clock is behind', () => {
    expect(suggestPrefix('20261019120000_x.sql', new Date('2026-10-20T08:09:10Z'))).toBe('20261020080910');
    expect(suggestPrefix('20261231235959_x.sql', new Date('2026-10-20T08:09:10Z'))).toBe('20270101000000');
  });
});

describe('where the order check reads its inputs', () => {
  it('in CI reads the PR files from the API, and the base listing from the API when the ref is not fetched', async () => {
    const api = fakeApi([added('20261018000000_late.sql'), added('src/x.ts')], { develop: developNames });
    const { problems } = await checkMigrationOrder({
      base: 'origin/develop',
      pr: 7,
      repo: 'o/r',
      token: 't',
      fetcher: api.fetcher,
      readOwn: noGit,
      readBaseNames: noGit,
      log: () => {},
    });
    expect(problems).toHaveLength(1);
    expect(api.calls.at(-1)).toBe('https://api.github.com/repos/o/r/contents/supabase/migrations?ref=develop');
  });

  it('falls back to git for the PR files when the API fails', async () => {
    const api = fakeApi([], {}, 502);
    const log: string[] = [];
    const { problems } = await checkMigrationOrder({
      base: 'origin/develop',
      pr: 7,
      repo: 'o/r',
      token: 't',
      fetcher: api.fetcher,
      readOwn: () => [mig('20261018000000_late.sql')],
      readBaseNames: () => developNames,
      log: (l) => log.push(l),
    });
    expect(problems).toHaveLength(1);
    expect(log[0]).toContain('reading them from git');
  });

  it('warns and passes when neither the API nor a shallow checkout can say', async () => {
    const log: string[] = [];
    const result = await checkMigrationOrder({
      base: 'origin/develop',
      pr: 7,
      repo: 'o/r',
      token: 't',
      fetcher: fakeApi([], {}, 503).fetcher,
      readOwn: noGit,
      readBaseNames: noGit,
      log: (l) => log.push(l),
    });
    expect(result.problems).toEqual([]);
    expect(log.at(-1)).toContain('Migration order check skipped: no merge-base with origin/develop');
  });

  it('warns and passes when the base listing fails on both git and the API', async () => {
    const api = fakeApi([added('20261018000000_late.sql')], {});
    const fetcher: Fetcher = async (url, init) =>
      url.includes('/contents/') ? { ok: false, status: 500, json: async () => ({}) } : api.fetcher(url, init);
    const log: string[] = [];
    const result = await checkMigrationOrder({
      base: 'origin/develop', pr: 7, repo: 'o/r', token: 't', fetcher, readOwn: noGit, readBaseNames: noGit, log: (l) => log.push(l),
    });
    expect(result.problems).toEqual([]);
    expect(log.at(-1)).toContain('origin/develop is not fetched and the GitHub API failed');
  });

  it('makes no base lookup when the PR adds no migration', async () => {
    let looked = false;
    const result = await checkMigrationOrder({
      base: 'origin/develop',
      readOwn: () => [],
      readBaseNames: () => ((looked = true), developNames),
      log: () => {},
    });
    expect(result.problems).toEqual([]);
    expect(looked).toBe(false);
  });
});

describe('when the order check runs', () => {
  it('runs locally from git against origin/develop, or --base', () => {
    expect(planOrderCheck([], {})).toEqual({ run: true, base: 'origin/develop' });
    expect(planOrderCheck(['--base', 'origin/feat/parent'], {})).toEqual({ run: true, base: 'origin/feat/parent' });
  });

  it('on pull_request compares with origin/<base_ref> and the PR from the API', () => {
    expect(
      planOrderCheck([], {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_BASE_REF: 'feat/parent',
        GITHUB_TOKEN: 't',
        GITHUB_REPOSITORY: 'o/r',
        PR_NUMBER: '12',
      }),
    ).toEqual({ run: true, base: 'origin/feat/parent', pr: 12, repo: 'o/r', token: 't' });
  });

  it('is skipped on a push', () => {
    expect(planOrderCheck([], { GITHUB_EVENT_NAME: 'push' }).run).toBe(false);
  });
});
