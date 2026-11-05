// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ProposalPhase } from '@/lib/discovery/propose/group';
import { proposalReason, proposedStepFor } from '@/lib/discovery/propose/station';
import { MVP_DEAL_RAIL, stepDisplayNumber } from '@/lib/rail/dealRail';

const PHASES: ProposalPhase[] = ['phase-1', 'phase-2', 'phase-3', 'phase-4', 'phase-5'];

describe('proposedStepFor', () => {
  it('is the first step of the phase on the MVP rail with a canonical seq of 1 or more', () => {
    expect(PHASES.map(proposedStepFor)).toEqual(['p1-s7', 'p2-s26', 'p3-s39', 'p4-s46', 'p5-s51']);
  });

  it.each(PHASES)('names a station on the rail that belongs to %s', (phase) => {
    const stepId = proposedStepFor(phase);
    expect(stepDisplayNumber(stepId, MVP_DEAL_RAIL)).toBeGreaterThan(0);
    expect(stepId.startsWith(`p${phase.slice('phase-'.length)}-`)).toBe(true);
  });

  it('never names a step without a canonical seq, such as Gate 0\'s notice', () => {
    const noSeq = MVP_DEAL_RAIL.flatMap((p) => p.steps).filter((s) => s.seq < 1).map((s) => s.id);
    expect(noSeq.length).toBeGreaterThan(0);
    for (const phase of PHASES) expect(noSeq).not.toContain(proposedStepFor(phase));
  });

  it('matches the SQL rule: the step id\'s phase digit is the phase the request stores', () => {
    for (const phase of PHASES) expect(proposedStepFor(phase)[1]).toBe(phase.slice(-1));
  });

  it('is the canonical array the accept RPC checks the proposed step against, in phase order', () => {
    // 20261023140100_model_proposal_accepts.sql refuses any step that is not the canonical station of the group's phase
    // (`(array[...])[right(v_phase, 1)::int]`). The TypeScript rule and that literal must never drift apart.
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20261023140100_model_proposal_accepts.sql'), 'utf8').replace(
      /--.*$/gm,
      '',
    );
    const stepArrays = [...sql.matchAll(/array\s*\[([^\]]*)\]/g)]
      .map((m) => [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]))
      .filter((items) => items.length > 0 && items.every((item) => /^p[1-5]-s[0-9]+$/.test(item)));
    expect(stepArrays).toHaveLength(1);
    expect(stepArrays[0]).toEqual(PHASES.map(proposedStepFor));
  });
});

describe('proposalReason', () => {
  it('is a fixed sentence over the counts, the phase number and its name', () => {
    expect(proposalReason({ placed: 3, of: 4, phase: 'phase-2' })).toBe(
      'The model placed 3 of 4 emails in Phase 2 · Preparation & Market Readiness',
    );
    expect(proposalReason({ placed: 2, of: 2, phase: 'phase-3' })).toBe(
      'The model placed 2 of 2 emails in Phase 3 · Marketing & First-Round Bids',
    );
  });

  it('counts one email in the singular', () => {
    expect(proposalReason({ placed: 1, of: 1, phase: 'phase-5' })).toBe(
      'The model placed 1 of 1 email in Phase 5 · Signing, Closing & Post-Close',
    );
  });

  it.each(PHASES)('has no em-dash or en-dash in %s', (phase) => {
    expect(proposalReason({ placed: 3, of: 4, phase })).not.toMatch(/[–—]/);
  });
});
