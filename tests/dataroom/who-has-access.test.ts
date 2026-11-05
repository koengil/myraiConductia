import { describe, expect, it } from 'vitest';

import {
  outsideViewerAccessText,
  parseAccessMembers,
  whoHasAccessText,
  type AccessMember,
} from '@/lib/dataroom/whoHasAccess';

const m = (over: Partial<AccessMember>): AccessMember => ({
  displayName: null,
  fullName: null,
  email: null,
  isExternal: false,
  companyName: null,
  dealRole: null,
  ...over,
});

describe('whoHasAccessText', () => {
  it('names the firm team on the Deal Folder and never mentions outside parties', () => {
    const text = whoHasAccessText('deal-folder', [
      m({ displayName: 'Storm' }),
      m({ fullName: 'Morgan Lee' }),
      m({ isExternal: true, companyName: 'Atlas Capital' }),
    ]);
    expect(text).toBe("Who has access on this deal: your firm's deal team (Storm and Morgan Lee). Individual files can be limited further.");
  });

  it('shortens a long team to three names and a count', () => {
    const team = ['A', 'B', 'C', 'D', 'E'].map((n) => m({ displayName: n }));
    expect(whoHasAccessText('deal-folder', team)).toContain('A, B, C, and 2 others');
  });

  it('adds outside firms on the Data Room, with head counts', () => {
    const text = whoHasAccessText('data-room', [
      m({ displayName: 'Storm' }),
      m({ isExternal: true, companyName: 'Atlas Capital' }),
      m({ isExternal: true, companyName: 'Atlas Capital' }),
      m({ isExternal: true, companyName: 'Birch Partners' }),
    ]);
    expect(text).toBe(
      "Who has access on this deal: your firm's deal team (Storm), plus Atlas Capital (2) and Birch Partners (1). Individual files can be limited further.",
    );
  });

  it('says plainly when no outside party has access yet', () => {
    expect(whoHasAccessText('data-room', [m({ displayName: 'Storm' })])).toContain(
      'No outside parties have been given access yet.',
    );
  });

  it('never contains an em dash', () => {
    expect(whoHasAccessText('data-room', null)).not.toContain('—');
  });
});

describe('the bank viewer names every outside seat', () => {
  it('names a seat with no company by its party role, never "Outside party"', () => {
    const text = whoHasAccessText('data-room', [
      m({ displayName: 'Storm' }),
      m({ isExternal: true, dealRole: 'seller' }),
      m({ isExternal: true, dealRole: 'buyer' }),
      m({ isExternal: true, dealRole: 'buyer' }),
    ]);
    expect(text).toBe(
      "Who has access on this deal: your firm's deal team (Storm), plus Seller (1) and Buyer (2). Individual files can be limited further.",
    );
    expect(text).not.toContain('Outside party');
  });
});

describe('the outside viewer line (handoff E25)', () => {
  it('names only their own firm and the bank deal team, and says who manages access', () => {
    expect(outsideViewerAccessText('Northwind Capital')).toBe(
      "Who has access on this deal: Northwind Capital and the bank's deal team. The bank's deal team manages who has access.",
    );
  });

  it('falls back to "your firm" without a firm name, never "your firm\'s deal team"', () => {
    const text = outsideViewerAccessText(null);
    expect(text).toBe(
      "Who has access on this deal: your firm and the bank's deal team. The bank's deal team manages who has access.",
    );
    expect(text).not.toContain("your firm's deal team");
  });
});

describe('parseAccessMembers', () => {
  it('reads the seat role and fills a missing company from the parties list', () => {
    const members = parseAccessMembers({
      members: [{ isExternal: true, dealRole: 'buyer', companyId: 'c-1', companyName: null }],
      parties: [{ companyId: 'c-1', companyName: 'Birch Partners', partyRole: 'acquirer' }],
    });
    expect(members?.[0]).toMatchObject({ dealRole: 'buyer', companyName: 'Birch Partners' });
  });

  it('reads the roster and treats anything else as no roster', () => {
    expect(parseAccessMembers({ members: [{ displayName: 'Storm', isExternal: false }] })).toHaveLength(1);
    expect(parseAccessMembers({ documents: [] })).toBeNull();
    expect(parseAccessMembers(null)).toBeNull();
  });
});
