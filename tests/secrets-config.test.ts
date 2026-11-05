// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { keyMaterialProblems } from '@/lib/secrets/keyMaterial';

const root = process.cwd();
const gitignore = readFileSync(join(root, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());

describe('.secrets configuration point (#259 R16)', () => {
  it('ignores everything in .secrets except its README', () => {
    expect(gitignore).toContain('.secrets/*');
    expect(gitignore).toContain('!.secrets/README.md');
  });

  it('tracks nothing under .secrets but the README', () => {
    const tracked = execFileSync('git', ['ls-files', '.secrets'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    // The README may still be untracked while a change is being prepared; it is never anything else.
    expect(tracked.filter((p) => p !== '.secrets/README.md')).toEqual([]);
  });

  it('git ignores a credential file dropped in .secrets and keeps the README', () => {
    const ignored = (path: string): boolean => {
      try {
        execFileSync('git', ['check-ignore', '-q', path], { cwd: root });
        return true;
      } catch {
        return false;
      }
    };
    expect(ignored('.secrets/google/worker-credentials.json')).toBe(true);
    expect(ignored('.secrets/vercel')).toBe(true);
    expect(ignored('.secrets/README.md')).toBe(false);
  });

  it('keeps key material out of the README', () => {
    const readme = readFileSync(join(root, '.secrets/README.md'), 'utf8');
    expect(keyMaterialProblems(readme)).toEqual([]);
    expect(keyMaterialProblems({ readme })).toEqual([]);
    expect(readme).toContain('google/worker-credentials.json');
    expect(readme).toContain('google/registration.json');
    expect(readme).toContain('google/seeding.json');
  });
});

describe('keyMaterialProblems', () => {
  it('finds each kind of key material and nothing in a plain registration', () => {
    expect(keyMaterialProblems({ a: '-----' + 'BEGIN PRIVATE KEY-----' })).toEqual(['holds a PEM block']);
    expect(keyMaterialProblems({ ['private_' + 'key']: 'x' })).toEqual(['holds a private_key field']);
    expect(keyMaterialProblems({ ['private_' + 'key_id']: 'x' })).toEqual(['holds a private_key field']);
    expect(keyMaterialProblems({ type: 'service_' + 'account' })).toEqual(['is a service-account key file']);
    expect(keyMaterialProblems({ type: 'external_account' })).toEqual([]);
    expect(keyMaterialProblems(null)).toEqual([]);
    expect(keyMaterialProblems(undefined)).toEqual([]);
  });
});
