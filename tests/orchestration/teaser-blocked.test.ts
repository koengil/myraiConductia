import { describe, expect, it } from 'vitest';
import { InMemoryJobStore } from '@/lib/orchestration/audit';
import { Orchestrator } from '@/lib/orchestration/orchestrator';
import { buildJob, ctx } from './helpers';

describe('teaser — blocked path (compliance hard stop)', () => {
  it('blocks a promissory draft and never lets the artifact leave', async () => {
    const store = new InMemoryJobStore();
    const orch = new Orchestrator({ store });
    // A promissory headline flows verbatim into the draft, which compliance blocks.
    const job = buildJob({
      brief: { sellerName: 'Atlassian', sector: 'Software', headline: 'I guarantee the board seat stays with the founder.' },
    });

    await orch.start(job, ctx());
    const rec = await orch.approve(job.id, 'plan', ctx());

    expect(rec.state).toBe('BLOCKED');
    expect(rec.compliance?.verdict).toBe('blocked');
    expect(rec.compliance?.rewrite).toBeTruthy(); // rewrite surfaced on block
    expect(rec.artifact).toBeUndefined(); // nothing leaves the firm
  });

  it('cannot be signed off once blocked', async () => {
    const store = new InMemoryJobStore();
    const orch = new Orchestrator({ store });
    const job = buildJob({
      brief: { sellerName: 'Atlassian', sector: 'Software', headline: 'We promise a premium outcome to the buyer.' },
    });
    await orch.start(job, ctx());
    await orch.approve(job.id, 'plan', ctx());
    await expect(orch.approve(job.id, 'signoff', ctx())).rejects.toThrow();
  });

  it('routes an MNPI draft to a human (hold), not a block', async () => {
    const store = new InMemoryJobStore();
    const orch = new Orchestrator({ store });
    const job = buildJob({
      brief: { sellerName: 'Atlassian', sector: 'Software', headline: 'Our internal model floors this at $510M valuation.' },
    });
    await orch.start(job, ctx());
    const rec = await orch.approve(job.id, 'plan', ctx());
    expect(rec.state).toBe('AWAIT_SIGNOFF');
    expect(rec.compliance?.verdict).toBe('hold');
  });
});
