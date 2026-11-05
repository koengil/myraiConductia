import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  ANSWER_KEY_ENV,
  ANSWER_KEY_FORMAT,
  AnswerKeyError,
  defaultRepoRoot,
  defaultRepoRoots,
  gitRepoRoots,
  isRealIsoDate,
  loadAnswerKey,
  normalizeDocumentPath,
  normalizeMessageId,
  parseAnswerKey,
  resolveAnswerKeyPath,
} from '../src/answerKey.ts';
import { removeTempDirs, scenario, tempDir, writeKey } from './synthetic.ts';

after(removeTempDirs);

function errorsOf(raw: unknown): string[] {
  const result = parseAnswerKey(raw);
  assert.equal(result.ok, false, 'expected the key to be refused');
  return result.ok ? [] : result.errors;
}

function minimal(extra: Record<string, unknown> = {}) {
  return {
    format: ANSWER_KEY_FORMAT,
    itemCoverage: 'complete',
    deals: [{ id: 'T01', name: 'Project Falcon' }],
    items: [],
    ...extra,
  };
}

describe('parseAnswerKey', () => {
  it('accepts the synthetic key and fills defaults', () => {
    const result = parseAnswerKey(scenario().key);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.key.deals.length, 4);
    assert.deepEqual(result.key.deals[2], {
      id: 'T03',
      name: 'Project Heron',
      codename: 'Heron',
      aliases: [],
      side: null,
      parties: [],
      window: { start: '2026-01-01', end: null },
    });
    const doc = result.key.items.find((i) => i.kind === 'document');
    assert.deepEqual(doc, { kind: 'document', path: 'Falcon/CIM.pdf', driveItemId: null, dealIds: ['T01'] });
    const attachment = result.key.items.find((i) => i.kind === 'message' && i.attachmentOnly);
    assert.ok(attachment);
  });

  it('refuses another format version, naming the expected one', () => {
    const errors = errorsOf(minimal({ format: 'conductia.deal-discovery.answer-key/v0' }));
    assert.match(errors[0], /\$\.format: must be "conductia\.deal-discovery\.answer-key\/v1"/);
  });

  it('refuses unknown fields at every level, with their path', () => {
    const errors = errorsOf(
      minimal({
        extra: 1,
        deals: [{ id: 'T01', name: 'Falcon', stage: 'closed', parties: [{ name: 'H', domain: 'h.example' }] }],
        items: [{ kind: 'message', internetMessageId: '<a@b>', dealId: 'T01', dealIds: ['T01'] }],
      }),
    );
    assert.ok(errors.some((e) => e.startsWith('$.extra: unknown field')));
    assert.ok(errors.some((e) => e.startsWith('$.deals[0].stage: unknown field')));
    assert.ok(errors.some((e) => e.startsWith('$.deals[0].parties[0].domain: unknown field')));
    assert.ok(errors.some((e) => e.startsWith('$.items[0].dealId: unknown field')));
  });

  it('refuses duplicate deals, unknown deal references and duplicate items', () => {
    const errors = errorsOf(
      minimal({
        deals: [
          { id: 'T01', name: 'Falcon' },
          { id: 'T01', name: 'Falcon again' },
        ],
        items: [
          { kind: 'message', internetMessageId: '<A@bank.example>', dealIds: ['T01'] },
          { kind: 'message', internetMessageId: 'a@bank.example', dealIds: ['T09'] },
          { kind: 'document', path: '/Falcon/CIM.pdf', dealIds: ['T01', 'T01'] },
          { kind: 'document', path: 'falcon\\cim.pdf', dealIds: ['T01'] },
        ],
      }),
    );
    assert.ok(errors.includes('$.deals: deal id "T01" appears twice'));
    assert.ok(errors.includes('$.items[1].dealIds: names deal "T09", which is not in $.deals'));
    assert.ok(errors.includes('$.items[1]: is the same item as $.items[0]'));
    assert.ok(errors.includes('$.items[2].dealIds: lists a deal twice'));
    assert.ok(errors.includes('$.items[3]: is the same item as $.items[2]'));
  });

  it('refuses malformed dates, windows, domains, kinds and flags', () => {
    const errors = errorsOf(
      minimal({
        itemCoverage: 'most',
        deals: [
          {
            id: 'T01',
            name: 'Falcon',
            side: 'sideways',
            window: { start: '2026-13-40', end: '2026-01-01' },
            parties: [{ name: 'H', domains: ['not a domain'] }],
          },
          { id: 'T02', name: 'Cobra', window: { start: '2026-06-01', end: '2026-01-01' } },
        ],
        items: [
          { kind: 'email', internetMessageId: '<a@b>', dealIds: [] },
          { kind: 'message', internetMessageId: '<a@b>', dealIds: [], attachmentOnly: true },
          { kind: 'message', internetMessageId: '<c@d>', dealIds: ['T01'], attachmentOnly: 'yes' },
          { kind: 'document', path: 'x.pdf', dealIds: ['T01'], attachmentOnly: true },
          { kind: 'message', dealIds: ['T01'] },
        ],
      }),
    );
    for (const expected of [
      /^\$\.itemCoverage: must be "complete" or "partial"$/,
      /^\$\.deals\[0\]\.side: must be one of sell, buy, other$/,
      /^\$\.deals\[0\]\.window\.start: "2026-13-40" is not a real ISO date/,
      /^\$\.deals\[0\]\.parties\[0\]\.domains\[0\]: "not a domain" is not a mail domain$/,
      /^\$\.deals\[1\]\.window: start is after end$/,
      /^\$\.items\[0\]\.kind: must be "message" or "document"$/,
      /^\$\.items\[1\]\.attachmentOnly: is set on an item that belongs to no deal$/,
      /^\$\.items\[2\]\.attachmentOnly: must be true or false$/,
      /^\$\.items\[3\]\.attachmentOnly: unknown field/,
      /^\$\.items\[4\]\.internetMessageId: is required$/,
    ]) {
      assert.ok(errors.some((e) => expected.test(e)), `missing ${expected}\n${errors.join('\n')}`);
    }
  });

  it('refuses impossible dates that Date.parse rolls over (review item 7)', () => {
    // The degenerate case: 2026-02-30 passed, read as March 2.
    assert.ok(Number.isFinite(Date.parse('2026-02-30')));
    for (const bad of ['2026-02-30', '2025-02-29', '2026-04-31', '2026-00-10', '2026-06-00', '2026-06-01T24:00Z', '2026-06-01T10:60Z', '2026-06-01T10:00:61Z', '2026-06-01T10:00+15:00']) {
      assert.equal(isRealIsoDate(bad), false, bad);
      const errors = errorsOf(minimal({ deals: [{ id: 'T01', name: 'Falcon', window: { start: bad } }] }));
      assert.ok(errors.some((e) => e.startsWith('$.deals[0].window.start:') && e.includes('is not a real ISO date')), bad);
    }
    for (const good of ['2024-02-29', '2000-02-29', '2026-12-31', '2026-06-01T23:59:59.999Z', '2026-06-01T10:00+14:00']) {
      assert.equal(isRealIsoDate(good), true, good);
    }
    assert.equal(isRealIsoDate('1900-02-29'), false);
  });

  it('refuses a Message-ID with no "@", which is a Graph message id (review item 4)', () => {
    const errors = errorsOf(minimal({ items: [{ kind: 'message', internetMessageId: 'AAMkADQ0ZjE3', dealIds: ['T01'] }] }));
    assert.ok(errors.includes('$.items[0].internetMessageId: has no "@": an Internet Message-ID is required, not a Graph message id'));
  });

  it('refuses a key with no deals, and a value that is not an object', () => {
    assert.ok(errorsOf(minimal({ deals: [] })).includes('$.deals: must be a non-empty array'));
    assert.deepEqual(errorsOf([]), ['The answer key must be a JSON object.']);
  });
});

describe('identities', () => {
  it('compares Message-IDs bracketed and in lower case', () => {
    assert.equal(normalizeMessageId(' Falcon-001@Bank.example '), '<falcon-001@bank.example>');
    assert.equal(normalizeMessageId('<falcon-001@bank.example>'), '<falcon-001@bank.example>');
  });

  it('compares document paths without a leading slash, in lower case, with forward slashes', () => {
    assert.equal(normalizeDocumentPath('/Falcon/CIM v3.pdf'), 'falcon/cim v3.pdf');
    assert.equal(normalizeDocumentPath('Falcon\\\\CIM v3.pdf'), 'falcon/cim v3.pdf');
  });
});

describe('the key never lives inside the repository', () => {
  const repo = tempDir('dd-repo-');
  mkdirSync(join(repo, 'evals', 'deal-discovery'), { recursive: true });
  const outside = tempDir('dd-secure-');
  const keyOutside = writeKey(outside, scenario().key);
  const keyInside = writeKey(join(repo, 'evals'), scenario().key);

  it('reads a key outside the repository', () => {
    const key = loadAnswerKey({ [ANSWER_KEY_ENV]: keyOutside }, repo);
    assert.equal(key.deals.length, 4);
  });

  it('refuses a key inside the repository', () => {
    assert.throws(() => resolveAnswerKeyPath({ [ANSWER_KEY_ENV]: keyInside }, repo), /points inside the repository/);
  });

  it('refuses a relative path, or a path with .. segments, that lands inside', () => {
    const viaDots = join(outside, '..', relative(join(outside, '..'), keyInside));
    assert.throws(() => resolveAnswerKeyPath({ [ANSWER_KEY_ENV]: viaDots }, repo), /inside the repository/);
    assert.throws(() => resolveAnswerKeyPath({ [ANSWER_KEY_ENV]: relative(process.cwd(), keyInside) }, repo), /inside/);
  });

  it('refuses a symlink outside the repository that points at a file inside it', () => {
    const link = join(outside, 'innocent-looking.json');
    symlinkSync(keyInside, link);
    assert.throws(() => resolveAnswerKeyPath({ [ANSWER_KEY_ENV]: link }, repo), /inside the repository/);
  });

  it('refuses a key inside the repository when the repository is reached through a symlink', () => {
    const repoLink = join(outside, 'repo-link');
    symlinkSync(repo, repoLink);
    assert.throws(() => resolveAnswerKeyPath({ [ANSWER_KEY_ENV]: keyInside }, repoLink), /inside the repository/);
    assert.throws(
      () => resolveAnswerKeyPath({ [ANSWER_KEY_ENV]: join(repoLink, 'evals', 'answer-key.json') }, repo),
      /inside the repository/,
    );
  });

  it('refuses any file of this repository, with the default root', () => {
    // An existing in-repo file stands in for a key; nothing is written to the repo.
    const inRepo = join(defaultRepoRoot(), 'evals', 'deal-discovery', 'package.json');
    assert.ok(existsSync(inRepo));
    assert.throws(() => resolveAnswerKeyPath({ [ANSWER_KEY_ENV]: inRepo }), AnswerKeyError);
    assert.throws(() => resolveAnswerKeyPath({ [ANSWER_KEY_ENV]: inRepo }), /points inside the repository/);
  });

  it('refuses a key in the main checkout of a linked worktree (review item 8)', () => {
    // The degenerate case: the key sits in the main checkout, which the
    // worktree's own root does not contain.
    const base = realpathSync.native(tempDir('dd-git-'));
    const main = join(base, 'main');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: main, stdio: 'ignore' });
    mkdirSync(main);
    git('init', '-q');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '--allow-empty', '-m', 'x');
    const worktree = join(base, 'wt');
    git('worktree', 'add', '-q', worktree);
    const key = writeKey(main, scenario().key);
    assert.deepEqual(gitRepoRoots(worktree), [worktree, main]);
    // With the worktree's root alone, the key would be accepted.
    assert.equal(resolveAnswerKeyPath({ [ANSWER_KEY_ENV]: key }, worktree), key);
    assert.throws(() => resolveAnswerKeyPath({ [ANSWER_KEY_ENV]: key }, gitRepoRoots(worktree)), /points inside the repository/);
  });

  it('fails closed when git cannot name the root', () => {
    assert.throws(() => gitRepoRoots(tempDir('dd-nogit-')), /git rev-parse failed/);
  });

  it('protects this worktree and its main checkout by default', () => {
    const roots = defaultRepoRoots();
    assert.equal(roots[0], realpathSync.native(defaultRepoRoot()));
    const common = execFileSync('git', ['-C', defaultRepoRoot(), 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
    assert.ok(roots.includes(realpathSync.native(join(common, '..'))));
  });

  it('names the default root as the repository root', () => {
    assert.ok(existsSync(join(defaultRepoRoot(), 'evals', 'deal-discovery', 'src', 'answerKey.ts')));
    assert.ok(existsSync(join(defaultRepoRoot(), 'package.json')));
  });

  it('refuses an unset variable and a missing file', () => {
    assert.throws(() => resolveAnswerKeyPath({}, repo), /EVAL_ANSWER_KEY_PATH is not set/);
    assert.throws(() => resolveAnswerKeyPath({ [ANSWER_KEY_ENV]: join(outside, 'nope.json') }, repo), /does not exist/);
  });

  it('reports invalid JSON without echoing the file', () => {
    const broken = join(outside, 'broken.json');
    writeFileSync(broken, '{"format": "SECRET-CONTENT"');
    assert.throws(
      () => loadAnswerKey({ [ANSWER_KEY_ENV]: broken }, repo),
      (error: Error) => error.message === 'The answer key is not valid JSON.' && !error.message.includes('SECRET'),
    );
  });

  it('lists every validation error with its path', () => {
    const bad = writeKey(outside, minimal({ items: [{ kind: 'message', dealIds: ['T02'] }] }), 'bad.json');
    assert.throws(() => loadAnswerKey({ [ANSWER_KEY_ENV]: bad }, repo), /\$\.items\[0\]\.internetMessageId: is required/);
  });
});
