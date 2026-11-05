// The eval's one command (design Q15):
//
//   EVAL_ANSWER_KEY_PATH=/secure/key.json npm --prefix evals/deal-discovery run score -- --export /tmp/dd-export
//     -> evals/out/scorecard-<run>.md and .html
//
//   EVAL_ANSWER_KEY_PATH=/secure/key.json npm --prefix evals/deal-discovery run check-key
//     validates the key and prints its counts, nothing from inside it
//
//   npm --prefix evals/deal-discovery run convert -- --ground-truth <file> --out <file>
//     builds the key from the seeder's ground truth, outside the repo
//     (convertGroundTruth.ts)
//
// Options for score:
//   --export <dir>  a directory written by `npm run discovery:export` (required)
//   --out <dir>     where the scorecard goes (default <repo>/evals/out, which
//                   is gitignored). Anywhere else inside the repo is refused.
//                   A scorecard written inside the repo is always redacted
//                   (review item 11): it would otherwise name the key's deals
//                   and hold key-only Message-IDs and paths. For the full
//                   scorecard of a real tenant, point --out outside the repo.
//   --redact        redact wherever the scorecard goes
//   --run <label>   the file suffix (default: the export's timestamp)
//
// A scorecard is never overwritten (review item 9): an existing file is an
// error, so pick another --run or --out. Each one prints the harness commit
// and the tuning digest it was scored with.
//
// Every command refuses to run from a dist/ built from other sources than
// src/ holds now (buildStamp.ts), so a score always matches the code it
// claims. Run it through npm, which builds first.
//
// It reads two local files and writes two. Besides git, which it asks for the
// repository root and the harness commit, it contacts no service: not the
// database (the export already happened) and not Microsoft.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AnswerKeyError, defaultRepoRoots, isInside, isInsideAny, loadAnswerKey, realRoots } from './answerKey.ts';
import { assertFreshBuild, PACKAGE_ROOT, StaleBuildError } from './buildStamp.ts';
import { ConvertError, runConvert } from './convertGroundTruth.ts';
import { ExportError, readExport } from './exportData.ts';
import { checkpointLine, formatRatio, provenanceLine, renderHtml, renderMarkdown } from './report.ts';
import { score, type ScoreOptions } from './score.ts';

export class UsageError extends Error {}

export type ScoreArgs = { exportDir: string; outDir: string | null; run: string | null; redact: boolean };

const RUN_LABEL = /^[A-Za-z0-9._-]{1,80}$/;

export function parseScoreArgs(argv: string[]): ScoreArgs {
  const args: ScoreArgs = { exportDir: '', outDir: null, run: null, redact: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--redact') {
      args.redact = true;
    } else if (flag === '--export' || flag === '--out' || flag === '--run') {
      if (!value || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      if (flag === '--export') args.exportDir = value;
      else if (flag === '--out') args.outDir = value;
      else args.run = value;
      i += 1;
    } else {
      throw new UsageError(`unknown argument ${flag}`);
    }
  }
  if (!args.exportDir) throw new UsageError('--export <dir> is required');
  if (args.run !== null && !RUN_LABEL.test(args.run)) {
    throw new UsageError('--run takes letters, digits, dot, dash and underscore only');
  }
  return args;
}

/** "2026-09-26T10:15:00.123Z" -> "20260926T101500Z". */
export function runLabelFor(exportedAt: string): string {
  const t = Date.parse(exportedAt);
  if (!Number.isFinite(t)) return 'export';
  return new Date(t).toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
}

/**
 * The scorecard's directory, and whether it lies inside the repository.
 * `repoRoot` is this checkout first, then any other root to stay out of (the
 * main checkout of a linked worktree). evals/out of this checkout is the
 * default and the only place inside the repo allowed. Checked before the
 * directory is created, then again once symlinks resolve.
 */
export function resolveOutDir(outDir: string | null, repoRoot: string | readonly string[]): { dir: string; insideRepo: boolean } {
  const given = typeof repoRoot === 'string' ? [repoRoot] : [...repoRoot];
  const roots = realRoots(given);
  const allowed = join(roots[0], 'evals', 'out');
  if (outDir === null) return { dir: allowed, insideRepo: true };
  const refuse = () =>
    new UsageError('--out points inside the repository. Use evals/out (gitignored) or a directory outside the repo.');
  const target = resolve(outDir);
  const lexicalRoots = given.map((r) => resolve(r));
  if (isInsideAny(lexicalRoots, target) && !isInside(resolve(given[0], 'evals', 'out'), target)) throw refuse();
  mkdirSync(target, { recursive: true });
  const real = realpathSync.native(target);
  const inside = isInsideAny(roots, real);
  if (inside && !isInside(allowed, real)) throw refuse();
  return { dir: real, insideRepo: inside };
}

/** The harness's commit, and whether evals/deal-discovery differs from it. */
export function harnessProvenance(): { commit: string; dirty: boolean } {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const git = (args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const commit = git(['rev-parse', 'HEAD']).trim();
    const top = git(['rev-parse', '--show-toplevel']).trim();
    const status = git(['-C', top, 'status', '--porcelain', '--untracked-files=all', '--', 'evals/deal-discovery']);
    // dist/ and node_modules/ are ignored, so a status line is a source change.
    return { commit, dirty: status.trim() !== '' };
  } catch {
    return { commit: 'unknown', dirty: true };
  }
}

export type ScoreResult = { markdownPath: string; htmlPath: string; redacted: boolean; headline: string[] };

export function runScore(
  argv: string[],
  options: {
    env?: Record<string, string | undefined>;
    repoRoot?: string | readonly string[];
    provenance?: ScoreOptions['provenance'];
  } = {},
): ScoreResult {
  const repoRoot = options.repoRoot ?? defaultRepoRoots();
  const args = parseScoreArgs(argv);
  const key = loadAnswerKey(options.env ?? process.env, repoRoot);
  const data = readExport(resolve(args.exportDir));

  const out = resolveOutDir(args.outDir, repoRoot);
  const run = args.run ?? runLabelFor(data.manifest.exportedAt);
  const markdownPath = join(out.dir, `scorecard-${run}.md`);
  const htmlPath = join(out.dir, `scorecard-${run}.html`);
  // Both checked before either is written, so a clash leaves nothing half-done.
  for (const path of [markdownPath, htmlPath]) {
    if (existsSync(path)) {
      throw new UsageError(`${path} already exists. A scorecard is never overwritten: pass another --run or --out.`);
    }
  }
  const redacted = args.redact || out.insideRepo;
  const card = score(key, data, { redact: redacted, provenance: options.provenance ?? harnessProvenance() });
  mkdirSync(out.dir, { recursive: true });
  writeFileSync(markdownPath, renderMarkdown(card), { mode: 0o600, flag: 'wx' });
  writeFileSync(htmlPath, renderHtml(card), { mode: 0o600, flag: 'wx' });

  const d = card.discovery;
  const pre = d.preRejection;
  const r = card.items.readUnrouted;
  const headline = [
    `Discovery precision (one-to-one) post-rejection ${formatRatio(d.precision)}, pre-rejection ${formatRatio(pre.precision)}`,
    `Discovery recall (one-to-one) post-rejection ${formatRatio(d.recall)}`,
    `Fragmentation post-rejection ${formatRatio(d.fragmentation)}, pre-rejection ${formatRatio(pre.fragmentation)}`,
    `Merge post-rejection ${formatRatio(d.merge)}, pre-rejection ${formatRatio(pre.merge)}`,
    `Item precision post-rejection ${formatRatio(card.items.precision)}, pre-rejection ${formatRatio(card.items.precisionPreRejection)}`,
    `Item recall post-rejection ${formatRatio(card.items.recall)}`,
    `Item recall on what the pipeline reads today ${formatRatio(card.items.readableRecall)}`,
    `Read, unrouted ${r.items} item${r.items === 1 ? '' : 's'}, ${formatRatio(r.share)} of true-deal items; ` +
      `item recall at most ${formatRatio(r.routingCeiling)} if routing were fixed, ` +
      `${formatRatio(r.attachmentCeiling)} if attachments were read as well`,
    checkpointLine(card),
    provenanceLine(card),
    redacted
      ? `Redacted${args.redact ? '' : ': the scorecard is inside the repository. For the full one, pass --out outside it'}.`
      : 'Not redacted: the scorecard names the key\'s deals and items. Keep it outside the repository.',
  ];
  return { markdownPath, htmlPath, redacted, headline };
}

export function runCheckKey(options: { env?: Record<string, string | undefined>; repoRoot?: string | readonly string[] } = {}): string {
  const key = loadAnswerKey(options.env ?? process.env, options.repoRoot ?? defaultRepoRoots());
  const messages = key.items.filter((i) => i.kind === 'message').length;
  const documents = key.items.length - messages;
  const attachmentOnly = key.items.filter((i) => i.kind === 'message' && i.attachmentOnly).length;
  const negatives = key.items.filter((i) => i.dealIds.length === 0).length;
  return (
    `The answer key is valid: ${key.deals.length} deals; ${messages} messages and ${documents} documents ` +
    `(${attachmentOnly} attachment-only, ${negatives} with no deal); coverage ${key.itemCoverage}.`
  );
}

function main(argv: string[]): void {
  const [command, ...rest] = argv;
  try {
    assertFreshBuild(PACKAGE_ROOT);
    if (command === 'score') {
      const result = runScore(rest);
      for (const line of result.headline) console.log(line);
      console.log(`Scorecard: ${result.markdownPath}`);
      console.log(`Scorecard: ${result.htmlPath}`);
    } else if (command === 'check-key') {
      console.log(runCheckKey());
    } else if (command === 'convert') {
      for (const line of runConvert(rest, defaultRepoRoots())) console.log(line);
    } else {
      throw new UsageError(
        'usage: cli.ts score --export <dir> [--out <dir>] [--run <label>] [--redact] | cli.ts check-key | ' +
          'cli.ts convert --ground-truth <file> (--describe | --out <file> --coverage complete|partial [--message-ids <file>])',
      );
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof StaleBuildError) {
      console.error(error.message);
      process.exitCode = 2;
    } else if (error instanceof AnswerKeyError || error instanceof ExportError || error instanceof ConvertError) {
      console.error(error.message);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
