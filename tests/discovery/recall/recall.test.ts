import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { inRepoCorpusFiles } from './corpus';
import { corpusIdOf, parseRecallCorpus, type RecallCorpus } from './format';
import { RECALL_MODES, runAll, type RecallMode } from './harness';
import { outcomeOf, scoreCorpus, type RecallTable, type RouteRule } from './score';

// The recall measurement (#173 G-09). One exact table per corpus: the in-repo corpus (corpus.ts) and every JSON
// corpus under corpora/. Every rule change shows up as a reviewed diff of these tables, never as a quiet number.
//
// Reading a table (score.ts has the full definitions):
//   rows            [form or form/variant, whole, graph50, gmail10t, page10, page10_rev]
//   a deal cell     "right/right_plus_wrong/wrong/miss", counted per (message, source) observation
//   a non-deal cell "observations:routes"
//   headline        the team inbox's observations in graph50 (an M365 inbox read by the Graph reader), by form
//   misdirected     routes on non-deal mail, plus routes to the wrong deal; misdirectedByRule splits it by the rule
//                   that made each route. The false-positive gate (GATE below) holds every rule to the preceding
//                   slice's tip; a slice that fails it stops and the trade-off goes to the owner.
// The modes (harness.ts): `whole` is a single-batch comparison, not a bound. graph50 and gmail10t are the two
// readers' real pages; page10 is a stress case with pages smaller than any reader's, and page10_rev reads it the
// opposite way round, the known limit that mail read before the mail that makes it routable keeps nothing.

const CORPORA_DIR = path.join(process.cwd(), 'tests/discovery/recall/corpora');

const corpusNames = () =>
  readdirSync(CORPORA_DIR)
    .filter((file) => file.endsWith('.messages.json'))
    .map((file) => file.slice(0, -'.messages.json'.length))
    .sort();

function loadCorpus(name: string): RecallCorpus {
  const read = (kind: 'messages' | 'labels' | 'world') =>
    JSON.parse(readFileSync(path.join(CORPORA_DIR, `${name}.${kind}.json`), 'utf8')) as unknown;
  return parseRecallCorpus({ messages: read('messages'), labels: read('labels'), world: read('world') });
}

const same = (cell: string): [string, string, string, string, string] => [cell, cell, cell, cell, cell];

/*
 * Slice 1 baseline (the router as develop had it: no source scope, no firm names), kept as the reference:
 *   - alias_cross_source/bare, thread_cross_source/reply and alias_mixed_copy_leak (the carrier and Lena's bare
 *     word) routed, because alias and thread knowledge was tenant-wide: these are the leaks 2/5 closes.
 *   - alias_mixed_copy_*_cost rows routed (right); they are the stated cost of closing the leaks.
 *   - every real_name* row misses: the rules know no company names. realNameRecall is 0 of 7.
 *   - misdirected was 6 in every mode but page10_rev (5): the Townhall: rows (two firm people open an internal
 *     prefix on two topics in one mailbox, and the prefix rule takes it), the "Aster Pharma results" collision rows
 *     (the bare alias word matches a company name), and the carrier (a bare alias route added to a message that
 *     already routes to another deal; the leak itself).
 *   - the page10_rev column loses every message read before its teacher, by design of the worker.
 *
 * 2/5 (router provenance and admit, harness scope { shared: team and ownerless sources }). What moved, and why:
 *   - thread_cross_source/reply and alias_cross_source/bare: right -> miss in every mode that had them. The key was
 *     taught in Ana's mailbox only; deals@ is shared and did not teach it.
 *   - alias_mixed_copy_leak/lena_bare: right -> miss. Heron was taught in deals@ only; Lena is personal.
 *   - alias_mixed_copy_leak/carrier: right_plus_wrong -> right. The Aster literal still routes both copies; the
 *     bare Heron is refused on the item, so its extra route (the laundering case) is gone.
 *   - alias_mixed_copy_personal_cost/mixed and _shared_cost/mixed, the stated cost: whole misses both copies (one side
 *     did not teach the key); the paged modes keep a side whose own page taught it, where the reading order allows.
 *   - misdirected falls to 4 (3 in page10_rev), all of it noise_* rows (Townhall: and "Aster Pharma results", a
 *     name that is also a codename taught everywhere). Those are findings for a later slice, not fixed here.
 */
const HARROW: RecallTable = {
  rows: [
    ['project_codename/body', ...same('1/0/0/0')],
    ['project_codename/subject_personal', ...same('1/0/0/0')],
    ['project_codename/subject_shared', ...same('2/0/0/0')],
    ['thread_reply/reply', '2/0/0/0', '2/0/0/0', '2/0/0/0', '2/0/0/0', '0/0/0/2'],
    ['thread_reply/reply_changed_subject', ...same('0/0/0/1')],
    ['thread_reply/reply_no_thread_id', ...same('0/0/0/1')],
    ['thread_reply/root', ...same('1/0/0/0')],
    ['thread_cross_source/reply', ...same('0/0/0/1')],
    ['thread_cross_source/root', ...same('1/0/0/0')],
    ['subject_prefix', ...same('3/0/0/0')],
    ['subject_prefix_thin/one_sender', ...same('0/0/0/2')],
    ['subject_prefix_thin/one_topic', ...same('0/0/0/2')],
    ['alias_same_source/bare', '1/0/0/0', '1/0/0/0', '0/0/0/1', '1/0/0/0', '0/0/0/1'],
    ['alias_same_source/bare_body', '1/0/0/0', '1/0/0/0', '0/0/0/1', '1/0/0/0', '0/0/0/1'],
    ['alias_same_source/literal', ...same('1/0/0/0')],
    ['alias_cross_source/bare', ...same('0/0/0/1')],
    ['alias_cross_source/literal', ...same('1/0/0/0')],
    ['alias_mixed_copy_leak/carrier', ...same('2/0/0/0')],
    ['alias_mixed_copy_leak/lena_bare', ...same('0/0/0/1')],
    ['alias_mixed_copy_leak/teacher', ...same('1/0/0/0')],
    ['alias_mixed_copy_personal_cost/mixed', '0/0/0/2', '1/0/0/1', '0/0/0/2', '1/0/0/1', '0/0/0/2'],
    ['alias_mixed_copy_personal_cost/teacher', ...same('1/0/0/0')],
    ['alias_mixed_copy_shared_cost/mixed', '0/0/0/2', '1/0/0/1', '0/0/0/2', '1/0/0/1', '0/0/0/2'],
    ['real_name/body_only', ...same('0/0/0/1')],
    ['real_name/case_variant', ...same('0/0/0/1')],
    ['real_name/external_sender', ...same('0/0/0/1')],
    ['real_name/full_name_term', ...same('0/0/0/2')],
    ['real_name/no_process_term', ...same('0/0/0/1')],
    ['real_name/short_form', ...same('0/0/0/1')],
    ['real_name_unentitled/no_leads_view', ...same('0/0/0/1')],
    ['real_name_unentitled/not_listable', ...same('0/0/0/2')],
    ['real_name_unapproved', ...same('0/0/0/2')],
    ['real_name_document', ...same('0/0/0/1')],
    ['no_marker', ...same('0/0/0/3')],
    ['noise', ...same('189:0')],
    ['noise/internal_prefix', ...same('4:2')],
    ['noise_collision', '5:2', '5:2', '5:2', '5:2', '5:1'],
    ['noise_client_mention', ...same('2:0')],
    ['noise_client_coverage_term', ...same('2:0')],
  ],
  headline: [
    ['project_codename', '1/0/0/0'],
    ['thread_reply', '3/0/0/2'],
    ['thread_cross_source', '0/0/0/1'],
    ['subject_prefix', '3/0/0/0'],
    ['subject_prefix_thin', '0/0/0/2'],
    ['alias_same_source', '3/0/0/0'],
    ['alias_cross_source', '0/0/0/1'],
    ['alias_mixed_copy_leak', '2/0/0/0'],
    ['alias_mixed_copy_personal_cost', '0/0/0/1'],
    ['alias_mixed_copy_shared_cost', '1/0/0/0'],
    ['real_name', '0/0/0/7'],
    ['real_name_document', '0/0/0/1'],
    ['no_marker', '0/0/0/3'],
    ['noise', '101:0'],
    ['noise_collision', '4:1'],
    ['noise_client_mention', '2:0'],
    ['noise_client_coverage_term', '2:0'],
  ],
  realNameRecall: {
    whole: { right: 0, of: 7 },
    graph50: { right: 0, of: 7 },
    gmail10t: { right: 0, of: 7 },
    page10: { right: 0, of: 7 },
    page10_rev: { right: 0, of: 7 },
  },
  misdirected: { whole: 4, graph50: 4, gmail10t: 4, page10: 4, page10_rev: 3 },
  misdirectedByRule: {
    whole: { alias: 2, prefix: 2 },
    graph50: { alias: 2, prefix: 2 },
    gmail10t: { alias: 2, prefix: 2 },
    page10: { alias: 2, prefix: 2 },
    page10_rev: { alias: 1, prefix: 2 },
  },
};

/** One pinned table per JSON corpus under corpora/, by file name. A corpus file with no entry here fails. */
const PINNED: Record<string, RecallTable> = {
  // heldout1 (hqpartners.example: 325 items, 6 sources, 7 deals, 167 noise) was written by a separate agent that saw
  // only corpora/README.md, never the rules. Baseline findings on develop, recorded and not fixed here:
  //   - noise_collision routes 17 (whole), 16 (graph50), 14 (gmail10t), 16 (page10) and 8 (page10_rev): street, hill
  //     and shop names that share a code-name word are matched by the bare alias rule. This is all of misdirected.
  //   - the prefix needs its two topics and two senders inside one router call, so its recall follows the reader's
  //     page: subject_prefix/several topics is 23 of 23 in whole, 16 in graph50 (deals@ all 15), 4 in gmail10t and
  //     2 in page10.
  //   - project_codename/forward misses: the code name is only in the forwarded part, which quote stripping drops.
  //   - every real_name row misses (0 of 30).
  // 3b carries each source's prefix evidence page to page: subject_prefix (several topics and external reply, 25
  // observations) goes from 17 to 21 in graph50, 4 to 17 in gmail10t and 2 to 18 in page10; deals@ was already 15 of
  // 15 in graph50. Prefix mail read before its prefix reaches the bar still keeps nothing.
  // Then a prefix route needs every mailbox that read the item to have promoted it (the `admit` barrier): discoverTenant
  // re-routes a stored copy held in deals@ and a personal mailbox whose stored mail alone does not promote the prefix,
  // so subject_prefix falls to 19 of 25 in graph50 (deals@ 14 of 15), 9 in gmail10t, 8 in page10 and 23 in whole.
  // misdirected does not move.
  heldout1: {
    rows: [
      ['project_codename/external', ...same('3/0/0/0')],
      ['project_codename/forward', ...same('0/0/0/4')],
      ['project_codename/root', ...same('25/0/0/0')],
      ['thread_reply/reply', '28/0/0/2', '24/0/0/6', '24/0/0/6', '24/0/0/6', '23/0/0/7'],
      ['thread_cross_source/reply', '4/0/0/1', '4/0/0/1', '4/0/0/1', '4/0/0/1', '0/0/0/5'],
      ['subject_prefix/external reply', '2/0/0/0', '2/0/0/0', '0/0/0/2', '0/0/0/2', '0/0/0/2'],
      ['subject_prefix/several topics', '21/0/0/2', '17/0/0/6', '9/0/0/14', '8/0/0/15', '9/0/0/14'],
      ['subject_prefix_thin/one sender one topic', '4/0/0/0', '4/0/0/0', '0/0/0/4', '4/0/0/0', '1/0/0/3'],
      ['alias_same_source/body', '11/0/0/0', '11/0/0/0', '8/0/0/3', '11/0/0/0', '9/0/0/2'],
      ['alias_same_source/subject', '1/0/0/0', '1/0/0/0', '1/0/0/0', '1/0/0/0', '0/0/0/1'],
      ['alias_cross_source/body', '5/0/0/0', '5/0/0/0', '5/0/0/0', '5/0/0/0', '0/0/0/5'],
      ['alias_mixed_copy_leak/d+p copy', '0/0/0/2', '1/0/0/1', '0/0/0/2', '1/0/0/1', '0/0/0/2'],
      ['alias_mixed_copy_leak/x', ...same('0/0/0/3')],
      ['alias_mixed_copy_personal_cost/d+t', '0/0/0/8', '4/0/0/4', '0/0/0/8', '4/0/0/4', '0/0/0/8'],
      ['alias_mixed_copy_shared_cost/d+i', '0/0/0/4', '2/0/0/2', '0/0/0/4', '2/0/0/2', '0/0/0/4'],
      ['alias_mixed_copy_shared_cost/d+t', '0/0/0/4', '2/0/0/2', '0/0/0/4', '2/0/0/2', '0/0/0/4'],
      ['real_name/external reply', ...same('0/0/0/1')],
      ['real_name/firm', ...same('0/0/0/25')],
      ['real_name/reply', ...same('0/0/0/4')],
      ['real_name_unentitled/x', ...same('0/0/0/4')],
      ['real_name_unapproved/external to departed', ...same('0/0/0/2')],
      ['real_name_unapproved/firm', ...same('0/0/0/1')],
      ['real_name_document', ...same('0/0/0/7')],
      ['no_marker/external', ...same('0/0/0/1')],
      ['no_marker/external counsel', ...same('0/0/0/2')],
      ['no_marker/none', ...same('0/0/0/10')],
      ['no_marker/terse', ...same('0/0/0/6')],
      ['noise', ...same('277:0')],
      ['noise/auto-reply', ...same('6:0')],
      ['noise/calendar', ...same('18:0')],
      ['noise/room booking', ...same('8:0')],
      ['noise_collision', '35:8', '35:13', '35:10', '35:13', '35:6'],
      ['noise_client_mention', ...same('10:0')],
      ['noise_client_coverage_term', ...same('10:0')],
    ],
    headline: [
      ['project_codename', '13/0/0/1'],
      ['thread_reply', '17/0/0/1'],
      ['subject_prefix', '14/0/0/1'],
      ['subject_prefix_thin', '4/0/0/0'],
      ['alias_same_source', '7/0/0/0'],
      ['alias_mixed_copy_leak', '1/0/0/0'],
      ['alias_mixed_copy_personal_cost', '0/0/0/4'],
      ['alias_mixed_copy_shared_cost', '4/0/0/0'],
      ['real_name', '0/0/0/15'],
      ['real_name_document', '0/0/0/5'],
      ['no_marker', '0/0/0/5'],
      ['noise', '42:0'],
      ['noise_collision', '7:3'],
      ['noise_client_mention', '3:0'],
      ['noise_client_coverage_term', '1:0'],
    ],
    realNameRecall: {
      whole: { right: 0, of: 30 },
      graph50: { right: 0, of: 30 },
      gmail10t: { right: 0, of: 30 },
      page10: { right: 0, of: 30 },
      page10_rev: { right: 0, of: 30 },
    },
    misdirected: { whole: 8, graph50: 13, gmail10t: 10, page10: 13, page10_rev: 6 },
    misdirectedByRule: {
      whole: { alias: 8 },
      graph50: { alias: 13 },
      gmail10t: { alias: 10 },
      page10: { alias: 13 },
      page10_rev: { alias: 6 },
    },
  },
  smoke: {
    rows: [
      ['project_codename', ...same('1/0/0/0')],
      ['alias_same_source', ...same('1/0/0/0')],
      ['real_name/full_name_term', ...same('0/0/0/1')],
      ['noise', ...same('3:0')],
    ],
    headline: [
      ['project_codename', '1/0/0/0'],
      ['alias_same_source', '1/0/0/0'],
      ['real_name', '0/0/0/1'],
      ['noise', '1:0'],
    ],
    realNameRecall: {
      whole: { right: 0, of: 1 },
      graph50: { right: 0, of: 1 },
      gmail10t: { right: 0, of: 1 },
      page10: { right: 0, of: 1 },
      page10_rev: { right: 0, of: 1 },
    },
    misdirected: { whole: 0, graph50: 0, gmail10t: 0, page10: 0, page10_rev: 0 },
    misdirectedByRule: {
      whole: {},
      graph50: {},
      gmail10t: {},
      page10: {},
      page10_rev: {},
    },
  },
};

/**
 * The false-positive gate (audit G9): per corpus, mode and rule, the misdirected routes of the preceding slice's tip.
 * No rule may misroute more than this, so a slice cannot spend slack that another slice made. This is 3b: the
 * preceding tip is 3/5.
 */
const GATE: Record<string, RecallTable['misdirectedByRule']> = {
  harrow: {
    whole: { alias: 2, prefix: 2 },
    graph50: { alias: 2, prefix: 2 },
    gmail10t: { alias: 2, prefix: 2 },
    page10: { alias: 2, prefix: 2 },
    page10_rev: { alias: 1, prefix: 2 },
  },
  heldout1: {
    whole: { alias: 8 },
    graph50: { alias: 13 },
    gmail10t: { alias: 10 },
    page10: { alias: 13 },
    page10_rev: { alias: 6 },
  },
  smoke: {
    whole: {},
    graph50: {},
    gmail10t: {},
    page10: {},
    page10_rev: {},
  },
};

/**
 * heldout1's subject_prefix observations in deals@, right of all, in every mode (3b, audit P6). The headline reads
 * graph50 only; these are the cells the per-reader prefix table in the guide and D121 cites.
 */
const HELDOUT1_DEALS_PREFIX: Record<RecallMode, string> = {
  whole: '14/15',
  graph50: '14/15',
  gmail10t: '9/15',
  page10: '8/15',
  page10_rev: '9/15',
};

const inRepo = (): RecallCorpus => parseRecallCorpus(inRepoCorpusFiles());

describe('recall corpora', () => {
  it('has a pinned table for every corpus file, and a corpus file for every pinned table', () => {
    expect(corpusNames()).toEqual(Object.keys(PINNED).sort());
  });

  it('the in-repo corpus has the frozen shape', () => {
    const corpus = inRepo();
    const observations = corpus.messages.flatMap((m) => m.sources);
    const perSource = Object.fromEntries(corpus.world.sources.map((s) => [s.id, observations.filter((o) => o === s.id).length]));
    const labelled = corpus.messages.reduce(
      (n, m) => n + (corpus.labels[corpusIdOf(m)].deal !== null ? m.sources.length : 0),
      0,
    );
    expect({
      messages: corpus.messages.length,
      observations: observations.length,
      perSource,
      dealObservations: labelled,
      deals: Object.keys(corpus.world.deals).length,
    }).toEqual({
      messages: 246,
      observations: 250,
      perSource: { 'src-ana': 50, 'src-tom': 20, 'src-deals': 140, 'src-lena': 30, 'src-archive': 10 },
      dealObservations: 48,
      deals: 13,
    });
  });

  it('pins the in-repo corpus (harrow.example)', () => {
    const corpus = inRepo();
    expect(scoreCorpus(corpus, runAll(corpus))).toEqual(HARROW);
  });

  it('holds the false-positive gate: no rule misroutes more than at the preceding tip, in any mode', () => {
    const tables: Array<[string, RecallTable]> = [
      ['harrow', scoreCorpus(inRepo(), runAll(inRepo()))],
      ...corpusNames().map((name): [string, RecallTable] => [name, scoreCorpus(loadCorpus(name), runAll(loadCorpus(name)))]),
    ];
    expect(Object.keys(GATE).sort()).toEqual(tables.map(([name]) => name).sort());
    for (const [name, table] of tables) {
      for (const mode of RECALL_MODES) {
        const gate = GATE[name][mode];
        for (const [rule, count] of Object.entries(table.misdirectedByRule[mode])) {
          expect(count, `${name} ${mode} ${rule}`).toBeLessThanOrEqual(gate[rule as RouteRule] ?? 0);
        }
      }
    }
  });

  it('pins heldout1\'s deals@ prefix cells in every mode', () => {
    const corpus = loadCorpus('heldout1');
    const runs = runAll(corpus);
    const headline = corpus.world.sources.find((s) => s.headline)!.id;
    const cells = Object.fromEntries(
      RECALL_MODES.map((mode) => {
        let right = 0;
        let of = 0;
        for (const message of corpus.messages) {
          const id = corpusIdOf(message);
          const label = corpus.labels[id];
          if (label.form !== 'subject_prefix' || label.deal === null || !message.sources.includes(headline)) continue;
          const routes = runs[mode].kept.get(id)?.has(headline) ? (runs[mode].routes.get(id) ?? []) : [];
          of += 1;
          if (outcomeOf(routes, corpus.world.deals[label.deal].keys) === 'right') right += 1;
        }
        return [mode, `${right}/${of}`];
      }),
    );
    expect(cells).toEqual(HELDOUT1_DEALS_PREFIX);
  });

  for (const name of corpusNames()) {
    it(`pins the ${name} corpus`, () => {
      const corpus = loadCorpus(name);
      expect(PINNED[name], `no pinned table for corpora/${name}.*.json`).toBeDefined();
      expect(scoreCorpus(corpus, runAll(corpus))).toEqual(PINNED[name]);
    });
  }
});
