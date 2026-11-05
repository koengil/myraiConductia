import { describe, expect, it, vi } from 'vitest';
import { HttpSkillAgent } from '@/lib/orchestration/transport/http-skill-agent';
import type { SkillWireRequest, SkillWireResponse } from '@/lib/orchestration/transport/wire';
import { TargetUniverseAgent } from '@/lib/orchestration/agents/target-universe-agent';
import { TargetUniverseReviewAgent } from '@/lib/orchestration/agents/target-universe-review-agent';
import { runSkillOnce } from '@/lib/orchestration/skill-runner';
import type { ComplianceMonitorEntry, TargetUniverseOutput } from '@/lib/orchestration/types';
import { buildJob, MD_ACTOR, DOCUMENTS } from './helpers';

/**
 * A fetch stub that hosts an agent the way the remote skill service would:
 * deserialize the wire request, run the agent, return the wire response with
 * the report side-channel entries collected remotely.
 */
function remoteServiceFetch(
  agent = new TargetUniverseAgent(),
): typeof fetch {
  return vi.fn(async (_url, init) => {
    const wire = JSON.parse(String(init?.body)) as SkillWireRequest;
    const reports: ComplianceMonitorEntry[] = [];
    const out = await agent.run({
      goal: wire.goal,
      envelope: wire.envelope,
      completionCondition: wire.completionCondition,
      model: wire.model,
      report: (entry) => reports.push(entry),
    });
    const body: SkillWireResponse<TargetUniverseOutput> = { ...out, reports };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
}

function tuJob() {
  return buildJob({
    id: 'job-tu-http',
    goal: 'Build the target universe for Atlassian',
    completionCondition: 'A reviewed candidate list with fixed fields exists',
    stakes: 'low',
  });
}

describe('HttpSkillAgent — the CapabilityAgent contract over HTTP', () => {
  it('is indistinguishable from an in-process skill in a full run', async () => {
    const remote = new HttpSkillAgent<TargetUniverseOutput>({
      name: 'target-universe',
      url: 'https://skills.example/run',
      fetchImpl: remoteServiceFetch(),
    });

    const run = await runSkillOnce({
      job: tuJob(),
      actor: MD_ACTOR,
      candidates: DOCUMENTS,
      skill: remote,
      reviewer: new TargetUniverseReviewAgent(),
    });

    expect(run.status).toBe('complete');
    expect(run.output?.candidates.length).toBeGreaterThan(0);
    expect(run.review?.approved).toBe(true);
  });

  it('replays remote report entries so the monitor halts a rogue remote skill', async () => {
    class RemoteRogue extends TargetUniverseAgent {
      async run(input: Parameters<TargetUniverseAgent['run']>[0]) {
        input.report({ agent: 'RemoteRogue', saw: ['d-mnpi-stolen'], did: 'peek', why: 'rogue' });
        return super.run(input);
      }
    }

    const remote = new HttpSkillAgent<TargetUniverseOutput>({
      name: 'target-universe',
      url: 'https://skills.example/run',
      fetchImpl: remoteServiceFetch(new RemoteRogue()),
    });

    const run = await runSkillOnce({
      job: tuJob(),
      actor: MD_ACTOR,
      candidates: DOCUMENTS,
      skill: remote,
      reviewer: new TargetUniverseReviewAgent(),
    });

    expect(run.status).toBe('halted');
    expect(run.output).toBeUndefined();
  });

  it('serializes the sealed envelope onto the wire — the remote sees only pushed context', async () => {
    const fetchImpl = remoteServiceFetch();
    const remote = new HttpSkillAgent<TargetUniverseOutput>({
      name: 'target-universe',
      url: 'https://skills.example/run',
      fetchImpl,
    });

    await runSkillOnce({
      job: tuJob(),
      actor: MD_ACTOR,
      candidates: DOCUMENTS,
      skill: remote,
      reviewer: new TargetUniverseReviewAgent(),
    });

    const firstCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const sent = JSON.parse(String(firstCall[1]?.body)) as SkillWireRequest;
    expect(sent.skill).toBe('target-universe');
    expect(sent.envelope.documents.map((d) => d.id)).toEqual(['d-public', 'd-conf']);
  });

  it('returns a failed result on a non-2xx response instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const remote = new HttpSkillAgent<TargetUniverseOutput>({
      name: 'target-universe',
      url: 'https://skills.example/run',
      fetchImpl,
    });

    const run = await runSkillOnce({
      job: tuJob(),
      actor: MD_ACTOR,
      candidates: DOCUMENTS,
      skill: remote,
      reviewer: new TargetUniverseReviewAgent(),
    });

    expect(run.status).toBe('failed');
  });
});
