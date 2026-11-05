/*
 * Weekly AI review scoring. I/O only: gh, unzip, stdout, $GITHUB_STEP_SUMMARY.
 * Usage: score-run.ts --repo owner/name [--days 7]
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { aggregate, isAiReviewer, latestPerPr, parseArtifactName, renderTable, type RunResult, type ScoredRun, type Thread } from './score';

type Artifact = { id: number; name: string; created_at: string; expired: boolean };

function run(cmd: string, args: string[], input?: string): Buffer {
  const r = spawnSync(cmd, args, { input, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed: ${r.stderr.toString().trim().slice(0, 300)}`);
  return r.stdout;
}

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (!v) throw new Error(`missing --${name}`);
  return v;
}

const QUERY = `query($owner:String!,$name:String!,$pr:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$pr){
reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{isResolved isOutdated comments(first:1){nodes{author{login} path line originalLine}}}}}}}`;

function threadsFor(repo: string, pr: number): Thread[] {
  const [owner, name] = repo.split('/');
  const out: Thread[] = [];
  let after: string | null = null;
  for (;;) {
    const args = ['api', 'graphql', '-f', `query=${QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `pr=${pr}`];
    if (after) args.push('-F', `after=${after}`);
    const page = JSON.parse(run('gh', args).toString()).data.repository.pullRequest.reviewThreads;
    for (const n of page.nodes) {
      const c = n.comments.nodes[0];
      if (!c) continue;
      const login: string = c.author?.login ?? '';
      out.push({
        isResolved: n.isResolved,
        isOutdated: n.isOutdated,
        bot: isAiReviewer(login),
        path: c.path,
        line: c.line,
        originalLine: c.originalLine,
      });
    }
    if (!page.pageInfo.hasNextPage) return out;
    after = page.pageInfo.endCursor;
  }
}

function main() {
  const repo = arg('repo');
  const days = Number(arg('days', '7'));
  const since = Date.now() - days * 86_400_000;

  const listed = run('gh', ['api', '--paginate', `repos/${repo}/actions/artifacts?per_page=100`, '--jq', '.artifacts[] | @json'])
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Artifact)
    .filter((a) => !a.expired && Date.parse(a.created_at) >= since && parseArtifactName(a.name) !== null);
  // The score is a per-PR snapshot of the latest review: keep only the newest artifact per PR.
  const newest = latestPerPr(listed);

  const dir = mkdtempSync(join(tmpdir(), 'ai-review-score-'));
  const runs: ScoredRun[] = [];
  try {
    for (const a of newest) {
      try {
        const zip = join(dir, `${a.id}.zip`);
        writeFileSync(zip, run('gh', ['api', `repos/${repo}/actions/artifacts/${a.id}/zip`]));
        const result = JSON.parse(run('unzip', ['-p', zip, 'ai-review-result.json']).toString()) as RunResult;
        runs.push({ pr: parseArtifactName(a.name) as number, result });
      } catch (e) {
        console.error(`skipping artifact ${a.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const threads = new Map<number, Thread[]>();
  for (const pr of new Set(runs.map((r) => r.pr))) threads.set(pr, threadsFor(repo, pr));

  const table = renderTable(aggregate(runs, threads), days, runs.length);
  console.log(table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
