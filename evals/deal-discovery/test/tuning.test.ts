// tuning.ts is frozen (phase 5 review, 2026-09-26): every number the scorer
// decides with is pinned here, and so is the digest the scorecard prints. A
// change to either fails this test on purpose. Change a value only as a
// reviewed diff, on synthetic data, never after reading a real-tenant
// scorecard; then update both the value and the digest below in that diff.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TUNING_DIGEST } from '../src/score.ts';
import { CANDIDATE_STATE_POLICY, CHECKPOINT_TARGETS, MATCH_TUNING, MERGE_TUNING } from '../src/tuning.ts';

describe('tuning.ts is frozen', () => {
  it('holds the reviewed values', () => {
    assert.deepEqual(MATCH_TUNING, {
      windowToleranceDays: 30,
      codenameWeight: 0.6,
      partyWeight: 0.3,
      timeWeight: 0.1,
      minEvidenceShare: 0.5,
    });
    assert.deepEqual(MERGE_TUNING, { minShare: 0.2, minItems: 2 });
    assert.deepEqual(CANDIDATE_STATE_POLICY, {
      postRejection: ['proposed', 'confirmed'],
      preRejection: ['proposed', 'confirmed', 'rejected', 'merged_into'],
    });
    assert.deepEqual(CHECKPOINT_TARGETS, {
      discoveryPrecision: 0.8,
      discoveryRecall: 0.7,
      itemPrecision: 0.8,
      itemRecall: 0.5,
      fragmentation: 0.25,
      merge: 0.2,
      provisional: true,
      setBy: 'Guillermo, 2026-09-26; pending Storm',
    });
  });

  it('prints the digest of those values on every scorecard', () => {
    assert.equal(TUNING_DIGEST, '7fb56304a98b');
  });
});
