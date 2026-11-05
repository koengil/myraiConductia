/*
 * Gate actions that run without a review. Usage:
 *   tsx gate-run.ts override|finalize --repo owner/name --pr N --sha SHA
 * The reason and the actor come from env only (AI_REVIEW_OVERRIDE_REASON, AI_REVIEW_ACTOR), never argv.
 */
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

import { applyOverride, finalizeUnfinished, type Gh } from './gate';

const gh: Gh = (args, body) => {
  const r = spawnSync('gh', ['api', ...args, ...(body === undefined ? [] : ['--input', '-'])], {
    input: body === undefined ? undefined : JSON.stringify(body),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`gh api ${args.join(' ')} failed: ${r.stderr.trim().slice(0, 300)}`);
  return r.stdout;
};

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { repo: { type: 'string' }, pr: { type: 'string' }, sha: { type: 'string' } },
});
const action = positionals[0];
const repo = values.repo ?? '';
const pr = Number(values.pr);
const sha = values.sha ?? '';
// finalize may run without a SHA (the review job died before resolving it) and then covers the PR head.
if (!repo || !Number.isInteger(pr) || (!sha && action !== 'finalize') || (action !== 'override' && action !== 'finalize')) {
  console.error('usage: gate-run.ts override|finalize --repo owner/name --pr N --sha SHA');
  process.exit(2);
}
// A passing check is only ever posted with the dedicated App token, whose slug the workflow passes.
if (action === 'override' && !process.env.AI_REVIEW_APP_SLUG) {
  console.error('override: the ai-review App token is not configured; nothing was posted');
  process.exit(1);
}
const runId = process.env.GITHUB_RUN_ID ?? 'local';
const runUrl = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${runId}`;
const appSlug = process.env.AI_REVIEW_APP_SLUG || 'github-actions';

try {
  const out =
    action === 'finalize'
      ? finalizeUnfinished(gh, { repo, pr, sha, appSlug, runId })
      : applyOverride(gh, {
          repo,
          pr,
          sha,
          actor: process.env.AI_REVIEW_ACTOR ?? '',
          reason: process.env.AI_REVIEW_OVERRIDE_REASON ?? '',
          appSlug,
          runId,
          runUrl,
          now: new Date(),
        });
  console.log(`${action}: ${out}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
