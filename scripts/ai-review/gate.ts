/*
 * Posting the ai-review result. The GitHub client is injected, so tests drive it with a fake.
 */
import type { Conclusion, GateMode } from './pipeline';

/**
 * Gate mode needs the dedicated App: a check posted with GITHUB_TOKEN can be spoofed by any workflow
 * with checks: write, so without the App the run stays advisory whatever gate.json says.
 */
export function effectiveMode(configured: GateMode, appSlug: string | undefined, log: (msg: string) => void = console.warn): GateMode {
  if (configured === 'gate' && !appSlug) {
    log('gate.json says gate, but no ai-review App token is configured: staying advisory');
    return 'advisory';
  }
  return configured;
}

/** `gh api` with optional JSON body; throws on a non-zero exit. */
export type Gh = (args: string[], body?: unknown) => string;

export type ReviewPost = {
  repo: string;
  pr: number;
  headSha: string;
  conclusion: Conclusion;
  summary: string;
  body: string;
  comments: { path: string; line: number; side: string; body: string }[];
  reply: string | null;
  needsHuman: boolean;
  /** Marks the result kind and run on the check, read back by holdEarlierFailure and applyOverride. */
  externalId?: string;
};

export const ANCILLARY_FAILED_NOTE =
  'Posting the review comment, reply or label failed; the result above stands. See the run log.';

/**
 * Posts the review, reply and label first, then the check run last. A failed ancillary call is logged
 * and noted in the check summary, never thrown, so a run that reached a result always posts it, and a
 * crash finalizer never sees a run that posted a result and then failed.
 */
export function postResult(gh: Gh, p: ReviewPost, log: (msg: string) => void = console.error): { ancillaryFailed: string[] } {
  const failed: string[] = [];
  const attempt = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      failed.push(what);
      log(`${what} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  attempt('review', () =>
    gh(['-X', 'POST', `repos/${p.repo}/pulls/${p.pr}/reviews`], {
      commit_id: p.headSha,
      event: 'COMMENT',
      body: p.body,
      comments: p.comments,
    }),
  );
  if (p.reply) attempt('reply', () => gh(['-X', 'POST', `repos/${p.repo}/issues/${p.pr}/comments`], { body: p.reply }));
  // An incomplete review (a truncated diff) leaves part of the change unreviewed, so a person must look.
  if (p.needsHuman) {
    attempt('label', () => gh(['-X', 'POST', `repos/${p.repo}/issues/${p.pr}/labels`], { labels: ['needs-human'] }));
  } else {
    try {
      gh(['-X', 'DELETE', `repos/${p.repo}/issues/${p.pr}/labels/needs-human`]);
    } catch {
      // label was not set
    }
  }

  const summary = failed.length ? `${p.summary}\n\n${ANCILLARY_FAILED_NOTE}` : p.summary;
  // The check is last, and its failure is the only one that throws.
  gh(['-X', 'POST', `repos/${p.repo}/check-runs`], {
    name: 'ai-review',
    head_sha: p.headSha,
    status: 'completed',
    conclusion: p.conclusion,
    ...(p.externalId ? { external_id: p.externalId } : {}),
    output: { title: `AI review: ${p.conclusion}`, summary },
  });
  return { ancillaryFailed: failed };
}

/**
 * What a posted check stands for. blocking: a completed review with a confirmed blocking finding, never
 * overridable. incomplete: the review ran but could not cover everything (size limits, tripwire, a failed
 * reviewer or validator); withheld: its output was withheld. unconfigured / unfinished: no review ran.
 * override: a maintainer passed an unfinished review by hand.
 */
export type ResultKind = 'clean' | 'blocking' | 'incomplete' | 'withheld' | 'unconfigured' | 'unfinished' | 'override';
const KINDS: ResultKind[] = ['clean', 'blocking', 'incomplete', 'withheld', 'unconfigured', 'unfinished', 'override'];
/** No review ran, so a later completed review may replace these; every other failure needs the override. */
const PLACEHOLDER_KINDS: ResultKind[] = ['unconfigured', 'unfinished'];

export function externalId(kind: ResultKind, runId: string): string {
  return `ai-review:${kind}:${runId}`;
}

export function kindOf(id: string | null | undefined): ResultKind | null {
  const m = /^ai-review:([a-z]+):/.exec(id ?? '');
  return m && (KINDS as string[]).includes(m[1]!) ? (m[1] as ResultKind) : null;
}

export function resultKind(decisionConclusion: 'success' | 'failure', conclusion: Conclusion): ResultKind {
  if (decisionConclusion === 'failure') return 'blocking';
  return conclusion === 'success' ? 'clean' : 'incomplete';
}

export type CheckRun = {
  id: number;
  status: string;
  conclusion: string | null;
  external_id: string | null;
  app: { slug: string } | null;
  output?: { title?: string | null };
};

/** Completed ai-review check runs on `sha` posted by `appSlug`, newest first. */
export function listChecks(gh: Gh, repo: string, sha: string, appSlug: string): CheckRun[] {
  const all: CheckRun[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = JSON.parse(
      gh([`repos/${repo}/commits/${sha}/check-runs?check_name=ai-review&filter=all&per_page=100&page=${page}`]),
    ) as { check_runs: CheckRun[] };
    all.push(...res.check_runs);
    if (res.check_runs.length < 100) break;
  }
  return all.filter((c) => c.status === 'completed' && c.app?.slug === appSlug).sort((a, b) => b.id - a.id);
}

export const HELD_NOTE =
  'An earlier ai-review failure on this commit stands. A later run cannot clear it; a maintainer override can, if no result on this commit was a confirmed blocking finding.';
export const OVERRIDE_HELD_NOTE =
  'A maintainer override on this commit stands (see the earlier override check for who, when and why). Only a confirmed blocking finding replaces it.';

/** A failure that is a confirmed blocking finding, or unmarked (posted before kinds existed). */
function isBlocking(c: CheckRun): boolean {
  const k = kindOf(c.external_id);
  return c.conclusion === 'failure' && (k === 'blocking' || k === null);
}

/**
 * Gate mode, for every result a run posts on a commit it has seen before (a mention, a label, a replay):
 * - a confirmed blocking finding is always posted;
 * - any earlier confirmed blocking finding on the commit stands, whatever this run found;
 * - an earlier maintainer override stands against anything short of a confirmed blocking finding;
 * - any other earlier failure stands against a pass, or a model could be re-rolled until it misses a
 *   finding. Only a placeholder failure, where no review ran, gives way to a completed review.
 */
export function holdEarlierFailure(
  earlier: CheckRun[],
  next: { conclusion: Conclusion; kind: ResultKind },
): { conclusion: Conclusion; kind: ResultKind; held: boolean; note?: string } {
  // A new confirmed blocking finding always posts, even over an earlier pass on this commit: a later flaky
  // or incomplete run can therefore turn a clean pass into a failure. That fails safe, and the maintainer
  // override recovers anything short of a confirmed blocking finding.
  if (next.kind === 'blocking') return { ...next, held: false };
  if (earlier.some(isBlocking)) return { conclusion: 'failure', kind: 'blocking', held: true, note: HELD_NOTE };
  // The override already answered every failure before it, so after one only this run's result matters.
  if (earlier.some((c) => c.conclusion === 'success' && kindOf(c.external_id) === 'override')) {
    return next.conclusion === 'success' ? { ...next, held: false } : { conclusion: 'success', kind: 'override', held: true, note: OVERRIDE_HELD_NOTE };
  }
  if (next.conclusion === 'failure') return { ...next, held: false };
  const failed = earlier.find((c) => c.conclusion === 'failure' && !PLACEHOLDER_KINDS.includes(kindOf(c.external_id)!));
  if (failed) return { conclusion: 'failure', kind: kindOf(failed.external_id)!, held: true, note: HELD_NOTE };
  return { ...next, held: false };
}

export const OVERRIDE_ROLES = ['admin', 'maintain'];
export const OVERRIDE_REASON_MAX = 500;

export type OverrideInput = {
  repo: string;
  pr: number;
  sha: string;
  actor: string;
  reason: string;
  appSlug: string;
  runId: string;
  runUrl: string;
  now: Date;
};

/**
 * The one maintainer override: passes an unfinished or incomplete review for exactly one commit, and
 * records who, when, why and which SHA on the check and on the PR. It refuses a confirmed blocking
 * finding, a commit that is not the PR head, and anyone below the maintain role.
 */
export function applyOverride(gh: Gh, o: OverrideInput, log: (msg: string) => void = console.log): 'posted' | 'nothing-to-override' {
  const reason = o.reason.replace(/\s+/g, ' ').trim();
  if (!reason) throw new Error('override: a reason is required');
  if (reason.length > OVERRIDE_REASON_MAX) throw new Error(`override: the reason is longer than ${OVERRIDE_REASON_MAX} characters`);
  if (!/^[A-Za-z0-9-]+$/.test(o.actor)) throw new Error('override: no valid actor');
  if (!/^[0-9a-f]{40}$/.test(o.sha)) throw new Error('override: the SHA must be a full 40-character commit SHA');

  const perm = JSON.parse(gh([`repos/${o.repo}/collaborators/${encodeURIComponent(o.actor)}/permission`])) as { role_name?: string };
  if (!OVERRIDE_ROLES.includes(perm.role_name ?? '')) {
    throw new Error(`override: @${o.actor} has role ${perm.role_name ?? 'none'}; an override needs ${OVERRIDE_ROLES.join(' or ')}`);
  }
  const pr = JSON.parse(gh([`repos/${o.repo}/pulls/${o.pr}`])) as { head: { sha: string } };
  if (pr.head.sha !== o.sha) throw new Error(`override: ${o.sha} is not the head of PR #${o.pr}; an override covers one commit only`);

  const checks = listChecks(gh, o.repo, o.sha, o.appSlug);
  if (checks.some(isBlocking)) {
    throw new Error('override: an ai-review result on this commit is a confirmed blocking finding (or unmarked); fix the code instead');
  }
  const latest = checks[0];
  if (latest?.conclusion === 'success') {
    log(`ai-review already passes on ${o.sha}; nothing to override`);
    return 'nothing-to-override';
  }
  const prior = latest ? kindOf(latest.external_id) : 'unfinished';

  const when = o.now.toISOString();
  const audit = [
    `Override by @${o.actor} at ${when} for commit ${o.sha}.`,
    `Reason: ${reason}`,
    `Overridden result: ${latest ? `${latest.output?.title ?? 'ai-review'} (check ${latest.id}, ${prior})` : 'no ai-review result posted'}.`,
    `Run: ${o.runUrl}`,
  ].join('\n\n');
  gh(['-X', 'POST', `repos/${o.repo}/check-runs`], {
    name: 'ai-review',
    head_sha: o.sha,
    status: 'completed',
    conclusion: 'success',
    external_id: externalId('override', o.runId),
    output: { title: `AI review: overridden by @${o.actor}`, summary: audit },
  });
  try {
    gh(['-X', 'POST', `repos/${o.repo}/issues/${o.pr}/comments`], { body: `AI review override.\n\n${audit}` });
  } catch (e) {
    log(`override comment failed (the check carries the audit): ${e instanceof Error ? e.message : String(e)}`);
  }
  return 'posted';
}

export const UNFINISHED_SUMMARY =
  'The review run did not finish (it crashed or timed out) before posting a result. Re-run the workflow or comment @ai-reviewer; a maintainer override can also pass it.';

/**
 * The timeout finalizer, run as its own job after the review job: posts a failure only when nothing
 * from the App is on the commit yet and the commit is still the PR head. A completed result, from this
 * run or an earlier one, always stands.
 */
export function finalizeUnfinished(
  gh: Gh,
  o: { repo: string; pr: number; sha: string; appSlug: string; runId: string },
  log: (msg: string) => void = console.log,
): 'posted' | 'result-exists' | 'head-moved' | 'not-develop' {
  const pr = JSON.parse(gh([`repos/${o.repo}/pulls/${o.pr}`])) as { head: { sha: string }; base: { ref: string } };
  // The review job may have died before it resolved the PR; then the finalizer covers the current head.
  const sha = o.sha || pr.head.sha;
  if (pr.base.ref !== 'develop') {
    log('base is not develop; the gate does not apply');
    return 'not-develop';
  }
  if (pr.head.sha !== sha) {
    log(`head moved from ${sha}; a newer run handles it`);
    return 'head-moved';
  }
  if (listChecks(gh, o.repo, sha, o.appSlug).length > 0) {
    log(`an ai-review result is already posted on ${sha}; nothing to finalize`);
    return 'result-exists';
  }
  gh(['-X', 'POST', `repos/${o.repo}/check-runs`], {
    name: 'ai-review',
    head_sha: sha,
    status: 'completed',
    conclusion: 'failure',
    external_id: externalId('unfinished', o.runId),
    output: { title: 'AI review did not finish', summary: UNFINISHED_SUMMARY },
  });
  return 'posted';
}
