// Perimeter parity — the guarantee that "what they'll see" IS what they see.
//
// Criterion B2. The preview and the real document list must not merely agree
// today; they must be incapable of disagreeing. This suite drives a generated
// matrix through the real entry point (perimeterForViewer, which loads a real
// viewer and computes a real perimeter) and compares its count against
// userCanSeeDocument applied directly to the same rows. If the perimeter ever
// grows its own opinion about visibility, these fail.
import { describe, expect, it, vi } from 'vitest';

import { perimeterForViewer } from '@/lib/perimeter/perimeter';
import {
  userCanSeeDocument,
  type DocumentSubject,
  type DocumentGate,
} from '@/lib/api/v1/documentAccess';

type Resp = { data: unknown; error: { message: string } | null };

function makeAdmin(tables: Record<string, Resp>) {
  const from = vi.fn((table: string) => {
    const resp: Resp = tables[table] ?? { data: null, error: null };
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.select = chain;
    builder.eq = chain;
    builder.single = () => Promise.resolve(resp);
    builder.maybeSingle = () => Promise.resolve(resp);
    builder.then = (onFulfilled: (v: Resp) => unknown) => Promise.resolve(resp).then(onFulfilled);
    return builder;
  });
  return { from } as never;
}

// Every room / classification / phase-gate combination that can exist.
const ROOMS = ['internal', 'deal'] as const;
const CLASSIFICATIONS = [1, 2, 3, 4];
const MIN_PHASES = [0, 1, 2, 3];

const ALL_DOCS: DocumentGate[] = ROOMS.flatMap((room) =>
  CLASSIFICATIONS.flatMap((classification) =>
    MIN_PHASES.map((min_phase) => ({ room, classification, min_phase })),
  ),
);

type Seat = {
  label: string;
  is_external: boolean;
  firm_role: string | null;
  deal_role: string;
  phase: number;
  company_role: string;
};

const SEATS: Seat[] = [
  { label: 'seller at phase 0', is_external: true, firm_role: null, deal_role: 'seller', phase: 0, company_role: 'director' },
  { label: 'seller at phase 2', is_external: true, firm_role: null, deal_role: 'seller', phase: 2, company_role: 'member' },
  { label: 'buyer at phase 1', is_external: true, firm_role: null, deal_role: 'buyer', phase: 1, company_role: 'member' },
  { label: 'buyer at phase 3', is_external: true, firm_role: null, deal_role: 'buyer', phase: 3, company_role: 'director' },
  { label: 'observer at phase 2', is_external: true, firm_role: null, deal_role: 'read_only', phase: 2, company_role: 'member' },
  { label: 'internal deal team', is_external: false, firm_role: null, deal_role: 'deal_team', phase: 0, company_role: 'member' },
  { label: 'internal legal', is_external: false, firm_role: null, deal_role: 'legal', phase: 0, company_role: 'member' },
  { label: 'the deal MD', is_external: false, firm_role: null, deal_role: 'md', phase: 0, company_role: 'director' },
  { label: 'a firm overseer', is_external: false, firm_role: 'cco', deal_role: 'read_only', phase: 0, company_role: 'member' },
];

const subjectFor = (seat: Seat): DocumentSubject => ({
  isExternal: seat.is_external,
  hasOversight: seat.firm_role === 'cco' || seat.firm_role === 'admin',
  dealRole: seat.deal_role,
  phase: seat.phase,
});

const adminFor = (seat: Seat, docs: DocumentGate[]) =>
  makeAdmin({
    users: {
      data: {
        is_external: seat.is_external,
        firm_role: seat.firm_role,
        company_role: seat.company_role,
      },
      error: null,
    },
    deal_memberships: { data: { deal_role: seat.deal_role, phase: seat.phase }, error: null },
    documents: { data: docs, error: null },
  });

describe('perimeter parity — the count equals the predicate, seat by seat', () => {
  for (const seat of SEATS) {
    it(`matches userCanSeeDocument for ${seat.label}`, async () => {
      const expected = ALL_DOCS.filter((doc) => userCanSeeDocument(subjectFor(seat), doc)).length;

      const result = await perimeterForViewer(adminFor(seat, ALL_DOCS), 'u1', 'deal-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.perimeter.documents.total).toBe(expected);
    });
  }

  it('never reports a room the seat cannot reach, not even as a zero', async () => {
    // Criterion B4: counts are computed from survivors, so an unreachable room
    // is absent rather than present-and-empty. A zero is still a disclosure.
    const external = SEATS.find((s) => s.label === 'seller at phase 2')!;

    const result = await perimeterForViewer(adminFor(external, ALL_DOCS), 'u1', 'deal-1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.perimeter.documents.rooms.map((r) => r.room)).not.toContain('internal');
    expect(result.perimeter.documents.rooms.every((r) => r.count > 0)).toBe(true);
  });

  it('room counts sum to the total', async () => {
    for (const seat of SEATS) {
      const result = await perimeterForViewer(adminFor(seat, ALL_DOCS), 'u1', 'deal-1');
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const summed = result.perimeter.documents.rooms.reduce((n, r) => n + r.count, 0);
      expect(summed).toBe(result.perimeter.documents.total);
    }
  });

  it('states the invariant denials for every external seat, at every phase', async () => {
    // Criterion B5: stated as facts, never as counts of what is being withheld.
    for (const seat of SEATS.filter((s) => s.is_external)) {
      const result = await perimeterForViewer(adminFor(seat, ALL_DOCS), 'u1', 'deal-1');
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.perimeter.invariants).toContain('external_never_internal_room');
      expect(result.perimeter.invariants).toContain('external_never_mnpi');
    }
  });

  it('reports zero access honestly, with no hint of hidden volume', async () => {
    // Criterion B13. A phase-0 buyer facing only gated documents sees a real
    // zero, and nothing that counts what they cannot reach.
    const buyer: Seat = { ...SEATS[2], phase: 0 };
    const gated: DocumentGate[] = [
      { room: 'deal', classification: 2, min_phase: 2 },
      { room: 'deal', classification: 2, min_phase: 3 },
      { room: 'internal', classification: 1, min_phase: 0 },
    ];

    const result = await perimeterForViewer(adminFor(buyer, gated), 'u1', 'deal-1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.perimeter.documents.total).toBe(0);
    expect(result.perimeter.documents.rooms).toEqual([]);
    expect(JSON.stringify(result.perimeter)).not.toContain('3');
  });
});

describe('perimeter parity — external seats reach only the permitted shell', () => {
  it('offers an external seat exactly the scoped destination set', async () => {
    // Criterion C9 / B3.
    const result = await perimeterForViewer(adminFor(SEATS[0], ALL_DOCS), 'u1', 'deal-1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.perimeter.destinations].sort()).toEqual([
      'audit',
      'dataRoom',
      'mail',
      'mandate',
      'rail',
      'team',
    ]);
  });
});

describe('perimeter — a failed or unrecognized read never becomes a count', () => {
  it('reports unavailable when the document read errors', async () => {
    const admin = makeAdmin({
      users: { data: { is_external: true, firm_role: null, company_role: 'member' }, error: null },
      deal_memberships: { data: { deal_role: 'seller', phase: 1 }, error: null },
      documents: { data: null, error: { message: 'timeout' } },
    });

    const result = await perimeterForViewer(admin, 'u1', 'deal-1');

    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('refuses the whole result when a row carries an unrecognized room', async () => {
    // The wall only special-cases the internal room, so an unknown value would
    // fall through and read as visible. It must never reach the predicate.
    const admin = makeAdmin({
      users: { data: { is_external: true, firm_role: null, company_role: 'member' }, error: null },
      deal_memberships: { data: { deal_role: 'seller', phase: 1 }, error: null },
      documents: {
        data: [
          { room: 'deal', classification: 1, min_phase: 0 },
          { room: 'vault', classification: 1, min_phase: 0 },
        ],
        error: null,
      },
    });

    const result = await perimeterForViewer(admin, 'u1', 'deal-1');

    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('refuses a viewer with no seat on the deal', async () => {
    const admin = makeAdmin({
      users: { data: { is_external: true, firm_role: null, company_role: 'member' }, error: null },
      deal_memberships: { data: null, error: null },
      documents: { data: [], error: null },
    });

    expect(await perimeterForViewer(admin, 'stranger', 'deal-1')).toEqual({
      ok: false,
      reason: 'forbidden',
    });
  });
});
