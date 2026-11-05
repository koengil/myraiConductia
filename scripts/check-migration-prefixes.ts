import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

import { checkHistory, findDroppedValues, formatCheckListProblem } from './check-migration-check-lists';
import { lintAddedMigrations } from './check-migration-lint';
import { branchAddedMigrations, checkOpenPrs, planOpenPrCheck } from './check-migration-open-prs';
import { checkMigrationOrder, planOrderCheck, suggestPrefix } from './check-migration-order';

const MIGRATIONS_DIR = 'supabase/migrations';
const MIGRATION_NAME = /^(\d{14})_[a-z0-9_]+\.sql$/;
const RELEASED_REF = 'origin/main';

// Two branches can pick the same YYYYMMDDHHMMSS prefix and nothing else
// notices: migrate.sh replays in filename order, so the pair would run in an
// order neither author tested. Non-.sql files are ignored.
export function findPrefixProblems(names: readonly string[]): string[] {
  const problems: string[] = [];
  const byPrefix = new Map<string, string[]>();

  for (const name of [...names].sort()) {
    if (!name.endsWith('.sql')) continue;
    const match = MIGRATION_NAME.exec(name);
    if (!match) {
      problems.push(`malformed: ${name}`);
      continue;
    }
    const group = byPrefix.get(match[1]) ?? [];
    group.push(name);
    byPrefix.set(match[1], group);
  }

  for (const [prefix, files] of byPrefix) {
    if (files.length > 1) problems.push(`duplicate ${prefix}: ${files.join(', ')}`);
  }

  return problems;
}

export function parseLsTree(stdout: string): Map<string, string> {
  const blobs = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
    if (match) blobs.set(match[2].slice(match[2].lastIndexOf('/') + 1), match[1]);
  }
  return blobs;
}

export function findReleasedFileProblems(
  released: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): string[] {
  const problems: string[] = [];
  for (const name of [...released.keys()].sort()) {
    if (!name.endsWith('.sql')) continue;
    const blob = current.get(name);
    if (blob === undefined) problems.push(`removed after release: ${name}`);
    else if (blob !== released.get(name)) problems.push(`changed after release: ${name}`);
  }
  return problems;
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readReleased(): Map<string, string> {
  return parseLsTree(git(['ls-tree', RELEASED_REF, `${MIGRATIONS_DIR}/`]));
}

function readCurrent(names: readonly string[]): Map<string, string> {
  const files = names.filter((name) => name.endsWith('.sql')).sort();
  if (files.length === 0) return new Map();
  const blobs = git(['hash-object', '--', ...files.map((name) => `${MIGRATIONS_DIR}/${name}`)])
    .trim()
    .split('\n');
  return new Map(files.map((name, index) => [name, blobs[index]]));
}

async function main(): Promise<void> {
  const names = readdirSync(MIGRATIONS_DIR);
  const naming = findPrefixProblems(names);

  let released: Map<string, string>;
  try {
    released = readReleased();
  } catch {
    console.log(
      `❌ ${RELEASED_REF} is not available, so released migration files cannot be compared. Run: git fetch origin main`,
    );
    process.exitCode = 1;
    return;
  }
  const changed = findReleasedFileProblems(released, readCurrent(names));
  const openPrs = await checkOpenPrsIfPossible();
  const order = await checkOrderIfPossible();
  const lists = findDroppedValues(checkHistory(MIGRATIONS_DIR)).map(formatCheckListProblem);
  const lint = await lintIfPossible();

  if (
    naming.length === 0 &&
    changed.length === 0 &&
    openPrs.length === 0 &&
    order.problems.length === 0 &&
    lists.length === 0 &&
    lint.length === 0
  ) {
    const count = names.filter((n) => n.endsWith('.sql')).length;
    console.log(
      `✅ ${count} migration files in ${MIGRATIONS_DIR}, one timestamp prefix each; the ${released.size} on ${RELEASED_REF} are unchanged; no CHECK restatement drops a value.`,
    );
    return;
  }

  if (naming.length > 0) {
    console.log(`❌ ${MIGRATIONS_DIR} has ${naming.length} naming problem(s):\n`);
    for (const p of naming) console.log(`   - ${p}`);
    console.log(
      '\nEach file needs its own YYYYMMDDHHMMSS prefix and a name matching ^\\d{14}_[a-z0-9_]+\\.sql$. Rename the newer file to a later, unused timestamp.',
    );
  }
  if (changed.length > 0) {
    console.log(`❌ ${changed.length} migration file(s) already on ${RELEASED_REF} differ here:\n`);
    for (const p of changed) console.log(`   - ${p}`);
    console.log(
      '\nA file on main is applied to production and is never applied again, so an edit would only reach databases built later. Restore the file and put the change in a new migration.',
    );
  }
  if (openPrs.length > 0) {
    console.log(`❌ ${openPrs.length} migration file(s) here share a timestamp prefix with another open PR:\n`);
    for (const p of openPrs) console.log(`   - ${p}`);
    console.log(
      '\nWhichever PR merges second breaks the chain. Rename the file this PR adds to a later, unused timestamp.',
    );
  }
  if (order.problems.length > 0 && order.newest) {
    console.log(`❌ ${order.problems.length} migration file(s) this PR adds sort before a migration already on its base:\n`);
    for (const p of order.problems) console.log(`   - ${p}`);
    console.log(
      `\nA hosted database applies it after everything it already has, a fresh replay in filename order, so the two would differ. Rename it to a timestamp after ${order.newest.slice(0, 14)}, e.g. ${suggestPrefix(order.newest, new Date())}.`,
    );
  }
  if (lists.length > 0) {
    console.log(`❌ ${lists.length} CHECK restatement(s) drop a value an earlier migration allowed:\n`);
    for (const p of lists) console.log(`   - ${p}`);
    console.log(
      "\nThe restatement was likely copied from a stale list, and every write of a dropped value would fail. Add the values back, or, if the removal is deliberate, put `-- check-removes: <value>[, <value>] <reason>` on the statement.",
    );
  }
  if (lint.length > 0) {
    console.log(`❌ ${lint.length} migration lint finding(s) in the files this PR adds:\n`);
    for (const p of lint) console.log(`   - ${p}`);
    console.log(
      '\nEach finding is a review comment that came back before. Apply the fix, or put the lint-allow comment, with a reason, on the statement or the line above it; reviewers see every marker.',
    );
  }
  process.exitCode = 1;
}

// The linter reads the files the PR adds the same way the order check does.
async function lintIfPossible(): Promise<string[]> {
  const plan = planOrderCheck(process.argv.slice(2), process.env);
  if (!plan.run) {
    console.log(`ℹ️  Migration lint skipped on ${process.env.GITHUB_EVENT_NAME} (it lints the files a pull request adds).`);
    return [];
  }
  return lintAddedMigrations({ ...plan, ci: process.env.GITHUB_EVENT_NAME === 'pull_request' });
}

async function checkOrderIfPossible(): Promise<{ problems: string[]; newest?: string }> {
  const plan = planOrderCheck(process.argv.slice(2), process.env);
  if (!plan.run) {
    console.log(plan.notice);
    return { problems: [] };
  }
  return checkMigrationOrder(plan);
}

async function checkOpenPrsIfPossible(): Promise<string[]> {
  const plan = planOpenPrCheck(process.argv.slice(2), process.env);
  if (!plan.run) {
    console.log(plan.notice);
    return [];
  }
  let own;
  if (plan.pr === undefined) {
    try {
      own = branchAddedMigrations(plan.base);
    } catch {
      console.log(`⚠️  Open-PR migration check skipped: ${plan.base} is not available. Run: git fetch origin develop`);
      return [];
    }
  }
  return checkOpenPrs({ repo: plan.repo, token: plan.token, pr: plan.pr, own });
}

if (process.argv[1]?.endsWith('check-migration-prefixes.ts')) void main();
