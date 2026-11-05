import { describe, it, expect, beforeEach } from 'vitest';

import {
  DEAL_RAIL,
  MVP_DEAL_RAIL,
  NEW_BIZ_DEV_STEPS,
  PERSISTENT_STEP_IDS,
  GATE0_ACTIONS,
  ALWAYS_ON_APPS,
  TEASER_STEP_ID,
  TEASER_STEP_SEQ,
  MD_BRIEFING_STEP_ID,
  MD_BRIEFING_STEP_SEQ,
  DEAL_ALWAYS_ON_FEATURES,
  PORTFOLIO_ALWAYS_ON_FEATURES,
  orderedSteps,
  totalSteps,
  stepIndexById,
  stepBySeq,
  stepIdForSeq,
  phaseForStep,
  stateForIndex,
  stepAgentFeatures,
  estimateTokens,
} from '../src/lib/rail/dealRail';
import { SEED_DEALS, createDeal, getAllDeals, resolveDeal } from '../src/lib/rail/deals';
import {
  gate0IntakeCompleteStepIds,
  CONFLICTS_STEP_ID,
  NOTIFY_STEP_ID,
  TEAM_STEP_ID,
} from '../src/lib/rail/stepRecords';

describe('deal rail census (canonical 5 phases / 65 steps)', () => {
  it('has exactly 5 phases numbered 1..5, each with roles and tools', () => {
    expect(DEAL_RAIL).toHaveLength(5);
    DEAL_RAIL.forEach((phase, i) => {
      expect(phase.index).toBe(i + 1);
      expect(phase.id).toBe(`phase-${i + 1}`);
      expect(phase.name.length).toBeGreaterThan(0);
      expect(phase.roles.length).toBeGreaterThan(0);
      expect(phase.tools.length).toBeGreaterThan(0);
    });
  });

  it('has exactly 65 steps with contiguous seq and canonical p{phase}-s{seq} ids', () => {
    const steps = orderedSteps();
    expect(steps).toHaveLength(65);
    expect(totalSteps()).toBe(65);
    steps.forEach((step, i) => {
      expect(step.seq).toBe(i + 1);
      const phase = phaseForStep(step.id);
      expect(phase).toBeDefined();
      expect(step.id).toBe(`p${phase!.index}-s${step.seq}`);
    });
  });

  it('census guard: every seq maps to its canonical name (renumber / rename tripwire)', () => {
    // A full seq -> name snapshot of the verified HV ledger (65 steps).
    // WHY this exists: step ids are position-encoded (`p{phase}-s{seq}`), and
    // several hand-kept references anchor on those numbers — PERSISTENT_STEP_IDS
    // (the seven phase-1 mandate-formation steps that ride the MVP rail: 6, 7,
    // 8, 9, 12, 20, 25), the seq-anchored compliance features, and the seam skillIds.
    // If the census is regenerated (scripts/hv/ledger_to_rail.py from
    // docs/06-research/hv-extraction/ledger/hv-ledger.json) with a different
    // ordering or naming, this test fails and names the exact seq that moved,
    // so those anchors get re-verified and corrected in dealRail.ts instead of
    // silently pointing at the wrong step. Update this map deliberately when the
    // census legitimately changes.
    const EXPECTED_CENSUS: Record<number, string> = {
      1: 'Target Universe',
      2: 'Exit Readiness',
      3: 'Acquirer Strategy',
      4: 'Lead Registration',
      5: 'Source Intelligence',
      6: 'Conflicts Checklist',
      7: 'Codename / Deal Shell',
      8: 'Relationship Pathing',
      9: 'MD Briefing + Company Backgrounding',
      10: 'Meeting Intelligence',
      11: 'Deal Qualification',
      12: 'Client NDA Workflow',
      13: 'Initial Diligence Request List',
      14: 'Outreach Strategy',
      15: 'Strategy / SWOT',
      16: 'Stakeholder Psychology',
      17: 'Buyer Universe',
      18: 'Case Study Library',
      19: 'Engagement Economics',
      20: 'Engagement Letter Strategy',
      21: 'Pitchbook Drafting',
      22: 'Pitch Page QC',
      23: 'Pitch Rehearsal',
      24: 'Pitch Follow-Up',
      25: 'Engagement Negotiation',
      26: 'Mandate Activation Checklist',
      27: 'Win/Loss Debrief',
      28: 'Kickoff / Org Meeting',
      29: 'Timeline',
      30: 'Working Group List',
      31: 'VDR Setup',
      32: 'Document Intake / Metadata',
      33: 'Data Room Diligence',
      34: 'Financial Normalization',
      35: 'Deal Pulse Checklist',
      36: 'Teaser',
      37: 'CIM / Management Presentation',
      38: 'FAQ&A',
      39: 'Outreach Sequencing',
      40: 'Buyer Synergies Model + Valuation',
      41: 'Buyer Log / Feedback',
      42: 'Buyer NDA',
      43: 'Buyer VDR Access',
      44: 'Management Meeting',
      45: 'Buyer Q&A',
      46: 'LOI / Process Letter',
      47: 'Bid Comparison',
      48: 'LOI Review',
      49: 'Merger Agreement Distribution',
      50: 'Definitive Agreement Support',
      51: 'Signing / Announcement Prep',
      52: 'Announcement',
      53: 'LinkedIn Post',
      54: 'Email Blast',
      55: 'League Table Submission',
      56: 'Regulatory Approval Tracker',
      57: 'Closing Checklist',
      58: 'Fee Realization / Invoice',
      59: 'Closing Compliance Checklist / Binder',
      60: 'Post-Close Fee Monitor',
      61: 'Relationship Follow-Up (closing dinner)',
      62: 'Transaction Marketing / Asset Library',
      63: 'Earned / Paid Publication',
      64: 'Deal Learning / Post-Mortem',
      65: 'Tail Rights & Termination Monitor',
    };
    // RailStep.title is the census `name` (toRailStep maps name -> title).
    const actual = Object.fromEntries(orderedSteps().map((s) => [s.seq, s.title]));
    expect(actual).toEqual(EXPECTED_CENSUS);
    expect(Object.keys(EXPECTED_CENSUS)).toHaveLength(65);
  });

  it('maps deals.status onto the phases: intake → 1, active mid-rail, closed at the end', () => {
    expect(DEAL_RAIL[0].dealStatus).toBe('intake');
    expect(DEAL_RAIL[1].dealStatus).toBe('active');
    expect(DEAL_RAIL[2].dealStatus).toBe('active');
    expect(DEAL_RAIL[3].dealStatus).toBe('active');
    expect(DEAL_RAIL[4].dealStatus).toBe('active → closed');
  });

  it('carries the generated contract fields on every step', () => {
    for (const step of orderedSteps()) {
      expect(['vertical', 'hybrid']).toContain(step.layer);
      expect(['rts', 'futureproofing-os']).toContain(step.buildOwner);
      expect(['A', 'A+H', 'H+A', 'H', 'unknown']).toContain(step.executionClass);
      expect(step.io).toBeDefined();
      expect(Array.isArray(step.io.inputs)).toBe(true);
      expect(Array.isArray(step.io.outputs)).toBe(true);
      expect(Array.isArray(step.tools)).toBe(true);
      expect(typeof step.priorityBuild).toBe('boolean');
      expect(typeof step.approvalBy).toBe('string');
      expect(Array.isArray(step.compliance)).toBe(true);
      expect(step.description.length).toBeGreaterThan(0);
      // WS6: every step carries a banker-legible "why it's better" line.
      expect(step.whyBetter && step.whyBetter.length).toBeGreaterThan(0);
    }
  });

  it('exposes the ledger gate-0 actions and the 21 always-on apps', () => {
    expect(GATE0_ACTIONS).toHaveLength(4);
    expect(ALWAYS_ON_APPS).toHaveLength(21);
  });
});

describe('timeline partition (WS9 — New Business Development cut from the MVP rail)', () => {
  it('keeps DEAL_RAIL the full 65-step census (invariant unchanged)', () => {
    expect(totalSteps()).toBe(65);
    expect(DEAL_RAIL).toHaveLength(5);
  });

  it('assigns every step a timeline: phase-1 non-persistent → new-biz-dev, else execution', () => {
    for (const step of orderedSteps()) {
      expect(['new-biz-dev', 'execution']).toContain(step.timeline);
      const phase = phaseForStep(step.id)!;
      const expected =
        phase.index === 1 && !PERSISTENT_STEP_IDS.has(step.id)
          ? 'new-biz-dev'
          : 'execution';
      expect(step.timeline).toBe(expected);
    }
  });

  it('marks exactly the twenty persistent phase-1 mandate-formation steps', () => {
    const persistent = orderedSteps().filter((s) => s.persistent);
    expect(persistent.map((s) => s.id).sort()).toEqual([
      'p1-s10',
      'p1-s11',
      'p1-s12',
      'p1-s13',
      'p1-s14',
      'p1-s15',
      'p1-s16',
      'p1-s17',
      'p1-s18',
      'p1-s19',
      'p1-s20',
      'p1-s21',
      'p1-s22',
      'p1-s23',
      'p1-s24',
      'p1-s25',
      'p1-s6',
      'p1-s7',
      'p1-s8',
      'p1-s9',
    ]);
    // All persistent steps live in phase 1 but ride the execution timeline.
    for (const step of persistent) {
      expect(phaseForStep(step.id)!.index).toBe(1);
      expect(step.timeline).toBe('execution');
    }
  });

  it('NEW_BIZ_DEV_STEPS is the phase-1 origination steps only (5 of them)', () => {
    expect(NEW_BIZ_DEV_STEPS).toHaveLength(5);
    for (const step of NEW_BIZ_DEV_STEPS) {
      expect(phaseForStep(step.id)!.index).toBe(1);
      expect(step.timeline).toBe('new-biz-dev');
      expect(PERSISTENT_STEP_IDS.has(step.id)).toBe(false);
    }
  });

  it('MVP_DEAL_RAIL is the execution rail: 5 phases, 61 steps, Gate 0 intake first', () => {
    const mvpSteps = orderedSteps(MVP_DEAL_RAIL);
    expect(mvpSteps).toHaveLength(61);
    expect(totalSteps(MVP_DEAL_RAIL)).toBe(61);
    expect(MVP_DEAL_RAIL).toHaveLength(5);

    // Every MVP step is on the execution timeline.
    for (const step of mvpSteps) expect(step.timeline).toBe('execution');

    // Phase 1 opens with Gate 0, then mandate-formation steps in census order.
    const mvpPhase1 = MVP_DEAL_RAIL.find((p) => p.index === 1)!;
    expect(mvpPhase1.steps.map((s) => s.id)).toEqual([
      'p1-s7',
      'p1-s6',
      'g0-notify',
      'p1-s8',
      'p1-s9',
      'p1-s10',
      'p1-s11',
      'p1-s12',
      'p1-s13',
      'p1-s14',
      'p1-s15',
      'p1-s16',
      'p1-s17',
      'p1-s18',
      'p1-s19',
      'p1-s20',
      'p1-s21',
      'p1-s22',
      'p1-s23',
      'p1-s24',
      'p1-s25',
    ]);

    // Census execution steps + one synthetic notify step on the MVP rail.
    expect(NEW_BIZ_DEV_STEPS.length + 60).toBe(65);

    // The live Teaser step survives on the MVP rail (still the demo cursor).
    expect(mvpSteps.some((s) => s.id === TEASER_STEP_ID)).toBe(true);
    expect(stepIndexById(TEASER_STEP_ID, MVP_DEAL_RAIL)).toBe(31);
  });
});

describe('reality axis', () => {
  it('Teaser and MD Briefing are the live steps and route to a runner', () => {
    const teaser = stepBySeq(TEASER_STEP_SEQ);
    expect(teaser).toBeDefined();
    expect(teaser!.id).toBe(TEASER_STEP_ID);
    expect(teaser!.id).toBe('p2-s36');
    expect(teaser!.title).toBe('Teaser');
    expect(teaser!.reality).toBe('live');
    expect(teaser!.live).toBe(true);
    expect(teaser!.skill).toContain('Teaser workflow');
    expect(stepAgentFeatures(teaser!)).toHaveLength(0);

    const briefing = stepBySeq(MD_BRIEFING_STEP_SEQ);
    expect(briefing).toBeDefined();
    expect(briefing!.id).toBe(MD_BRIEFING_STEP_ID);
    expect(briefing!.reality).toBe('live');
    expect(briefing!.live).toBe(true);
    expect(briefing!.skill).toContain('md-briefing');
    expect(stepAgentFeatures(briefing!)).toHaveLength(0);

    const liveSteps = orderedSteps().filter((s) => s.reality === 'live');
    expect(liveSteps.map((s) => s.id)).toEqual([MD_BRIEFING_STEP_ID, TEASER_STEP_ID]);
  });

  it('every step is exactly live, schema (has canned features), or planned (none)', () => {
    const census = { live: 0, schema: 0, planned: 0 };
    for (const step of orderedSteps()) {
      census[step.reality] += 1;
      const features = stepAgentFeatures(step);
      if (step.reality === 'schema') {
        expect(features.length).toBeGreaterThan(0);
      } else {
        expect(features).toHaveLength(0);
      }
    }
    expect(census).toEqual({ live: 2, schema: 27, planned: 36 });
    expect(census.live + census.schema + census.planned).toBe(65);
  });
});

describe('feature re-keying onto canonical steps', () => {
  const featureIds = (seq: number) => stepAgentFeatures(stepBySeq(seq)!).map((f) => f.id);

  it('buyer outreach features live on seq 39 (Outreach Sequencing)', () => {
    expect(featureIds(39)).toEqual(['presend-qc', 'cover-note']);
  });

  it('NDA features live on seq 42 (Buyer NDA)', () => {
    expect(featureIds(42)).toEqual(['draft-nda', 'compare-redlines']);
  });

  it('the weekly update lives on seq 35 (Deal Pulse Checklist)', () => {
    expect(featureIds(35)).toContain('weekly-update');
    expect(DEAL_ALWAYS_ON_FEATURES.map((f) => f.id)).not.toContain('weekly-update');
  });

  it('closing features live on seq 57 (Closing Checklist)', () => {
    expect(featureIds(57)).toEqual(['place-hold', 'frozen-artifacts']);
  });

  it('the compliance screen features live on seq 6 (Conflicts Checklist)', () => {
    expect(featureIds(6)).toEqual(['screen-parties', 'check-conflicts', 'wall-cross']);
  });

  it('seam skills link onto their canonical steps via skillId', () => {
    expect(stepBySeq(2)!.skillId).toBe('deal-readiness');
    expect(stepBySeq(17)!.skillId).toBe('acquirer-fit');
    expect(stepBySeq(34)!.skillId).toBe('financial-performance');
    expect(stepBySeq(40)!.skillId).toBe('synergy-engine');
    expect(stepBySeq(3)!.skillId).toBe('culture-signal');
  });
});

describe('cursor helpers and always-on split', () => {
  it('derives state from the cursor across the 65-step rail', () => {
    expect(stateForIndex(0, 3)).toBe('done');
    expect(stateForIndex(3, 3)).toBe('active');
    expect(stateForIndex(4, 3)).toBe('todo');
  });

  it('resolves ids and seqs both ways', () => {
    expect(stepIndexById('p1-s1')).toBe(0);
    expect(stepIndexById(TEASER_STEP_ID)).toBe(35);
    expect(stepIndexById('draft-teaser')).toBe(-1); // retired pre-census id
    expect(stepIdForSeq(1)).toBe('p1-s1');
    expect(stepIdForSeq(65)).toBe('p5-s65');
    expect(stepIdForSeq(0)).toBe('p1-s1'); // out of range → first step
  });

  it('splits always-on features between the portfolio and the deal rail', () => {
    expect(PORTFOLIO_ALWAYS_ON_FEATURES.map((f) => f.id).sort()).toEqual([
      'daily-digest',
      'staffing',
    ]);
    const dealIds = DEAL_ALWAYS_ON_FEATURES.map((f) => f.id);
    expect(dealIds).toContain('ask-deal');
    expect(dealIds).toContain('pre-send-qc');
    expect(dealIds).not.toContain('daily-digest');
  });

  it('estimates tokens deterministically for a feature', () => {
    const feature = stepAgentFeatures(stepBySeq(42)!)[0];
    const est = estimateTokens(feature);
    expect(est).toBeGreaterThan(0);
    expect(est % 10).toBe(0);
    expect(estimateTokens(feature)).toBe(est);
  });
});

describe('fixture deals on the canonical rail', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('seed deals sit on canonical steps with Gate 0 complete and entry at seq 1', () => {
    for (const deal of SEED_DEALS) {
      expect(stepIndexById(deal.cursorStepId)).toBeGreaterThanOrEqual(0);
      expect(deal.entryStepSeq).toBe(1);
      expect(deal.gate0Complete).toBe(true);
    }
    expect(SEED_DEALS[0].cursorStepId).toBe(TEASER_STEP_ID);
  });

  it('createDeal opens after Gate 0 by default and honors an explicit entry point', () => {
    const dayOne = createDeal({ id: 'canva', name: 'Canva', sector: 'Design' }, 'Project Beacon');
    expect(dayOne.cursorStepId).toBe('p1-s8');
    expect(dayOne.entryStepSeq).toBe(8);
    expect(dayOne.gate0Complete).toBe(true);
    // COMPLIANCE: the slug is the code name, never the target company —
    // the URL must not name the masked seller.
    expect(dayOne.id).toBe('project-beacon');

    const midRail = createDeal(
      { id: 'figma', name: 'Figma', sector: 'Design' },
      'Project Vertex',
      { entryStepSeq: 26, gate0Complete: true },
    );
    expect(midRail.id).toBe('project-vertex');
    expect(midRail.entryStepSeq).toBe(26);
    expect(midRail.cursorStepId).toBe('p2-s26');
    // Round-trips by its code-name slug (not the company name).
    expect(resolveDeal(midRail.id)?.cursorStepId).toBe('p2-s26');
  });

  it('normalizes stored deals persisted before the re-census', () => {
    window.localStorage.setItem(
      'ib-fixture-deals',
      JSON.stringify([
        {
          id: 'notion',
          codename: 'Project Lumen',
          code: 'LUM-2026-101',
          target: 'Notion',
          sector: 'Productivity software',
          status: 'Origination',
          cursorStepId: 'win-mandate', // retired pre-census id
          dealRole: 'Managing Director',
        },
      ]),
    );
    const stored = getAllDeals().find((d) => d.id === 'notion')!;
    expect(stored.entryStepSeq).toBe(1);
    expect(stored.gate0Complete).toBe(true);
    expect(stored.cursorStepId).toBe('p1-s7');
  });

  it('does not mark Mandate Activation done at Gate 0 intake', () => {
    const ids = gate0IntakeCompleteStepIds({
      id: 'GUN-2026-042',
      codename: 'Project Gunners',
      code: 'GUN-2026-042',
      target: '',
      sector: '',
      status: 'Origination',
      cursorStepId: 'p2-s26',
      entryStepSeq: 1,
      gate0Complete: true,
      dealRole: 'Managing Director',
      createdAt: '2026-07-31T12:00:00.000Z',
      createdBy: 'Storm Duncan',
    });
    expect(ids.has(TEAM_STEP_ID)).toBe(false);
    expect(ids.has(NOTIFY_STEP_ID)).toBe(true);
  });

  it('marks Gate 0 Conflicts done when the deal completed intake without a local attestation', () => {
    const ids = gate0IntakeCompleteStepIds({
      id: 'ZEP-2026-001',
      codename: 'Project Zephyr',
      code: 'ZEP-2026-001',
      target: '',
      sector: '',
      status: 'Intake',
      cursorStepId: 'p1-s6',
      entryStepSeq: 12,
      gate0Complete: true,
      dealRole: 'Managing Director',
      createdAt: '2026-08-03T12:00:00.000Z',
    });
    expect(ids.has(CONFLICTS_STEP_ID)).toBe(true);
  });
});
