import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';

/**
 * Which replies file the discovery demo runs on. The owner's recording (T2) is
 * the real one; until it is committed the journey, CI and the runbook fall back
 * to the stub built from the test double (tests/helpers/stubReplies.ts). The
 * paths repeat the ones in that helper on purpose: the recordings test asserts
 * they agree, and this file stays free of the corpus code it would pull in.
 */
export const RECORDING_PATH = 'tests/fixtures/discovery/demo/model-replies/extract.v1.json';
export const STUB_PATH = 'tests/fixtures/discovery/demo/model-replies/extract.v1.stub.json';

export function repliesFile(): { path: string; kind: 'recording' | 'stub' } {
  return existsSync(path.join(process.cwd(), RECORDING_PATH))
    ? { path: RECORDING_PATH, kind: 'recording' }
    : { path: STUB_PATH, kind: 'stub' };
}

/**
 * The beats that assert an extracted step (2, 3 and 7) read what the model
 * found. While only the stub exists they still run, against the stub, and the
 * run carries a pending annotation so nobody reads them as a recording check.
 */
export function annotatePendingRecording(beat: string): void {
  if (repliesFile().kind === 'recording') return;
  const info = test.info();
  if (info.annotations.some((a) => a.type === 'pending-t2-recording' && a.description?.startsWith(beat))) return;
  info.annotations.push({
    type: 'pending-t2-recording',
    description: `${beat}: asserted against the stub replies; pending T2's recording (${RECORDING_PATH})`,
  });
}
