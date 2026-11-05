import { describe, expect, it } from 'vitest';

import {
  MILESTONE_LABEL,
  MILESTONE_STATION,
  MILESTONE_TYPES,
  type MilestoneEvent,
  type MilestoneType,
} from '@/lib/discovery/milestones';
import { reasonDate } from '@/lib/discovery/reason';
import { assessStage, ENGINE_VERSION } from '@/lib/discovery/stageEngine';
import { MVP_DEAL_RAIL, orderedSteps, type RailPhase } from '@/lib/rail/dealRail';

let n = 0;
const ev = (type: MilestoneType, occurredAt: string, sourceItemId = `item-${++n}`, confidence = 0.9): MilestoneEvent => ({
  id: `${sourceItemId}:${type}`,
  sourceItemId,
  type,
  occurredAt,
  confidence,
  basis: 'model',
});
/** The same event, found by the rule detector rather than a model. */
const rule = (e: MilestoneEvent): MilestoneEvent => ({ ...e, basis: 'rules' });
const steps = orderedSteps(MVP_DEAL_RAIL);
const stationOf = (stepId: string) => steps.findIndex((s) => s.id === stepId) + 1;

describe('the milestone table', () => {
  it('maps every station-bearing milestone to a step that exists on the MVP rail', () => {
    for (const type of MILESTONE_TYPES) {
      const stepId = MILESTONE_STATION[type];
      if (stepId === null) continue;
      expect(steps.some((s) => s.id === stepId), `${type} -> ${stepId}`).toBe(true);
    }
  });

  it('names every type in the reason vocabulary', () => {
    for (const type of MILESTONE_TYPES) expect(MILESTONE_LABEL[type], type).toBeTruthy();
    expect(Object.keys(MILESTONE_STATION)).toEqual([...MILESTONE_TYPES]);
  });

  it('confirms the step titles the demo shows', () => {
    expect(stationOf('p4-s48')).toBe(44);
    expect(steps[43].title).toBe('LOI Review');
    expect(stationOf('p5-s51')).toBe(47);
    expect(steps[46].title).toBe('Signing / Announcement Prep');
    expect(stationOf('p5-s57')).toBe(53);
    expect(steps[52].title).toBe('Closing Checklist');
  });
});

describe('assessStage', () => {
  it.each(MILESTONE_TYPES.filter((t) => MILESTONE_STATION[t] !== null))(
    'golden: a lone %s gives its mapped station',
    (type) => {
      const a = assessStage([ev(type, '2026-03-02')], MVP_DEAL_RAIL);
      expect(a.stepId).toBe(MILESTONE_STATION[type]);
      expect(a.station).toBe(stationOf(MILESTONE_STATION[type]!));
      expect(a.engineVersion).toBe(ENGINE_VERSION);
      expect(a.flags).toEqual([]);
    },
  );

  it('gives a pause or termination alone no station', () => {
    for (const type of ['process_paused', 'process_terminated'] as const) {
      const a = assessStage([ev(type, '2026-03-02')], MVP_DEAL_RAIL);
      expect(a.stepId).toBeNull();
      expect(a.station).toBeNull();
      expect(a.reason).toBe('No milestones extracted yet');
    }
  });

  it('reads no events as no step and no lifecycle', () => {
    expect(assessStage([], MVP_DEAL_RAIL)).toMatchObject({ stepId: null, station: null, lifecycle: null, confidence: 0 });
  });

  it('takes the highest step, however late an earlier milestone was mailed', () => {
    const a = assessStage(
      [ev('loi_signed', '2026-09-18'), ev('vdr_opened', '2026-09-20'), ev('bids_received', '2026-08-28')],
      MVP_DEAL_RAIL,
    );
    expect(a.stepId).toBe('p4-s48');
    expect(a.station).toBe(44);
    expect(a.lifecycle).toBe('live');
  });

  it('moves back to step 43 with a conflict when exclusivity lapses after the LOI', () => {
    const a = assessStage([ev('loi_signed', '2026-09-18'), ev('exclusivity_lapsed', '2026-10-02')], MVP_DEAL_RAIL);
    expect(a.stepId).toBe('p4-s47');
    expect(a.station).toBe(43);
    expect(a.flags).toEqual(['conflict']);
    expect(a.confidence).toBeCloseTo(0.9 * 0.7, 10);
  });

  it('does not regress on a lapse that came before the LOI', () => {
    const a = assessStage([ev('exclusivity_lapsed', '2026-09-01'), ev('loi_signed', '2026-09-18')], MVP_DEAL_RAIL);
    expect(a.station).toBe(44);
    expect(a.flags).toEqual([]);
  });

  it('sets lifecycle closed when the deal closed', () => {
    const a = assessStage([ev('signed', '2025-05-30'), ev('closed', '2025-07-15')], MVP_DEAL_RAIL);
    expect(a.stepId).toBe('p5-s57');
    expect(a.station).toBe(53);
    expect(a.lifecycle).toBe('closed');
  });

  it('holds the mandate when a pause has no later event, and resumes when one follows', () => {
    const paused = assessStage([ev('kickoff_held', '2026-05-14'), ev('process_paused', '2026-06-01')], MVP_DEAL_RAIL);
    expect(paused.lifecycle).toBe('mandate_hold');
    expect(paused.stepId).toBe('p2-s28');
    const resumed = assessStage(
      [ev('kickoff_held', '2026-05-14'), ev('process_paused', '2026-06-01'), ev('teaser_drafted', '2026-06-20')],
      MVP_DEAL_RAIL,
    );
    expect(resumed.lifecycle).toBe('live');
  });

  it('marks a terminated process terminated', () => {
    const a = assessStage([ev('bids_received', '2026-08-28'), ev('process_terminated', '2026-09-05')], MVP_DEAL_RAIL);
    expect(a.lifecycle).toBe('terminated');
  });

  it('flags an override but keeps the evidence suggestion', () => {
    const a = assessStage([ev('loi_signed', '2026-09-18')], MVP_DEAL_RAIL, { stepId: 'p2-s31' });
    expect(a.stepId).toBe('p4-s48');
    expect(a.flags).toEqual(['overridden']);
    const same = assessStage([ev('loi_signed', '2026-09-18')], MVP_DEAL_RAIL, { stepId: 'p4-s48' });
    expect(same.flags).toEqual([]);
  });

  it('flags a step the rail no longer carries', () => {
    const trimmed: RailPhase[] = MVP_DEAL_RAIL.map((p) => ({ ...p, steps: p.steps.filter((s) => s.id !== 'p4-s48') }));
    const a = assessStage([ev('loi_signed', '2026-09-18')], trimmed);
    expect(a.flags).toContain('station_removed');
    expect(a.station).toBeNull();
    expect(a.stepId).toBe('p4-s48');
  });

  it('reads "LOI Review because LOI signed on Sep 18, 2026 (3 emails)"', () => {
    const a = assessStage(
      [
        ev('kickoff_held', '2026-05-14', 'k3'),
        ev('loi_signed', '2026-09-18', 'k13'),
        ev('loi_signed', '2026-09-18', 'k14'),
        ev('loi_signed', '2026-09-18', 'k15'),
      ],
      MVP_DEAL_RAIL,
    );
    expect(a.reason).toBe('LOI Review because LOI signed on Sep 18, 2026 (3 emails)');
    expect(a.evidenceEventIds).toHaveLength(3);
  });

  it('counts emails, not events, and says "email" for one', () => {
    const one = assessStage([ev('closed', '2025-07-15', 'o7')], MVP_DEAL_RAIL);
    expect(one.reason).toBe('Closing Checklist because closing on Jul 15, 2025 (1 email)');
    const twoEventsOneMail = assessStage(
      [ev('closed', '2025-07-15', 'o7'), { ...ev('closed', '2025-07-15', 'o7'), id: 'o7:closed:2' }],
      MVP_DEAL_RAIL,
    );
    expect(twoEventsOneMail.reason).toContain('(1 email)');
  });

  describe('engine v2: lifecycle from model events only (#173 G-07)', () => {
    it('is stage-engine/v2', () => {
      expect(ENGINE_VERSION).toBe('stage-engine/v2');
    });

    it('lets a rule closing place the station, but never close the deal', () => {
      const a = assessStage([ev('signed', '2025-05-30'), rule(ev('closed', '2025-07-15'))], MVP_DEAL_RAIL);
      expect(a.stepId).toBe('p5-s57');
      expect(a.station).toBe(53);
      expect(a.lifecycle).toBe('live');
      const alone = assessStage([rule(ev('closed', '2025-07-15'))], MVP_DEAL_RAIL);
      expect(alone.stepId).toBe('p5-s57');
      expect(alone.lifecycle).toBeNull();
    });

    it('gives rule events alone a station and no lifecycle', () => {
      const a = assessStage([rule(ev('loi_signed', '2026-09-18'))], MVP_DEAL_RAIL);
      expect(a).toMatchObject({ stepId: 'p4-s48', station: 44, lifecycle: null });
      expect(a.reason).toBe('LOI Review because LOI signed on Sep 18, 2026 (1 email)');
    });

    it('lets no rule event pause, end or resume a deal', () => {
      const paused = assessStage([ev('kickoff_held', '2026-05-14'), rule(ev('process_paused', '2026-06-01'))], MVP_DEAL_RAIL);
      expect(paused.lifecycle).toBe('live');
      const held = assessStage(
        [ev('kickoff_held', '2026-05-14'), ev('process_paused', '2026-06-01'), rule(ev('teaser_drafted', '2026-06-20'))],
        MVP_DEAL_RAIL,
      );
      expect(held.lifecycle).toBe('mandate_hold');
      expect(held.stepId).toBe('p2-s36'); // the rule event still places the station
    });

    it('keeps every model-only result of v1', () => {
      const events = [ev('signed', '2025-05-30'), ev('closed', '2025-07-15'), ev('bids_received', '2025-03-01')];
      expect(assessStage(events, MVP_DEAL_RAIL)).toMatchObject({ stepId: 'p5-s57', lifecycle: 'closed', flags: [] });
    });
  });

  it('is deterministic whatever order the events arrive in', () => {
    const events = [ev('loi_signed', '2026-09-18'), ev('bids_received', '2026-08-28'), ev('vdr_opened', '2026-05-28')];
    expect(assessStage([...events].reverse(), MVP_DEAL_RAIL)).toEqual(assessStage(events, MVP_DEAL_RAIL));
  });
});

describe('reasonDate', () => {
  it('uses a fixed month table, never Intl', () => {
    expect(reasonDate('2026-09-18')).toBe('Sep 18, 2026');
    expect(reasonDate('2026-05-06')).toBe('May 6, 2026');
    expect(reasonDate('2025-01-13')).toBe('Jan 13, 2025');
  });
});
