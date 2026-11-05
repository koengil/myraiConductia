import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { removeTempDirs, tempDir } from './synthetic.ts';

describe('test temp directories', () => {
  it('removeTempDirs deletes every directory tempDir made, contents included', () => {
    const first = tempDir();
    const second = tempDir('dd-pkg-');
    mkdirSync(join(first, 'nested'));
    writeFileSync(join(first, 'nested', 'key.json'), '{}');
    removeTempDirs();
    assert.equal(existsSync(first), false);
    assert.equal(existsSync(second), false);
    removeTempDirs(); // a second call has nothing left to do
  });
});
