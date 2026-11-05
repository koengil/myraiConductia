/*
 * Pure scoring for the weekly AI review report: parse artifact names, match
 * posted findings to review threads, aggregate per lens, render a table.
 * Both outcome signals are proxies, not ground truth.
 */
import { LENSES, type Lens } from './findings';

/** Judge roles report as their own rows and carry no findings. */
export type JudgeRole = 'validator' | 'evaluator';
export const JUDGE_ROLES: JudgeRole[] = ['validator', 'evaluator'];

/**
 * The fields of ai-review-result.json that scoring reads (see shapeResult).
 * Entries without `role` come from older artifacts and count as lens runs.
 */
export type RunResult = {
  /** Set when the output held a token-shaped string: the artifact then carries counts only. */
  withheld?: boolean;
  lenses: { role?: 'lens' | JudgeRole; lens?: Lens; status: 'ok' | 'failed'; durationMs: number; findings: number }[];
  counts: { raw: number; confirmed: number; rejected: number; unclear: number; noVerdict: number; final: number };
  rejected: { lens: Lens; file: string; line: number }[];
  findings: { lens: Lens; file: string; line: number }[];
};

export type ScoredRun = { pr: number; result: RunResult };

/** A review thread's first comment. `line` is null once the line was changed away (outdated). */
export type Thread = { isResolved: boolean; isOutdated: boolean; bot: boolean; path: string; line: number | null; originalLine: number | null };

export type LensRow = {
  runs: number;
  failed: number;
  raw: number;
  rejected: number;
  posted: number;
  threaded: number;
  acted: number;
  durations: number[];
};

export type Score = { rows: Record<Lens | JudgeRole, LensRow>; totals: RunResult['counts']; misses: number; humanComments: number; withheld: number };

/** `ai-review-<pr>-<sha>` -> pr number, or null for any other artifact. */
export function parseArtifactName(name: string): number | null {
  const m = /^ai-review-(\d+)-[0-9a-f]{7,40}$/.exec(name);
  return m ? Number(m[1]) : null;
}

/** Keeps the newest artifact per PR, so the score is a per-PR snapshot of the latest review. */
export function latestPerPr<T extends { name: string; created_at: string }>(artifacts: T[]): T[] {
  const best = new Map<number, T>();
  for (const a of artifacts) {
    const pr = parseArtifactName(a.name);
    if (pr === null) continue;
    const cur = best.get(pr);
    if (!cur || Date.parse(a.created_at) > Date.parse(cur.created_at)) best.set(pr, a);
  }
  return [...best.values()];
}

/** True only for the AI reviewer's workflow identity (github-actions bot). */
export function isAiReviewer(login: string | null | undefined): boolean {
  return login === 'github-actions' || login === 'github-actions[bot]';
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const emptyRow = (): LensRow => ({ runs: 0, failed: 0, raw: 0, rejected: 0, posted: 0, threaded: 0, acted: 0, durations: [] });

/** Human comments within this many lines of an AI finding count as covered. */
export const OVERLAP_LINES = 3;

export function aggregate(runs: ScoredRun[], threadsByPr: Map<number, Thread[]>): Score {
  const rows = Object.fromEntries([...LENSES, ...JUDGE_ROLES].map((k) => [k, emptyRow()])) as Record<Lens | JudgeRole, LensRow>;
  const totals = { raw: 0, confirmed: 0, rejected: 0, unclear: 0, noVerdict: 0, final: 0 };
  const aiByPr = new Map<number, { file: string; line: number }[]>();
  let misses = 0;
  let humanComments = 0;

  let withheld = 0;

  for (const { pr, result } of runs) {
    // A withheld run kept no findings or lens records, so it is counted, not scored.
    if (result.withheld) {
      withheld++;
      continue;
    }
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += result.counts[k] ?? 0;
    for (const l of result.lenses) {
      const judge = l.role === 'validator' || l.role === 'evaluator' ? l.role : undefined;
      const key = judge ?? l.lens;
      const row = key ? rows[key] : undefined;
      if (!row) continue;
      row.runs++;
      row.durations.push(l.durationMs);
      if (l.status === 'failed') row.failed++;
      if (!judge) row.raw += l.findings;
    }
    for (const f of result.rejected) rows[f.lens].rejected++;
    const bots = (threadsByPr.get(pr) ?? []).filter((t) => t.bot);
    for (const f of result.findings) {
      const row = rows[f.lens];
      row.posted++;
      const t = bots.find((b) => b.path === f.file && (b.line ?? b.originalLine) === f.line);
      if (!t) continue;
      row.threaded++;
      if (t.isResolved || t.isOutdated) row.acted++;
    }
    const ai = aiByPr.get(pr) ?? [];
    ai.push(...result.findings, ...result.rejected);
    aiByPr.set(pr, ai);
  }

  for (const [pr, threads] of threadsByPr) {
    const ai = aiByPr.get(pr);
    if (!ai) continue;
    for (const t of threads.filter((x) => !x.bot)) {
      humanComments++;
      const line = t.line ?? t.originalLine;
      if (!ai.some((f) => f.file === t.path && line !== null && Math.abs(f.line - line) <= OVERLAP_LINES)) misses++;
    }
  }
  return { rows, totals, misses, humanComments, withheld };
}

const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${Math.round((100 * n) / d)}%`);

export function renderTable(s: Score, days: number, runCount: number): string {
  const head = '| Lens | Runs | Failed | Raw | Rejected | Posted | Resolved or changed | Precision proxy | Median s |';
  const lines = [`### AI review score, last ${days} days (${runCount} runs, ${s.withheld} withheld)`, '', head, '|---|---|---|---|---|---|---|---|---|'];
  for (const lens of LENSES) {
    const r = s.rows[lens];
    const m = median(r.durations);
    lines.push(
      `| ${lens} | ${r.runs} | ${r.failed} | ${r.raw} | ${r.rejected} | ${r.posted} | ${r.acted} | ${pct(r.acted, r.threaded)} | ${m === null ? 'n/a' : Math.round(m / 1000)} |`,
    );
  }
  for (const role of JUDGE_ROLES) {
    const r = s.rows[role];
    const m = median(r.durations);
    lines.push(`| ${role} | ${r.runs} | ${r.failed} | - | - | - | - | - | ${m === null ? 'n/a' : Math.round(m / 1000)} |`);
  }
  const t = s.totals;
  lines.push(
    '',
    `All lenses: raw ${t.raw}, confirmed ${t.confirmed}, rejected ${t.rejected}, unclear ${t.unclear}, no verdict ${t.noVerdict}, posted ${t.final}.`,
    `Human review comments with no AI finding within ${OVERLAP_LINES} lines: ${s.misses} of ${s.humanComments} (misses proxy, count only).`,
    '',
    'Precision proxy = posted inline threads that were resolved or whose line later changed, over posted inline threads. Per-lens confirmed and unclear are not recorded in the artifact. Validator and evaluator rows count judge calls; they have no findings columns.',
  );
  return lines.join('\n');
}
