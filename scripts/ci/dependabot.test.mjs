import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// No YAML parser: package.json has none, and no scripts/ci test imports one. Like gates.test.mjs
// splits ci.yml into jobs, this splits dependabot.yml into `- package-ecosystem:` blocks, after
// stripping comments, so a key moved into a comment or into another block fails its pin.
const root = fileURLToPath(new URL('../..', import.meta.url));
const config = readFileSync(new URL('../../.github/dependabot.yml', import.meta.url), 'utf8');

function stripComments(text) {
  return text.replace(/^[ \t]*#.*$/gm, '').replace(/[ \t]+#.*$/gm, '');
}

function blocksOf(text) {
  return stripComments(text)
    .split('\n  - package-ecosystem:')
    .slice(1)
    .map((block) => {
      const [first, ...rest] = block.split('\n');
      return { ecosystem: first.trim(), body: rest.join('\n') };
    });
}

function block(text, ecosystem) {
  const found = blocksOf(text).filter((b) => b.ecosystem === ecosystem);
  assert.equal(found.length, 1, `exactly one ${ecosystem} block`);
  return found[0].body;
}

function quoted(list) {
  return list.map((line) => line.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, ''));
}

/** The `directories:` list of a block, written as a YAML block sequence. */
function directories(body) {
  const match = /^ {4}directories:\n((?: {6}- .*\n?)+)/m.exec(body);
  assert.ok(match, 'a block-style directories: list at the block level');
  return quoted(match[1].trim().split('\n'));
}

/** Every `update-types: [..]` token found under the block's groups: key. */
function groupUpdateTypes(body) {
  const groups = /^ {4}groups:\n((?: {6,}.*\n?)+)/m.exec(body);
  assert.ok(groups, 'a groups: key at the block level');
  const lists = [...groups[1].matchAll(/^\s+update-types:\s*\[([^\]]*)\]/gm)];
  assert.ok(lists.length > 0, 'every group states update-types as a flow list');
  return lists.flatMap((m) => m[1].split(',').map((t) => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean));
}

function lockfileDirectories() {
  const files = execFileSync('git', ['ls-files', '--', 'package-lock.json', '**/package-lock.json'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
  return files.map((file) => {
    const dir = file.slice(0, -'package-lock.json'.length).replace(/\/$/, '');
    return dir === '' ? '/' : `/${dir}`;
  });
}

test('the file declares exactly the npm and github-actions ecosystems', () => {
  assert.deepEqual(blocksOf(config).map((b) => b.ecosystem).sort(), ['github-actions', 'npm']);
});

for (const ecosystem of ['npm', 'github-actions']) {
  test(`${ecosystem}: version updates target develop, weekly, behind a cooldown`, () => {
    const body = block(config, ecosystem);
    assert.match(body, /^ {4}target-branch: develop$/m);
    assert.match(body, /^ {4}cooldown:\n {6}default-days: \d+$/m);
    assert.match(body, /^ {4}schedule:\n(?: {6}.*\n)*? {6}interval: weekly$/m);
  });
}

test('npm: directories are the lockfile directories in the tree', () => {
  const declared = directories(block(config, 'npm'));
  assert.deepEqual(declared, ['/', '/evals/deal-discovery']);
  assert.deepEqual([...declared].sort(), lockfileDirectories().sort(), 'a new package-lock.json needs a directory here');
});

test('github-actions: majors arrive one by one, never inside a group', () => {
  const types = groupUpdateTypes(block(config, 'github-actions'));
  assert.deepEqual(types.sort(), ['minor', 'patch']);
  assert.ok(!types.includes('major'));
});

test('a pin fails when its key leaves the block or turns into a comment', () => {
  const commented = config.replace(/^(\s+)target-branch: develop$/m, '$1# target-branch: develop');
  assert.notEqual(commented, config);
  assert.doesNotMatch(block(commented, 'npm'), /^ {4}target-branch: develop$/m);

  const major = config.replace(/(patterns: \["\*"\]\n\s+update-types: )\[minor, patch\]/, '$1[major, minor, patch]');
  assert.notEqual(major, config);
  assert.ok(groupUpdateTypes(block(major, 'github-actions')).includes('major'));

  const noCooldown = config.replace(/^ {4}cooldown:\n {6}default-days: 7\n {6}semver-major-days: 14\n/m, '');
  assert.notEqual(noCooldown, config);
  assert.doesNotMatch(block(noCooldown, 'npm'), /^ {4}cooldown:/m);
});
