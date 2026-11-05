import { describe, it, expect } from 'vitest';
import { acquirers, seller, peers, team, skills } from '../src/lib/api/fixtures';

describe('fixtures', () => {
  it('Anthropic fit inputs average to sub-scores 84 / 91', () => {
    const a = acquirers.find(x => x.id === 'anthropic')!;
    const f = a.fitInputs.financial; const c = a.fitInputs.culture;
    const fin = Math.round((f.valuationCoverage+f.cashCapacity+f.growth+f.margin)/4);
    const cul = Math.round((c.vision+c.mission+c.founder+c.headcount+c.industry+c.product+c.culture)/7);
    expect(fin).toBe(84); expect(cul).toBe(91);
  });
  it('Salesforce fit inputs average to sub-scores 71 / 62', () => {
    const a = acquirers.find(x => x.id === 'salesforce')!;
    const f = a.fitInputs.financial; const c = a.fitInputs.culture;
    const fin = Math.round((f.valuationCoverage+f.cashCapacity+f.growth+f.margin)/4);
    const cul = Math.round((c.vision+c.mission+c.founder+c.headcount+c.industry+c.product+c.culture)/7);
    expect(fin).toBe(71); expect(cul).toBe(62);
  });
  it('has seller Atlassian, ≥5 acquirers, peers, 3 team, 5 skills incl 1 premium', () => {
    expect(seller.id).toBe('atlassian');
    expect(acquirers.length).toBeGreaterThanOrEqual(5);
    expect(peers.length).toBeGreaterThanOrEqual(2);
    expect(team).toHaveLength(3);
    expect(skills).toHaveLength(5);
    expect(skills.filter(s => s.premium)).toHaveLength(1);
  });
});
