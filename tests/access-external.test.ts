import { describe, expect, it } from 'vitest';
import { canAccessDestination, type DestinationId } from '@/lib/perspective/access';

/*
 * The external shell (platform_onboarding, spec-v3 criterion 13): a real
 * client-company or buyer-side user reaches the deal home, the Deal Rail, the
 * Data Room, the cross-party Team, Mail, and Audit for deals they are on.
 * This is nav-level presentation; the API predicates are the wall (ADR-0009).
 */

const ALL: DestinationId[] = [
  'mandate',
  'chat',
  'rail',
  'acquirers',
  'team',
  'mail',
  'dealFolder',
  'dataRoom',
  'skills',
  'audit',
];

describe('external perspective', () => {
  it('reaches deal home, Rails, Data Room, Team, Mail, and Audit', () => {
    const allowed = ALL.filter((d) => canAccessDestination('external', d));
    expect(allowed.sort()).toEqual(['audit', 'dataRoom', 'mail', 'mandate', 'rail', 'team']);
  });

  it('never reaches the internal Deal Folder or other bank-side surfaces', () => {
    for (const walled of ['dealFolder', 'acquirers', 'skills', 'chat'] as DestinationId[]) {
      expect(canAccessDestination('external', walled)).toBe(false);
    }
  });
});
