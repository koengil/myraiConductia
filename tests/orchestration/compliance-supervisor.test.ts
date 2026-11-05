import { describe, expect, it } from 'vitest';
import { ComplianceSupervisor } from '@/lib/orchestration/compliance/supervisor';

describe('ComplianceSupervisor.gate — hard pre-send gate', () => {
  it('clears compliant copy', () => {
    const sup = new ComplianceSupervisor();
    const out = sup.gate('Financials attached for your review.');
    expect(out.decision).toBe('clear');
    expect(out.result.verdict).toBe('compliant');
  });

  it('holds MNPI copy and routes to a human (no fabricated rewrite)', () => {
    const sup = new ComplianceSupervisor();
    const out = sup.gate('Our internal model floors this at $510M, keep it here.');
    expect(out.decision).toBe('hold');
    expect(out.result.verdict).toBe('hold');
    expect(out.result.rewrite).toBeUndefined();
  });

  it('blocks promissory copy and surfaces the rewrite', () => {
    const sup = new ComplianceSupervisor();
    const out = sup.gate('I guarantee the board seat stays with the founder.');
    expect(out.decision).toBe('block');
    expect(out.result.verdict).toBe('blocked');
    expect(out.result.rewrite).toBeTruthy();
  });
});

describe('ComplianceSupervisor.inspect — continuous monitor over the graph', () => {
  it('passes an agent that only saw what it was given', () => {
    const sup = new ComplianceSupervisor();
    const verdict = sup.inspect(
      { agent: 'ResearchAgent', saw: ['d-public', 'd-conf'], did: 'pulled comps', why: 'comps requested' },
      ['d-public', 'd-conf'],
    );
    expect(verdict.halt).toBe(false);
  });

  it('halts a rogue agent that saw an out-of-envelope artifact', () => {
    const sup = new ComplianceSupervisor();
    const verdict = sup.inspect(
      { agent: 'DraftAgent', saw: ['d-public', 'd-mnpi'], did: 'read board minutes', why: 'n/a' },
      ['d-public'],
    );
    expect(verdict.halt).toBe(true);
    expect(verdict.reason).toContain('DraftAgent');
    expect(verdict.reason).toContain('d-mnpi');
  });
});
