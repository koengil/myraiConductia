import type {
  Acquirer,
  Company,
  ComplianceCheckResult,
  CompositeScore,
  CultureMatrix,
  FounderRead,
  ConductiaAPI,
  Skill,
  SkillRunData,
  SynergyStressTest,
  TeamMember,
  Valuation,
} from './types';
import { skills } from './fixtures';
import { datasetFor } from './datasets';
import {
  computeCompositeScore,
  computeDealReadiness,
} from '../scoring/composite';
import { screenMessage } from '../compliance/screen';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class MockConductiaAPI implements ConductiaAPI {
  getSeller(dealId: string): Promise<Company> {
    return Promise.resolve(datasetFor(dealId).seller);
  }

  getAcquirers(dealId: string): Promise<Acquirer[]> {
    return Promise.resolve(datasetFor(dealId).acquirers);
  }

  getPeers(dealId: string): Promise<Company[]> {
    return Promise.resolve(datasetFor(dealId).peers);
  }

  getSkills(): Promise<Skill[]> {
    return Promise.resolve(skills);
  }

  getTeam(dealId: string): Promise<TeamMember[]> {
    return Promise.resolve(datasetFor(dealId).team);
  }

  getAcquirerScore(dealId: string, id: string): Promise<CompositeScore> {
    const acquirer = datasetFor(dealId).acquirers.find((a) => a.id === id);
    if (!acquirer) {
      throw new Error(`getAcquirerScore: unknown acquirer id "${id}"`);
    }
    return Promise.resolve(computeCompositeScore(acquirer.fitInputs));
  }

  async runSkill(
    dealId: string,
    skillId: string,
    acquirerId: string,
  ): Promise<{ locked: true } | { locked: false; data: SkillRunData }> {
    const skill = skills.find((s) => s.id === skillId);
    if (!skill) {
      throw new Error(`runSkill: unknown skill id "${skillId}"`);
    }
    if (skill.premium) {
      await delay(450);
      return { locked: true };
    }
    const acquirer = datasetFor(dealId).acquirers.find((a) => a.id === acquirerId);
    if (!acquirer) {
      throw new Error(`runSkill: unknown acquirer id "${acquirerId}"`);
    }
    let data: SkillRunData;
    switch (skill.dataShape) {
      case 'company':
        data = { dataKind: 'company', company: acquirer };
        break;
      case 'cultureFactors':
        data = { dataKind: 'cultureFactors', factors: acquirer.fitInputs.culture };
        break;
      case 'compositeScore': {
        // Both acquirer-fit and deal-readiness share the compositeScore wire
        // shape (ADR-0005) but answer different questions. The skill id picks
        // the scoring function so the two panels carry distinct totals + a
        // distinct breakdown — strategic fit vs operational readiness.
        const score =
          skill.id === 'deal-readiness'
            ? computeDealReadiness(acquirer.fitInputs)
            : computeCompositeScore(acquirer.fitInputs);
        data = { dataKind: 'compositeScore', score };
        break;
      }
    }
    await delay(450);
    return { locked: false, data };
  }

  checkMessageCompliance(body: string): Promise<ComplianceCheckResult> {
    return Promise.resolve(screenMessage(body));
  }

  async sendMessage(input: {
    fromId: string;
    toId: string;
    body: string;
  }): Promise<{ delivered: boolean; compliance: ComplianceCheckResult }> {
    const compliance = screenMessage(input.body);
    await delay(450);
    // Phase B (ADR-0003): only 'compliant' delivers automatically. 'hold' and
    // 'blocked' both stop delivery; the composer surfaces the rewrite (if
    // present) and routes to a hold-for-review or blocked card depending on
    // the verdict.
    return { delivered: compliance.verdict === 'compliant', compliance };
  }

  // ─── Phase D of the sandbox merge (2026-05-20) — analytical-panel seam.

  async getValuation(dealId: string): Promise<Valuation> {
    await delay(180);
    return datasetFor(dealId).valuation;
  }

  async getSynergyStressTest(dealId: string, acquirerId: string): Promise<SynergyStressTest> {
    void acquirerId; // deal-scoped; per-acquirer specialisation reserved
    await delay(180);
    return datasetFor(dealId).synergyStressTest;
  }

  async getFounderRead(dealId: string, acquirerId: string): Promise<FounderRead> {
    void acquirerId; // deal-scoped; per-acquirer re-weighting reserved
    await delay(180);
    return datasetFor(dealId).founderRead;
  }

  async getCultureMatrix(dealId: string, acquirerId: string): Promise<CultureMatrix> {
    await delay(180);
    const ds = datasetFor(dealId);
    const acquirer = ds.acquirers.find((a) => a.id === acquirerId);
    if (!acquirer) {
      throw new Error(`getCultureMatrix: unknown acquirer id "${acquirerId}"`);
    }
    return ds.cultureMatrixFor(acquirerId, acquirer.name);
  }
}
