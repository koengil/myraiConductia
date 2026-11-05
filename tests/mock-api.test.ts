import { describe, it, expect } from 'vitest';
import { getApi } from '../src/lib/api';
import { datasetFor } from '../src/lib/api/datasets';
import { SEED_DEALS } from '../src/lib/rail/deals';

describe('MockConductiaAPI (contract)', () => {
  const api = getApi();
  // The sandbox deal (Project Summit = the Atlassian dataset) keeps the locked
  // composite floor (ADR-0002). Passing the deal id is the new per-deal seam.
  const SUMMIT = 'project-summit';
  it('getAcquirerScore is deterministic 87/67 on the sandbox deal', async () => {
    expect((await api.getAcquirerScore(SUMMIT, 'anthropic')).total).toBe(87);
    expect((await api.getAcquirerScore(SUMMIT, 'salesforce')).total).toBe(67);
  });
  it('runSkill returns locked for the premium skill', async () => {
    const r = await api.runSkill(SUMMIT, 'synergy-engine', 'anthropic');
    expect(r.locked).toBe(true);
  });

  // Per-deal scoping: a different deal returns a genuinely different dataset,
  // not the same Atlassian fixtures relabeled.
  it('scopes content per deal — Harbor is GitLab, not Atlassian', async () => {
    const summitSeller = await api.getSeller(SUMMIT);
    const harborSeller = await api.getSeller('project-harbor');
    expect(summitSeller.name).toBe('Atlassian');
    expect(harborSeller.name).toBe('GitLab');

    const summitBuyers = (await api.getAcquirers(SUMMIT)).map((a) => a.id);
    const harborBuyers = (await api.getAcquirers('project-harbor')).map((a) => a.id);
    expect(summitBuyers).toContain('anthropic');
    expect(harborBuyers).not.toContain('anthropic');
    expect(harborBuyers.length).toBeGreaterThan(0);
  });

  it('resolves the dataset by deal code as well as by code-name slug', async () => {
    const [summit, harbor] = SEED_DEALS;

    expect(datasetFor(summit.id)).toBe(datasetFor(summit.code));
    expect(datasetFor(harbor.id)).toBe(datasetFor(harbor.code));

    expect((await api.getSeller(summit.code)).name).toBe('Atlassian');
    expect((await api.getSeller(harbor.code)).name).toBe('GitLab');

    expect((await api.getAcquirerScore(summit.code, 'anthropic')).total).toBe(87);
    expect((await api.getAcquirerScore(summit.code, 'salesforce')).total).toBe(67);
  });

  it('an unknown id resolves to the EMPTY dataset, by code shape or otherwise', async () => {
    expect(datasetFor('ATLAS-2026-001').acquirers).toEqual([]);
    expect(datasetFor('not-a-uuid').acquirers).toEqual([]);
    expect(datasetFor(undefined).acquirers).toEqual([]);
    expect((await api.getSeller('ATLAS-2026-001')).name).not.toBe('Atlassian');
  });

  it('created/unknown deals resolve to an EMPTY dataset, never another deal', async () => {
    // COMPLIANCE: a created deal (e.g. Falcon) must not show another named
    // deal's confidential analysis. It gets an honestly-empty dataset.
    const seller = await api.getSeller('project-falcon');
    expect(seller.name).not.toBe('Atlassian');
    expect(await api.getAcquirers('project-falcon')).toEqual([]);
    expect(await api.getPeers('project-falcon')).toEqual([]);
  });
  // Lockstep edit (Phase F sandbox merge, 2026-05-20 — ADR-0005 carry):
  // runSkill's return shape is now `{ data: SkillRunData }` with a
  // domain-name discriminator, not the prior `{ panel: PanelData }` with a
  // UI-panel-name discriminator. The acquirer-fit skill produces a
  // CompositeScore, dataKind 'compositeScore'.
  it('runSkill returns domain data for a free skill', async () => {
    const r = await api.runSkill(SUMMIT, 'acquirer-fit', 'anthropic');
    expect(r.locked).toBe(false);
    if (!r.locked) expect(r.data.dataKind).toBe('compositeScore');
  });
  // Lockstep edit (Phase B sandbox merge, ADR-0003): the compliance engine
  // is the three-state screenMessage (promissory / MNPI / compliant); the
  // old binary profanity check was retired. The test exercises all three
  // verdicts — compliant delivers, hold and blocked do not.
  it('sendMessage delivers compliant; holds MNPI; blocks promissory', async () => {
    const ok = await api.sendMessage({ fromId:'md', toId:'cfo', body:'Financials attached for your review.' });
    expect(ok.delivered).toBe(true);
    expect(ok.compliance.verdict).toBe('compliant');

    const held = await api.sendMessage({ fromId:'md', toId:'advisor', body:'Our internal model floors this at $510M, keep it here.' });
    expect(held.delivered).toBe(false);
    expect(held.compliance.verdict).toBe('hold');

    const blocked = await api.sendMessage({ fromId:'md', toId:'advisor', body:'I guarantee the board seat stays with the founder.' });
    expect(blocked.delivered).toBe(false);
    expect(blocked.compliance.verdict).toBe('blocked');
    expect(blocked.compliance.rewrite).toBeDefined();
  });
});
