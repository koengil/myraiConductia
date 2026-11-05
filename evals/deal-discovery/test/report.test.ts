import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseAnswerKey, type AnswerKey } from '../src/answerKey.ts';
import { formatRatio, renderHtml, renderMarkdown } from '../src/report.ts';
import { BUCKET_LABEL, MISS_BUCKETS, score } from '../src/score.ts';
import { candidate, scenario } from './synthetic.ts';

function keyOf(raw: unknown): AnswerKey {
  const result = parseAnswerKey(raw);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.key;
}

describe('report', () => {
  const { data, key } = scenario();
  const card = score(keyOf(key), data);
  const md = renderMarkdown(card);
  const html = renderHtml(card);

  it('formats ratios with their counts, and n/a for an empty denominator', () => {
    assert.equal(formatRatio({ num: 4, den: 5, value: 0.8 }), '80.0% (4/5)');
    assert.equal(formatRatio({ num: 0, den: 0, value: null }), 'n/a (0/0)');
  });

  it('leads with the headline numbers', () => {
    assert.match(md, /^# Deal discovery scorecard\n/);
    assert.match(md, /\| Metric \| Post-rejection \| Pre-rejection \|/);
    assert.match(md, /\| Discovery precision \(one-to-one\) \| 60\.0% \(3\/5\) \| 50\.0% \(3\/6\) \|/);
    assert.match(md, /\| Discovery recall \(one-to-one\) \| 75\.0% \(3\/4\) \| /);
    assert.match(md, /\| Fragmentation rate \| 33\.3% \(1\/3\) \| 33\.3% \(1\/3\) \|/);
    assert.match(md, /\| Item precision \| 50\.0% \(4\/8\) \| 44\.4% \(4\/9\) \|/);
    assert.match(md, /\| Item recall \| 28\.6% \(4\/14\) \|  \|/);
    assert.match(md, /\| Item recall on what the pipeline reads today \| 33\.3% \(4\/12\) \|  \|/);
    assert.match(md, /Post-rejection metrics count the 5 proposed or confirmed candidates and their active links \(1 rejected and 0 merged candidates are left out\)\. Pre-rejection metrics count all 6 candidates created/);
  });

  it('shows the read, unrouted items as their own line, bounded', () => {
    assert.match(md, /\| Read, unrouted: share of true-deal items \| [\d.]+% \(4\/\d+\) \|/);
    assert.match(md, /\| Item recall if routing were fixed \(ceiling\) \| 50\.0% \(7\/14\) \|/);
    assert.match(md, /\| Item recall if routing were fixed and attachments read \(ceiling\) \| 57\.1% \(8\/14\) \|/);
    assert.match(
      md,
      /Read, unrouted: 4 of \d+ true-deal items .*1 late thread, 2 other, 1 attachment-only.*Fixing routing \(3 pairs\) would raise item recall from 28\.6% \(4\/14\) to at most 50\.0% \(7\/14\); reading mail attachments as well \(1 more\), to at most 57\.1% \(8\/14\)\./,
    );
    assert.ok(html.includes('Read, unrouted: share of true-deal items'));
  });

  it('states the checkpoint verdict, each target with its basis, and that the targets are provisional', () => {
    assert.match(
      md,
      /Week-2 checkpoint: Outside target on discovery precision, item precision, item recall, fragmentation rate: the demo is seeded\. The targets are provisional \(Guillermo, 2026-09-26; pending Storm\)\./,
    );
    assert.match(md, /\| Checkpoint target \| Value \| Met \|/);
    assert.match(md, /\| Discovery precision at least 80% \(pre-rejection\) \| 50\.0% \(3\/6\) \| no \|/);
    assert.match(md, /\| Discovery recall at least 70% \(post-rejection\) \| 75\.0% \(3\/4\) \| yes \|/);
    assert.match(md, /\| Item precision at least 80% \(pre-rejection\) \| 44\.4% \(4\/9\) \| no \|/);
    assert.match(md, /\| Item recall at least 50% \(post-rejection\) \| 28\.6% \(4\/14\) \| no \|/);
    assert.match(md, /\| Fragmentation rate at most 25% \(pre-rejection\) \| 33\.3% \(1\/3\) \| no \|/);
    assert.match(md, /\| Merge rate at most 20% \(pre-rejection\) \| 0\.0% \(0\/4\) \| yes \|/);
  });

  it('gives no verdict on a partial key, and says why (second review)', () => {
    const partial = renderMarkdown(score(keyOf({ ...key, itemCoverage: 'partial' }), data));
    assert.match(
      partial,
      /Week-2 checkpoint: The answer key is partial, so the checkpoint is undetermined: items it does not list are invisible to the evidence gate and to item precision\. Only a complete key decides it\./,
    );
    assert.match(partial, /\| Answer key coverage complete \| partial \| no \|/);
    assert.match(md, /\| Answer key coverage complete \| complete \| yes \|/);
  });

  it('names an n/a metric in the verdict', () => {
    const { data: d, key: k } = scenario();
    const none = renderMarkdown(score(keyOf(k), { ...d, links: [] }));
    assert.match(none, /item precision \(n\/a\), item recall, fragmentation rate \(n\/a\), merge rate \(n\/a\): the demo is seeded\./);
  });

  it('prints the harness commit and the tuning digest', () => {
    const card2 = score(keyOf(key), data, { provenance: { commit: 'deadbeef', dirty: true } });
    assert.match(
      renderMarkdown(card2),
      /Harness 1\.0\.0 at commit deadbeef, with uncommitted changes in evals\/deal-discovery, so this score cannot be reproduced from the commit\. Tuning [0-9a-f]{12}/,
    );
  });

  it('lists every miss bucket, in both formats', () => {
    for (const bucket of MISS_BUCKETS) {
      assert.ok(md.includes(BUCKET_LABEL[bucket].label), bucket);
      assert.ok(html.includes(BUCKET_LABEL[bucket].label), bucket);
    }
    assert.match(md, /\| Read, unrouted: late thread \| Routing \(read order\) \| 1 \| 7\.1% \|/);
    assert.match(md, /\| Evidence only in a mail attachment, not read yet \| Needs attachment reading \| 1 \| 7\.1% \|/);
  });

  it('shows the five worst errors with their evidence ids as code', () => {
    assert.match(md, /## Five worst errors/);
    assert.ok(md.includes('`<lunch@bank.example>`'));
    assert.ok(html.includes('<code>&lt;lunch@bank.example&gt;</code>'));
  });

  it('escapes names from the export in HTML and Markdown', () => {
    const hostile = candidate({ proposedName: '<script>alert(1)</script> | *x*' });
    const card2 = score(keyOf(key), { ...data, candidates: [...data.candidates, hostile] });
    const html2 = renderHtml(card2);
    assert.ok(!html2.includes('<script>'));
    assert.ok(html2.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    const md2 = renderMarkdown(card2);
    assert.ok(md2.includes('\\<script\\>alert(1)\\</script\\> \\| \\*x\\*'));
  });

  it('writes a self-contained page: no script, no external asset', () => {
    assert.match(html, /^<!doctype html>/);
    assert.ok(!/<script|<link|src=|https?:\/\//i.test(html));
  });

  it('uses no em dash in visible copy', () => {
    assert.ok(!md.includes('—'));
    assert.ok(!html.includes('—'));
  });

  it('is deterministic for the same inputs', () => {
    assert.equal(renderMarkdown(score(keyOf(key), data)), md);
  });
});
