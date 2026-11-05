/*
 * AI review orchestrator. I/O only: gh, the Claude Code CLI, files.
 * Logic lives in pipeline.ts. Usage:
 *   tsx run.ts --pr N --repo owner/name --head-dir DIR --config-dir DIR [--head-sha SHA] [--dry-run]
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { decide } from './decide';
import { effectiveMode, externalId, holdEarlierFailure, listChecks, postResult, resultKind, type ResultKind } from './gate';
import { parseReviewerOutput, parseVerdicts, type Finding, type Lens } from './findings';
import {
  anonymise,
  applyVerdicts,
  checkSummary,
  DIFF_INCOMPLETE_REASON,
  FILES_INCOMPLETE_REASON,
  gated,
  GITHUB_FILES_CAP,
  VERDICTS_INCOMPLETE_REASON,
  envelopeResult,
  evaluatorPrompt,
  extractJson,
  finalConclusion,
  judgeIncomplete,
  leaksSecret,
  parseMention,
  patchLines,
  rawDiffArgs,
  readGateMode,
  resolveModel,
  parseEvaluatorOutput,
  reconcileEvaluated,
  capDiff,
  claudeArgs,
  reviewerEnv,
  reviewerPrompt,
  seedFromSha,
  shapeResult,
  stripInvisible,
  TRIPWIRE_REASON,
  tripwire,
  validatorPrompt,
  type Conclusion,
  type LensRun,
  type ModelMap,
  type PrInfo,
} from './pipeline';
import { loadConfig, route, type ChangedFile } from './router';

const CLAUDE_TIMEOUT_MS = 15 * 60 * 1000;

const { values } = parseArgs({
  options: {
    pr: { type: 'string' },
    repo: { type: 'string' },
    'head-dir': { type: 'string' },
    'config-dir': { type: 'string' },
    'head-sha': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});
const prNumber = Number(values.pr);
const repo = values.repo;
const headDir = values['head-dir'] ? resolve(values['head-dir']) : '';
const configDir = values['config-dir'] ? resolve(values['config-dir']) : '';
if (!Number.isInteger(prNumber) || !repo || !headDir || !configDir) {
  console.error('usage: run.ts --pr N --repo owner/name --head-dir DIR --config-dir DIR [--dry-run]');
  process.exit(2);
}
const argHeadSha = values['head-sha'] ?? '';
if (!values['dry-run'] && !argHeadSha) {
  console.error('--head-sha is required outside a dry run');
  process.exit(2);
}
const dryRun = values['dry-run'] === true;
// Marks this run on every check it posts; the finalizer and the override read it back.
const runId = process.env.GITHUB_RUN_ID ?? 'local';
// The dedicated ai-review App, when its token is in GH_TOKEN; its earlier checks count on this commit.
const appSlug = process.env.AI_REVIEW_APP_SLUG || 'github-actions';

function gh(args: string[], body?: unknown): string {
  const r = spawnSync('gh', ['api', ...args, ...(body === undefined ? [] : ['--input', '-'])], {
    input: body === undefined ? undefined : JSON.stringify(body),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`gh api ${args.join(' ')} failed: ${r.stderr.trim().slice(0, 300)}`);
  return r.stdout;
}

/** True when the PR head is no longer the SHA this run was started for. */
function headMoved(expected: string): boolean {
  const pr = JSON.parse(gh([`repos/${repo}/pulls/${prNumber}`])) as { head: { sha: string } };
  return pr.head.sha !== expected;
}

function runClaude(prompt: string, model: string): Promise<string> {
  // In CI (token set) the reviewer gets an empty HOME so it finds no credentials or config.
  const home = process.env.CLAUDE_CODE_OAUTH_TOKEN ? mkdtempSync(join(tmpdir(), 'ai-review-home-')) : undefined;
  const cleanup = () => {
    if (home) rmSync(home, { recursive: true, force: true });
  };
  return new Promise<string>((res, rej) => {
    const child = spawn('claude', claudeArgs(model), {
      cwd: headDir,
      env: reviewerEnv(process.env, home) as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), CLAUDE_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      rej(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) rej(new Error(`claude exited ${code}: ${err.trim().slice(0, 300)}`));
      else res(out);
    });
    // Every prompt (reviewer, validator, evaluator) passes here, so hidden characters are removed once, here.
    child.stdin.end(stripInvisible(prompt));
  }).finally(cleanup);
}

async function askJson<T>(prompt: string, model: string, parse: (j: unknown) => T): Promise<T> {
  return parse(extractJson(envelopeResult(await runClaude(prompt, model))));
}

async function withRetry<T>(fn: () => Promise<T>): Promise<{ value?: T; attempts: number; error?: string }> {
  let error = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return { value: await fn(), attempts: attempt };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  return { attempts: 2, error };
}

type GhFile = { filename: string; previous_filename?: string; additions: number; deletions: number; patch?: string };

async function main() {
  const pr = JSON.parse(gh([`repos/${repo}/pulls/${prNumber}`])) as {
    base: { sha: string };
    head: { sha: string };
    labels: { name: string }[];
  };
  const files: GhFile[] = [];
  const incomplete: string[] = [];
  for (let page = 1; ; page++) {
    const batch = JSON.parse(gh([`repos/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`])) as GhFile[];
    files.push(...batch);
    if (batch.length < 100) break;
  }
  // GitHub stops listing at GITHUB_FILES_CAP files, so a PR that long is not fully listed.
  if (files.length >= GITHUB_FILES_CAP) incomplete.push(FILES_INCOMPLETE_REASON);
  // Re-fetch: the head may have moved while the files were paginated.
  if (argHeadSha && headMoved(argHeadSha)) {
    console.log(`head moved (${argHeadSha} -> now another SHA); a newer run handles it, posting nothing`);
    return;
  }
  const info: PrInfo = { number: prNumber, baseSha: pr.base.sha, headSha: argHeadSha || pr.head.sha };
  const changed: ChangedFile[] = files.map((f) => ({
    path: f.filename,
    previousPath: f.previous_filename,
    additions: f.additions,
    deletions: f.deletions,
  }));

  const { profiles, fence } = loadConfig(configDir);
  const models = JSON.parse(readFileSync(join(configDir, 'models.json'), 'utf8')) as ModelMap;
  const mode = effectiveMode(readGateMode(JSON.parse(readFileSync(join(configDir, 'gate.json'), 'utf8'))), process.env.AI_REVIEW_APP_SLUG);
  // The comment body comes from env only (never argv), and is data: it only steers lens choice and focus.
  const commentId = process.env.AI_REVIEW_COMMENT_ID;
  const mention = commentId
    ? parseMention(process.env.AI_REVIEW_COMMENT_BODY ?? '')
    : { mentioned: true, focus: null as string | null, keywords: [] as string[] };
  if (commentId && !mention.mentioned) {
    console.log('comment does not mention @ai-reviewer; nothing to do');
    return;
  }
  if (commentId && !dryRun) {
    try {
      gh(['-X', 'POST', `repos/${repo}/issues/comments/${commentId}/reactions`], { content: 'eyes' });
    } catch (e) {
      console.error(`reaction failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const r = route({ files: changed, labels: pr.labels.map((l) => l.name) }, profiles, fence, mention.keywords);
  console.log(`routed: ${r.lenses.join(', ')} small=${r.small} fenced=${r.fenced.length} strictness=${r.strictness}`);

  const modelsUsed: Record<string, string> = {};
  const promptOf = (name: string) => readFileSync(join(configDir, 'prompts', `${name}.md`), 'utf8');

  // Resolve every model first so an unwired one fails before any spend.
  const lensModels = new Map<Lens, string>();
  for (const lens of r.lenses) {
    const model = resolveModel(models, profiles.lenses[lens].model[models.phase]);
    lensModels.set(lens, model);
    modelsUsed[lens] = model;
  }
  const judgeModel = resolveModel(models, 'claude-generalist');
  modelsUsed.validator = judgeModel;
  modelsUsed.evaluator = judgeModel;

  const gitDiff = spawnSync('git', rawDiffArgs(headDir, info.baseSha, info.headSha), {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (gitDiff.status !== 0) throw new Error(`git diff failed: ${String(gitDiff.stderr).trim().slice(0, 300)}`);
  // Tripwire on the raw diff, before stripping or capping: hidden text must be seen before any model reads it.
  const tripHits = tripwire(gitDiff.stdout);
  if (tripHits.length > 0) incomplete.push(TRIPWIRE_REASON);
  const capped = capDiff(gitDiff.stdout, changed.map((c) => c.path));
  const diff = capped.text;
  if (capped.truncated) incomplete.push(DIFF_INCOMPLETE_REASON);

  const runs: LensRun[] = [];
  const byLens = new Map<Lens, Finding[]>();
  await Promise.all(
    r.lenses.map(async (lens) => {
      const started = Date.now();
      const model = lensModels.get(lens)!;
      const out = await withRetry(() =>
        askJson(reviewerPrompt(promptOf(lens), info, diff, mention.focus), model, (j) => parseReviewerOutput(j)),
      );
      const findings = out.value?.findings ?? [];
      byLens.set(lens, findings.map((f) => ({ ...f, lens })));
      runs.push({
        role: 'lens',
        lens,
        model,
        status: out.value ? 'ok' : 'failed',
        attempts: out.attempts,
        durationMs: Date.now() - started,
        findings: findings.length,
        error: out.error,
      });
      console.log(`lens ${lens}: ${out.value ? 'ok' : 'FAILED'} findings=${findings.length}`);
    }),
  );

  // Router lens order, not completion order, so the shuffle input is reproducible.
  const raw: Finding[] = r.lenses.flatMap((l) => byLens.get(l) ?? []);

  const seed = seedFromSha(info.headSha);
  let judged = { confirmed: [] as Finding[], rejected: [] as Finding[], unclear: [] as Finding[], missing: [] as Finding[] };
  if (raw.length > 0) {
    const anon = anonymise(raw, seed);
    const vStarted = Date.now();
    const v = await withRetry(() =>
      askJson(validatorPrompt(promptOf('validator'), info, anon.items), judgeModel, (j) => parseVerdicts(j)),
    );
    if (!v.value) {
      runs.push({ role: 'validator', model: judgeModel, status: 'failed', attempts: v.attempts, durationMs: Date.now() - vStarted, findings: 0, error: `validator: ${v.error}` });
    } else {
      judged = applyVerdicts(v.value, anon.back);
      if (judgeIncomplete(judged)) {
        incomplete.push(VERDICTS_INCOMPLETE_REASON);
        runs.push({ role: 'validator', model: judgeModel, status: 'failed', attempts: v.attempts, durationMs: Date.now() - vStarted, findings: 0, error: 'incomplete verdicts' });
      }
    }
  }

  let final = judged.confirmed;
  if (r.runEvaluator && final.length > 1) {
    const anon = anonymise(final, seed ^ 0x9e3779b9);
    const eStarted = Date.now();
    const e = await withRetry(() =>
      askJson(evaluatorPrompt(promptOf('evaluator'), info, anon.items), judgeModel, (j) => parseEvaluatorOutput(j)),
    );
    if (e.value) final = reconcileEvaluated(e.value, anon.back);
    else runs.push({ role: 'evaluator', model: judgeModel, status: 'failed', attempts: e.attempts, durationMs: Date.now() - eStarted, findings: 0, error: `evaluator: ${e.error}` });
  }

  const decision = decide({ route: r, findings: final });
  const conclusion = gated(finalConclusion(decision, runs, incomplete), mode);
  const summary = checkSummary(decision, runs, judged.unclear.length, incomplete, tripHits);
  const result = shapeResult({ headSha: info.headSha, route: r, runs, raw: raw.length, judged, final, decision, conclusion, models: modelsUsed, strictness: r.strictness, focus: mention.focus, tripwire: tripHits });

  const visible = new Map(files.map((f) => [f.filename, patchLines(f.patch)]));
  const inline = final.filter((f) => visible.get(f.file)?.has(f.line));
  const rest = final.filter((f) => !inline.includes(f));
  const text = (f: Finding) => `**${f.severity}** ${f.claim}\n\n${f.evidence}`;
  const body = [
    summary,
    ...(rest.length ? ['', '#### Findings outside the diff', ...rest.map((f) => `- \`${f.file}:${f.line}\` ${text(f)}`)] : []),
  ].join('\n');
  const comments = inline.map((f) => ({ path: f.file, line: f.line, side: 'RIGHT', body: text(f) }));

  // Scan everything that is written or posted: the artifact, the review body and every inline comment.
  const secrets = [process.env.CLAUDE_CODE_OAUTH_TOKEN, process.env.GH_TOKEN, process.env.GITHUB_TOKEN];
  const echo = mention.focus ? ` Focus: ${mention.focus.replace(/\s+/g, ' ').slice(0, 120)}` : '';
  const replyFor = (c: string) => (commentId ? `AI review (${r.strictness}): ${c}, ${final.length} finding(s).${echo}` : null);
  const reply = replyFor(conclusion);
  const leaked = leaksSecret(JSON.stringify({ result, summary, body, comments, reply }), secrets);
  // The artifact keeps counts only when the output may hold a secret.
  const counts = { raw: raw.length, confirmed: judged.confirmed.length, rejected: judged.rejected.length, final: final.length };
  writeFileSync('ai-review-result.json', JSON.stringify(leaked ? { headSha: info.headSha, withheld: true, counts } : result, null, 2));
  console.log(`conclusion=${conclusion} final=${final.length} confirmed=${judged.confirmed.length} rejected=${judged.rejected.length} unclear=${judged.unclear.length}`);
  if (dryRun) return;

  // The head may have moved during the review; a newer run posts instead.
  if (headMoved(info.headSha)) {
    console.log(`head moved during the review (${info.headSha}); a newer run handles it, posting nothing`);
    return;
  }

  // Gate mode: every post, the withheld one included, goes through the same rule for this commit's
  // earlier results; only the maintainer override clears a failure.
  const hold = (next: { conclusion: Conclusion; kind: ResultKind }) =>
    mode === 'gate' ? holdEarlierFailure(listChecks(gh, repo!, info.headSha, appSlug), next) : { ...next, held: false, note: undefined };

  if (leaked) {
    const w = hold({ conclusion: gated('neutral', mode), kind: 'withheld' });
    const withheld = 'The review output contained a token-shaped string, so nothing was posted. A maintainer should read the run log.';
    gh(['-X', 'POST', `repos/${repo}/check-runs`], {
      name: 'ai-review',
      head_sha: info.headSha,
      status: 'completed',
      conclusion: w.conclusion,
      external_id: externalId(w.kind, runId),
      output: { title: 'AI review: output withheld', summary: w.note ? `${w.note}\n\n${withheld}` : withheld },
    });
    markPosted();
    return;
  }

  const posted = hold({ conclusion, kind: resultKind(decision.conclusion, conclusion) });
  if (posted.held) console.log(`an earlier result on ${info.headSha} stands (${posted.kind}); this run found ${conclusion}`);

  postResult(gh, {
    repo: repo!,
    pr: prNumber,
    headSha: info.headSha,
    conclusion: posted.conclusion,
    summary: posted.note ? `${posted.note}\n\nThis run: ${conclusion}.\n\n${summary}` : summary,
    body,
    comments,
    reply: replyFor(posted.conclusion),
    needsHuman: decision.needsHuman || incomplete.length > 0,
    externalId: externalId(posted.kind, runId),
  });
  markPosted();
}

/** Tells the workflow a final check was posted, so its crash finalizer stays quiet. */
function markPosted() {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'posted=true\n');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
