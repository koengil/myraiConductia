import { describe, expect, it } from 'vitest';

import { groupProposals, type ModelProposalAccept, type ModelProposalRow } from '@/lib/discovery/propose/group';
import { messageKey } from '@/lib/discovery/propose/key';
import { proposedStepFor } from '@/lib/discovery/propose/station';
import { GENERATED_PHASES } from '@/lib/rail/railData.generated';

const CANDIDATE = '3e4f5a6b-7c8d-4e9f-8a1b-2c3d4e5f6071';

const row = ({ id, ...over }: Partial<ModelProposalRow> & { id: string }): ModelProposalRow => ({
  message_key: messageKey(id),
  outcome: 'deal',
  deal_key: 'm:project-heron',
  deal_name: 'Project Heron',
  candidate_id: null,
  phase: 'phase-2',
  sent_at: '2026-03-02T10:00:00Z',
  party_domains: ['harbourline.example'],
  ...over,
});

describe('groupProposals', () => {
  it('gives one entry per deal key, from the deal rows only', () => {
    const groups = groupProposals([
      row({ id: '<a@x>' }),
      row({ id: '<b@x>', sent_at: '2026-03-05T10:00:00Z' }),
      row({ id: '<c@x>', deal_key: `c:${CANDIDATE}`, deal_name: 'Project Kestrel', candidate_id: CANDIDATE, phase: 'phase-3' }),
      row({ id: '<d@x>', outcome: 'not_deal', deal_key: null, deal_name: null, phase: null }),
      row({ id: '<e@x>', outcome: 'invalid', deal_key: null, deal_name: null, phase: null }),
    ]);
    expect(groups.map((g) => [g.dealKey, g.emails])).toEqual([
      ['m:project-heron', 2],
      [`c:${CANDIDATE}`, 1],
    ]);
    expect(groups[1]).toMatchObject({ name: 'Project Kestrel', candidateId: CANDIDATE });
  });

  it('places a deal at its highest proposed phase, named from the rail', () => {
    const [g] = groupProposals([
      row({ id: '<a@x>', phase: 'phase-1', sent_at: '2026-03-09T00:00:00Z' }),
      row({ id: '<b@x>', phase: 'phase-4', sent_at: '2026-03-01T00:00:00Z' }),
      row({ id: '<c@x>', phase: 'phase-2' }),
    ]);
    expect(g.phase).toEqual({ id: 'phase-4', name: GENERATED_PHASES.find((p) => p.num === 4)!.name });
  });

  it('breaks a phase tie by the later sent_at', () => {
    const rows = [
      row({ id: '<a@x>', phase: 'phase-3', sent_at: '2026-03-01T00:00:00Z', deal_name: 'Heron (early)' }),
      row({ id: '<b@x>', phase: 'phase-3', sent_at: '2026-03-08T00:00:00Z', deal_name: 'Project Heron' }),
    ];
    const [g] = groupProposals(rows);
    expect(g.phase.id).toBe('phase-3');
    expect(g.name).toBe('Project Heron'); // the latest row names the deal
    expect(groupProposals([...rows].reverse())[0]).toEqual(g);
  });

  it('counts distinct messages: two messages with one text count twice, one message counts once', () => {
    const twins = groupProposals([
      row({ id: '<twin-a@x>', message_key: messageKey('<twin-a@x>') }),
      row({ id: '<twin-b@x>', message_key: messageKey('<twin-b@x>') }),
    ]);
    expect(twins[0].emails).toBe(2);
    const once = groupProposals([row({ id: '<same@x>' }), row({ id: '<same@x>' })]);
    expect(once[0].emails).toBe(1);
  });

  it('spans the date range and joins the parties', () => {
    const [g] = groupProposals([
      row({ id: '<a@x>', sent_at: '2026-03-05T00:00:00Z', party_domains: ['b.example', 'a.example'] }),
      row({ id: '<b@x>', sent_at: null, party_domains: ['a.example'] }),
      row({ id: '<c@x>', sent_at: '2026-02-01T00:00:00Z', party_domains: null }),
    ]);
    expect(g).toMatchObject({ firstSentAt: '2026-02-01T00:00:00Z', lastSentAt: '2026-03-05T00:00:00Z', parties: ['a.example', 'b.example'] });
  });

  it('orders the newest deal first, and returns nothing for no deal rows', () => {
    const groups = groupProposals([
      row({ id: '<a@x>', deal_key: 'm:old', deal_name: 'Old', sent_at: '2025-01-01T00:00:00Z' }),
      row({ id: '<b@x>', deal_key: 'm:new', deal_name: 'New', sent_at: '2026-01-01T00:00:00Z' }),
    ]);
    expect(groups.map((g) => g.name)).toEqual(['New', 'Old']);
    expect(groupProposals([])).toEqual([]);
    expect(groupProposals([row({ id: '<x@x>', outcome: 'not_deal', deal_key: null, deal_name: null, phase: null })])).toEqual([]);
  });

  it('carries promoted per c: group, from the candidates that are already a mandate (G-02a)', () => {
    const OTHER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
    const rows = [
      row({ id: '<a@x>' }),
      row({ id: '<b@x>', deal_key: `c:${CANDIDATE}`, deal_name: 'Project Kestrel', candidate_id: CANDIDATE }),
      row({ id: '<c@x>', deal_key: `c:${OTHER}`, deal_name: 'Project Osprey', candidate_id: OTHER }),
    ];
    const promoted = (groups: ReturnType<typeof groupProposals>) =>
      Object.fromEntries(groups.map((g) => [g.dealKey, g.promoted]));
    expect(promoted(groupProposals(rows, new Set([CANDIDATE])))).toEqual({
      'm:project-heron': false,
      [`c:${CANDIDATE}`]: true,
      [`c:${OTHER}`]: false,
    });
    // Without the reader's candidate read, nothing is promoted.
    expect(groupProposals(rows).every((g) => g.promoted === false)).toBe(true);
  });

  it('carries origin per c: group from the reader\'s model-origin candidates, and null for an m: group (G-02b)', () => {
    const OTHER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
    const rows = [
      row({ id: '<a@x>' }),
      row({ id: '<b@x>', deal_key: `c:${CANDIDATE}`, deal_name: 'Project Falcon', candidate_id: CANDIDATE }),
      row({ id: '<c@x>', deal_key: `c:${OTHER}`, deal_name: 'Project Osprey', candidate_id: OTHER }),
    ];
    const origin = (groups: ReturnType<typeof groupProposals>) => Object.fromEntries(groups.map((g) => [g.dealKey, g.origin]));
    expect(origin(groupProposals(rows, new Set(), new Set(), new Map(), new Set([CANDIDATE])))).toEqual({
      'm:project-heron': null,
      [`c:${CANDIDATE}`]: 'model_proposal',
      [`c:${OTHER}`]: 'rules',
    });
    // Without the reader's candidate read, a c: group is a rules-found one.
    expect(origin(groupProposals(rows))[`c:${CANDIDATE}`]).toBe('rules');
  });

  it('carries no origin for a c: group whose candidate the database gave none for, never rules (G-02b)', () => {
    const OTHER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
    const rows = [
      row({ id: '<b@x>', deal_key: `c:${CANDIDATE}`, deal_name: 'Project Falcon', candidate_id: CANDIDATE }),
      row({ id: '<c@x>', deal_key: `c:${OTHER}`, deal_name: 'Project Osprey', candidate_id: OTHER }),
    ];
    const origin = (groups: ReturnType<typeof groupProposals>) => Object.fromEntries(groups.map((g) => [g.dealKey, g.origin]));
    expect(origin(groupProposals(rows, new Set(), new Set(), new Map(), new Set([CANDIDATE]), new Set([OTHER])))).toEqual({
      [`c:${CANDIDATE}`]: 'model_proposal',
      [`c:${OTHER}`]: null,
    });
  });

  it('opens a group to actions only when the reader listed its key, and keeps every other closed', () => {
    const rows = [
      row({ id: '<a@x>' }),
      row({ id: '<b@x>', deal_key: `c:${CANDIDATE}`, deal_name: 'Project Kestrel', candidate_id: CANDIDATE }),
    ];
    const actionable = (groups: ReturnType<typeof groupProposals>) =>
      Object.fromEntries(groups.map((g) => [g.dealKey, g.actionable]));
    expect(actionable(groupProposals(rows, new Set(), new Set(['m:project-heron'])))).toEqual({
      'm:project-heron': true,
      [`c:${CANDIDATE}`]: false,
    });
    // Without the reader's owner check, nothing is actionable.
    expect(groupProposals(rows).every((g) => g.actionable === false)).toBe(true);
  });

  describe('the proposal and the accept state of an owned m: group (G-02b, #173)', () => {
    const OWNED = new Set(['m:project-heron']);

    it('proposes the highest phase\'s station, and counts the messages placed in that phase', () => {
      const [g] = groupProposals(
        [
          row({ id: '<a@x>', phase: 'phase-2' }),
          row({ id: '<b@x>', phase: 'phase-2' }),
          row({ id: '<c@x>', phase: 'phase-4' }),
          row({ id: '<d@x>', phase: 'phase-1' }),
        ],
        new Set(),
        OWNED,
      );
      expect(g.proposed).toEqual({ stepId: proposedStepFor('phase-4'), phase: 'phase-4', placed: 1, of: 4 });
    });

    it('takes the highest phase when two phases are tied two and two, whatever the dates', () => {
      const rows = [
        row({ id: '<a@x>', phase: 'phase-2', sent_at: '2026-04-01T00:00:00Z' }),
        row({ id: '<b@x>', phase: 'phase-2', sent_at: '2026-04-02T00:00:00Z' }),
        row({ id: '<c@x>', phase: 'phase-3', sent_at: '2026-03-01T00:00:00Z' }),
        row({ id: '<d@x>', phase: 'phase-3', sent_at: '2026-03-02T00:00:00Z' }),
      ];
      for (const order of [rows, [...rows].reverse()]) {
        const [g] = groupProposals(order, new Set(), OWNED);
        expect(g.proposed).toEqual({ stepId: proposedStepFor('phase-3'), phase: 'phase-3', placed: 2, of: 4 });
        expect(g.phase.id).toBe(g.proposed!.phase);
      }
    });

    it('counts a message seen twice once', () => {
      const [g] = groupProposals([row({ id: '<same@x>', phase: 'phase-3' }), row({ id: '<same@x>', phase: 'phase-3' })], new Set(), OWNED);
      expect(g.proposed).toMatchObject({ placed: 1, of: 1 });
    });

    it('passes the accept state of an owned m: key through, and nothing for any other group', () => {
      const KESTREL = `c:${CANDIDATE}`;
      const rows = [
        row({ id: '<a@x>' }),
        row({ id: '<w@x>', deal_key: 'm:project-wren', deal_name: 'Project Wren' }),
        row({ id: '<k@x>', deal_key: KESTREL, deal_name: 'Project Kestrel', candidate_id: CANDIDATE }),
      ];
      const accepts = new Map<string, ModelProposalAccept>([
        ['m:project-heron', { state: 'pending', requested: 1 }],
        ['m:project-wren', { state: 'failed', code: 'error' }],
        [KESTREL, { state: 'failed', code: 'error' }],
      ]);
      const groups = groupProposals(rows, new Set(), new Set(['m:project-heron', KESTREL]), accepts);
      expect(Object.fromEntries(groups.map((g) => [g.dealKey, [g.actionable, g.proposed !== null, g.accept]]))).toEqual({
        'm:project-heron': [true, true, { state: 'pending', requested: 1 }],
        // Not listed as owned: closed, nothing proposed, nothing shown.
        'm:project-wren': [false, false, null],
        // A rules-found candidate has its own station; the model proposes none.
        [KESTREL]: [true, false, null],
      });
    });

    it('carries no proposal or accept state without the reader\'s owner check', () => {
      const [g] = groupProposals([row({ id: '<a@x>' })]);
      expect(g).toMatchObject({ actionable: false, proposed: null, accept: null });
    });
  });

  it('never carries a row timestamp out of the group', () => {
    const [g] = groupProposals([{ ...row({ id: '<a@x>' }), created_at: '2026-03-05T00:00:00Z' } as ModelProposalRow]);
    expect(Object.keys(g).sort()).toEqual(
      ['accept', 'actionable', 'candidateId', 'dealKey', 'emails', 'firstSentAt', 'lastSentAt', 'name', 'origin', 'parties', 'phase', 'promoted', 'proposed'],
    );
  });
});
