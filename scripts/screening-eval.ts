/**
 * Measure how often the pre-send email screen interrupts ordinary banker mail.
 *
 *   npm run eval:screening          rule layer only: free, no key needed
 *   npm run eval:screening -- --llm full send-time screen, rules then Claude
 *   npm run eval:screening -- --jev rules, then Jev as a second opinion (D82)
 *
 * --llm makes one Claude call per corpus email (about 360), so it needs
 * AI_GATEWAY_API_KEY in .env.local and costs real money; the total is printed.
 * It also needs a local NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_APP_ENV=dev: the
 * model gate (src/lib/ai/modelPolicy.ts) honors the DEV tenant's synthetic corpus there only.
 * --jev asks Jev (TypeSafe AI, through the AI Gateway) about every email the
 * rules flag and every risky email they miss, then reports the false-positive
 * rate if Jev could clear a flag below each threshold. It needs
 * AI_GATEWAY_API_KEY and NEXT_PUBLIC_APP_ENV=dev in .env.local; Jev costs a
 * fraction of a cent per run.
 *
 * It is a developer measurement: nothing is stored and nothing is sent.
 *
 * Three sets are reported apart, never blended: the realistic mix, the
 * near-miss set (hard by design) and the risk repository (Oct 20), which is
 * broken down by risk category and difficulty.
 *
 * "Flagged" is the send-time decision: the outbox would return the email to
 * the banker with issues instead of sending it. The CCO band is reported too,
 * because a clear email that lands in the review queue is a supervision
 * false positive even though the banker is not interrupted.
 */
import { SCREENING_CORPUS } from './lib/screeningCorpus';
import { modelCallsAllowed } from '../src/lib/ai/modelPolicy';
import { costForUsage } from '../src/lib/ai/pricing';
import { DEV_TENANT_ID } from '../src/lib/db/tenant';
import { jevAllowedHere, jevRiskRead } from '../src/lib/ai/jev';
import { fullScreenFields } from '../src/lib/compliance/llm';
import { riskBandFor } from '../src/lib/compliance/riskBand';
import {
  evaluateRules,
  outcomeFor,
  summarize,
  type EvalResult,
  type EvalSummary,
} from '../src/lib/compliance/screeningEval';

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

const caseById = new Map(SCREENING_CORPUS.map((c) => [c.id, c]));
const inRepository = (r: EvalResult) => r.kind === 'risk-repository';
const inRealistic = (r: EvalResult) => r.kind !== 'near-miss' && !inRepository(r);
const RISKS = ['legal', 'regulatory', 'compliance', 'reputational'] as const;
const DIFFICULTIES = ['obvious', 'edge'] as const;

/**
 * The risk repository by category and by difficulty. `flagged` is the final
 * decision for each result (the rule layer's, or the rules after Jev).
 */
function printRepository(
  title: string,
  results: EvalResult[],
  flagged: (r: EvalResult) => boolean = (r) => r.flagged,
  // False when nothing asked about the clean twins: print n/a, not a 0 that reads as measured.
  fpMeasured = true,
) {
  const repo = results.filter(inRepository);
  const line = (label: string, set: EvalResult[]) => {
    const risky = set.filter((r) => r.expected === 'flag');
    const clear = set.filter((r) => r.expected === 'clear');
    const caught = risky.filter(flagged).length;
    const fps = clear.filter(flagged).length;
    console.log(
      `  ${label.padEnd(22)} caught ${String(caught).padStart(3)} of ${String(risky.length).padStart(3)}, ` +
        `missed ${String(risky.length - caught).padStart(3)}; false positives ` +
        (fpMeasured ? `${String(fps).padStart(3)} of ${String(clear.length).padStart(3)}` : 'n/a'),
    );
  };
  console.log(`\n${title}`);
  for (const risk of RISKS) line(risk, repo.filter((r) => caseById.get(r.id)?.risk === risk));
  for (const difficulty of DIFFICULTIES) line(`${difficulty} cases`, repo.filter((r) => caseById.get(r.id)?.difficulty === difficulty));
  line('whole repository', repo);
}

function printResults(title: string, results: EvalResult[], extra?: Map<string, string>) {
  console.log(`\n${title}`);
  for (const r of results) {
    const mark = { ok: 'ok    ', 'false-positive': 'FP    ', caught: 'caught', missed: 'MISSED' }[r.outcome];
    const band = extra?.get(r.id) ? ` [${extra.get(r.id)}]` : '';
    const why = r.reasons.length ? `  ${r.reasons.join('; ')}` : '';
    console.log(`  ${mark}  ${r.id.padEnd(14)}${band}${why}`);
  }
}

function printSummary(label: string, s: EvalSummary) {
  console.log(
    `\n${label}: ${s.falsePositives} of ${s.clear} ordinary emails flagged ` +
      `(false-positive rate ${pct(s.falsePositiveRate)}); ` +
      `${s.caught} of ${s.flag} risky emails caught, ${s.missed} missed.`,
  );
}

async function runLlm() {
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.error('\n--llm needs AI_GATEWAY_API_KEY in .env.local. Rule-layer results are above.');
    process.exitCode = 1;
    return;
  }
  // The corpus is synthetic, so the run asks the model gate as the DEV tenant
  // (#339): Claude is reached only on a local dev stack.
  const model = modelCallsAllowed(DEV_TENANT_ID, 'screening_eval');
  if (!model.allowed) {
    console.error(
      `\n--llm runs only against a local stack with NEXT_PUBLIC_APP_ENV=dev (model gate: ${model.reason}). Rule-layer results are above.`,
    );
    process.exitCode = 1;
    return;
  }
  const results: EvalResult[] = [];
  const bands = new Map<string, string>();
  let costUsd = 0;
  let unchecked = 0;
  for (const c of SCREENING_CORPUS) {
    // One at a time: a sequential run is slower but stays well inside rate limits.
    const screened = await fullScreenFields([c.subject, c.body], model);
    // A rule-layer block skips Claude on purpose, so only count a missing
    // answer where Claude was actually asked.
    if (!screened.llmChecked && screened.verdict !== 'blocked') unchecked += 1;
    if (screened.ai) costUsd += costForUsage(screened.ai.model, screened.ai) ?? 0;
    const flagged = screened.verdict !== 'compliant';
    bands.set(c.id, riskBandFor(screened));
    results.push({
      id: c.id,
      kind: c.kind,
      expected: c.expected,
      flagged,
      outcome: outcomeFor(c.expected, flagged),
      reasons: flagged ? screened.reasons : [],
    });
  }
  printResults('Full screen (rules, then Claude), with the CCO band:', results, bands);
  printSummary('Full screen', summarize(results));
  const supervised = results.filter(
    (r) => r.expected === 'clear' && !r.flagged && bands.get(r.id) !== 'routine',
  );
  console.log(
    `Clear emails sent but routed to CCO review or sampling: ${supervised.length}` +
      (supervised.length ? ` (${supervised.map((r) => r.id).join(', ')})` : ''),
  );
  if (unchecked) console.log(`Claude did not answer for ${unchecked} email(s) (timeout or unreadable reply); those show the rule layer's result only.`);
  console.log(`Claude cost for this run: $${costUsd.toFixed(4)}`);
}

// Thresholds swept by --jev: a rule flag is cleared when Jev puts both risks below it.
const JEV_THRESHOLDS = [0.02, 0.05, 0.1, 0.2, 0.3, 0.5];

async function runJev(rules: EvalResult[]) {
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.error('\n--jev needs AI_GATEWAY_API_KEY in .env.local. Rule-layer results are above.');
    process.exitCode = 1;
    return;
  }
  if (!jevAllowedHere()) {
    console.error('\n--jev runs only on a dev stack (NEXT_PUBLIC_APP_ENV=dev). Rule-layer results are above.');
    process.exitCode = 1;
    return;
  }
  // Jev's own gate decision (#339), minted separately from --llm's: the corpus
  // is synthetic, so it asks as the DEV tenant, and Jev's processor id is its own.
  const jevModel = modelCallsAllowed(DEV_TENANT_ID, 'mail_send_second_opinion');
  if (!jevModel.allowed) {
    console.error(
      `\n--jev runs only against a local stack with NEXT_PUBLIC_APP_ENV=dev (model gate: ${jevModel.reason}). Rule-layer results are above.`,
    );
    process.exitCode = 1;
    return;
  }
  const byId = caseById;
  // Jev reads every email the rules flag (the ones it may clear) and every
  // risky email the rules miss (to see whether it would have caught them).
  const asked = rules.filter((r) => r.flagged || r.expected === 'flag');
  const risk = new Map<string, number>();
  let costUsd = 0;
  const failed: string[] = [];
  const latencies: number[] = [];
  // Four at a time: Jev answers in about 100 ms, so this stays well inside rate limits.
  for (let i = 0; i < asked.length; i += 4) {
    await Promise.all(
      asked.slice(i, i + 4).map(async (r) => {
        const c = byId.get(r.id)!;
        const read = await jevRiskRead({ subject: c.subject, body: c.body }, jevModel);
        if (!read.ok) {
          failed.push(`${r.id} (${read.code})`);
          return;
        }
        risk.set(r.id, Math.max(read.promissory, read.mnpi));
        costUsd += read.costUsd ?? 0;
        latencies.push(read.latencyMs);
      }),
    );
  }

  console.log('\nJev on every rule-flagged or risky email (higher = riskier):');
  for (const r of asked) {
    const p = risk.get(r.id);
    const mark = { ok: 'ok    ', 'false-positive': 'FP    ', caught: 'caught', missed: 'MISSED' }[r.outcome];
    console.log(`  ${mark}  ${r.id.padEnd(14)} ${p === undefined ? 'no answer' : p.toFixed(3)}`);
  }

  // A flag Jev did not answer for is kept: the rule verdict stands (fail closed).
  const realistic = rules.filter(inRealistic);
  const nearMiss = rules.filter((r) => r.kind === 'near-miss');
  const repository = rules.filter(inRepository);
  const fpRate = (set: EvalResult[], cleared: (r: EvalResult) => boolean) => {
    const clear = set.filter((r) => r.expected === 'clear').length;
    const fps = set.filter((r) => r.outcome === 'false-positive' && !cleared(r)).length;
    return `${fps} of ${clear} (${(clear ? (fps / clear) * 100 : 0).toFixed(1)}%)`;
  };
  console.log('\nRules, then Jev clears a flag when both risks are below the threshold:');
  console.log('  threshold  FP, realistic mix     FP, near-miss set     FP, risk repository   risky emails cleared by Jev');
  for (const t of JEV_THRESHOLDS) {
    const cleared = (r: EvalResult) => r.flagged && (risk.get(r.id) ?? 1) < t;
    const wronglyCleared = rules.filter((r) => r.outcome === 'caught' && cleared(r)).map((r) => r.id);
    console.log(
      `  ${t.toFixed(2).padEnd(9)}  ${fpRate(realistic, cleared).padEnd(20)}  ${fpRate(nearMiss, cleared).padEnd(20)}  ` +
        `${fpRate(repository, cleared).padEnd(20)}  ` +
        `${wronglyCleared.length}${wronglyCleared.length ? ` (${wronglyCleared.join(', ')})` : ''}`,
    );
  }
  const missed = rules.filter((r) => r.outcome === 'missed');
  const wouldCatch = missed.filter((r) => (risk.get(r.id) ?? 0) >= 0.5).map((r) => r.id);
  console.log(`Risky emails the rules miss that Jev rates 0.5 or higher: ${wouldCatch.length} of ${missed.length}` +
    (wouldCatch.length ? ` (${wouldCatch.join(', ')})` : ''));
  // Jev is asked only about promissory and MNPI risk, so a repository case in
  // another family (off-channel, document destruction, harassment...) reads
  // low by construction; these lines show what that does at the thresholds a
  // pilot would use.
  for (const t of [0.05, 0.1]) {
    printRepository(
      `Risk repository, rules then Jev clearing flags below ${t.toFixed(2)}:`,
      rules,
      (r) => r.flagged && (risk.get(r.id) ?? 1) >= t,
    );
  }
  printRepository(
    'Risk repository, rules OR Jev at 0.5 or higher (what Jev would add as a catcher; Jev is not asked about clean twins the rules pass, so false positives here are not measured):',
    rules,
    (r) => r.flagged || (risk.get(r.id) ?? 0) >= 0.5,
    false,
  );
  if (failed.length) console.log(`Jev did not answer for ${failed.length}: ${failed.join(', ')}; their rule flags are kept.`);
  latencies.sort((a, b) => a - b);
  if (latencies.length) {
    console.log(`Latency: median ${latencies[Math.floor(latencies.length / 2)]} ms, ` +
      `slowest ${latencies[latencies.length - 1]} ms over ${latencies.length} calls.`);
  }
  console.log(`Jev cost for this run: $${costUsd.toFixed(6)}`);
}

async function main() {
  const rules = evaluateRules(SCREENING_CORPUS);
  printResults('Rule layer (what the composer underlines and the send gate checks first):', rules);
  printSummary('Rule layer, realistic mix', summarize(rules.filter(inRealistic)));
  printSummary('Rule layer, near-miss set (hard by design)', summarize(rules.filter((r) => r.kind === 'near-miss')));
  printRepository('Rule layer, risk repository (Oct 20), by risk category and difficulty:', rules);
  if (process.argv.includes('--llm')) await runLlm();
  if (process.argv.includes('--jev')) await runJev(rules);
}

void main();
