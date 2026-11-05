import { describe, expect, it } from 'vitest';
import { selectModel, TokenMeter } from '@/lib/orchestration/model-router';

describe('selectModel — importance, not cost', () => {
  it('routes external-facing output to the frontier tier', () => {
    expect(selectModel({ step: 'draft', stakes: 'high' })).toBe('frontier');
  });

  it('routes internal research to a cheaper tier', () => {
    expect(selectModel({ step: 'research', stakes: 'high' })).toBe('economy');
  });

  it('does not spend the frontier tier on a low-stakes draft', () => {
    expect(selectModel({ step: 'draft', stakes: 'low' })).toBe('standard');
  });
});

describe('TokenMeter — spend per agent/deal/actor is first-class', () => {
  it('accumulates total spend across recorded events', () => {
    const meter = new TokenMeter();
    meter.record({ agent: 'ResearchAgent', dealId: 'd1', actorId: 'a1', model: 'economy', tokens: 1200 });
    meter.record({ agent: 'DraftAgent', dealId: 'd1', actorId: 'a1', model: 'frontier', tokens: 3400 });
    expect(meter.total()).toBe(4600);
  });

  it('reports spend per agent', () => {
    const meter = new TokenMeter();
    meter.record({ agent: 'ResearchAgent', dealId: 'd1', actorId: 'a1', model: 'economy', tokens: 1200 });
    meter.record({ agent: 'DraftAgent', dealId: 'd1', actorId: 'a1', model: 'frontier', tokens: 3400 });
    expect(meter.byAgent('DraftAgent')).toBe(3400);
    expect(meter.byAgent('ResearchAgent')).toBe(1200);
  });

  it('retains every event for the audit trail', () => {
    const meter = new TokenMeter();
    meter.record({ agent: 'ResearchAgent', dealId: 'd1', actorId: 'a1', model: 'economy', tokens: 1200 });
    expect(meter.entries).toHaveLength(1);
    expect(meter.entries[0]).toMatchObject({ agent: 'ResearchAgent', model: 'economy', tokens: 1200 });
  });
});
