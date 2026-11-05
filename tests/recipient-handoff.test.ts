import { describe, expect, it } from 'vitest';

import { recipientHandoffLinks, recipientHandoffs } from '@/lib/mail/recipientHandoff';

describe('recipientHandoffLinks', () => {
  it('sends an outsider to the Data Room access entry', () => {
    expect(recipientHandoffLinks('ZZ-A', { email: 'a@x.test', boundary: 'external' })).toEqual([
      { kind: 'data-room', label: 'Give a@x.test data room access', href: '/projects/ZZ-A/data-room' },
    ]);
  });

  it('sends a colleague to Team', () => {
    expect(recipientHandoffLinks('ZZ-A', { email: 'c@firm.test', boundary: 'internal' })).toEqual([
      { kind: 'team', label: 'Invite c@firm.test to deal', href: '/projects/ZZ-A/team' },
    ]);
  });

  it('offers both choices when the side cannot be told', () => {
    const links = recipientHandoffLinks('ZZ-A', { email: 'u@x.test', boundary: 'unverified' });
    expect(links.map((l) => l.kind)).toEqual(['data-room', 'team']);
  });

  it('lists each address once and encodes the project in the path', () => {
    const out = recipientHandoffs('A B', [
      { email: 'a@x.test', boundary: 'external' },
      { email: 'a@x.test', boundary: 'external' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].links[0].href).toBe('/projects/A%20B/data-room');
  });
});
