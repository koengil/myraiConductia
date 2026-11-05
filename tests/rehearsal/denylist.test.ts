import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DenylistRefusal, writeDenylist } from '../../scripts/rehearsal/denylist';

// #173 audit item 5: the denylist is written outside the working tree even through a symlink, and is always 0600.

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'denylist-'));
  temps.push(dir);
  return dir;
};

describe('writeDenylist', () => {
  it('refuses a parent directory that is a symlink into the working tree', () => {
    const base = tempDir();
    const root = path.join(base, 'root');
    fs.mkdirSync(root);
    fs.symlinkSync(root, path.join(base, 'outside'));
    expect(() => writeDenylist(path.join(base, 'outside', 'denylist.txt'), root)).toThrow(DenylistRefusal);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('refuses a target that is itself a symlink', () => {
    const base = tempDir();
    const root = path.join(base, 'root');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'kept\n');
    fs.symlinkSync(path.join(root, 'tracked.txt'), path.join(base, 'denylist.txt'));
    expect(() => writeDenylist(path.join(base, 'denylist.txt'), root)).toThrow(DenylistRefusal);
    expect(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8')).toBe('kept\n');
  });

  it('leaves an existing, wider file at 0600', () => {
    const out = path.join(tempDir(), 'denylist.txt');
    fs.writeFileSync(out, '', { mode: 0o644 });
    fs.chmodSync(out, 0o644);
    expect(writeDenylist(out, process.cwd())).toBeGreaterThan(0);
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
  });
});
