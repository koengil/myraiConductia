// The scorecard, as Markdown and as a self-contained HTML page (no external
// assets, every value escaped). Both render one block list, so the two never
// disagree. Identifiers (Message-IDs, paths, candidate ids) render as code, so
// a Message-ID is never read as a link or a tag.

import type { CheckpointCheck, Ratio, Scorecard } from './score.ts';
import { BUCKET_LABEL, MISS_BUCKETS } from './score.ts';
import { MATCH_TUNING, MERGE_TUNING } from './tuning.ts';

type Inline = string | { code: string };
type Text = Inline | Inline[];

type Block =
  | { type: 'heading'; level: 1 | 2; text: string }
  | { type: 'paragraph'; text: Text }
  | { type: 'table'; head: string[]; rows: Text[][]; numeric?: number[] }
  | { type: 'list'; items: Text[] };

export function formatRatio(r: Ratio): string {
  if (r.value === null) return `n/a (${r.num}/${r.den})`;
  return `${(r.value * 100).toFixed(1)}% (${r.num}/${r.den})`;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function code(value: string): Inline {
  return { code: value };
}

function entries(record: Record<string, number>): string {
  const list = Object.entries(record);
  return list.length === 0 ? 'none' : list.map(([k, v]) => `${k} ${v}`).join(', ');
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function checkText(c: CheckpointCheck): string {
  return `${c.label} ${c.bound === 'min' ? 'at least' : 'at most'} ${percent(c.target)} (${c.basis})`;
}

function missedText(c: CheckpointCheck): string {
  return c.value.value === null ? `${c.label.toLowerCase()} (n/a)` : c.label.toLowerCase();
}

/** The week-2 decision, with the targets it was taken against and their status. */
export function checkpointLine(card: Scorecard): string {
  const c = card.checkpoint;
  const missed = c.checks.filter((k) => k.met === false).map(missedText);
  const verdict =
    c.verdict === 'discovery_led'
      ? 'Every target is met: the demo can be discovery-led.'
      : c.verdict === 'seeded'
        ? `Outside target on ${missed.join(', ')}: the demo is seeded.`
        : c.undeterminedBecause === 'partial_key'
          ? 'The answer key is partial, so the checkpoint is undetermined: items it does not list are invisible to the evidence gate and to item precision. Only a complete key decides it.'
          : 'No candidates or no deals to score: the checkpoint is undetermined.';
  const status = c.provisional ? ` The targets are provisional (${c.setBy}).` : '';
  return `Week-2 checkpoint: ${verdict}${status}`;
}

/** The read, unrouted items, with the recall they could still hide. */
export function readUnroutedLine(card: Scorecard): string {
  const r = card.items.readUnrouted;
  const b = r.byBucket;
  return (
    `Read, unrouted: ${r.items} of ${r.share.den} true-deal items were read and ledgered unrouted ` +
    `(${b.unrouted_late_thread} late thread, ${b.unrouted_other} other, ${b.attachment_only} attachment-only), ` +
    `${r.pairs} (item, deal) pairs. Fixing routing (${r.routingFixablePairs} pairs) would raise item recall from ` +
    `${formatRatio(card.items.recall)} to at most ${formatRatio(r.routingCeiling)}; reading mail attachments as well ` +
    `(${r.attachmentPairs} more), to at most ${formatRatio(r.attachmentCeiling)}.`
  );
}

/** Where the numbers came from: the harness commit and the tuning digest, so a score can be reproduced. */
export function provenanceLine(card: Scorecard): string {
  const m = card.meta;
  const tuning = `Tuning ${m.tuningDigest} (frozen, src/tuning.ts).`;
  if (m.harnessCommit === null) {
    return `Warning: harness ${m.harnessVersion} was run without provenance, so this score cannot be tied to a commit. Score through npm run score. ${tuning}`;
  }
  const dirty = m.harnessDirty
    ? ', with uncommitted changes in evals/deal-discovery, so this score cannot be reproduced from the commit'
    : '';
  return `Harness ${m.harnessVersion} at commit ${m.harnessCommit}${dirty}. ${tuning}`;
}

/** The scorecard as blocks, in reading order. */
export function scorecardBlocks(card: Scorecard): Block[] {
  const { meta, discovery, items, ingestion } = card;
  const blocks: Block[] = [];

  blocks.push({ type: 'heading', level: 1, text: 'Deal discovery scorecard' });
  blocks.push({
    type: 'paragraph',
    text: [
      'Tenant ',
      code(meta.tenantId),
      `, exported ${meta.exportedAt}. Answer key: ${meta.keyDeals} deals, ${meta.keyItems} items, coverage ${meta.itemCoverage}. Formats `,
      code(meta.exportFormat),
      ' and ',
      code(meta.keyFormat),
      '.',
    ],
  });
  blocks.push({ type: 'paragraph', text: provenanceLine(card) });
  if (meta.redacted) {
    blocks.push({
      type: 'paragraph',
      text: 'Redacted: deal and candidate names, link methods and skip reasons are withheld. Each deal id, Message-ID or document path is shown as a keyed digest (deal:, msg: or doc: and 12 hex digits). The key was drawn at random for this scorecard and never printed, so digests line up within this scorecard only.',
    });
  }
  blocks.push({ type: 'paragraph', text: checkpointLine(card) });
  blocks.push({
    type: 'table',
    head: ['Checkpoint target', 'Value', 'Met'],
    numeric: [1],
    rows: [
      ...card.checkpoint.checks.map((c) => [
        checkText(c),
        formatRatio(c.value),
        c.met === null ? 'no data' : c.met ? 'yes' : 'no',
      ]),
      ['Answer key coverage complete', card.checkpoint.coverage, card.checkpoint.coverage === 'complete' ? 'yes' : 'no'],
    ],
  });

  blocks.push({ type: 'heading', level: 2, text: 'Headline' });
  blocks.push({
    type: 'table',
    head: ['Metric', 'Post-rejection', 'Pre-rejection'],
    numeric: [1, 2],
    rows: [
      ['Discovery precision (one-to-one)', formatRatio(discovery.precision), formatRatio(discovery.preRejection.precision)],
      ['Discovery recall (one-to-one)', formatRatio(discovery.recall), formatRatio(discovery.preRejection.recall)],
      ['Fragmentation rate', formatRatio(discovery.fragmentation), formatRatio(discovery.preRejection.fragmentation)],
      ['Merge rate', formatRatio(discovery.merge), formatRatio(discovery.preRejection.merge)],
      ['Item precision', formatRatio(items.precision), formatRatio(items.precisionPreRejection)],
      ['Item recall', formatRatio(items.recall), ''],
      ['Item recall on what the pipeline reads today', formatRatio(items.readableRecall), ''],
      ['Read, unrouted: share of true-deal items', formatRatio(items.readUnrouted.share), ''],
      ['Item recall if routing were fixed (ceiling)', formatRatio(items.readUnrouted.routingCeiling), ''],
      ['Item recall if routing were fixed and attachments read (ceiling)', formatRatio(items.readUnrouted.attachmentCeiling), ''],
    ],
  });
  blocks.push({ type: 'paragraph', text: readUnroutedLine(card) });
  blocks.push({
    type: 'paragraph',
    text:
      `Post-rejection metrics count the ${discovery.scoredCandidates} proposed or confirmed candidates and their active links ` +
      `(${discovery.excluded.rejected} rejected and ${discovery.excluded.mergedInto} merged candidates are left out). ` +
      `Pre-rejection metrics count all ${discovery.createdCandidates} candidates created and every one of their links. ` +
      `The checkpoint takes everything a rejection or a merge could improve pre-rejection, so no correction can move the verdict; discovery and item recall are post-rejection. ` +
      `Item metrics count (item, deal) pairs: ${items.predictedPairs} predicted post-rejection, ${items.goldPairs} in the key. ` +
      `Recall on what the pipeline reads today leaves attachment-only items and skipped items out of both sides.`,
  });

  blocks.push({ type: 'heading', level: 2, text: 'Where item recall was lost' });
  blocks.push({
    type: 'table',
    head: ['Outcome', 'Stage', 'Pairs', 'Share of key'],
    numeric: [2, 3],
    rows: [
      ['Recovered', 'Found', String(items.recall.num), share(items.recall.num, items.goldPairs)],
      ...MISS_BUCKETS.map((bucket) => [
        BUCKET_LABEL[bucket].label,
        BUCKET_LABEL[bucket].stage,
        String(items.misses[bucket]),
        share(items.misses[bucket], items.goldPairs),
      ]),
    ],
  });
  blocks.push({
    type: 'list',
    items: [
      `Skipped items in the key, by reason: ${entries(items.skippedByReason)}.`,
      `Attachment-only items in the key: ${items.attachmentOnly.inKey}, of which ${items.attachmentOnly.recovered} were recovered through the message itself.`,
      `Routed items the key does not list: ${items.routedNotInKey} (${meta.itemCoverage === 'complete' ? 'counted as wrong, since coverage is complete' : 'left out of precision, since coverage is partial'}).`,
    ],
  });

  blocks.push({ type: 'heading', level: 2, text: 'Deals' });
  blocks.push({
    type: 'table',
    head: ['Deal', 'Name', 'Paired candidate', 'Also qualifies', 'Key items', 'Recovered'],
    numeric: [4, 5],
    rows: discovery.deals.map((d) => {
      const others = d.qualifyingIds.filter((id) => id !== d.pairedCandidateId);
      return [
        code(d.id),
        d.name,
        d.pairedCandidateId ? code(shortId(d.pairedCandidateId)) : 'none',
        others.length ? others.flatMap((id, i) => (i === 0 ? [code(shortId(id))] : [', ', code(shortId(id))])) : 'none',
        String(d.goldItems),
        String(d.recoveredItems),
      ];
    }),
  });

  blocks.push({ type: 'heading', level: 2, text: 'Candidates' });
  blocks.push({
    type: 'table',
    head: ['Candidate', 'Name', 'State', 'Paired with', 'Basis', 'Evidence', 'Correct', 'Wrong', 'Unlabeled'],
    numeric: [5, 6, 7, 8],
    rows: discovery.candidates.map((c) => {
      const best = c.qualifying.find((q) => q.dealId === c.pairedDealId) ?? c.qualifying[0];
      const basis = best
        ? [
            best.codename ? 'name' : null,
            best.partyOverlap > 0 ? `parties ${Math.round(best.partyOverlap * 100)}%` : null,
            `time ${best.time}`,
            `evidence ${Math.round(best.evidenceShare * 100)}%`,
            `score ${best.score}`,
          ]
            .filter(Boolean)
            .join(', ')
        : 'qualifies for no deal';
      const others = c.qualifying.map((q) => q.dealId).filter((id) => id !== c.pairedDealId);
      const matchText: Inline[] = c.pairedDealId ? [code(c.pairedDealId)] : ['none'];
      if (others.length) matchText.push(` (${c.pairedDealId ? 'also qualifies' : 'qualifies'}: ${others.join(', ')})`);
      if (c.merge) matchText.push(`, merge by ${c.merge === 'qualifying' ? 'qualifying twice' : 'evidence'}`);
      if (!c.scored) matchText.push(', not scored post-rejection');
      return [
        code(shortId(c.id)),
        c.name,
        c.state,
        matchText,
        basis,
        String(c.evidenceItems),
        String(c.labeled.correct),
        String(c.labeled.wrong),
        String(c.labeled.unlabeled),
      ];
    }),
  });

  blocks.push({ type: 'heading', level: 2, text: 'Five worst errors' });
  if (card.worstErrors.length === 0) {
    blocks.push({ type: 'paragraph', text: 'No errors against this key.' });
  } else {
    blocks.push({
      type: 'table',
      head: ['#', 'Error', 'Weight', 'Evidence'],
      numeric: [2],
      rows: card.worstErrors.map((e, i) => [
        String(i + 1),
        e.title,
        String(e.weight),
        e.evidence.length ? e.evidence.flatMap((ref, j) => (j === 0 ? [code(ref)] : [', ', code(ref)])) : 'none',
      ]),
    });
  }

  blocks.push({ type: 'heading', level: 2, text: 'Ingestion' });
  blocks.push({
    type: 'list',
    items: [
      `Sources: ${entries(ingestion.sources)}; ${ingestion.sourcesWithOwner} with an owner, ${ingestion.sourcesBackfilled} with a completed backfill.`,
      `Ledger rows (one per item per source): ${entries(ingestion.ledgerByDecision)}.`,
      `Stored items: ${entries(ingestion.storedItems)}.`,
      `Skipped documents in the tenant, by reason: ${entries(ingestion.skippedByReason)}.`,
      `Candidates by state: ${entries(ingestion.candidatesByState)}.`,
    ],
  });
  blocks.push({
    type: 'table',
    head: ['Link method', 'Route tier', 'Active', 'Rejected'],
    numeric: [2, 3],
    rows: ingestion.linksByMethodTier.map((l) => [l.method, l.tier, String(l.active), String(l.rejected)]),
  });

  blocks.push({ type: 'heading', level: 2, text: 'Method' });
  blocks.push({
    type: 'list',
    items: [
      `A candidate qualifies for a deal when three things hold: their dates overlap (the deal window widened by ${MATCH_TUNING.windowToleranceDays} days each side; a missing date passes); it names the deal (codename, name, a codename derived from "Project <Name>", or an alias) or shares a party by mail domain or company name; and at least ${Math.round(MATCH_TUNING.minEvidenceShare * 100)}% of its labeled evidence items belong to the deal. A shared party or a missing date never qualifies a candidate alone, and a candidate with no labeled evidence qualifies for nothing.`,
      `Discovery precision and recall pair candidates and deals one-to-one: a maximum-weight assignment that maximizes, first, the deal items the paired candidates hold, then the match score (${MATCH_TUNING.codenameWeight} name, ${MATCH_TUNING.partyWeight} share of parties, ${MATCH_TUNING.timeWeight} known date overlap). A second candidate of a deal is a false positive and a fragment.`,
      `Fragmentation counts deals that two or more candidates qualify for. A candidate is a merge when it qualifies for two deals, or when two deals each hold at least ${Math.round(MERGE_TUNING.minShare * 100)}% and ${MERGE_TUNING.minItems} of its labeled evidence items.`,
      'An item link counts for the deal its candidate is paired with. A link to an unpaired candidate is always wrong.',
      'Late thread means read and unrouted, in a conversation the tenant routed: the reply was read before the message that made its thread routable.',
      'Known limit: an item read before the message that teaches its alias lands in "Read, unrouted: other". No metadata tells it from a rules miss.',
      'Known limit: mail attachments are not read, so the key must mark attachment-only items for them to be counted apart.',
      'Known limit: documents match on their path inside the library. Two libraries holding the same path collide.',
    ],
  });
  return blocks;
}

function share(n: number, total: number): string {
  return total === 0 ? 'n/a' : `${((n / total) * 100).toFixed(1)}%`;
}

// ── Markdown ────────────────────────────────────────────────────────────────

function mdEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/([*_`[\]|<>])/g, '\\$1').replace(/\r?\n/g, ' ');
}

function mdCode(value: string): string {
  const clean = value.replace(/\r?\n/g, ' ');
  const fence = clean.includes('`') ? '``' : '`';
  const pad = clean.startsWith('`') || clean.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${clean}${pad}${fence}`.replace(/\|/g, '\\|');
}

function mdInline(text: Text): string {
  const parts = Array.isArray(text) ? text : [text];
  return parts.map((p) => (typeof p === 'string' ? mdEscape(p) : mdCode(p.code))).join('');
}

export function renderMarkdown(card: Scorecard): string {
  const out: string[] = [];
  for (const block of scorecardBlocks(card)) {
    if (block.type === 'heading') out.push(`${'#'.repeat(block.level)} ${mdEscape(block.text)}`, '');
    else if (block.type === 'paragraph') out.push(mdInline(block.text), '');
    else if (block.type === 'list') out.push(...block.items.map((item) => `- ${mdInline(item)}`), '');
    else {
      const align = block.head.map((_, i) => (block.numeric?.includes(i) ? '---:' : '---'));
      out.push(`| ${block.head.map(mdEscape).join(' | ')} |`, `| ${align.join(' | ')} |`);
      for (const row of block.rows) out.push(`| ${row.map(mdInline).join(' | ')} |`);
      out.push('');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}

// ── HTML ────────────────────────────────────────────────────────────────────

function htmlEscape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function htmlInline(text: Text): string {
  const parts = Array.isArray(text) ? text : [text];
  return parts.map((p) => (typeof p === 'string' ? htmlEscape(p) : `<code>${htmlEscape(p.code)}</code>`)).join('');
}

const STYLE = `
  :root { color-scheme: light; }
  body { margin: 0; background: #F5F4F1; color: #191919;
    font: 13px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1080px; margin: 32px auto; padding: 32px; background: #FFFFFF;
    border: 1px solid #ECEAE5; border-radius: 12px; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  h2 { font-size: 15px; margin: 28px 0 8px; padding-top: 16px; border-top: 1px solid #ECEAE5; }
  p, li { color: #55534E; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0 12px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #ECEAE5; vertical-align: top; }
  th { font-weight: 600; font-size: 12px; color: #6B6B68; background: #FAF9F6; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  code { font: 12px/1.4 "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #F1F0EC; border-radius: 4px; padding: 1px 4px; overflow-wrap: anywhere; }
`;

export function renderHtml(card: Scorecard): string {
  const body: string[] = [];
  for (const block of scorecardBlocks(card)) {
    if (block.type === 'heading') body.push(`<h${block.level}>${htmlEscape(block.text)}</h${block.level}>`);
    else if (block.type === 'paragraph') body.push(`<p>${htmlInline(block.text)}</p>`);
    else if (block.type === 'list') body.push(`<ul>${block.items.map((i) => `<li>${htmlInline(i)}</li>`).join('')}</ul>`);
    else {
      const cls = (i: number) => (block.numeric?.includes(i) ? ' class="num"' : '');
      const head = block.head.map((h, i) => `<th${cls(i)}>${htmlEscape(h)}</th>`).join('');
      const rows = block.rows
        .map((row) => `<tr>${row.map((cell, i) => `<td${cls(i)}>${htmlInline(cell)}</td>`).join('')}</tr>`)
        .join('');
      body.push(`<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`);
    }
  }
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>Deal discovery scorecard ${htmlEscape(card.meta.exportedAt)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    `<body><main>${body.join('\n')}</main></body>`,
    '</html>',
    '',
  ].join('\n');
}
