import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { parseAnswerKey } from '../src/answerKey.ts';
import { ConvertError, convertGroundTruth, describeStructure, parseConvertArgs, runConvert } from '../src/convertGroundTruth.ts';
import { removeTempDirs, tempDir } from './synthetic.ts';

after(removeTempDirs);

// A synthetic ground truth, written at test time. It mixes the spellings the
// converter accepts: nested and top-level items, a party as a name or an
// object, window fields flat or nested.
function groundTruth(options: { messageIds?: boolean } = {}) {
  const withIds = options.messageIds ?? true;
  return {
    deals: [
      {
        id: 'T01',
        title: 'Project Falcon',
        codename: 'Falcon',
        aliases: ['Heliotrope sale'],
        side: 'sell',
        parties: [{ name: 'Heliotrope Inc', domain: 'heliotrope.example', role: 'target' }],
        startDate: '2026-01-15',
        endDate: '2026-06-30',
        messages: [
          withIds ? { messageId: '<f1@bank.example>' } : { seedId: 'm-1' },
          withIds ? { messageId: '<f2@bank.example>', attachmentOnly: true } : { seedId: 'm-2', attachmentOnly: true },
        ],
        files: [{ drivePath: 'Falcon/CIM.pdf', itemId: '01AB' }],
      },
      { dealId: 'T02', name: 'Project Cobra', parties: ['Cobalt Systems'], window: { start: '2026-02-01' } },
    ],
    messages: [
      withIds ? { internetMessageId: '<c1@bank.example>', dealId: 'T02' } : { id: 'm-3', dealId: 'T02' },
      withIds ? { internetMessageId: '<lunch@bank.example>' } : { id: 'm-4' },
      // The same Falcon message listed again, as another mailbox copy.
      withIds ? { internetMessageId: '<f1@bank.example>', deal: 'T01' } : { id: 'm-1', deal: 'T01' },
    ],
    documents: [{ path: 'Cobra/teaser.docx', dealIds: ['T02'] }],
  };
}

describe('convertGroundTruth', () => {
  it('builds a valid v1 key, one item per Message-ID, deals unioned', () => {
    const { key, warnings, negatives } = convertGroundTruth({ groundTruth: groundTruth(), coverage: 'complete' });
    assert.ok(parseAnswerKey(key).ok);
    assert.deepEqual(
      key.deals.map((d) => [d.id, d.name, d.window.start, d.window.end]),
      [
        ['T01', 'Project Falcon', '2026-01-15', '2026-06-30'],
        ['T02', 'Project Cobra', '2026-02-01', null],
      ],
    );
    assert.deepEqual(key.deals[0].parties, [{ name: 'Heliotrope Inc', domains: ['heliotrope.example'], role: 'target' }]);
    assert.deepEqual(key.deals[1].parties, [{ name: 'Cobalt Systems', domains: [], role: null }]);
    assert.deepEqual(
      key.items.map((i) => (i.kind === 'message' ? [i.internetMessageId, i.dealIds, i.attachmentOnly] : [i.path, i.dealIds, i.driveItemId])),
      [
        ['<f1@bank.example>', ['T01'], false],
        ['<f2@bank.example>', ['T01'], true],
        ['<c1@bank.example>', ['T02'], false],
        ['<lunch@bank.example>', [], false],
        ['Falcon/CIM.pdf', ['T01'], '01AB'],
        ['Cobra/teaser.docx', ['T02'], null],
      ],
    );
    assert.equal(key.itemCoverage, 'complete');
    assert.equal(negatives, 1);
    assert.deepEqual(warnings, ['1 documents have no driveItemId: a skipped or unrouted one will be reported as "not placed".']);
  });

  it('looks Message-IDs up by seed id when the ground truth has none (Q1: no)', () => {
    const messageIds = { 'm-1': '<f1@bank.example>', 'm-2': '<f2@bank.example>', 'm-3': '<c1@bank.example>', 'm-4': '<lunch@bank.example>' };
    const { key } = convertGroundTruth({ groundTruth: groundTruth({ messageIds: false }), messageIds, coverage: 'complete' });
    assert.equal(key.items.filter((i) => i.kind === 'message').length, 4);
  });

  it('keeps one item per copy, and warns, when each copy has its own Message-ID (Q2: per copy)', () => {
    const messageIds = {
      'm-1': ['<f1-alex@bank.example>', '<f1-storm@bank.example>'],
      'm-2': '<f2@bank.example>',
      'm-3': '<c1@bank.example>',
      'm-4': '<lunch@bank.example>',
    };
    const { key, warnings } = convertGroundTruth({ groundTruth: groundTruth({ messageIds: false }), messageIds, coverage: 'complete' });
    const ids = key.items.filter((i) => i.kind === 'message').map((i) => (i.kind === 'message' ? i.internetMessageId : ''));
    assert.deepEqual(ids.slice(0, 2), ['<f1-alex@bank.example>', '<f1-storm@bank.example>']);
    assert.match(warnings[0], /^2 messages have a different Message-ID in each mailbox copy/);
  });

  it('names the keys it found, never the values, when the shape differs', () => {
    assert.throws(
      () => convertGroundTruth({ groundTruth: { threads: [{ secret: 'Project Falcon' }] }, coverage: 'complete' }),
      (error: unknown) =>
        error instanceof ConvertError && /top-level keys: threads/.test(error.message) && !/Project Falcon/.test(error.message),
    );
    assert.throws(
      () => convertGroundTruth({ groundTruth: { deals: [{ id: 'T01', name: 'X', messages: [{ subject: 'Falcon kickoff' }] }] }, coverage: 'complete' }),
      (error: unknown) =>
        error instanceof ConvertError && /no Internet Message-ID \(keys: subject\)/.test(error.message) && !/kickoff/.test(error.message),
    );
  });

  it('refuses a key that would not validate, such as a deal id no deal has', () => {
    assert.throws(
      () =>
        convertGroundTruth({
          groundTruth: { deals: [{ id: 'T01', name: 'X' }], messages: [{ messageId: '<a@b.example>', dealId: 'T09' }] },
          coverage: 'complete',
        }),
      /not in \$\.deals/,
    );
  });
});

describe('the converter fails closed (review item 4)', () => {
  const base = { deals: [{ id: 'T01', name: 'Project Falcon' }] };
  const convert = (groundTruth: unknown, messageIds?: unknown) => convertGroundTruth({ groundTruth, messageIds, coverage: 'complete' });
  const refuses = (groundTruth: unknown, pattern: RegExp, messageIds?: unknown) =>
    assert.throws(() => convert(groundTruth, messageIds), (e: unknown) => e instanceof ConvertError && pattern.test(e.message));

  it('refuses a deal-reference field it does not read, instead of calling the item a negative', () => {
    // The degenerate case: deal_id, deal_ids and a numeric dealId all became dealIds: [].
    for (const item of [
      { internetMessageId: '<a@bank.example>', deal_id: 'T01' },
      { internetMessageId: '<a@bank.example>', deal_ids: ['T01'] },
      { internetMessageId: '<a@bank.example>', Deals: ['T01'] },
    ]) {
      refuses({ ...base, messages: [item] }, /is not a deal reference the converter reads/);
    }
    refuses({ ...base, messages: [{ internetMessageId: '<a@bank.example>', dealId: 1 }] }, /must be a deal id or a list of deal ids/);
    refuses({ ...base, messages: [{ internetMessageId: '<a@bank.example>', dealIds: ['T01', 2] }] }, /must be a deal id or a list of deal ids/);
  });

  it('refuses a Message-ID with no "@", from the ground truth or from --message-ids', () => {
    // The degenerate case: a Graph REST id, which never matches the tenant's Message-ID header.
    refuses({ ...base, messages: [{ messageId: 'AAMkADQ0ZjE3', dealId: 'T01' }] }, /no "@" is a Graph message id/);
    refuses({ ...base, messages: [{ seedId: 'm-1', dealId: 'T01' }] }, /--message-ids entry "m-1": a Message-ID with no "@"/, { 'm-1': 'AAMkADQ0ZjE3' });
  });

  it('refuses a field present under two spellings', () => {
    refuses({ deals: [{ id: 'T01', dealId: 'T01', name: 'X' }] }, /"id" and "dealId" are spellings of one field/);
    refuses({ deals: [{ id: 'T01', name: 'X', title: 'Y' }] }, /"name" and "title" are spellings of one field/);
    refuses({ ...base, messages: [{ messageId: '<a@b.example>', internetMessageId: '<a@b.example>' }] }, /"internetMessageId" and "messageId"/);
    refuses({ ...base, messages: [{ messageId: '<a@b.example>', dealId: 'T01', deal: 'T01' }] }, /"dealId" and "deal"/);
    refuses({ ...base, files: [{ path: 'a.pdf' }], documents: [{ path: 'b.pdf' }] }, /"files" and "documents"/);
    refuses({ deals: [{ id: 'T01', name: 'X', window: { start: '2026-01-01' }, startDate: '2026-01-01' }] }, /"window" and "startDate" both give its dates/);
    refuses({ ...base, files: [{ path: 'a.pdf', drivePath: 'a.pdf' }] }, /"path" and "drivePath"/);
  });

  it('keeps a file\'s name apart from its path', () => {
    const { key } = convert({ ...base, files: [{ path: 'Falcon/CIM.pdf', name: 'CIM.pdf', dealId: 'T01' }, { name: 'teaser.pdf', dealId: 'T01' }] });
    assert.deepEqual(key.items.map((i) => (i.kind === 'document' ? i.path : '')), ['Falcon/CIM.pdf', 'teaser.pdf']);
  });

  it('refuses a nested item that names another deal', () => {
    refuses({ deals: [{ id: 'T01', name: 'X', messages: [{ messageId: '<a@b.example>', dealId: 'T02' }] }, { id: 'T02', name: 'Y' }] }, /names a deal other than the one it is listed under/);
  });

  it('never prints a value in its errors', () => {
    assert.throws(
      () => convert({ ...base, messages: [{ internetMessageId: '<secret@bank.example>', deal_id: 'Project Falcon' }] }),
      (e: unknown) => e instanceof ConvertError && !e.message.includes('secret') && !e.message.includes('Project Falcon'),
    );
  });

  it('requires --coverage, with no default', () => {
    // The degenerate case: a partial ground truth converted silently as complete.
    assert.throws(() => parseConvertArgs(['--ground-truth', 'g.json', '--out', 'k.json']), /--coverage complete\|partial is required/);
    assert.equal(parseConvertArgs(['--ground-truth', 'g.json', '--out', 'k.json', '--coverage', 'partial']).coverage, 'partial');
    assert.equal(parseConvertArgs(['--ground-truth', 'g.json', '--describe']).coverage, null);
    assert.throws(() => convertGroundTruth({ groundTruth: base } as never), /coverage must be given/);
  });
});

describe('the converter fails on anything it does not consume (second review)', () => {
  const base = { deals: [{ id: 'T01', name: 'Project Falcon' }] };
  const convert = (groundTruth: unknown) => convertGroundTruth({ groundTruth, coverage: 'complete' });
  const refuses = (groundTruth: unknown, pattern: RegExp) =>
    assert.throws(() => convert(groundTruth), (e: unknown) => e instanceof ConvertError && pattern.test(e.message));

  it('refuses a null deal reference instead of calling the item a negative', () => {
    refuses({ ...base, messages: [{ internetMessageId: '<a@bank.example>', dealId: null }] }, /messages\[0\]: its deal reference must be a deal id/);
    refuses({ ...base, messages: [{ internetMessageId: '<a@bank.example>', dealIds: [null] }] }, /its deal reference must be a deal id/);
  });

  it('refuses a deal reference under a key it does not read, deal-like or not', () => {
    refuses({ ...base, messages: [{ internetMessageId: '<a@bank.example>', project: 'T01' }] }, /messages\[0\]\.project: a field the converter does not read/);
  });

  it('refuses item lists it does not read, so a key cannot silently lose its items', () => {
    // The degenerate cases: all three produced a key with zero items.
    refuses({ deals: [{ id: 'T01', name: 'X', emails: [{ internetMessageId: '<a@bank.example>' }] }] }, /deals\[0\]\.emails: a field the converter does not read/);
    refuses({ ...base, threads: [{ messages: [{ internetMessageId: '<a@bank.example>', dealId: 'T01' }] }] }, /\$\.threads: a field the converter does not read/);
    refuses({ ...base, emails: [{ internetMessageId: '<a@bank.example>', dealId: 'T01' }] }, /\$\.emails: a field the converter does not read/);
  });

  it('refuses a window it cannot read, instead of "any date"', () => {
    refuses({ deals: [{ id: 'T01', name: 'X', window: '2026-01-01/2026-06-30' }] }, /deals\[0\]\.window: must be an object with start and end/);
    refuses({ deals: [{ id: 'T01', name: 'X', window: { from: '2026-01-01', to: '2026-06-30' } }] }, /deals\[0\]\.window\.from: a field the converter does not read/);
    refuses({ deals: [{ id: 'T01', name: 'X', window: { start: 20260101 } }] }, /deals\[0\]\.window\.start: must be a non-empty string/);
  });

  it('refuses a flag of the wrong type, instead of reading it as false', () => {
    refuses({ ...base, messages: [{ internetMessageId: '<a@bank.example>', dealId: 'T01', attachmentOnly: 'true' }] }, /messages\[0\]\.attachmentOnly: must be true or false/);
  });

  it('refuses a value of the wrong type anywhere else', () => {
    refuses({ deals: [{ id: 1, name: 'X' }] }, /deals\[0\]\.id: must be a non-empty string/);
    refuses({ deals: [{ id: 'T01', name: 'X', codename: null }] }, /deals\[0\]\.codename: must be a non-empty string/);
    refuses({ deals: [{ id: 'T01', name: 'X', aliases: 'Heliotrope sale' }] }, /deals\[0\]\.aliases: must be an array of non-empty strings/);
    refuses({ deals: [{ id: 'T01', name: 'X', aliases: ['ok', 3] }] }, /deals\[0\]\.aliases: must be an array/);
    refuses({ deals: [{ id: 'T01', name: 'X', side: 'sell-side' }] }, /deals\[0\]\.side: must be sell, buy or other/);
    refuses({ deals: [{ id: 'T01', name: 'X', parties: [{ name: 'H', domains: 'h.example' }] }] }, /parties\[0\]\.domains: must be an array/);
    refuses({ deals: [{ id: 'T01', name: 'X', parties: [{ name: 'H', website: 'h.example' }] }] }, /parties\[0\]\.website: a field the converter does not read/);
    refuses({ ...base, messages: [{ internetMessageId: ['<a@bank.example>'], dealId: 'T01' }] }, /messages\[0\]\.internetMessageId: must be a non-empty string/);
    refuses({ ...base, files: [{ path: 'a.pdf', driveItemId: 7, dealId: 'T01' }] }, /files\[0\]\.driveItemId: must be a non-empty string/);
    assert.throws(
      () => convertGroundTruth({ groundTruth: { ...base, messages: [{ seedId: 'm-1', dealId: 'T01' }] }, messageIds: { 'm-1': [42] }, coverage: 'complete' }),
      /--message-ids entry "m-1": must be a Message-ID or a non-empty list/,
    );
  });

  it('never prints a value in these errors', () => {
    assert.throws(
      () => convert({ deals: [{ id: 'T01', name: 'X', window: 'Falcon Q1', emails: [{ subject: 'secret kickoff' }] }] }),
      (e: unknown) => e instanceof ConvertError && !/Falcon Q1|secret kickoff/.test(e.message),
    );
  });

  it('does not count a positive that is also listed without a deal as a negative', () => {
    // The degenerate case: <f1> nested under T01 and listed again at the top level with no deal counted as a negative.
    const { key, negatives, warnings } = convert({
      deals: [{ id: 'T01', name: 'X', messages: [{ messageId: '<f1@bank.example>' }] }],
      messages: [{ messageId: '<f1@bank.example>' }, { messageId: '<lunch@bank.example>' }],
    });
    assert.equal(negatives, 1);
    assert.deepEqual(key.items.map((i) => i.dealIds), [['T01'], []]);
    assert.ok(warnings.includes('1 items are listed both with a deal and without one. Each keeps its deal and is not counted as a negative.'));
  });
});

describe('describeStructure', () => {
  it('prints keys, types and lengths, never a value', () => {
    const lines = describeStructure(groundTruth());
    assert.ok(lines.includes('$.deals: array (2)'));
    assert.ok(lines.includes('$.deals[].messages[].messageId: string'));
    assert.ok(lines.includes('$.messages: array (3)'));
    const all = lines.join('\n');
    for (const value of ['Falcon', 'f1@bank.example', 'heliotrope', '2026-01-15', 'T01']) assert.ok(!all.includes(value), value);
  });
});

describe('runConvert: where the files may live', () => {
  function setup() {
    const repo = tempDir('dd-repo-');
    mkdirSync(join(repo, 'evals', 'out'), { recursive: true });
    const outside = tempDir('dd-secure-');
    const gt = join(outside, 'ground-truth.json');
    writeFileSync(gt, JSON.stringify(groundTruth()));
    return { repo, outside, gt };
  }

  it('writes the key outside the repo, 0600, and never overwrites it', () => {
    const { repo, outside, gt } = setup();
    const out = join(outside, 'answer-key.json');
    const lines = runConvert(['--ground-truth', gt, '--out', out, '--coverage', 'complete'], repo);
    assert.match(lines[0], /^Wrote the answer key: 2 deals; 4 messages and 2 documents; coverage complete\.$/);
    assert.equal(lines[1], '1 listed items carry no deal reference and are labeled as belonging to no deal.');
    assert.ok(parseAnswerKey(JSON.parse(readFileSync(out, 'utf8'))).ok);
    assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.throws(() => runConvert(['--ground-truth', gt, '--out', out, '--coverage', 'complete'], repo), /never overwrites/);
  });

  it('refuses an output inside the repo, evals/out included, and through a symlink', () => {
    const { repo, outside, gt } = setup();
    for (const out of [join(repo, 'answer-key.json'), join(repo, 'evals', 'out', 'answer-key.json')]) {
      assert.throws(() => runConvert(['--ground-truth', gt, '--out', out, '--coverage', 'complete'], repo), /inside the repository/);
      assert.ok(!existsSync(out));
    }
    const link = join(outside, 'into-repo');
    symlinkSync(join(repo, 'evals'), link);
    assert.throws(() => runConvert(['--ground-truth', gt, '--out', join(link, 'key.json'), '--coverage', 'complete'], repo), /inside the repository/);
    assert.ok(!existsSync(join(repo, 'evals', 'key.json')));
  });

  it('refuses a ground truth or a Message-ID map inside the repo', () => {
    const { repo, outside, gt } = setup();
    const inRepo = join(repo, 'ground-truth.json');
    writeFileSync(inRepo, JSON.stringify(groundTruth()));
    assert.throws(() => runConvert(['--ground-truth', inRepo, '--describe'], repo), /--ground-truth points inside/);
    const map = join(repo, 'ids.json');
    writeFileSync(map, '{}');
    assert.throws(
      () => runConvert(['--ground-truth', gt, '--out', join(outside, 'k.json'), '--message-ids', map, '--coverage', 'complete'], repo),
      /--message-ids points inside/,
    );
  });

  it('describes without writing anything', () => {
    const { repo, gt } = setup();
    const lines = runConvert(['--ground-truth', gt, '--describe'], repo);
    assert.equal(lines[0], '$: object');
  });
});
