import { describe, expect, it, vi } from 'vitest';

import { createSkillBench, isRunnableBenchSkill, normalizeSkillList } from '@/lib/ignatious/bench';
import { parseBenchChatBody } from '@/lib/ignatious/benchRequest';
import { readBenchEvents } from '@/lib/ignatious/client';

const CONFIG = {
  baseUrl: 'http://localhost:4111',
  apiKey: 'local-dev-key',
  tenantId: 'tn_demo',
  leadIdOverride: null,
  benchUrl: 'http://localhost:4212',
  conductiaBaseUrl: null,
};

describe('normalizeSkillList', () => {
  it('reads the post-2026-08-24 listing (routing ceiling, tester, enabled)', () => {
    const listed = normalizeSkillList({
      skills: [
        {
          name: 'md-briefing',
          origin: 'repo',
          tag: { stageId: 'phase-1', applicationId: 'seq-9' },
          status: 'ok',
          reason: null,
          description: 'Governed first-call brief',
          version: 3,
          model: 'haiku',
          modelFrom: 'seed',
          maxModel: 'opus',
          maxEffort: 'high',
          routingFrom: 'seed',
          tester: null,
          testStatus: 'untested',
          enabled: true,
          sizeBytes: 4481,
          updatedAt: '2026-08-20T19:16:23.778Z',
          updatedBy: 'repo',
        },
      ],
      defaultModel: { modelId: 'anthropic/claude-sonnet-5', alias: 'sonnet' },
    });

    expect(listed.skills[0]).toEqual(
      expect.objectContaining({
        name: 'md-briefing',
        origin: 'repo',
        version: 3,
        model: 'haiku',
        maxModel: 'opus',
        maxEffort: 'high',
        enabled: true,
        testStatus: 'untested',
        tag: { stageId: 'phase-1', applicationId: 'seq-9' },
      }),
    );
    expect(listed.defaultModel).toEqual({
      modelId: 'anthropic/claude-sonnet-5',
      alias: 'sonnet',
    });
  });

  it('still accepts the older qualified-id listing', () => {
    const listed = normalizeSkillList({
      skills: [
        {
          id: 'committed:buyer-universe',
          kind: 'skill',
          name: 'buyer-universe',
          plugin: 'claude-skills',
          source: 'committed',
          tag: { stageId: 'preparation', applicationId: null },
          status: 'ok',
          reason: null,
        },
      ],
    });
    expect(listed.skills[0]).toEqual(
      expect.objectContaining({
        name: 'buyer-universe',
        origin: 'repo',
        version: null,
        model: null,
        maxModel: null,
        enabled: true,
        testStatus: 'untested',
      }),
    );
    expect(listed.defaultModel).toBeNull();
  });

  it('treats a missing enabled flag as on, and hides an explicit off', () => {
    const on = normalizeSkillList({ skills: [{ name: 'presearch', origin: 'repo' }] }).skills[0];
    const off = normalizeSkillList({
      skills: [{ name: 'presearch', origin: 'repo', enabled: false, status: 'ok' }],
    }).skills[0];
    expect(isRunnableBenchSkill(on)).toBe(true);
    expect(isRunnableBenchSkill(off)).toBe(false);
  });
});

describe('createSkillBench', () => {
  it('lists skills from GET /v1/bench/skills and returns defaultModel', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            skills: [
              {
                name: 'buyer-universe',
                origin: 'repo',
                tag: { stageId: 'phase-3', applicationId: 'seq-40' },
                status: 'ok',
                reason: null,
                description: null,
                version: 1,
                model: null,
                modelFrom: 'seed',
              },
            ],
            defaultModel: { modelId: 'anthropic/claude-sonnet-5', alias: 'sonnet' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    const bench = createSkillBench(CONFIG, fetchImpl as unknown as typeof fetch);
    const listed = await bench.listSkills();
    expect(listed.skills).toEqual([
      expect.objectContaining({ name: 'buyer-universe', version: 1 }),
    ]);
    expect(listed.defaultModel?.alias).toBe('sonnet');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:4212/v1/bench/skills',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-api-key': 'local-dev-key' }),
      }),
    );
  });

  it('forwards model on POST /v1/bench/chat', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const bench = createSkillBench(CONFIG, fetchImpl as unknown as typeof fetch);
    await bench.chat({
      tenantId: 'tn_demo',
      leadId: 'FALCO-2026-100',
      message: '/pitch-deck\n\nDraft the teaser',
      model: 'opus',
      selection: { stageId: 'phase-1', applicationId: 'seq-21' },
      token: 'jwt',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:4212/v1/bench/chat',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          tenantId: 'tn_demo',
          leadId: 'FALCO-2026-100',
          message: '/pitch-deck\n\nDraft the teaser',
          conversationId: null,
          selection: { stageId: 'phase-1', applicationId: 'seq-21' },
          model: 'opus',
        }),
      }),
    );
  });

  it('forwards conductiaBaseUrl when this instance names a callback origin', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const bench = createSkillBench(
      { ...CONFIG, conductiaBaseUrl: 'https://app.conductia.com' },
      fetchImpl as unknown as typeof fetch,
    );
    await bench.chat({
      tenantId: 'tn_demo',
      leadId: 'FALCO-2026-100',
      message: 'hello',
      token: 'jwt',
    });
    const body = JSON.parse(
      String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    ) as { conductiaBaseUrl?: string };
    expect(body.conductiaBaseUrl).toBe('https://app.conductia.com');
  });

  it('lists versions from GET /v1/bench/skills/{name}/versions', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            current: 2,
            versions: [
              {
                version: 2,
                origin: 'upload',
                updatedAt: '2026-08-20T10:00:00.000Z',
                updatedBy: 'md@firm.com',
                downloadable: true,
                current: true,
                description: 'Pitch deck v2',
                status: 'ok',
                reason: null,
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const bench = createSkillBench(CONFIG, fetchImpl as unknown as typeof fetch);
    await expect(bench.listVersions('pitch-deck')).resolves.toEqual({
      current: 2,
      versions: [expect.objectContaining({ version: 2, current: true })],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:4212/v1/bench/skills/pitch-deck/versions',
      expect.anything(),
    );
  });
});

describe('parseBenchChatBody', () => {
  it('reads model and selection', () => {
    expect(
      parseBenchChatBody({
        message: 'hello',
        model: 'haiku',
        selection: { stageId: 'phase-2', applicationId: 'seq-36' },
      }),
    ).toEqual({
      message: 'hello',
      conversationId: null,
      selection: { stageId: 'phase-2', applicationId: 'seq-36' },
      model: 'haiku',
      stepId: null,
    });
  });

  it('reads a rail step id for the spend ledger and drops anything that is not one', () => {
    expect(parseBenchChatBody({ message: 'hello', stepId: 'p1-s10' })).toEqual(expect.objectContaining({ stepId: 'p1-s10' }));
    for (const bad of ['../../etc', '', 'a'.repeat(41), 42, null]) {
      expect(parseBenchChatBody({ message: 'hello', stepId: bad })).toEqual(expect.objectContaining({ stepId: null }));
    }
  });

  it('rejects a raw model id', () => {
    const parsed = parseBenchChatBody({
      message: 'hello',
      model: 'anthropic/claude-sonnet-5',
    });
    expect(parsed).toEqual(expect.objectContaining({ model: null, message: 'hello' }));
  });
});

describe('readBenchEvents', () => {
  it('parses SSE data frames including model on ready', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'event: ready\ndata: {"type":"ready","conversationId":"11111111-1111-4111-8111-111111111111","skills":["buyer-universe"],"notLoaded":[],"excludedBySelection":0,"model":"anthropic/claude-sonnet-5","modelAlias":"sonnet","modelFrom":"request"}\n\n' +
              'event: text\ndata: {"type":"text","text":"Hello"}\n\n' +
              'event: end\ndata: {}\n\n',
          ),
        );
        controller.close();
      },
    });

    const events = [];
    for await (const event of readBenchEvents(stream)) {
      events.push(event);
    }
    expect(events).toEqual([
      expect.objectContaining({ type: 'ready', modelAlias: 'sonnet', modelFrom: 'request' }),
      { type: 'text', text: 'Hello' },
    ]);
  });
});
