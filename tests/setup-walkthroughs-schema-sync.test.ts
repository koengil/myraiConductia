import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SETUP_WALKTHROUGH_CONTENT_VERSION,
  SETUP_WALKTHROUGHS,
  SETUP_WALKTHROUGH_TRACKS,
  normalizeSetupWalkthroughSteps,
} from '@/lib/constants/setupWalkthroughs';
import { TABLE } from '@/lib/constants/tables';

const migration = readFileSync(
  'supabase/migrations/20260814230000_setup_walkthroughs.sql',
  'utf8',
);

describe('setup walkthrough schema synchronization', () => {
  it('keeps the current content version, tracks, and step IDs in the migration', () => {
    expect(migration).toContain(`create table ${TABLE.SETUP_WALKTHROUGH_PROGRESS}`);
    expect(migration).toContain(`content_version = ${SETUP_WALKTHROUGH_CONTENT_VERSION}`);
    for (const track of SETUP_WALKTHROUGH_TRACKS) {
      expect(migration).toContain(`'${track}'`);
      for (const step of SETUP_WALKTHROUGHS[track].steps) {
        expect(migration).toContain(`'${step.id}'`);
      }
    }
  });

  it('normalizes valid steps into definition order and rejects malformed sets', () => {
    expect(
      normalizeSetupWalkthroughSteps('user', ['communications_screening', 'data_security']),
    ).toEqual(['data_security', 'communications_screening']);
    expect(normalizeSetupWalkthroughSteps('user', ['data_security', 'data_security'])).toBeNull();
    expect(normalizeSetupWalkthroughSteps('user', ['access_governance'])).toBeNull();
  });
});
