import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The develop ruleset's required status checks, in one place. A promotion to
// staging requires every one of them green on the exact commit it moves.
// gates.test.mjs asserts that each name is a job in ci.yml.
export const REQUIRED_CHECKS = [
  'Lint, typecheck, test, build',
  'Phase 1 integration test (local Supabase)',
  'E2E (hermetic)',
  'Dependency vulnerability audit',
  'Secret scan',
];

// runs: check runs for one commit ({ id, name, status, conclusion }). A check
// that ran more than once (a re-run) is judged by its latest attempt.
export function evaluate(runs, required = REQUIRED_CHECKS) {
  const latest = new Map();
  for (const run of runs) {
    const seen = latest.get(run.name);
    if (!seen || run.id > seen.id) latest.set(run.name, run);
  }
  const problems = [];
  for (const name of required) {
    const run = latest.get(name);
    if (!run) problems.push(`${name}: missing`);
    else if (run.status !== 'completed') problems.push(`${name}: ${run.status}`);
    else if (run.conclusion !== 'success') problems.push(`${name}: ${run.conclusion}`);
  }
  return problems;
}

// CLI: one check-run JSON object per line on stdin, as printed by
//   gh api --paginate "repos/$REPO/commits/$SHA/check-runs?per_page=100" \
//     --jq '.check_runs[] | {id, name, status, conclusion}'
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runs = readFileSync(0, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const problems = evaluate(runs);
  if (problems.length > 0) {
    for (const problem of problems) console.log(`❌ ${problem}`);
    process.exit(1);
  }
  for (const name of REQUIRED_CHECKS) console.log(`✅ ${name}`);
}
