// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isProductionAppEnv } from '@/lib/appEnv';

// The production gates of the discovery worker, its readers and its probe read
// NEXT_PUBLIC_APP_ENV through isProductionAppEnv (#344): trimmed, lower-cased,
// prod or production. An exact `=== 'prod'` comparison would let ` prod` or
// `production` switch a refusal off.

const root = process.cwd();
const GATED = ['src/lib/google', 'src/lib/graph', 'src/lib/discovery', 'src/lib/mailboxAccess', 'src/lib/supabase', 'worker', 'scripts/google'];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|mjs)$/.test(name) ? [path] : [];
  });
}

describe('isProductionAppEnv', () => {
  it.each(['prod', 'production', ' PROD ', 'Production\n'])('reads %j as production', (value) => {
    expect(isProductionAppEnv({ NEXT_PUBLIC_APP_ENV: value })).toBe(true);
  });

  it.each([undefined, '', 'dev', 'staging', 'preprod', 'prod2'])('reads %j as not production', (value) => {
    expect(isProductionAppEnv({ NEXT_PUBLIC_APP_ENV: value })).toBe(false);
  });
});

describe('no worker, reader or probe gate compares NEXT_PUBLIC_APP_ENV exactly', () => {
  it('uses isProductionAppEnv everywhere it gates on production', () => {
    const offenders = GATED.flatMap((dir) => sources(join(root, dir)))
      .filter((file) => /NEXT_PUBLIC_APP_ENV\??\s*(?:\?\.trim\(\))?\s*[!=]==\s*'prod'/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file));
    expect(offenders).toEqual([]);
  });
});
