// The recall scorer (#173 G-09). The unit is the (message, source) observation: a message read in two sources is two
// observations. A run keeps an observation or it does not (a page run keeps only what that source's page routed);
// a kept observation carries the routes of the final re-route of its item.
//
// For a labelled deal, an observation is:
//   right             a route key is one the deal accepts, and no other key was routed
//   right_plus_wrong  an accepted key and another one
//   wrong             only keys the deal does not accept
//   miss              no route, or the run did not keep the observation
//
// misdirected (the false-positive gate) = every route on an observation of non-deal mail, plus every route on a
// deal observation to a key the deal does not accept. misdirectedByRule splits it by the rule that made each route,
// so a slice that adds false positives of one kind cannot hide them behind another kind it removed: the gate
// (recall.test.ts) holds every rule, in every mode on every corpus, to the preceding slice's tip.
//
// Table cell formats, so a pinned diff reads at a glance:
//   labelled deal observations   "right/right_plus_wrong/wrong/miss"   e.g. "3/0/0/2"
//   non-deal observations        "observations:routes"                 e.g. "101:0"
//   a row holding both           the two joined by a space

import { ROUTE_METHOD } from '@/lib/constants/discovery';
import type { FirmRoute } from '@/lib/discovery/route/firmRules';
import { RECALL_FORMS, corpusIdOf, type RecallCorpus, type RecallForm } from './format';
import { HEADLINE_MODE, RECALL_MODES, type RecallMode, type RunResult } from './harness';

/** The rule that made a route: a literal "Project <Name>", a subject prefix, a bare alias or a thread continuation. */
export type RouteRule = 'literal' | 'prefix' | 'alias' | 'thread';
export function ruleOf(route: FirmRoute): RouteRule {
  if (route.fromSubjectPrefix) return 'prefix';
  if (route.method === ROUTE_METHOD.CODENAME) return 'literal';
  return route.method === ROUTE_METHOD.ALIAS ? 'alias' : 'thread';
}

export type Outcome = 'right' | 'right_plus_wrong' | 'wrong' | 'miss';
const OUTCOMES: readonly Outcome[] = ['right', 'right_plus_wrong', 'wrong', 'miss'];

export function outcomeOf(routes: ReadonlyArray<Pick<FirmRoute, 'codenameKey'>>, accepted: readonly string[]): Outcome {
  const right = routes.some((r) => accepted.includes(r.codenameKey));
  const wrong = routes.some((r) => !accepted.includes(r.codenameKey));
  if (right && wrong) return 'right_plus_wrong';
  if (right) return 'right';
  return wrong ? 'wrong' : 'miss';
}

type Scored = {
  form: RecallForm;
  variant: string;
  deal: string | null;
  source: string;
  accepted: readonly string[];
  routes: Record<RecallMode, readonly FirmRoute[]>;
};

export type RecallTable = {
  /** [form or form/variant, then one cell per mode in RECALL_MODES order] */
  rows: Array<[string, ...string[]]>;
  /** The headline source's observations in HEADLINE_MODE (graph50), by form. */
  headline: Array<[string, string]>;
  /** Observations of the real_name form: the ones scored right, and all of them. */
  realNameRecall: Record<RecallMode, { right: number; of: number }>;
  misdirected: Record<RecallMode, number>;
  /** misdirected by the rule that made each route; a rule with none is left out. */
  misdirectedByRule: Record<RecallMode, Partial<Record<RouteRule, number>>>;
};

function scoreObservations(corpus: RecallCorpus, runs: Record<RecallMode, RunResult>): Scored[] {
  const out: Scored[] = [];
  for (const message of corpus.messages) {
    const id = corpusIdOf(message);
    const label = corpus.labels[id];
    for (const source of message.sources) {
      const routesIn = (mode: RecallMode): readonly FirmRoute[] =>
        runs[mode].kept.get(id)?.has(source) ? (runs[mode].routes.get(id) ?? []) : [];
      out.push({
        form: label.form,
        variant: label.variant ?? '',
        deal: label.deal,
        source,
        accepted: label.deal === null ? [] : corpus.world.deals[label.deal].keys,
        routes: Object.fromEntries(RECALL_MODES.map((m) => [m, routesIn(m)])) as Record<RecallMode, readonly FirmRoute[]>,
      });
    }
  }
  return out;
}

function cellOf(observations: Scored[], mode: RecallMode): string {
  const deal = observations.filter((o) => o.deal !== null);
  const rest = observations.filter((o) => o.deal === null);
  const parts: string[] = [];
  if (deal.length > 0 || rest.length === 0) {
    const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;
    for (const o of deal) counts[outcomeOf(o.routes[mode], o.accepted)] += 1;
    parts.push(OUTCOMES.map((o) => counts[o]).join('/'));
  }
  if (rest.length > 0) parts.push(`${rest.length}:${rest.reduce((n, o) => n + o.routes[mode].length, 0)}`);
  return parts.join(' ');
}

function misroutes(observations: Scored[], mode: RecallMode): FirmRoute[] {
  return observations.flatMap((o) => o.routes[mode].filter((r) => o.deal === null || !o.accepted.includes(r.codenameKey)));
}

function byRule(routes: FirmRoute[]): Partial<Record<RouteRule, number>> {
  const out: Partial<Record<RouteRule, number>> = {};
  for (const route of routes) out[ruleOf(route)] = (out[ruleOf(route)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function scoreCorpus(corpus: RecallCorpus, runs: Record<RecallMode, RunResult>): RecallTable {
  const observations = scoreObservations(corpus, runs);
  const headlineSource = corpus.world.sources.find((s) => s.headline)!.id;
  const byMode = <T>(f: (mode: RecallMode) => T) => Object.fromEntries(RECALL_MODES.map((m) => [m, f(m)])) as Record<RecallMode, T>;

  const rowKeys = [...new Set(observations.map((o) => (o.variant ? `${o.form}/${o.variant}` : o.form)))].sort((a, b) => {
    const [formA, variantA = ''] = a.split('/');
    const [formB, variantB = ''] = b.split('/');
    const byForm = RECALL_FORMS.indexOf(formA as RecallForm) - RECALL_FORMS.indexOf(formB as RecallForm);
    // Code-point order, so the table never depends on the locale.
    if (byForm !== 0) return byForm;
    return variantA < variantB ? -1 : variantA > variantB ? 1 : 0;
  });
  const rows = rowKeys.map((key): [string, ...string[]] => {
    const inRow = observations.filter((o) => (o.variant ? `${o.form}/${o.variant}` : o.form) === key);
    return [key, ...RECALL_MODES.map((mode) => cellOf(inRow, mode))];
  });

  const headlineObservations = observations.filter((o) => o.source === headlineSource);
  const headline = RECALL_FORMS.filter((form) => headlineObservations.some((o) => o.form === form)).map(
    (form): [string, string] => [form, cellOf(headlineObservations.filter((o) => o.form === form), HEADLINE_MODE)],
  );

  const realName = observations.filter((o) => o.form === 'real_name' && o.deal !== null);
  return {
    rows,
    headline,
    realNameRecall: byMode((mode) => ({
      right: realName.filter((o) => outcomeOf(o.routes[mode], o.accepted) === 'right').length,
      of: realName.length,
    })),
    misdirected: byMode((mode) => misroutes(observations, mode).length),
    misdirectedByRule: byMode((mode) => byRule(misroutes(observations, mode))),
  };
}
