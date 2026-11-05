import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { parseAnswerKey, type AnswerKey } from '../src/answerKey.ts';
import { byCodePoint } from '../src/compare.ts';
import { renderHtml, renderMarkdown } from '../src/report.ts';
import { MISS_BUCKETS, REDACTED, checkpoint, ratio, score, type CheckpointMetric, type Ratio } from '../src/score.ts';
import { candidate, document, fiveDeals, ledger, link, message, scenario, shuffled } from './synthetic.ts';

function keyOf(raw: unknown): AnswerKey {
  const result = parseAnswerKey(raw);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.key;
}

describe('score: the synthetic scenario', () => {
  const { data, key, ids } = scenario();
  const card = score(keyOf(key), data);

  it('pairs candidates and deals one-to-one, post-rejection', () => {
    // Falcon, Cobra and one Osprey fragment are paired; the second Osprey
    // fragment and "Management" are false positives.
    assert.equal(card.discovery.scoredCandidates, 5);
    assert.deepEqual(card.discovery.excluded, { rejected: 1, mergedInto: 0 });
    assert.deepEqual(card.discovery.precision, { num: 3, den: 5, value: 0.6 });
    assert.deepEqual(card.discovery.recall, { num: 3, den: 4, value: 0.75 });
    assert.deepEqual(card.discovery.fragmentation, { num: 1, den: 3, value: 1 / 3 });
    assert.deepEqual(card.discovery.merge, { num: 0, den: 4, value: 0 });
  });

  it('computes the same metrics pre-rejection, over every candidate created', () => {
    assert.equal(card.discovery.createdCandidates, 6);
    assert.deepEqual(card.discovery.preRejection.precision, { num: 3, den: 6, value: 0.5 });
    assert.deepEqual(card.discovery.preRejection.fragmentation, { num: 1, den: 3, value: 1 / 3 });
  });

  it('names each deal\'s paired candidate and every candidate that qualifies', () => {
    const byId = Object.fromEntries(card.discovery.deals.map((d) => [d.id, d]));
    assert.equal(byId.T01.pairedCandidateId, ids.falcon.id);
    assert.equal(byId.T03.pairedCandidateId, null);
    assert.equal(byId.T04.pairedCandidateId, ids.ospreyA.id);
    assert.deepEqual(byId.T04.qualifyingIds, [ids.ospreyA.id, ids.ospreyB.id]);
    assert.deepEqual([byId.T01.goldItems, byId.T01.recoveredItems], [10, 2]);
  });

  it('counts item pairs: a wrong deal, an unpaired fragment, a negative and an unlisted item are all wrong', () => {
    assert.equal(card.items.predictedPairs, 8);
    assert.deepEqual(card.items.precision, { num: 4, den: 8, value: 0.5 });
    // Pre-rejection adds the rejected Falcon link on <c1>.
    assert.deepEqual(card.items.precisionPreRejection, { num: 4, den: 9, value: 4 / 9 });
    assert.equal(card.items.routedNotInKey, 1);
    assert.equal(card.items.goldPairs, 14);
    assert.deepEqual(card.items.recall, { num: 4, den: 14, value: 4 / 14 });
  });

  it('puts every miss in exactly one bucket', () => {
    assert.deepEqual(card.items.misses, {
      routed_elsewhere: 1,
      routed_fragment: 1,
      routed_unlinked: 1,
      attachment_only: 1,
      unrouted_late_thread: 1,
      unrouted_other: 2,
      skipped: 1,
      document_unresolved: 1,
      never_read: 1,
    });
    const total = MISS_BUCKETS.reduce((sum, b) => sum + card.items.misses[b], 0);
    assert.equal(total + card.items.recall.num, card.items.goldPairs);
  });

  it('places each item where the outline says', () => {
    const outcome = (ref: string) => card.items.outcomes.find((o) => o.itemRef === ref)?.outcome;
    assert.equal(outcome('<f1@bank.example>'), 'recovered');
    assert.equal(outcome('f2@bank.example'), 'routed_elsewhere');
    assert.equal(outcome('<f3@bank.example>'), 'unrouted_late_thread');
    assert.equal(outcome('<F4@bank.example>'), 'unrouted_other');
    assert.equal(outcome('<f5@bank.example>'), 'attachment_only');
    assert.equal(outcome('<f6@bank.example>'), 'routed_unlinked');
    assert.equal(outcome('Falcon/CIM.pdf'), 'recovered');
    assert.equal(outcome('Falcon/scan.pdf'), 'skipped');
    assert.equal(outcome('Falcon/notes.docx'), 'document_unresolved');
    assert.equal(outcome('Falcon/memo.docx'), 'unrouted_other');
    assert.equal(outcome('<h1@bank.example>'), 'never_read');
    assert.equal(outcome('<o2@bank.example>'), 'routed_fragment');
  });

  it('reports recall on readable items, skip reasons and attachment-only items', () => {
    assert.deepEqual(card.items.readableRecall, { num: 4, den: 12, value: 4 / 12 });
    assert.deepEqual(card.items.skippedByReason, { image_only: 1 });
    assert.deepEqual(card.ingestion.skippedByReason, { image_only: 1, unsupported_type: 1 });
    assert.deepEqual(card.items.attachmentOnly, { inKey: 1, recovered: 0 });
  });

  it('reports the read, unrouted items once each, with the two ceilings they bound', () => {
    const trueDealItems = new Set(card.items.outcomes.map((o) => `${o.kind}:${o.itemRef}`)).size;
    assert.deepEqual(card.items.readUnrouted, {
      items: 4,
      share: { num: 4, den: trueDealItems, value: 4 / trueDealItems },
      byBucket: { attachment_only: 1, unrouted_late_thread: 1, unrouted_other: 2 },
      pairs: 4,
      routingFixablePairs: 3,
      attachmentPairs: 1,
      routingCeiling: { num: 7, den: 14, value: 7 / 14 },
      attachmentCeiling: { num: 8, den: 14, value: 8 / 14 },
    });
  });

  it('takes the week-2 checkpoint against the provisional targets', () => {
    const met = Object.fromEntries(card.checkpoint.checks.map((c) => [c.metric, c.met]));
    assert.deepEqual(met, { discoveryPrecision: false, discoveryRecall: true, itemPrecision: false, itemRecall: false, fragmentation: false, merge: true });
    assert.equal(card.checkpoint.verdict, 'seeded');
    assert.equal(card.checkpoint.provisional, true);
    assert.deepEqual(
      card.checkpoint.checks.map((c) => [c.metric, c.basis, c.bound, c.target]),
      [
        ['discoveryPrecision', 'pre-rejection', 'min', 0.8],
        ['discoveryRecall', 'post-rejection', 'min', 0.7],
        ['itemPrecision', 'pre-rejection', 'min', 0.8],
        ['itemRecall', 'post-rejection', 'min', 0.5],
        ['fragmentation', 'pre-rejection', 'max', 0.25],
        ['merge', 'pre-rejection', 'max', 0.2],
      ],
    );
  });

  it('summarizes ingestion', () => {
    assert.deepEqual(card.ingestion.sources, { mailbox: 1, sharepoint_site: 1 });
    assert.deepEqual(card.ingestion.ledgerByDecision, { routed: 1, skipped: 2, unrouted: 4 });
    assert.deepEqual(card.ingestion.storedItems, { document: 1, message: 8 });
    assert.deepEqual(card.ingestion.candidatesByState, { proposed: 5, rejected: 1 });
    assert.deepEqual(card.ingestion.linksByMethodTier, [{ method: 'codename', tier: 'firm', active: 8, rejected: 1 }]);
  });

  it('ranks the five worst errors by weight, each with evidence ids in code-point order', () => {
    assert.deepEqual(
      card.worstErrors.map((e) => [e.kind, e.weight]),
      [
        ['false_candidate', 2],
        ['item_misses', 2],
        ['missed_deal', 1],
        ['fragmented_deal', 1],
        ['item_misses', 1],
      ],
    );
    assert.deepEqual(card.worstErrors[0].evidence, ['<lunch@bank.example>', '<stray@bank.example>']);
    assert.equal(card.worstErrors[1].title, 'T01 Project Falcon: 2 items lost as "Read, unrouted: other"');
    assert.deepEqual(card.worstErrors[1].evidence, ['<F4@bank.example>', 'Falcon/memo.docx']);
    assert.deepEqual(card.worstErrors[2].evidence, ['<h1@bank.example> (never_read)']);
    for (const e of card.worstErrors) assert.deepEqual(e.evidence, [...e.evidence].sort(byCodePoint));
  });
});

describe('score: coverage and merges', () => {
  it('leaves unlisted routed items out of precision when coverage is partial', () => {
    const { data, key } = scenario();
    const card = score(keyOf({ ...key, itemCoverage: 'partial' }), data);
    assert.deepEqual(card.items.precision, { num: 4, den: 7, value: 4 / 7 });
    assert.equal(card.items.routedNotInKey, 1);
  });

  it('flags a candidate whose evidence holds two deals as a merge', () => {
    const { data, key, ids } = scenario();
    const extra = [message('<c2@bank.example>', 'conv-c2'), message('<c3@bank.example>', 'conv-c3')];
    const merged = {
      ...data,
      items: [...data.items, ...extra],
      links: [...data.links, link(ids.falcon.id, extra[0].id), link(ids.falcon.id, extra[1].id)],
    };
    const mergedKey = {
      ...key,
      items: [
        ...key.items,
        { kind: 'message', internetMessageId: '<c2@bank.example>', dealIds: ['T02'] },
        { kind: 'message', internetMessageId: '<c3@bank.example>', dealIds: ['T02'] },
      ],
    };
    const card = score(keyOf(mergedKey), merged);
    const falcon = card.discovery.candidates.find((c) => c.id === ids.falcon.id)!;
    assert.equal(falcon.merge, 'evidence');
    assert.deepEqual(falcon.evidenceDeals, { T01: 2, T02: 2 });
    assert.deepEqual(card.discovery.merge, { num: 1, den: 4, value: 0.25 });
    assert.ok(card.worstErrors.some((e) => e.kind === 'merged_candidate' && e.weight === 2));
  });

  it('flags a candidate that qualifies for two deals as a merge', () => {
    const { data, key } = scenario();
    const twoParties = candidate({
      proposedName: 'Kestrel',
      parties: [
        { name: 'Heliotrope', domain: 'heliotrope.example' },
        { name: 'Cobalt Systems', domain: 'cobalt-systems.example' },
      ],
      firstSeenAt: null,
      lastSeenAt: null,
    });
    const f7 = message('<f7@bank.example>', 'conv-f7');
    const c4 = message('<c4@bank.example>', 'conv-c4');
    const card = score(
      keyOf({
        ...key,
        items: [
          ...key.items,
          { kind: 'message', internetMessageId: '<f7@bank.example>', dealIds: ['T01'] },
          { kind: 'message', internetMessageId: '<c4@bank.example>', dealIds: ['T02'] },
        ],
      }),
      {
        ...data,
        items: [...data.items, f7, c4],
        candidates: [...data.candidates, twoParties],
        links: [...data.links, link(twoParties.id, f7.id), link(twoParties.id, c4.id)],
      },
    );
    const row = card.discovery.candidates.find((c) => c.id === twoParties.id)!;
    assert.equal(row.merge, 'qualifying');
    assert.deepEqual(row.qualifying.map((q) => q.dealId), ['T01', 'T02']);
  });

  it('returns n/a ratios, not NaN, on an empty export', () => {
    const { data, key } = scenario();
    const empty = { ...data, candidates: [], links: [], items: [], ledger: [], provenance: [] };
    const card = score(keyOf(key), empty);
    assert.deepEqual(card.discovery.precision, { num: 0, den: 0, value: null });
    assert.deepEqual(card.items.precision, { num: 0, den: 0, value: null });
    assert.equal(card.items.misses.never_read + card.items.misses.document_unresolved, card.items.goldPairs);
  });
});

describe('ceilings and denominators (review item 6)', () => {
  it('leaves a recovered attachment-only pair out of both sides of readable recall', () => {
    // The degenerate case: readable recall used to drop only the missed
    // attachment-only pairs from its denominator but keep the recovered ones
    // in its numerator, so the class it claims to leave out still raised it
    // (8/9 here, where the readable pairs alone give 7/8).
    const f = fiveDeals(2, 0);
    const k = f.key as { items: Array<Record<string, unknown>> };
    // Both Falcon items are attachment-only; one is recovered and one is not.
    const key = keyOf({ ...f.key, items: k.items.map((i, n) => (n < 2 ? { ...i, attachmentOnly: true } : i)) });
    const data = f.exportOf(f.dealItems.map((items, d) => ({ candidate: f.named(d), items: d < 2 ? [items[0]] : items })));
    const card = score(key, data);
    assert.deepEqual(card.items.attachmentOnly, { inKey: 2, recovered: 1 });
    assert.deepEqual(card.items.recall, { num: 8, den: 10, value: 0.8 });
    assert.deepEqual(card.items.readableRecall, { num: 7, den: 8, value: 7 / 8 });
  });

  it('files a skipped ledger row as read, for a message and for a document in any source', () => {
    const { data, key } = scenario();
    const skippedMail = ledger({ providerItemId: 'p-h1', decision: 'skipped', skipReason: 'too_large', internetMessageId: '<h1@bank.example>' });
    // A document row whose source the export does not list as a site.
    const skippedDoc = ledger({ sourceId: 'unlisted', providerItemId: 'D-LOST', decision: 'skipped', skipReason: 'extraction_failed' });
    const card = score(
      keyOf({ ...key, items: [...key.items, { kind: 'document', path: 'Falcon/lost.pdf', driveItemId: 'D-LOST', dealIds: ['T01'] }] }),
      { ...data, ledger: [...data.ledger, skippedMail, skippedDoc] },
    );
    const outcome = (ref: string) => card.items.outcomes.find((o) => o.itemRef === ref);
    assert.deepEqual([outcome('<h1@bank.example>')?.outcome, outcome('<h1@bank.example>')?.skipReason], ['skipped', 'too_large']);
    assert.deepEqual([outcome('Falcon/lost.pdf')?.outcome, outcome('Falcon/lost.pdf')?.skipReason], ['skipped', 'extraction_failed']);
    assert.equal(card.items.misses.never_read, 0);
  });

  it('splits the recall ceiling into routing fixes and attachment reading', () => {
    const card = score(keyOf(scenario().key), scenario().data);
    const r = card.items.readUnrouted;
    assert.equal(r.routingFixablePairs, card.items.misses.unrouted_late_thread + card.items.misses.unrouted_other);
    assert.equal(r.attachmentPairs, card.items.misses.attachment_only);
    assert.ok(r.routingCeiling.num < r.attachmentCeiling.num);
  });
});

describe('deterministic output (review item 10)', () => {
  it('renders the same scorecard for any order of the inputs', () => {
    // The degenerate case: 30 shuffles of the export rendered 30 different scorecards.
    const { data, key } = scenario();
    const expected = renderMarkdown(score(keyOf(key), data));
    for (let seed = 1; seed <= 30; seed += 1) {
      const shuffledData = {
        ...data,
        items: shuffled(data.items, seed),
        ledger: shuffled(data.ledger, seed + 100),
        candidates: shuffled(data.candidates, seed + 200),
        links: shuffled(data.links, seed + 300),
        sources: shuffled(data.sources, seed + 400),
      };
      const shuffledKey = { ...key, deals: shuffled(key.deals, seed + 500), items: shuffled(key.items, seed + 600) };
      assert.equal(renderMarkdown(score(keyOf(shuffledKey), shuffledData)), expected, `seed ${seed}`);
    }
  });

  it('resolves colliding document paths the same way in any order', () => {
    const { data, key } = scenario();
    const twin = document('/Falcon/CIM.pdf', 'D-CIM-TWIN');
    const withTwin = { ...data, items: [...data.items, twin] };
    const a = renderMarkdown(score(keyOf(key), withTwin));
    const b = renderMarkdown(score(keyOf(key), { ...withTwin, items: [...withTwin.items].reverse() }));
    assert.equal(a, b);
  });

  it('orders by code point, not by the host locale', () => {
    assert.deepEqual(['b', 'a', 'B', 'é', 'Z'].sort(byCodePoint), ['B', 'Z', 'a', 'b', 'é']);
  });
});

describe('redaction (review item 11, second review)', () => {
  it('withholds deal and candidate names and digests every item reference', () => {
    const { data, key } = scenario();
    const card = score(keyOf(key), data, { redact: true });
    const md = renderMarkdown(card);
    for (const secret of ['Falcon', 'Cobra', 'Heron', 'Osprey', 'Management', '@bank.example', 'CIM.pdf', 'memo.docx']) {
      assert.ok(!md.includes(secret), secret);
    }
    assert.match(md, /Redacted: deal and candidate names, link methods and skip reasons are withheld/);
    assert.ok(card.items.outcomes.every((o) => /^(msg|doc):[0-9a-f]{12}$/.test(o.itemRef)));
    // The same item digests the same from the key and from the export.
    const lunchRef = card.worstErrors.find((e) => e.kind === 'false_candidate')!.evidence;
    const plain = score(keyOf(key), data).worstErrors.find((e) => e.kind === 'false_candidate')!.evidence;
    assert.equal(lunchRef.length, plain.length);
    assert.ok(lunchRef.every((r) => r.startsWith('msg:')));
    // The metrics do not change.
    assert.deepEqual(card.checkpoint, score(keyOf(key), data).checkpoint);
  });

  it('replaces deal ids with digests, since an id can carry the name', () => {
    // The degenerate case: deal ids such as falcon-heliotrope were printed as they are.
    const { data, key } = scenario();
    const named = JSON.parse(JSON.stringify(key).replaceAll('"T01"', '"falcon-heliotrope"'));
    const card = score(keyOf(named), data, { redact: true });
    const md = renderMarkdown(card);
    const html = renderHtml(card);
    for (const page of [md, html]) {
      assert.ok(!/falcon|heliotrope/i.test(page));
      for (const id of ['T01', 'T02', 'T03', 'T04']) assert.ok(!page.includes(id), id);
    }
    assert.ok(card.discovery.deals.every((d) => /^deal:[0-9a-f]{12}$/.test(d.id)));
    // Every place a deal id reaches the card uses the same digest.
    const shown = new Set(card.discovery.deals.map((d) => d.id));
    assert.ok(card.items.outcomes.every((o) => shown.has(o.dealId)));
    for (const c of card.discovery.candidates) {
      for (const id of [c.pairedDealId, c.pairedDealIdPreRejection, ...c.qualifying.map((q) => q.dealId), ...Object.keys(c.evidenceDeals)]) {
        if (id !== null) assert.ok(shown.has(id), id);
      }
    }
    assert.deepEqual(card.checkpoint, score(keyOf(named), data).checkpoint);
  });

  it('salts the digests per run, so a guessed reference cannot be confirmed', () => {
    // The degenerate case: unsalted sha256 of a normalized path, which anyone can recompute.
    const { data, key } = scenario();
    const k = keyOf(key);
    const a = score(k, data, { redact: true });
    const b = score(k, data, { redact: true });
    const refs = (c: typeof a) => c.items.outcomes.map((o) => o.itemRef);
    assert.notDeepEqual(refs(a), refs(b));
    assert.notDeepEqual(a.discovery.deals.map((d) => d.id), b.discovery.deals.map((d) => d.id));
    const plainDigest = createHash('sha256').update('falcon/cim.pdf').digest('hex').slice(0, 12);
    assert.ok(!refs(a).includes(`doc:${plainDigest}`));
    assert.ok(!renderMarkdown(a).includes(plainDigest));
  });

  it('withholds link methods and skip reasons', () => {
    // The degenerate case: free-text method and skipReason were printed.
    const { data, key } = scenario();
    const card = score(keyOf(key), data, { redact: true });
    assert.ok(card.ingestion.linksByMethodTier.every((l) => l.method === REDACTED));
    assert.deepEqual(Object.keys(card.ingestion.skippedByReason), [REDACTED]);
    assert.deepEqual(Object.keys(card.items.skippedByReason), [REDACTED]);
    assert.ok(card.items.outcomes.every((o) => o.skipReason === null || o.skipReason === REDACTED));
    const md = renderMarkdown(card);
    // Markdown escapes the underscore, so look for both spellings.
    for (const secret of ['image_only', 'image\\_only', 'unsupported\\_type', '| codename |']) assert.ok(!md.includes(secret), secret);
    // Unredacted, they show.
    const plain = renderMarkdown(score(keyOf(key), data));
    assert.ok(plain.includes('image\\_only') && plain.includes('| codename |'));
  });
});

describe('checkpoint', () => {
  const r = ratio;
  const good: Record<CheckpointMetric, Ratio> = {
    discoveryPrecision: r(8, 10),
    discoveryRecall: r(7, 10),
    itemPrecision: r(8, 10),
    itemRecall: r(5, 10),
    fragmentation: r(1, 4),
    merge: r(1, 5),
  };
  const cp = (over: Partial<Record<CheckpointMetric, Ratio>>) => checkpoint({ ...good, ...over }, 'complete');

  it('is discovery-led only when every target is met, and seeded when any is missed', () => {
    assert.equal(cp({}).verdict, 'discovery_led');
    assert.equal(cp({ discoveryPrecision: r(7, 10) }).verdict, 'seeded');
    assert.equal(cp({ discoveryRecall: r(6, 10) }).verdict, 'seeded');
    assert.equal(cp({ itemPrecision: r(7, 10) }).verdict, 'seeded');
  });

  it('fails on item recall below 50% (second review)', () => {
    // The degenerate case: one correct link per deal, item recall 1%, passed every other target.
    assert.equal(cp({ itemRecall: r(5, 500) }).verdict, 'seeded');
    assert.equal(cp({ itemRecall: r(49, 100) }).verdict, 'seeded');
    assert.equal(cp({ itemRecall: r(50, 100) }).verdict, 'discovery_led');
    assert.equal(cp({ itemRecall: r(0, 0) }).checks.find((k) => k.metric === 'itemRecall')!.met, false);
  });

  it('gives no verdict on a partial key, whatever the values (second review)', () => {
    const partial = checkpoint(good, 'partial');
    assert.equal(partial.verdict, 'undetermined');
    assert.equal(partial.undeterminedBecause, 'partial_key');
    assert.ok(partial.checks.every((k) => k.met === true));
    assert.equal(checkpoint({ ...good, merge: r(3, 4) }, 'partial').verdict, 'undetermined');
    assert.equal(cp({}).undeterminedBecause, null);
  });

  it('fails on fragmentation above 25% or a merge rate above 20% (review item 3)', () => {
    assert.equal(cp({ fragmentation: r(2, 7) }).verdict, 'seeded');
    assert.equal(cp({ merge: r(1, 4) }).verdict, 'seeded');
    assert.equal(cp({ fragmentation: r(1, 4), merge: r(1, 5) }).verdict, 'discovery_led');
  });

  it('treats an n/a (0/0) item precision, fragmentation or merge rate as a fail (review item 13)', () => {
    for (const metric of ['itemPrecision', 'itemRecall', 'fragmentation', 'merge'] as const) {
      const c = cp({ [metric]: r(0, 0) });
      assert.equal(c.checks.find((k) => k.metric === metric)!.met, false, metric);
      assert.equal(c.verdict, 'seeded', metric);
    }
  });

  it('is undetermined only when discovery has no data and nothing else failed', () => {
    assert.equal(cp({ discoveryPrecision: r(0, 0) }).verdict, 'undetermined');
    assert.equal(cp({ discoveryPrecision: r(0, 0) }).undeterminedBecause, 'no_discovery_data');
    assert.equal(cp({ discoveryPrecision: r(0, 0), merge: r(3, 4) }).verdict, 'seeded');
  });
});

describe('corrections cannot raise the verdict (review item 12)', () => {
  it('auto-rejecting the unpaired candidates raises post-rejection precision but not the verdict', () => {
    const { data, key } = scenario();
    const k = keyOf(key);
    const before = score(k, data);
    const unpaired = new Set(before.discovery.candidates.filter((c) => c.scored && c.pairedDealId === null).map((c) => c.id));
    assert.ok(unpaired.size > 0);
    const rejected = {
      ...data,
      candidates: data.candidates.map((c) => (unpaired.has(c.id) ? { ...c, discoveryState: 'rejected' as const } : c)),
    };
    const after = score(k, rejected);
    assert.ok(after.discovery.precision.value! > before.discovery.precision.value!);
    assert.deepEqual(after.checkpoint.checks.filter((c) => c.basis === 'pre-rejection'), before.checkpoint.checks.filter((c) => c.basis === 'pre-rejection'));
    assert.equal(after.checkpoint.verdict, before.checkpoint.verdict);
  });

  it('merging a fragment into its deal lowers post-rejection fragmentation but not the verdict\'s', () => {
    const { data, key, ids } = scenario();
    const k = keyOf(key);
    const before = score(k, data);
    const merged = score(k, {
      ...data,
      candidates: data.candidates.map((c) => (c.id === ids.ospreyB.id ? { ...c, discoveryState: 'merged_into' as const, mergedIntoId: ids.ospreyA.id } : c)),
    });
    assert.ok(merged.discovery.fragmentation.value! < before.discovery.fragmentation.value!);
    const frag = (c: typeof merged) => c.checkpoint.checks.find((x) => x.metric === 'fragmentation')!.value;
    assert.deepEqual(frag(merged), frag(before));
  });

  it('rejecting the wrong links raises post-rejection item precision but not the verdict', () => {
    const { data, key } = scenario();
    const k = keyOf(key);
    const before = score(k, data);
    const rejectAll = { ...data, links: data.links.map((l) => ({ ...l, state: 'rejected' as const })) };
    const after = score(k, rejectAll);
    assert.deepEqual(after.items.precision, { num: 0, den: 0, value: null });
    const item = (c: typeof after) => c.checkpoint.checks.find((x) => x.metric === 'itemPrecision')!.value;
    assert.deepEqual(item(after), item(before));
  });
});
