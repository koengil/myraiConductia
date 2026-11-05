import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { isDocumentation } from './docs-paths.mjs';


function docsOnly() {
  const git = (...args) => execFileSync('git', args, {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const name = process.env.GITHUB_EVENT_NAME;
  let base;
  let head;
  if (name === 'pull_request') {
    base = event.pull_request?.base?.sha;
    head = event.pull_request?.head?.sha;
  } else if (name === 'push' && !event.forced && !event.deleted) {
    base = event.before;
    head = event.after;
  } else {
    return false;
  }

  const isCommit = (sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha) && !/^0+$/.test(sha);
  if (!isCommit(base) || !isCommit(head)) return false;
  if (git('rev-parse', '--is-shallow-repository') !== 'false') return false;
  // Missing objects, unrelated history and oversized diffs throw and fall back
  // to full CI. PRs compare the entire branch; pushes compare before to after.
  if (name === 'pull_request') base = git('merge-base', base, head);
  else git('merge-base', '--is-ancestor', base, head);
  const files = git('diff', '--name-only', '--no-renames', '-z', base, head, '--')
    .split('\0').filter(Boolean);
  return files.length > 0 && files.every(isDocumentation);
}

let result = false;
try {
  result = docsOnly();
} catch {
  console.log('::notice::Change range unavailable or uncertain; running full CI.');
}
// Output/write failures fail the detection job. Required jobs reject a failed
// detector rather than treating its missing output as a documentation skip.
appendFileSync(process.env.GITHUB_OUTPUT, `docs_only=${result}\n`);
console.log(result ? 'Documentation-only change.' : 'Full CI required.');
