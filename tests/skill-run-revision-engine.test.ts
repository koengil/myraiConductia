// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createSkillBench } from '@/lib/ignatious/bench';
import { readRevisionStream } from '@/lib/skillRun/revisionStream';

const CONFIG = {
  baseUrl: 'https://plane.test',
  apiKey: 'bench-key',
  tenantId: 'tn_demo',
  leadIdOverride: null,
  benchUrl: 'https://bench.test',
  conductiaBaseUrl: 'https://conductia.test',
};

const PUBLICATION = {
  kind: 'publication' as const,
  skillId: '2d362e20-0709-4ba0-bbd7-d21831148282',
  versionId: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
  digest: 'a'.repeat(64),
};

function stream(frames: unknown[], options: { breakAfter?: boolean } = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`));
      }
      if (options.breakAfter) controller.error(new Error('socket closed'));
      else controller.close();
    },
  });
}

describe('startSkillRunRevision', () => {
  it('posts the document and passages to the bench with the caller token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response('ok');
    }) as typeof fetch;

    await createSkillBench(CONFIG, fetchImpl).startSkillRunRevision({
      revisionId: 'rev-1',
      skill: PUBLICATION,
      projectId: 'deal-1',
      document: '# Memo',
      passages: [{ id: 'p1', start: 0, end: 6, comment: 'Retitle.' }],
      tenantId: 'tn_demo',
      leadId: 'ATLAS-2026-001',
      model: 'sonnet',
      token: 'trigger-token',
    });

    expect(calls[0]?.url).toBe('https://bench.test/v1/bench/skill-run-revisions');
    expect(calls[0]?.init.headers).toMatchObject({
      'x-api-key': 'bench-key',
      authorization: 'Bearer trigger-token',
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      revisionId: 'rev-1',
      skill: { ...PUBLICATION, projectId: 'deal-1' },
      document: '# Memo',
      passages: [{ id: 'p1', start: 0, end: 6, comment: 'Retitle.' }],
      tenantId: 'tn_demo',
      leadId: 'ATLAS-2026-001',
      model: 'sonnet',
      conductiaBaseUrl: 'https://conductia.test',
    });
  });

  it('sends a null skill for a run that recorded no reference', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('ok');
    }) as typeof fetch;

    await createSkillBench(CONFIG, fetchImpl).startSkillRunRevision({
      revisionId: 'rev-1',
      skill: null,
      projectId: 'deal-1',
      document: '# Memo',
      passages: [{ id: 'p1', start: 0, end: 6, comment: 'Retitle.' }],
      tenantId: 'tn_demo',
      leadId: 'ATLAS-2026-001',
      token: 'trigger-token',
    });

    expect(sent.skill).toBeNull();
    expect(sent.model).toBeNull();
  });
});

describe('readRevisionStream', () => {
  it('reads the replacements, the cost, the model and whether the skill was mounted', async () => {
    const outcome = await readRevisionStream(
      stream([
        { type: 'ready', model: 'anthropic/claude-sonnet-5' },
        { type: 'text', text: 'Working.' },
        {
          type: 'replacements',
          items: [
            { id: 'p1', text: 'Revenue rose 12%.' },
            { id: 'p2', unresolved: 'No document names the buyer.' },
          ],
        },
        { type: 'done', costUsd: 0.04, model: 'sonnet', modelId: 'anthropic/claude-sonnet-5', skillMounted: true },
      ]),
    );

    expect(outcome.finished).toBe(true);
    expect(outcome.costUsd).toBe(0.04);
    expect(outcome.model).toBe('sonnet');
    expect(outcome.alias).toBe('sonnet');
    expect(outcome.skillMounted).toBe(true);
    expect([...(outcome.replacements ?? [])]).toEqual([
      ['p1', { text: 'Revenue rose 12%.' }],
      ['p2', { unresolved: 'No document names the buyer.' }],
    ]);
  });

  it('reports no replacements when the model never submitted', async () => {
    const outcome = await readRevisionStream(
      stream([{ type: 'error', message: 'The provider refused.' }, { type: 'done', costUsd: null }]),
    );

    expect(outcome.replacements).toBeNull();
    expect(outcome.error).toBe('The provider refused.');
    expect(outcome.finished).toBe(true);
  });

  it('reports an unfinished turn when the stream ends before done', async () => {
    const outcome = await readRevisionStream(stream([{ type: 'text', text: 'Working.' }]));

    expect(outcome.finished).toBe(false);
    expect(outcome.replacements).toBeNull();
  });

  it('drops an item that is neither a text nor a reason', async () => {
    const outcome = await readRevisionStream(
      stream([
        { type: 'replacements', items: [{ id: 'p1' }, { text: 'no id' }, { id: 'p2', text: '' }] },
        { type: 'done', costUsd: 0 },
      ]),
    );

    expect([...(outcome.replacements ?? [])]).toEqual([['p2', { text: '' }]]);
  });

  it('rejects when the connection breaks mid-stream', async () => {
    await expect(
      readRevisionStream(stream([{ type: 'text', text: 'Working.' }], { breakAfter: true })),
    ).rejects.toThrow('socket closed');
  });
});
