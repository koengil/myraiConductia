import { describe, it, expect } from 'vitest';

import {
  canAccessDestination,
  destinationFromPathname,
  type DestinationId,
} from '../src/lib/perspective/access';

/*
 * Perspective access — the nav-level internal/external boundary (2026-07-09
 * Deal Folder / Data Room split + consolidated Team).
 *
 * The Deal Folder is our INTERNAL work product: only the MD (storm) may reach
 * it. The Data Room is the client's external documents: every party may reach
 * it. Team is the cross-party roster: every party may reach
 * it. This suite locks those guarantees at the access layer.
 */

describe('access — Deal Folder is internal-only', () => {
  it('storm (MD) reaches both the Deal Folder and the Data Room', () => {
    expect(canAccessDestination('storm', 'dealFolder')).toBe(true);
    expect(canAccessDestination('storm', 'dataRoom')).toBe(true);
  });

  it('mike (client) is BLOCKED from the Deal Folder but reaches the Data Room', () => {
    expect(canAccessDestination('mike', 'dealFolder')).toBe(false);
    expect(canAccessDestination('mike', 'dataRoom')).toBe(true);
  });

  it('dana (buyer) is BLOCKED from the Deal Folder but reaches the Data Room', () => {
    expect(canAccessDestination('dana', 'dealFolder')).toBe(false);
    expect(canAccessDestination('dana', 'dataRoom')).toBe(true);
  });
});

describe('access — Ask is not in the MVP', () => {
  it('no perspective reaches /chat', () => {
    for (const p of ['storm', 'mike', 'dana', 'external'] as const) {
      expect(canAccessDestination(p, 'chat')).toBe(false);
    }
  });
});

describe('access — Team is cross-party', () => {
  it('every perspective reaches Team', () => {
    for (const p of ['storm', 'mike', 'dana'] as const) {
      expect(canAccessDestination(p, 'team')).toBe(true);
    }
  });
});

describe('destinationFromPathname — route → destination', () => {
  const cases: Array<[string, DestinationId]> = [
    ['/projects/project-summit', 'mandate'],
    ['/projects/project-summit/deal-folder', 'dealFolder'],
    ['/projects/project-summit/data-room', 'dataRoom'],
    ['/projects/project-summit/working-group', 'team'],
    ['/projects/project-summit/acquirers', 'acquirers'],
    ['/projects/project-summit/acquirers/anthropic', 'acquirers'],
    ['/projects/project-summit/rail', 'rail'],
    // The Book deal view (fee, schedule, internal roll-up) is bank-only: it
    // takes the internal Deal Folder's classification, so outside parties are
    // sent to the deal home (handoff E26).
    ['/projects/project-summit/book', 'dealFolder'],
    ['/projects/project-summit/team', 'team'],
    ['/projects/project-summit/skills', 'skills'],
    ['/projects/project-summit/audit', 'audit'],
    ['/projects/project-summit/chat', 'chat'],
  ];

  it.each(cases)('%s → %s', (pathname, expected) => {
    expect(destinationFromPathname(pathname)).toBe(expected);
  });

  it('matches /data-room as dataRoom, not the internal Deal Folder', () => {
    // Guards the ordering invariant: the external room resolves first.
    expect(destinationFromPathname('/projects/x/data-room')).toBe('dataRoom');
    expect(destinationFromPathname('/projects/x/deal-folder')).toBe('dealFolder');
  });

  it('returns null off project routes', () => {
    expect(destinationFromPathname('/sign-in')).toBeNull();
    expect(destinationFromPathname(null)).toBeNull();
  });
});

describe('the Book is bank-only (handoff E26)', () => {
  const book = '/projects/ATLAS-2026-001/book';
  it('an outside party on /book is refused, so the shell sends them to the deal home', () => {
    const destination = destinationFromPathname(book);
    expect(destination).not.toBeNull();
    expect(canAccessDestination('external', destination!)).toBe(false);
  });
  it('the bank keeps /book', () => {
    expect(canAccessDestination('storm', destinationFromPathname(book)!)).toBe(true);
  });
  it('an outside party keeps /rail (the rail shows its own message)', () => {
    const destination = destinationFromPathname('/projects/ATLAS-2026-001/rail');
    expect(destination).toBe('rail');
    expect(canAccessDestination('external', destination!)).toBe(true);
  });
});
