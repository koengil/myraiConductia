import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  ANCILLARY_FAILED_NOTE,
  applyOverride,
  effectiveMode,
  finalizeUnfinished,
  externalId,
  holdEarlierFailure,
  kindOf,
  listChecks,
  postResult,
  resultKind,
  type CheckRun,
  type Gh,
  type OverrideInput,
  type ReviewPost,
} from '../../scripts/ai-review/gate';
import { DIFF_CAP, capDiff, finalConclusion, gated, tripwire } from '../../scripts/ai-review/pipeline';

type Call = { args: string[]; body?: unknown };

/** A fake `gh api`: records every call; `fail` names the route fragments that answer with an error. */
function fakeGh(fail: string[] = []): { gh: Gh; calls: Call[] } {
  const calls: Call[] = [];
  const gh: Gh = (args, body) => {
    calls.push({ args, body });
    const route = args.join(' ');
    if (fail.some((f) => route.includes(f))) throw new Error(`gh api ${route} failed: HTTP 422`);
    return '{}';
  };
  return { gh, calls };
}

const post: ReviewPost = {
  repo: 'o/r',
  pr: 7,
  headSha: 'abc',
  conclusion: 'success',
  summary: 'clean',
  body: 'clean',
  comments: [],
  reply: 'AI review (normal): success, 0 finding(s).',
  needsHuman: false,
};

const isCheck = (c: Call) => c.args.includes('repos/o/r/check-runs');

describe('postResult', () => {
  it('posts the check run last, after the review, reply and label calls', () => {
    const { gh, calls } = fakeGh();
    postResult(gh, { ...post, needsHuman: true }, () => {});
    expect(calls.map((c) => c.args[2])).toEqual([
      'repos/o/r/pulls/7/reviews',
      'repos/o/r/issues/7/comments',
      'repos/o/r/issues/7/labels',
      'repos/o/r/check-runs',
    ]);
  });

  it('still posts the check when the review post fails, and notes it', () => {
    const { gh, calls } = fakeGh(['/reviews']);
    const logs: string[] = [];
    const r = postResult(gh, post, (m) => logs.push(m));
    expect(r.ancillaryFailed).toEqual(['review']);
    const check = calls.filter(isCheck);
    expect(check).toHaveLength(1);
    expect(calls.at(-1)).toBe(check[0]);
    expect((check[0]!.body as { conclusion: string }).conclusion).toBe('success');
    expect((check[0]!.body as { output: { summary: string } }).output.summary).toContain(ANCILLARY_FAILED_NOTE);
    expect(logs[0]).toContain('review failed');
  });

  it('throws only when the check post itself fails, so nothing was posted', () => {
    const { gh } = fakeGh(['check-runs']);
    expect(() => postResult(gh, post, () => {})).toThrow();
  });
});

describe('crash finalizer', () => {
  const yml = readFileSync('.github/workflows/ai-review.yml', 'utf8');
  const run = readFileSync('scripts/ai-review/run.ts', 'utf8');

  it('stays quiet once run.ts reported a posted result', () => {
    expect(run).toContain("'posted=true\\n'");
    // markPosted runs only after the check post returns.
    expect(run.indexOf('postResult(gh, {')).toBeLessThan(run.lastIndexOf('markPosted();'));
    expect(yml).toContain('posted: ${{ steps.review.outputs.posted }}');
  });

  it('a check post followed by a failed review never yields a second, failing check', () => {
    const { gh, calls } = fakeGh(['/reviews', '/comments', '/labels']);
    postResult(gh, { ...post, needsHuman: true }, () => {});
    const checks = calls.filter(isCheck).map((c) => (c.body as { conclusion: string }).conclusion);
    expect(checks).toEqual(['success']);
  });
});

const SHA = 'a'.repeat(40);
const check = (id: number, conclusion: string, kind: string | null, slug = 'ai-review-app'): CheckRun => ({
  id,
  status: 'completed',
  conclusion,
  external_id: kind ? `ai-review:${kind}:${id}` : null,
  app: { slug },
  output: { title: `AI review: ${conclusion}` },
});

/** A fake GitHub holding check runs on one commit; POSTed check runs are appended like the real API. */
function fakeRepo(opts: { checks?: CheckRun[]; role?: string; head?: string; base?: string } = {}) {
  const checks = [...(opts.checks ?? [])];
  const calls: Call[] = [];
  const gh: Gh = (args, body) => {
    calls.push({ args, body });
    const route = args.join(' ');
    if (route.includes('/permission')) return JSON.stringify({ role_name: opts.role ?? 'admin' });
    if (route.includes('/commits/')) return JSON.stringify({ check_runs: checks });
    if (route.startsWith('repos/o/r/pulls/7')) return JSON.stringify({ head: { sha: opts.head ?? SHA }, base: { ref: opts.base ?? 'develop' } });
    if (route === '-X POST repos/o/r/check-runs') {
      const b = body as { conclusion: string; external_id?: string };
      checks.push({ ...check(checks.length + 100, b.conclusion, null), external_id: b.external_id ?? null });
    }
    return '{}';
  };
  return { gh, calls, checks };
}

describe('result kinds', () => {
  it('marks a confirmed blocking finding apart from an incomplete review', () => {
    expect(resultKind('failure', 'failure')).toBe('blocking');
    expect(resultKind('success', 'failure')).toBe('incomplete');
    expect(resultKind('success', 'neutral')).toBe('incomplete');
    expect(resultKind('success', 'success')).toBe('clean');
    expect(kindOf(externalId('incomplete', '42'))).toBe('incomplete');
    expect(kindOf('ai-review:bogus:1')).toBeNull();
    expect(kindOf(null)).toBeNull();
  });

  it('keeps a size-limited review incomplete, not blocking, in gate mode (claim 2)', () => {
    const capped = capDiff('x'.repeat(DIFF_CAP + 1), ['a.ts']);
    expect(capped.truncated).toBe(true);
    const c = gated(finalConclusion({ conclusion: 'success' } as never, [], ['truncated']), 'gate');
    expect(c).toBe('failure');
    expect(resultKind('success', c)).toBe('incomplete');
  });

  it('a documentation line with an emoji still trips the wire, and the result stays overridable (claim 3)', () => {
    const diff = ['diff --git a/README.md b/README.md', '--- a/README.md', '+++ b/README.md', '@@ -1,0 +1,1 @@', '+\u26a0\ufe0f Read this first.'].join('\n');
    expect(tripwire(diff).length).toBeGreaterThan(0);
    const c = gated(finalConclusion({ conclusion: 'success' } as never, [], ['tripwire']), 'gate');
    expect(resultKind('success', c)).toBe('incomplete');
  });
});

describe('listChecks', () => {
  it('keeps only completed checks from the given app, newest first', () => {
    const { gh } = fakeRepo({ checks: [check(1, 'failure', 'incomplete'), check(3, 'success', 'clean', 'github-actions'), check(2, 'success', 'clean')] });
    expect(listChecks(gh, 'o/r', SHA, 'ai-review-app').map((c) => c.id)).toEqual([2, 1]);
  });
});

describe('holdEarlierFailure (claim 14)', () => {
  const clean = { conclusion: 'success' as const, kind: 'clean' as const };
  it('a clean re-run on the same commit keeps an earlier review failure', () => {
    expect(holdEarlierFailure([check(1, 'failure', 'blocking')], clean)).toMatchObject({ conclusion: 'failure', kind: 'blocking', held: true });
    expect(holdEarlierFailure([check(1, 'failure', 'incomplete')], clean)).toMatchObject({ conclusion: 'failure', kind: 'incomplete', held: true });
    expect(holdEarlierFailure([check(1, 'failure', null)], clean)).toMatchObject({ conclusion: 'failure', kind: 'blocking', held: true });
  });
  it('a completed review replaces a failure where no review ran', () => {
    expect(holdEarlierFailure([check(1, 'failure', 'unfinished')], clean).held).toBe(false);
    expect(holdEarlierFailure([check(1, 'failure', 'unconfigured')], clean).held).toBe(false);
  });
  it('after an override or a pass, a re-run posts its own result', () => {
    expect(holdEarlierFailure([check(1, 'success', 'override')], clean).held).toBe(false);
    expect(holdEarlierFailure([], clean).held).toBe(false);
  });
  it('failure, clean mention re-run, then override: only the override passes', () => {
    const { gh, checks } = fakeRepo({ checks: [check(1, 'failure', 'incomplete')] });
    const next = holdEarlierFailure(listChecks(gh, 'o/r', SHA, 'ai-review-app'), clean);
    postResult(gh, { ...post, headSha: SHA, conclusion: next.conclusion, externalId: externalId(next.kind, '2') }, () => {});
    expect(checks.at(-1)!.conclusion).toBe('failure');
    expect(applyOverride(gh, override, () => {})).toBe('posted');
    expect(checks.at(-1)!.conclusion).toBe('success');
    expect(kindOf(checks.at(-1)!.external_id)).toBe('override');
  });
});

const override: OverrideInput = {
  repo: 'o/r',
  pr: 7,
  sha: SHA,
  actor: 'storm',
  reason: 'Tripwire hit on an emoji in the changelog; read by hand.',
  appSlug: 'ai-review-app',
  runId: '99',
  runUrl: 'https://github.com/o/r/actions/runs/99',
  now: new Date('2026-10-16T12:00:00Z'),
};

describe('applyOverride (claim 4)', () => {
  it('passes an incomplete review for one SHA and records who, when, why and the SHA', () => {
    const { gh, calls } = fakeRepo({ checks: [check(1, 'failure', 'incomplete')] });
    expect(applyOverride(gh, override, () => {})).toBe('posted');
    const posted = calls.find((c) => c.args.join(' ') === '-X POST repos/o/r/check-runs')!.body as {
      head_sha: string;
      conclusion: string;
      external_id: string;
      output: { title: string; summary: string };
    };
    expect(posted.head_sha).toBe(SHA);
    expect(posted.conclusion).toBe('success');
    expect(posted.external_id).toBe('ai-review:override:99');
    for (const part of ['@storm', '2026-10-16T12:00:00.000Z', SHA, 'emoji in the changelog', 'actions/runs/99']) {
      expect(posted.output.summary).toContain(part);
    }
    expect(calls.some((c) => c.args.join(' ') === '-X POST repos/o/r/issues/7/comments')).toBe(true);
  });

  it('passes a commit where no review result was posted (crash or timeout)', () => {
    const { gh } = fakeRepo();
    expect(applyOverride(gh, override, () => {})).toBe('posted');
  });

  it('refuses a confirmed blocking finding and an unmarked failure', () => {
    expect(() => applyOverride(fakeRepo({ checks: [check(1, 'failure', 'blocking')] }).gh, override, () => {})).toThrow(/blocking/);
    expect(() => applyOverride(fakeRepo({ checks: [check(1, 'failure', null)] }).gh, override, () => {})).toThrow(/blocking/);
  });

  it('refuses an actor below the maintain role', () => {
    for (const role of ['write', 'triage', 'read']) {
      const { gh, calls } = fakeRepo({ role, checks: [check(1, 'failure', 'incomplete')] });
      expect(() => applyOverride(gh, override, () => {})).toThrow(/maintain/);
      expect(calls.some((c) => c.args.includes('-X'))).toBe(false);
    }
    expect(applyOverride(fakeRepo({ role: 'maintain' }).gh, override, () => {})).toBe('posted');
  });

  it('refuses a SHA that is not the PR head, a short SHA, and an empty reason', () => {
    expect(() => applyOverride(fakeRepo({ head: 'b'.repeat(40) }).gh, override, () => {})).toThrow(/not the head/);
    expect(() => applyOverride(fakeRepo().gh, { ...override, sha: 'aaaa' }, () => {})).toThrow(/40-character/);
    expect(() => applyOverride(fakeRepo().gh, { ...override, reason: '  ' }, () => {})).toThrow(/reason/);
  });

  it('does nothing when the commit already passes', () => {
    const { gh, calls } = fakeRepo({ checks: [check(1, 'success', 'clean')] });
    expect(applyOverride(gh, override, () => {})).toBe('nothing-to-override');
    expect(calls.some((c) => c.args.includes('-X'))).toBe(false);
  });
});

describe('override workflow', () => {
  const yml = readFileSync('.github/workflows/ai-review.yml', 'utf8');
  it('takes the override through workflow_dispatch, with inputs only in env', () => {
    expect(yml).toMatch(/override_sha:\n\s+description:/);
    expect(yml).toMatch(/override_reason:\n\s+description:/);
    expect(yml).toContain("if: github.event_name == 'workflow_dispatch' && inputs.override_sha != '' && github.ref == 'refs/heads/develop'");
    expect(yml).toContain("(github.event_name == 'workflow_dispatch' && inputs.override_sha == '' && github.ref == 'refs/heads/develop')");
    expect(yml).toContain('AI_REVIEW_OVERRIDE_REASON: ${{ inputs.override_reason }}');
    expect(yml).toContain('AI_REVIEW_ACTOR: ${{ github.triggering_actor }}');
    expect(yml.split('\n').filter((l) => l.includes('inputs.override_reason'))).toHaveLength(1);
  });
  it('marks every check the workflow posts with its kind', () => {
    expect(yml).toContain('external_id="ai-review:unconfigured:${GITHUB_RUN_ID}"');
  });
});

describe('dedicated App token (claim 5)', () => {
  const yml = readFileSync('.github/workflows/ai-review.yml', 'utf8');

  it('stays advisory without the App, whatever gate.json says', () => {
    const logs: string[] = [];
    expect(effectiveMode('gate', undefined, (m) => logs.push(m))).toBe('advisory');
    expect(effectiveMode('gate', '', (m) => logs.push(m))).toBe('advisory');
    expect(logs).toHaveLength(2);
    expect(effectiveMode('gate', 'ai-review-app', () => {})).toBe('gate');
    expect(effectiveMode('advisory', 'ai-review-app', () => {})).toBe('advisory');
  });

  it('mints the App token from its own secrets in every job that posts', () => {
    expect(yml.match(/uses: actions\/create-github-app-token@v1/g)?.length).toBe(yml.match(/^  [a-z]+:\n(?:    .*\n)*?    runs-on:/gm)?.length);
    expect(yml).toContain('app-id: ${{ secrets.AI_REVIEW_APP_ID }}');
    expect(yml).toContain('private-key: ${{ secrets.AI_REVIEW_APP_PRIVATE_KEY }}');
    expect(yml).toContain("HAS_APP: ${{ secrets.AI_REVIEW_APP_ID != '' && secrets.AI_REVIEW_APP_PRIVATE_KEY != '' }}");
  });

  it('downgrades gate to advisory in the workflow when the App token is missing', () => {
    expect(yml).toMatch(/if \[ "\$MODE" = gate \] && \[ "\$APP_TOKEN" != true \]; then\n\s+echo "::warning::[^\n]*\n\s+MODE=advisory/);
  });

  it('posts every gate result with the App token, never GITHUB_TOKEN alone', () => {
    // Each step that posts a check sets GH_TOKEN from the App step; the finalizer (gate only) has no fallback.
    expect(yml).toMatch(/Post a failure for an unfinished review\n\s+if: [^\n]*\n\s+env:\n\s+GH_TOKEN: \$\{\{ steps\.app\.outputs\.token \}\}\n/);
    // Fallback to GITHUB_TOKEN only where no pass can be posted: the config step (neutral or a gate
    // failure) and the review step (advisory when the App is absent, see effectiveMode).
    expect(yml.match(/GH_TOKEN: \$\{\{ steps\.app\.outputs\.token \|\| github\.token \}\}/g)?.length).toBe(2);
    expect(yml.match(/AI_REVIEW_APP_SLUG: \$\{\{ steps\.app\.outputs\.app-slug \}\}/g)?.length).toBe(3);
  });

  it('documents pinning the required check to the App integration_id', () => {
    expect(yml).toContain('integration_id');
  });
});

describe('timeout finalizer (claim 9)', () => {
  const yml = readFileSync('.github/workflows/ai-review.yml', 'utf8');
  const fin = { repo: 'o/r', pr: 7, sha: SHA, appSlug: 'ai-review-app', runId: '5' };

  it('runs as its own job after the review job, whatever its result', () => {
    const job = yml.slice(yml.indexOf('  finalize:\n'), yml.indexOf('  override:\n'));
    expect(job).toContain('needs: review');
    expect(job).toContain("    if: always() && needs.review.result != 'success' && needs.review.result != 'skipped'\n");
    // It decides from its own read of gate.json, never from the review job's outputs (a timeout can leave them unset).
    const jobIf = /\n    if: ([^\n]*)\n/.exec(job)![1]!;
    expect(jobIf).not.toContain('outputs');
    expect(job).toContain('jq -r .mode reviewer/.github/ai-review/gate.json');
    expect(job).toMatch(/advisory\|gate\) ;;\n\s+\*\) echo "::error::[^\n]*"; exit 1 ;;/);
    expect(job).toMatch(/if \[ "\$MODE" = gate \] && \[ "\$APP_TOKEN" != true \]; then\n[^\n]*\n\s+MODE=advisory/);
    expect(job.match(/if: steps\.mode\.outputs\.mode == 'gate'/g)?.length).toBe(2);
    expect(job).not.toContain("needs.review.outputs.mode");
    expect(job).toContain('gate-run.ts finalize');
    // The review job no longer finalizes itself: a timed-out job runs none of its own later steps.
    expect(yml).not.toContain('Block on a crashed run');
  });

  it('posts an unfinished failure when nothing was posted for the head SHA', () => {
    const { gh, checks } = fakeRepo();
    expect(finalizeUnfinished(gh, fin, () => {})).toBe('posted');
    expect(checks).toHaveLength(1);
    expect(checks[0]!.conclusion).toBe('failure');
    expect(kindOf(checks[0]!.external_id)).toBe('unfinished');
  });

  it('stays quiet when a completed result is already on the SHA (claim 13)', () => {
    for (const prior of [check(1, 'success', 'clean'), check(1, 'failure', 'blocking'), check(1, 'success', 'override')]) {
      const { gh, calls } = fakeRepo({ checks: [prior] });
      expect(finalizeUnfinished(gh, fin, () => {})).toBe('result-exists');
      expect(calls.some((c) => c.args.includes('-X'))).toBe(false);
    }
  });

  it('ignores ai-review checks from another app, so a spoofed check cannot silence it', () => {
    const { gh } = fakeRepo({ checks: [check(1, 'success', 'clean', 'github-actions')] });
    expect(finalizeUnfinished(gh, fin, () => {})).toBe('posted');
  });

  it('posts nothing when the head moved', () => {
    const { gh, calls } = fakeRepo({ head: 'b'.repeat(40) });
    expect(finalizeUnfinished(gh, fin, () => {})).toBe('head-moved');
    expect(calls.some((c) => c.args.includes('-X'))).toBe(false);
  });

  it('a placeholder failure gives way to the next completed review', () => {
    const { gh, checks } = fakeRepo();
    finalizeUnfinished(gh, fin, () => {});
    const next = holdEarlierFailure(listChecks(gh, 'o/r', SHA, 'ai-review-app'), { conclusion: 'success', kind: 'clean' });
    expect(next.held).toBe(false);
    expect(checks).toHaveLength(1);
  });
});

describe('workflow triggers and mode (claims 7, 8, 10)', () => {
  const yml = readFileSync('.github/workflows/ai-review.yml', 'utf8');
  it('reviews a reopened PR and a PR retargeted to develop, not every description edit', () => {
    expect(yml).toContain('types: [opened, synchronize, reopened, edited, ready_for_review, labeled]');
    expect(yml).toMatch(/pull_request_target:\n(?:\s+#[^\n]*\n)?\s+types: [^\n]*\n\s+branches: \[develop\]/);
    expect(yml).toContain("(github.event.action != 'edited' || github.event.changes.base)");
  });

  it('skips Dependabot-authored PRs inside the pull_request_target clause only (#473)', () => {
    const jobIf = /\n  review:\n    if: >-\n((?:      .*\n)+)/.exec(yml)![1]!;
    const [pullRequestTarget, ...others] = jobIf.split(/\n\s+\|\| /);
    expect(pullRequestTarget).toContain("github.event.pull_request.user.login != 'dependabot[bot]'");
    expect(pullRequestTarget).toContain('github.event.pull_request.draft != true');
    expect(others.join('\n')).not.toContain('dependabot');
    expect(yml.match(/dependabot\[bot\]/g)).toHaveLength(1);
  });

  it('fails the config step on an unknown mode before anything is posted', () => {
    const cfg = yml.slice(yml.indexOf('id: cfg'), yml.indexOf('Checkout PR head'));
    const caseAt = cfg.indexOf('case "$MODE" in');
    expect(caseAt).toBeGreaterThan(-1);
    expect(cfg).toMatch(/advisory\|gate\) ;;\n\s+\*\) echo "::error::[^\n]*"; exit 1 ;;/);
    expect(caseAt).toBeLessThan(cfg.indexOf('gh api'));
  });
});

describe('review findings: withheld path and blocking history (fix A)', () => {
  it('a withheld or incomplete result never replaces an earlier confirmed blocking finding', () => {
    const earlier = [check(2, 'failure', 'incomplete'), check(1, 'failure', 'blocking')];
    for (const next of [
      { conclusion: 'failure' as const, kind: 'withheld' as const },
      { conclusion: 'failure' as const, kind: 'incomplete' as const },
      { conclusion: 'success' as const, kind: 'clean' as const },
    ]) {
      expect(holdEarlierFailure(earlier, next)).toMatchObject({ conclusion: 'failure', kind: 'blocking', held: true });
    }
  });

  it('a placeholder after an incomplete failure does not let a pass through', () => {
    const earlier = [check(2, 'failure', 'unfinished'), check(1, 'failure', 'incomplete')];
    expect(holdEarlierFailure(earlier, { conclusion: 'success', kind: 'clean' })).toMatchObject({ conclusion: 'failure', kind: 'incomplete', held: true });
  });

  it('the override refuses when any check on the SHA was a confirmed blocking finding, not only the latest', () => {
    const { gh, calls } = fakeRepo({ checks: [check(2, 'failure', 'withheld'), check(1, 'failure', 'blocking')] });
    expect(() => applyOverride(gh, override, () => {})).toThrow(/blocking/);
    expect(calls.some((c) => c.args.includes('-X'))).toBe(false);
  });

  it('run.ts routes the withheld post through the same hold rule', () => {
    const run = readFileSync('scripts/ai-review/run.ts', 'utf8');
    const leaked = run.slice(run.indexOf('if (leaked) {'), run.indexOf('markPosted();'));
    expect(leaked).toContain("hold({ conclusion: gated('neutral', mode), kind: 'withheld' })");
    expect(leaked).toContain('conclusion: w.conclusion');
    expect(leaked).toContain('external_id: externalId(w.kind, runId)');
  });
});

describe('override durability (fix B)', () => {
  const earlier = [check(2, 'success', 'override'), check(1, 'failure', 'incomplete')];
  it('a rerun after an override keeps the pass unless it finds a confirmed blocking finding', () => {
    for (const kind of ['incomplete', 'withheld'] as const) {
      expect(holdEarlierFailure(earlier, { conclusion: 'failure', kind })).toMatchObject({ conclusion: 'success', kind: 'override', held: true });
    }
    expect(holdEarlierFailure(earlier, { conclusion: 'success', kind: 'clean' })).toMatchObject({ conclusion: 'success', held: false });
    expect(holdEarlierFailure(earlier, { conclusion: 'failure', kind: 'blocking' })).toMatchObject({ conclusion: 'failure', kind: 'blocking', held: false });
  });

  it('end to end: incomplete, override, incomplete rerun still passes; a blocking rerun fails and stays failed', () => {
    const { gh, checks } = fakeRepo({ checks: [check(1, 'failure', 'incomplete')] });
    applyOverride(gh, override, () => {});
    const rerun = (next: { conclusion: 'success' | 'failure'; kind: 'incomplete' | 'blocking' | 'clean' }) => {
      const r = holdEarlierFailure(listChecks(gh, 'o/r', SHA, 'ai-review-app'), next);
      postResult(gh, { ...post, headSha: SHA, conclusion: r.conclusion, externalId: externalId(r.kind, 'x') }, () => {});
      return checks.at(-1)!;
    };
    expect(rerun({ conclusion: 'failure', kind: 'incomplete' }).conclusion).toBe('success');
    expect(rerun({ conclusion: 'failure', kind: 'blocking' }).conclusion).toBe('failure');
    expect(rerun({ conclusion: 'success', kind: 'clean' }).conclusion).toBe('failure');
    expect(() => applyOverride(gh, override, () => {})).toThrow(/blocking/);
  });
});

describe('finalizer without the review job outputs (fix C)', () => {
  const fin = { repo: 'o/r', pr: 7, sha: '', appSlug: 'ai-review-app', runId: '5' };
  it('covers the PR head when the review job died before resolving the SHA', () => {
    const { gh, checks } = fakeRepo();
    expect(finalizeUnfinished(gh, fin, () => {})).toBe('posted');
    expect(kindOf(checks[0]!.external_id)).toBe('unfinished');
  });
  it('posts nothing for a PR that does not target develop', () => {
    const { gh, calls } = fakeRepo({ base: 'main' });
    expect(finalizeUnfinished(gh, fin, () => {})).toBe('not-develop');
    expect(calls.some((c) => c.args.includes('-X'))).toBe(false);
  });
});

describe('round 2: override needs the App, unconfigured never revokes', () => {
  const yml = readFileSync('.github/workflows/ai-review.yml', 'utf8');
  const job = yml.slice(yml.indexOf('  override:\n'));

  it('the override job refuses without the App token and has no GITHUB_TOKEN fallback', () => {
    expect(job).toMatch(/- name: Require the ai-review App\n\s+if: steps\.app\.outputs\.token == ''\n\s+run: \|\n\s+echo "::error::[^\n]*"\n\s+exit 1/);
    expect(job.indexOf('Require the ai-review App')).toBeLessThan(job.indexOf('Apply the maintainer override'));
    expect(job).toContain('GH_TOKEN: ${{ steps.app.outputs.token }}\n');
    expect(job).not.toContain('github.token');
    const cli = readFileSync('scripts/ai-review/gate-run.ts', 'utf8');
    expect(cli).toMatch(/action === 'override' && !process\.env\.AI_REVIEW_APP_SLUG\) \{\n[^\n]*\n\s+process\.exit\(1\)/);
  });

  it('the unconfigured placeholder is posted in gate mode only when no App result is on the SHA', () => {
    const cfg = yml.slice(yml.indexOf('id: cfg'), yml.indexOf('Checkout PR head'));
    const lookup = cfg.indexOf('select(.status == "completed" and .app.slug == env.APP_SLUG)');
    expect(lookup).toBeGreaterThan(-1);
    expect(lookup).toBeLessThan(cfg.indexOf('gh api -X POST'));
    expect(cfg).toMatch(/if \[ "\$EXISTING" != 0 \]; then\n[^\n]*\n\s+exit 0/);
    expect(cfg).toContain('APP_SLUG: ${{ steps.app.outputs.app-slug }}');
  });
});

describe('App secrets stay on develop (finding A)', () => {
  const yml = readFileSync('.github/workflows/ai-review.yml', 'utf8');
  const jobs = ['review', 'finalize', 'override'].map((name) => {
    const start = yml.indexOf(`\n  ${name}:\n`);
    const next = yml.slice(start + 1).search(/\n  [a-z]+:\n/);
    return yml.slice(start, next === -1 ? undefined : start + 1 + next);
  });

  it('runs every job that mints the App token in the ai-review environment', () => {
    for (const job of jobs) {
      expect(job).toContain('uses: actions/create-github-app-token@v1');
      expect(job).toContain('\n    environment: ai-review\n');
    }
  });

  it('checks the reviewer code out from develop in every job, whatever the triggering ref', () => {
    for (const job of jobs) {
      expect(job).toMatch(/- name: Checkout reviewer \(base branch\)\n(?:\s+if: [^\n]*\n)?\s+uses: actions\/checkout@v4\n\s+with:\n\s+path: reviewer\n\s+ref: develop\n/);
    }
    expect(yml.match(/path: reviewer\n/g)?.length).toBe(3);
  });

  it('deletes symlinks from the PR checkout before any reviewer reads it', () => {
    const step = yml.indexOf('run: find pr -type l -delete');
    expect(step).toBeGreaterThan(yml.indexOf('path: pr\n'));
    expect(step).toBeLessThan(yml.indexOf('- name: Run AI review'));
  });
});
