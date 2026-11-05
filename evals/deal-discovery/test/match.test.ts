import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { KeyDeal } from '../src/answerKey.ts';
import {
  dealNames,
  normalizeCodename,
  normalizeCompany,
  qualifyingDeals,
  scoreMatch,
  timeRelation,
  type Evidence,
} from '../src/match.ts';
import { candidate } from './synthetic.ts';

/** Evidence that is all of one deal: the attribute tests below are not about the gate. */
function all(dealId: string, n = 4): Evidence {
  return { labeled: n, byDeal: { [dealId]: n } };
}

function deal(partial: Partial<KeyDeal> & { id: string }): KeyDeal {
  return {
    name: partial.id,
    codename: null,
    aliases: [],
    side: null,
    parties: [],
    window: { start: null, end: null },
    ...partial,
  };
}

const falcon = deal({
  id: 'T01',
  codename: 'Falcon',
  aliases: ['Heliotrope sale'],
  parties: [
    { name: 'Heliotrope, Inc.', domains: ['heliotrope.example'], role: 'target' },
    { name: 'Northwind Capital', domains: ['northwind.example'], role: 'buyer' },
  ],
  window: { start: '2026-01-15', end: '2026-06-30' },
});

describe('normalization', () => {
  it('reads "Project Falcon" and "falcon" as the same codename', () => {
    assert.equal(normalizeCodename('Project Falcon'), 'falcon');
    assert.equal(normalizeCodename('  PROJECT   Falcon!'), 'falcon');
    assert.equal(normalizeCodename('Café Noir'), 'cafe noir');
  });

  it('drops corporate suffixes from company names', () => {
    assert.equal(normalizeCompany('Heliotrope, Inc.'), 'heliotrope');
    assert.equal(normalizeCompany('Cobalt Systems Holdings Ltd'), 'cobalt systems');
    assert.equal(normalizeCompany('Group'), 'group');
  });
});

describe('scoreMatch', () => {
  it('matches on codename, parties and time, with the full score', () => {
    const m = scoreMatch(
      candidate({ proposedName: 'Project Falcon', parties: [{ name: 'Heliotrope', domain: 'heliotrope.example' }, { name: 'Northwind', domain: 'mail.northwind.example' }] }),
      falcon,
      all('T01'),
    );
    assert.deepEqual(m, { dealId: 'T01', score: 1, codename: true, partyOverlap: 1, time: 'overlap', evidenceItems: 4, evidenceShare: 1 });
  });

  it('matches on an alias', () => {
    const m = scoreMatch(candidate({ proposedName: 'Heliotrope Sale', codenameGuess: null }), falcon, all('T01'));
    assert.equal(m?.codename, true);
  });

  it('matches on a party alone, by domain or by company name', () => {
    const byDomain = scoreMatch(candidate({ proposedName: 'Kestrel', parties: [{ name: 'X', domain: 'northwind.example' }] }), falcon, all('T01'));
    assert.deepEqual(byDomain, { dealId: 'T01', score: 0.25, codename: false, partyOverlap: 0.5, time: 'overlap', evidenceItems: 4, evidenceShare: 1 });
    const byName = scoreMatch(candidate({ proposedName: 'Kestrel', parties: [{ name: 'Heliotrope', domain: 'other.example' }] }), falcon, all('T01'));
    assert.equal(byName?.partyOverlap, 0.5);
  });

  it('does not match on neither codename nor party', () => {
    assert.equal(scoreMatch(candidate({ proposedName: 'Management' }), falcon, all('T01')), null);
  });

  it('does not match a candidate whose dates fall outside the widened window', () => {
    const late = candidate({ proposedName: 'Falcon', firstSeenAt: '2026-08-15T00:00:00Z', lastSeenAt: '2026-09-01T00:00:00Z' });
    assert.equal(scoreMatch(late, falcon, all('T01')), null);
    const early = candidate({ proposedName: 'Falcon', firstSeenAt: '2025-10-01T00:00:00Z', lastSeenAt: '2025-11-30T00:00:00Z' });
    assert.equal(scoreMatch(early, falcon, all('T01')), null);
  });

  it('allows the 30-day tolerance, and counts a date-only end as the whole day', () => {
    const withinTolerance = candidate({ proposedName: 'Falcon', firstSeenAt: '2026-07-29T12:00:00Z', lastSeenAt: '2026-08-01T00:00:00Z' });
    assert.equal(timeRelation(withinTolerance, falcon), 'overlap');
    const lastDay = candidate({ proposedName: 'Falcon', firstSeenAt: '2026-07-30T23:00:00Z', lastSeenAt: null });
    assert.equal(timeRelation(lastDay, falcon), 'overlap');
    const dayAfter = candidate({ proposedName: 'Falcon', firstSeenAt: '2026-07-31T00:00:01Z', lastSeenAt: null });
    assert.equal(timeRelation(dayAfter, falcon), 'disjoint');
  });

  it('treats a missing date on either side as compatible, without the time bonus', () => {
    const undated = candidate({ proposedName: 'Falcon', firstSeenAt: null, lastSeenAt: null });
    assert.deepEqual(scoreMatch(undated, falcon, all('T01')), {
      dealId: 'T01',
      score: 0.6,
      codename: true,
      partyOverlap: 0,
      time: 'unknown',
      evidenceItems: 4,
      evidenceShare: 1,
    });
    assert.equal(timeRelation(candidate({ proposedName: 'Falcon' }), deal({ id: 'T09' })), 'unknown');
  });
});

describe('the evidence gate (review item 2)', () => {
  const lawFirm = { name: 'Baker Stone LLP', domains: ['bakerstone.example'], role: 'counsel' };
  const withCounsel = deal({ id: 'T05', codename: 'Kestrel', parties: [lawFirm], window: { start: '2026-01-01', end: '2026-06-30' } });

  it('does not qualify a candidate on one shared party alone', () => {
    // The degenerate case: five "Weekly call" candidates share the firm's law firm with every deal.
    const weekly = candidate({ proposedName: 'Weekly call', parties: [{ name: 'Baker Stone', domain: 'bakerstone.example' }] });
    assert.equal(scoreMatch(weekly, withCounsel, { labeled: 3, byDeal: {} }), null);
    assert.equal(scoreMatch(weekly, withCounsel, { labeled: 0, byDeal: {} }), null);
    // With the deal's evidence behind it, the same party does qualify it.
    assert.equal(scoreMatch(weekly, withCounsel, all('T05', 3))?.dealId, 'T05');
  });

  it('does not qualify a candidate on a missing date and a name with no evidence', () => {
    const undated = candidate({ proposedName: 'Falcon', firstSeenAt: null, lastSeenAt: null });
    assert.equal(timeRelation(undated, falcon), 'unknown');
    assert.equal(scoreMatch(undated, falcon, { labeled: 0, byDeal: {} }), null);
  });

  it('needs the minimum share of the candidate\'s labeled evidence', () => {
    const c = candidate({ proposedName: 'Falcon' });
    assert.equal(scoreMatch(c, falcon, { labeled: 4, byDeal: { T01: 1, T02: 3 } }), null);
    assert.equal(scoreMatch(c, falcon, { labeled: 4, byDeal: { T01: 2, T02: 2 } })?.evidenceShare, 0.5);
  });

  it('does not qualify correct names whose every link belongs to another deal', () => {
    assert.equal(scoreMatch(candidate({ proposedName: 'Falcon' }), falcon, all('T02')), null);
  });
});

describe('the deal\'s name matches too (review item 5)', () => {
  it('matches a key deal with no codename on its name', () => {
    // The degenerate case: no codename, so nothing matched before.
    const noCodename = deal({ id: 'T01', name: 'Project Falcon' });
    assert.equal(scoreMatch(candidate({ proposedName: 'Falcon', codenameGuess: null }), noCodename, all('T01'))?.codename, true);
    assert.equal(scoreMatch(candidate({ proposedName: 'Project Falcon' }), noCodename, all('T01'))?.codename, true);
  });

  it('derives the codename from a longer "Project <Codename> ..." name', () => {
    const long = deal({ id: 'T01', name: 'Project Falcon: sale of Heliotrope' });
    assert.deepEqual(dealNames(long), ['falcon', 'falcon sale of heliotrope']);
    assert.equal(scoreMatch(candidate({ proposedName: 'Falcon' }), long, all('T01'))?.codename, true);
  });
});

describe('qualifyingDeals', () => {
  it('lists every deal it qualifies for, most evidence first', () => {
    const cobra = deal({ id: 'T02', codename: 'Cobra', parties: [{ name: 'Heliotrope', domains: [], role: null }] });
    const m = qualifyingDeals(
      candidate({ proposedName: 'Project Falcon', parties: [{ name: 'Heliotrope', domain: 'heliotrope.example' }] }),
      [cobra, falcon],
      { labeled: 4, byDeal: { T01: 2, T02: 2 } },
    );
    assert.deepEqual(m.map((q) => q.dealId), ['T01', 'T02']);
  });

  it('breaks a tie on the lower deal id, in code-point order', () => {
    const a = deal({ id: 'T07', codename: 'Falcon' });
    const b = deal({ id: 'T05', codename: 'Falcon' });
    const m = qualifyingDeals(candidate({ proposedName: 'Falcon' }), [a, b], { labeled: 2, byDeal: { T05: 1, T07: 1 } });
    assert.deepEqual(m.map((q) => q.dealId), ['T05', 'T07']);
  });

  it('matches nothing when nothing qualifies', () => {
    assert.deepEqual(qualifyingDeals(candidate({ proposedName: 'Newsletter' }), [falcon], all('T01')), []);
  });
});
