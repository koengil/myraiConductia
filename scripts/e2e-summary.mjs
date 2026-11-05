/**
 * Turn Playwright's JSON report into a markdown failure summary.
 *
 * CI's job is to say what broke without making anyone download a zip first.
 * This emits the failing spec names, their file:line, and the head of each
 * error, which is enough to recognize a known break or a flake. The screenshot
 * video, screenshot, and trace still live in the uploaded artifact, because
 * GitHub markdown cannot render an image or play a video out of an artifact
 * zip (artifact URLs require auth, so there is no public URL to point an <img>
 * or <video> at). The summary names each attachment and the command to fetch
 * them instead.
 *
 * Usage: node scripts/e2e-summary.mjs [path/to/results.json]
 * Writes markdown to stdout. Exits 0 even with no report, so it can never turn
 * a test failure into a second, confusing CI failure.
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

const REPORT = process.argv[2] ?? 'e2e-results.json';
const ERROR_LINES = 12;

/** Depth-first walk of the suite tree, collecting only failed/timed-out specs. */
function collectFailures(suite, failures = []) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      // `results` holds one entry per attempt; with retries on, the last entry
      // is the one that decided the outcome.
      const last = test.results?.[test.results.length - 1];
      if (!last || (last.status !== 'failed' && last.status !== 'timedOut')) continue;
      failures.push({
        title: spec.title,
        file: spec.file ?? suite.file,
        line: spec.line,
        project: test.projectName,
        status: last.status,
        retries: (test.results?.length ?? 1) - 1,
        error: last.error?.message ?? last.errors?.[0]?.message ?? '',
        // Name them ("video", "screenshot", "trace") rather than dumping bare
        // paths: the reader needs to know a recording exists before they
        // decide whether downloading the artifact is worth it.
        attachments: (last.attachments ?? [])
          .filter((a) => a.path)
          // Relative: Playwright reports absolute paths, which in CI means the
          // runner's home directory, useless to the reader and noise in a
          // comment.
          .map((a) => ({ name: a.name, path: relative(process.cwd(), a.path) })),
      });
    }
  }
  for (const child of suite.suites ?? []) collectFailures(child, failures);
  return failures;
}

/** Strip ANSI so the error reads as markdown, not as escape soup. */
function plain(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '').trim();
}

let report;
try {
  report = JSON.parse(readFileSync(REPORT, 'utf8'));
} catch {
  process.stdout.write(
    `### E2E\n\nNo Playwright report at \`${REPORT}\` — the run failed before any test reported. Read the step log.\n`,
  );
  process.exit(0);
}

const failures = (report.suites ?? []).flatMap((s) => collectFailures(s));
const stats = report.stats ?? {};

if (failures.length === 0) {
  process.stdout.write(
    `### E2E\n\nNo failing specs in the report (${stats.expected ?? 0} passed). The job failed outside the suite — read the step log.\n`,
  );
  process.exit(0);
}

const out = [];
out.push(`### E2E: ${failures.length} failing spec${failures.length === 1 ? '' : 's'}`);
out.push('');
out.push(
  `${stats.expected ?? 0} passed · ${stats.unexpected ?? 0} failed · ${stats.flaky ?? 0} flaky · ${stats.skipped ?? 0} skipped`,
);
out.push('');

for (const f of failures) {
  const where = f.line ? `${f.file}:${f.line}` : f.file;
  out.push(`#### \`${f.title}\``);
  out.push('');
  out.push(
    `\`${where}\` · project \`${f.project}\` · ${f.status}${f.retries ? ` after ${f.retries} retry` : ''}`,
  );
  out.push('');
  const lines = plain(f.error).split('\n');
  const head = lines.slice(0, ERROR_LINES).join('\n');
  out.push('```');
  out.push(head + (lines.length > ERROR_LINES ? `\n… ${lines.length - ERROR_LINES} more lines in the report` : ''));
  out.push('```');
  if (f.attachments.length) {
    out.push('');
    out.push(
      `Attachments: ${f.attachments.map((a) => `${a.name} \`${a.path}\``).join(' · ')}`,
    );
  }
  out.push('');
}

process.stdout.write(out.join('\n'));
