// The phase 5 reviews' degenerate tables, re-run against the fixed scorer.
// Before each fix, every row below but "perfect" passed the checkpoint as
// discovery_led (5-deal key). Now each row states its verdict and exactly
// which checks fail, and the rows the export reader must refuse are refused.
// The table is printed as test diagnostics, so `npm test` shows it.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { parseAnswerKey, type AnswerKey } from '../src/answerKey.ts';
import { ExportError, readExport, type DiscoveryExport, type ExportCandidate } from '../src/exportData.ts';
import { formatRatio } from '../src/report.ts';
import { score, type CheckpointMetric, type Scorecard } from '../src/score.ts';
import { fiveDeals, message, removeTempDirs, tempDir, writeExport } from './synthetic.ts';

after(removeTempDirs);

function keyOf(raw: unknown): AnswerKey {
  const result = parseAnswerKey(raw);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.key;
}

type Expect = { verdict: Scorecard['checkpoint']['verdict']; fails: CheckpointMetric[] };

type Row = {
  system: string;
  key: AnswerKey;
  data: DiscoveryExport;
  expect: Expect;
  /** The export reader and score() must refuse `data` with this error; `expect` then holds for `asKnown`. */
  refused?: { error: RegExp; asKnown: DiscoveryExport };
  /** The same export against a complete key (the partial-key row). */
  complete?: { key: AnswerKey; expect: Expect };
};

const ALL: CheckpointMetric[] = ['discoveryPrecision', 'discoveryRecall', 'itemPrecision', 'itemRecall', 'fragmentation', 'merge'];

function rows(): Row[] {
  const out: Row[] = [];
  const add = (
    system: string,
    expect: Expect,
    build: (f: ReturnType<typeof fiveDeals>) => DiscoveryExport,
    perDeal = 4,
  ) => {
    const f = fiveDeals(perDeal);
    out.push({ system, key: keyOf(f.key), data: build(f), expect });
  };
  const weekly = (f: ReturnType<typeof fiveDeals>, partial: Partial<ExportCandidate> = {}) =>
    f.named(0, { proposedName: 'Weekly call', codenameGuess: null, parties: [{ name: 'Baker Stone', domain: 'bakerstone.example' }], ...partial });

  add('perfect', { verdict: 'discovery_led', fails: [] }, (f) =>
    f.exportOf(f.dealItems.map((items, d) => ({ candidate: f.named(d), items }))),
  );

  // ── The first review (review items 1 to 3) ──────────────────────────────
  add('3 duplicate candidates per deal', { verdict: 'seeded', fails: ['discoveryPrecision', 'itemPrecision', 'fragmentation'] }, (f) =>
    f.exportOf(f.dealItems.flatMap((items, d) => [0, 1, 2].map(() => ({ candidate: f.named(d), items })))),
  );

  add('one candidate per item', { verdict: 'seeded', fails: ['discoveryPrecision', 'itemPrecision', 'itemRecall', 'fragmentation'] }, (f) =>
    f.exportOf(f.dealItems.flatMap((items, d) => items.map((item) => ({ candidate: f.named(d), items: [item] })))),
  );

  add('correct names, zero links', { verdict: 'seeded', fails: ALL }, (f) =>
    f.exportOf(f.dealItems.map((_, d) => ({ candidate: f.named(d), items: [] }))),
  );

  add('correct names, every link to the wrong deal', { verdict: 'seeded', fails: ALL }, (f) =>
    f.exportOf(f.dealItems.map((_, d) => ({ candidate: f.named(d), items: f.dealItems[(d + 1) % 5] }))),
  );

  add('one party shared by every deal, five "Weekly call" candidates', { verdict: 'seeded', fails: ['discoveryPrecision', 'itemPrecision'] }, (f) =>
    f.exportOf([
      ...f.dealItems.slice(0, 4).map((items, d) => ({ candidate: f.named(d), items })),
      ...f.negativeItems.map((item) => ({ candidate: weekly(f), items: [item] })),
    ]),
  );

  // 51 of deal d's items and 49 of deal d+1's in each candidate.
  add(
    '51/49 mixed candidates',
    { verdict: 'seeded', fails: ['itemPrecision', 'merge'] },
    (f) =>
      f.exportOf(
        f.dealItems.map((_, d) => ({
          candidate: f.named(d),
          items: [...f.dealItems[d].slice(0, 51), ...f.dealItems[(d + 1) % 5].slice(51)],
        })),
      ),
    100,
  );

  // Rows the verdict must hold against once corrections exist (phases 7 and 8).
  add('"Weekly call" candidates, then auto-rejected', { verdict: 'seeded', fails: ['discoveryPrecision', 'itemPrecision'] }, (f) =>
    f.exportOf([
      ...f.dealItems.slice(0, 4).map((items, d) => ({ candidate: f.named(d), items })),
      ...f.negativeItems.map((item) => ({ candidate: weekly(f, { discoveryState: 'rejected' }), items: [item] })),
    ]),
  );

  add('3 duplicates per deal, then two merged into the first', { verdict: 'seeded', fails: ['discoveryPrecision', 'itemPrecision', 'fragmentation'] }, (f) =>
    f.exportOf(
      f.dealItems.flatMap((items, d) => {
        const first = f.named(d);
        const merged = () => f.named(d, { discoveryState: 'merged_into', mergedIntoId: first.id });
        return [first, merged(), merged()].map((candidate) => ({ candidate, items }));
      }),
    ),
  );

  add('"Weekly call" candidates, their links rejected', { verdict: 'seeded', fails: ['discoveryPrecision', 'itemPrecision'] }, (f) =>
    f.exportOf([
      ...f.dealItems.slice(0, 4).map((items, d) => ({ candidate: f.named(d), items })),
      ...f.negativeItems.map((item) => ({ candidate: f.named(0, { proposedName: 'Weekly call', codenameGuess: null }), items: [item], linkState: 'rejected' as const })),
    ]),
  );

  // ── The second review ────────────────────────────────────────────────────
  // Item recall 1% (5/500) used to pass every target.
  add(
    'one correct link per deal',
    { verdict: 'seeded', fails: ['itemRecall'] },
    (f) => f.exportOf(f.dealItems.map((items, d) => ({ candidate: f.named(d), items: [items[0]] }))),
    100,
  );

  // Junk the key does not list was invisible to the evidence gate and to item precision.
  {
    const f = fiveDeals(1);
    const junk = f.dealItems.map((_, d) => Array.from({ length: 50 }, (_, k) => message(`<junk-${d}-${k}@bank.example>`, `conv-junk-${d}-${k}`)));
    const data = f.exportOf(f.dealItems.map((items, d) => ({ candidate: f.named(d), items: [...items, ...junk[d]] })));
    out.push({
      system: 'partial key, 1 labeled item and 50 junk items per candidate',
      key: keyOf({ ...f.key, itemCoverage: 'partial' }),
      data,
      expect: { verdict: 'undetermined', fails: [] },
      complete: { key: keyOf(f.key), expect: { verdict: 'seeded', fails: ALL } },
    });
  }

  // Unknown candidate states used to drop out of both views.
  {
    const f = fiveDeals(4);
    const build = (state: string) =>
      f.exportOf(
        f.dealItems.flatMap((items, d) => [
          { candidate: f.named(d), items },
          ...[0, 1].map(() => ({ candidate: f.named(d, { discoveryState: state as ExportCandidate['discoveryState'] }), items })),
        ]),
      );
    out.push({
      system: 'duplicates in state "archived"',
      key: keyOf(f.key),
      data: build('archived'),
      refused: { error: /candidates\.jsonl line \d+: discoveryState must be one of proposed, confirmed, rejected, merged_into/, asKnown: build('proposed') },
      expect: { verdict: 'seeded', fails: ['discoveryPrecision', 'itemPrecision', 'fragmentation'] },
    });
  }
  {
    const f = fiveDeals(4);
    const build = (state: string) =>
      f.exportOf([
        ...f.dealItems.map((items, d) => ({ candidate: f.named(d), items })),
        ...f.negativeItems.map((item) => ({ candidate: weekly(f, { discoveryState: state as ExportCandidate['discoveryState'] }), items: [item] })),
      ]);
    out.push({
      system: 'junk candidates in state "Proposed"',
      key: keyOf(f.key),
      data: build('Proposed'),
      refused: { error: /candidates\.jsonl line \d+: discoveryState must be one of/, asKnown: build('proposed') },
      expect: { verdict: 'seeded', fails: ['discoveryPrecision'] },
    });
  }
  return out;
}

function failed(card: Scorecard): CheckpointMetric[] {
  return card.checkpoint.checks.filter((c) => c.met === false).map((c) => c.metric);
}

function line(system: string, card: Scorecard): string {
  const v = (metric: string) => formatRatio(card.checkpoint.checks.find((c) => c.metric === metric)!.value);
  return (
    `${system}: ${card.checkpoint.verdict}${card.checkpoint.undeterminedBecause ? ` (${card.checkpoint.undeterminedBecause})` : ''}; ` +
    `P(pre) ${v('discoveryPrecision')}, R ${v('discoveryRecall')}, item P(pre) ${v('itemPrecision')}, ` +
    `item R ${v('itemRecall')}, frag(pre) ${v('fragmentation')}, merge(pre) ${v('merge')}; failed: ${failed(card).join(', ') || 'none'}`
  );
}

function assertExpected(card: Scorecard, expect: Expect): void {
  assert.equal(card.checkpoint.verdict, expect.verdict);
  assert.deepEqual(failed(card), expect.fails);
}

describe('the reviews\' degenerate tables', () => {
  for (const row of rows()) {
    it(row.system, (t) => {
      if (row.refused) {
        // Refused by the export reader, and by score() for a caller that skips it.
        const dir = writeExport(join(tempDir(), 'export'), row.data);
        assert.throws(() => readExport(dir), (e: unknown) => e instanceof ExportError && row.refused!.error.test(e.message));
        assert.throws(() => score(row.key, row.data), (e: unknown) => e instanceof ExportError && row.refused!.error.test(e.message));
        t.diagnostic(`${row.system}: refused by readExport and score()`);
        const card = score(row.key, row.refused.asKnown);
        t.diagnostic(line(`${row.system}, as a known state`, card));
        assertExpected(card, row.expect);
        return;
      }
      const card = score(row.key, row.data);
      t.diagnostic(line(row.system, card));
      assertExpected(card, row.expect);
      if (row.system === 'perfect') assert.deepEqual(card.discovery.precision, { num: 5, den: 5, value: 1 });
      if (row.complete) {
        assert.equal(card.checkpoint.undeterminedBecause, 'partial_key');
        assert.ok(card.checkpoint.checks.every((c) => c.met === true), 'every check passes on the partial key');
        const complete = score(row.complete.key, row.data);
        t.diagnostic(line(`${row.system}, against the complete key`, complete));
        assertExpected(complete, row.complete.expect);
      }
    });
  }
});
