// First import, on purpose: the fake tenant reaches the synthetic corpus through
// src/lib/mailboxAccess/readers.ts, which claims the reader capability when it loads
// (tests/mailbox-access/boot-claim.test.ts pins the order).
import '../../src/lib/mailboxAccess/readers';

import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createFakeTenant, fakeTenantSources } from './cassette/fakeTenant';
import { saveCassette } from './cassette/format';
import { recordSources } from './cassette/record';

// Regenerates tests/fixtures/m365-replay/synthetic/ from the fake tenant (the bank.example fixture
// mailboxes). Deterministic: fixed recordedAt, derived ids and tokens. CI checks it by regenerating
// and diffing; never hand-edit the output (digest.json fails a hand edit).
//   npm run m365:cassette:synthetic
export const SYNTHETIC_CASSETTE_DIR = join(process.cwd(), 'tests', 'fixtures', 'm365-replay', 'synthetic');
export const SYNTHETIC_RECORDED_AT = '2026-09-29T00:00:00.000Z';

export async function buildSyntheticCassette(dir = SYNTHETIC_CASSETTE_DIR): Promise<{ interactions: number; digestSha256: string }> {
  // The cassette is recorded with RECORD_EXTRACT (text is never needed to record); replay runs the real extractor.
  const { cassette } = await recordSources({
    http: { getToken: async () => 'synthetic', fetchImpl: createFakeTenant().fetch, sleep: async () => undefined },
    sources: fakeTenantSources(),
    recordedAt: SYNTHETIC_RECORDED_AT,
  });
  mkdirSync(dirname(dir), { recursive: true });
  rmSync(dir, { recursive: true, force: true });
  const { digestSha256 } = saveCassette(dir, cassette);
  return { interactions: cassette.interactions.length, digestSha256 };
}

if (process.argv[1]?.endsWith('build-synthetic-cassette.ts')) {
  buildSyntheticCassette()
    .then(({ interactions, digestSha256 }) => {
      console.log(`Wrote ${interactions} interactions to ${SYNTHETIC_CASSETTE_DIR}`);
      console.log(`cassette sha256:${digestSha256}`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
