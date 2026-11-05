// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ledger = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));
vi.mock('@/lib/ai/usage', () => ({
  recordAiUsage: async (_admin: unknown, row: Record<string, unknown>) => {
    ledger.rows.push(row);
    return { error: null };
  },
}));

import * as jwt from '@/lib/ignatious/jwt';
import { readTriggerClaims } from '@/lib/ignatious/jwt';
import { STRUCTURE_PROBLEM, STRUCTURE_REASON } from '@/lib/skillRun/revisions';
import {
  applyCommentBatch,
  ENGINE_FAILED_MESSAGE,
  ENGINE_TIMEOUT_MESSAGE,
  HEAD_MOVED_MESSAGE,
  MISSING_REASON,
  NO_REPLACEMENTS_MESSAGE,
  NOTHING_APPLIED_MESSAGE,
  recordHandRevision,
  recordRestore,
  type CommentBatchJob,
  type RevisionTarget,
} from '@/lib/skillRun/applyRevision';

import { fakeAdmin, type FakeAdmin } from './helpers/skillRunAdmin';

const ROOT_ID = '3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11';
const DEAL_STEP_ID = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const PARENT_TEXT = ['# Memo', '', 'Revenue fell.', '', '- one', '- two'].join('\n');

function targetFor(store: FakeAdmin, overrides: Partial<RevisionTarget> = {}): RevisionTarget {
  return {
    admin: store.admin,
    dealId: 'deal-1',
    stepKey: 'custom:step',
    stepTitle: 'Weekly update',
    actorId: 'user-1',
    root: {
      id: ROOT_ID,
      dealStepId: DEAL_STEP_ID,
      skillId: '2d362e20-0709-4ba0-bbd7-d21831148282',
      versionId: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
      mountName: null,
      mountVersion: null,
      digest: 'a'.repeat(64),
      model: 'sonnet',
    },
    parent: { id: ROOT_ID, text: PARENT_TEXT },
    ...overrides,
  };
}

function runs(store: FakeAdmin) {
  return store.tables.deal_step_skill_runs ?? [];
}

function audits(store: FakeAdmin) {
  return (store.tables.audit_log ?? []).map((row) => row.detail as Record<string, unknown>);
}

describe('recordHandRevision', () => {
  let store: FakeAdmin;
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    store = fakeAdmin();
    ledger.rows.length = 0;
    logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logged.mockRestore();
  });

  it('writes a revision whose only changes are the edited passages', async () => {
    const result = await recordHandRevision(targetFor(store), [
      { kind: 'hand', start: 23, end: 28, text: '- uno' },
      { kind: 'hand', start: 8, end: 21, text: 'Revenue rose sharply.\n\n' },
    ]);

    expect(result).toEqual({ ok: true, revisionId: expect.any(String) });
    expect(runs(store)).toHaveLength(1);
    expect(runs(store)[0]).toMatchObject({
      source: 'revision',
      parent_run_id: ROOT_ID,
      root_run_id: ROOT_ID,
      deal_step_id: DEAL_STEP_ID,
      actor_id: 'user-1',
      skill_id: '2d362e20-0709-4ba0-bbd7-d21831148282',
      digest: 'a'.repeat(64),
      outcome: 'succeeded',
      result_text: ['# Memo', '', 'Revenue rose sharply.', '', '- uno', '- two'].join('\n'),
      model: null,
      cost_usd: null,
    });
    expect((runs(store)[0]?.inputs as { edits: unknown[] }).edits).toEqual([
      { id: expect.any(String), kind: 'hand', start: 23, end: 28, status: 'applied', resultStart: 31, resultEnd: 36 },
      { id: expect.any(String), kind: 'hand', start: 8, end: 21, status: 'applied', resultStart: 8, resultEnd: 29 },
    ]);
  });

  it('audits the revision with ids, counts and a digest, and no text', async () => {
    await recordHandRevision(targetFor(store), [{ kind: 'hand', start: 8, end: 21, text: 'Secret figure.' }]);

    expect(audits(store)).toHaveLength(1);
    expect(audits(store)[0]).toMatchObject({
      kind: 'skill_run_revision',
      phase: 'recorded',
      rootRunId: ROOT_ID,
      parentRunId: ROOT_ID,
      revisionKind: 'edits',
      outcome: 'succeeded',
      edits: { applied: 1 },
      resultDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(store.tables.audit_log)).not.toContain('Secret');
  });

  it('names the step on the audit row and still holds no comment or output text', async () => {
    await recordHandRevision(targetFor(store), [{ kind: 'hand', start: 8, end: 21, text: 'Secret figure.' }]);

    expect(audits(store)[0]).toMatchObject({ stepKey: 'custom:step', title: 'Weekly update' });
    expect(JSON.stringify(store.tables.audit_log)).not.toContain('Secret');
    expect(JSON.stringify(store.tables.audit_log)).not.toContain('Revenue');
  });

  it('refuses a result that would be empty and writes nothing', async () => {
    const store2 = fakeAdmin();

    const result = await recordHandRevision(
      targetFor(store2, { parent: { id: ROOT_ID, text: 'Only paragraph.' } }),
      [{ kind: 'hand', start: 0, end: 15, text: '   ' }],
    );

    expect(result).toEqual({ ok: false, status: 422, message: 'The revised output would be empty.' });
    expect(runs(store2)).toHaveLength(0);
  });

  it('refuses a hand edit that empties a table row and writes nothing', async () => {
    const table = ['| a | b |', '| - | - |', '| 1 | 2 |', '| 3 | 4 |', '| 5 | 6 |'].join('\n');
    const start = table.indexOf('| 3 | 4 |');

    const result = await recordHandRevision(
      targetFor(store, { parent: { id: ROOT_ID, text: table } }),
      [{ kind: 'hand', start, end: start + '| 3 | 4 |'.length, text: '' }],
    );

    expect(result).toEqual({ ok: false, status: 422, message: STRUCTURE_PROBLEM });
    expect(runs(store)).toHaveLength(0);
    expect(audits(store)).toHaveLength(0);
  });

  it('records a failed attempt and answers 409 when another revision won the same parent', async () => {
    store = fakeAdmin({
      deal_step_skill_runs: [{ id: 'winner', parent_run_id: ROOT_ID, root_run_id: ROOT_ID, outcome: 'succeeded' }],
    });

    const result = await recordHandRevision(targetFor(store), [
      { kind: 'hand', start: 8, end: 21, text: 'Revenue rose.' },
    ]);

    expect(result).toEqual({ ok: false, status: 409, message: HEAD_MOVED_MESSAGE });
    const attempt = runs(store).find((row) => row.id !== 'winner');
    expect(attempt).toMatchObject({ outcome: 'failed', result_text: null, error_message: HEAD_MOVED_MESSAGE });
    expect((attempt?.inputs as { edits: { status: string; reason: string }[] }).edits[0]).toMatchObject({
      status: 'failed',
      reason: HEAD_MOVED_MESSAGE,
    });
  });

  it('saves neither the revision nor its audit entry when the audit entry is refused', async () => {
    store.failInsertsInto.add('audit_log');

    const result = await recordHandRevision(targetFor(store), [
      { kind: 'hand', start: 8, end: 21, text: 'Revenue rose.' },
    ]);

    expect(result).toEqual({ ok: false, status: 500, message: 'The revision could not be recorded.' });
    expect(runs(store)).toHaveLength(0);
    expect(audits(store)).toHaveLength(0);
  });

  it('answers 500 and logs the code when the revision row is refused', async () => {
    store.failInsertsInto.add('deal_step_skill_runs');

    const result = await recordHandRevision(targetFor(store), [
      { kind: 'hand', start: 8, end: 21, text: 'Revenue rose.' },
    ]);

    expect(result).toEqual({ ok: false, status: 500, message: 'The revision could not be recorded.' });
    expect(runs(store)).toHaveLength(0);
    expect(audits(store)).toHaveLength(0);
    expect(logged).toHaveBeenCalledWith(
      '[skill-revision] the revision was not recorded',
      expect.any(String),
      { code: 'XX000' },
    );
  });
});

describe('recordRestore', () => {
  it('writes a revision that carries the text of the restored version', async () => {
    const store = fakeAdmin();

    const result = await recordRestore(
      targetFor(store, { parent: { id: 'v2', text: 'Second output.' } }),
      { id: ROOT_ID, text: PARENT_TEXT },
    );

    expect(result.ok).toBe(true);
    expect(runs(store)[0]).toMatchObject({
      parent_run_id: 'v2',
      root_run_id: ROOT_ID,
      outcome: 'succeeded',
      result_text: PARENT_TEXT,
      inputs: { kind: 'restore', restoredFrom: ROOT_ID },
    });
    expect(audits(store)[0]).toMatchObject({ phase: 'recorded', revisionKind: 'restore', restoredFrom: ROOT_ID });
  });
});

const REVISION_ID = '8e8e8e8e-8e8e-4e8e-8e8e-8e8e8e8e8e8e';

type Sent = {
  url: string;
  authorization: string | null;
  body: {
    revisionId: string;
    skill: unknown;
    document: string;
    passages: { id: string; start: number; end: number; comment: string }[];
    model: string | null;
  };
};

function sse(frames: unknown[], options: { breakAfter?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`));
        }
        if (options.breakAfter) controller.error(new Error('socket closed'));
        else controller.close();
      },
    }),
  );
}

function bench(reply: (sent: Sent) => Response) {
  const calls: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const sent = {
      url: String(url),
      authorization: headers.authorization ?? null,
      body: JSON.parse(String(init?.body)) as Sent['body'],
    };
    calls.push(sent);
    return reply(sent);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function jobFor(store: FakeAdmin, edits: CommentBatchJob['edits'], overrides: Partial<CommentBatchJob> = {}): CommentBatchJob {
  return {
    ...targetFor(store),
    revisionId: REVISION_ID,
    edits,
    tenantId: '00000000-0000-4000-8000-00000000000a',
    deal: { id: 'deal-1', code: 'ATLAS-2026-001' },
    config: {
      baseUrl: 'https://plane.test',
      apiKey: 'key',
      tenantId: 'tn_demo',
      leadIdOverride: null,
      benchUrl: 'https://bench.test',
      conductiaBaseUrl: null,
    },
    actorEmail: 'md@example.test',
    stepTitle: 'Weekly update',
    ...overrides,
  };
}

function recorded(store: FakeAdmin) {
  const row = runs(store).find((entry) => entry.id === REVISION_ID);
  return {
    row,
    edits: ((row?.inputs as { edits?: Record<string, unknown>[] } | undefined)?.edits ?? []),
  };
}

const COMMENT = { kind: 'comment' as const, start: 8, end: 21, comment: 'It rose 12%. Say so.' };
const SECOND_COMMENT = { kind: 'comment' as const, start: 29, end: 34, comment: 'Name the buyer.' };

describe('applyCommentBatch', () => {
  let store: FakeAdmin;
  let logged: ReturnType<typeof vi.spyOn>;

  function loggedText(): string {
    return JSON.stringify(logged.mock.calls);
  }

  beforeEach(() => {
    store = fakeAdmin();
    ledger.rows.length = 0;
    logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies a comment and a hand edit and changes nothing else', async () => {
    const engine = bench((sent) =>
      sse([
        { type: 'replacements', items: [{ id: sent.body.passages[0]?.id, text: 'Revenue rose 12%.\n' }] },
        { type: 'done', costUsd: 0.04, model: 'sonnet', skillMounted: true },
      ]),
    );

    await applyCommentBatch(
      jobFor(store, [COMMENT, { kind: 'hand', start: 23, end: 28, text: '- uno' }]),
      { fetchImpl: engine.fetchImpl },
    );

    const { row, edits } = recorded(store);
    expect(row).toMatchObject({
      outcome: 'succeeded',
      result_text: ['# Memo', '', 'Revenue rose 12%.', '', '- uno', '- two'].join('\n'),
      model: 'sonnet',
      cost_usd: 0.04,
      parent_run_id: ROOT_ID,
      root_run_id: ROOT_ID,
    });
    expect(edits).toEqual([
      { id: expect.any(String), kind: 'comment', start: 8, end: 21, comment: 'It rose 12%. Say so.', status: 'applied', resultStart: 8, resultEnd: 25 },
      { id: expect.any(String), kind: 'hand', start: 23, end: 28, status: 'applied', resultStart: 27, resultEnd: 32 },
    ]);
    expect((row?.inputs as { skillMounted?: boolean }).skillMounted).toBe(true);
  });

  it('shows the engine the document as the banker already corrected it', async () => {
    const engine = bench((sent) =>
      sse([
        { type: 'replacements', items: [{ id: sent.body.passages[0]?.id, text: '- the buyer' }] },
        { type: 'done', costUsd: 0.01 },
      ]),
    );

    await applyCommentBatch(
      jobFor(store, [
        { kind: 'hand', start: 8, end: 21, text: 'Revenue rose sharply.' },
        { kind: 'comment', start: 23, end: 28, comment: 'Name it.' },
      ]),
      { fetchImpl: engine.fetchImpl },
    );

    expect(engine.calls[0]?.url).toBe('https://bench.test/v1/bench/skill-run-revisions');
    expect(engine.calls[0]?.body.revisionId).toBe(REVISION_ID);
    expect(engine.calls[0]?.body.document).toBe(
      ['# Memo', '', 'Revenue rose sharply.', '', '- one', '- two'].join('\n'),
    );
    expect(engine.calls[0]?.body.passages).toEqual([
      { id: expect.any(String), start: 31, end: 36, comment: 'Name it.' },
    ]);
    expect(recorded(store).row?.result_text).toBe(
      ['# Memo', '', 'Revenue rose sharply.', '', '- the buyer', '- two'].join('\n'),
    );
  });

  it('sends the run skill and model, on a token that cannot write', async () => {
    const engine = bench(() => sse([{ type: 'done', costUsd: 0 }]));

    await applyCommentBatch(jobFor(store, [COMMENT]), { fetchImpl: engine.fetchImpl });

    const claims = readTriggerClaims(engine.calls[0]?.authorization ?? null);
    expect(claims).toMatchObject({ agentName: 'skill-run-revision', dealId: 'deal-1', userId: 'user-1' });
    expect(claims?.scopes).toEqual(['lead.read', 'documents.read', 'maps.read', 'library.read', 'personas.read']);
    expect(engine.calls[0]?.body.skill).toEqual({
      kind: 'publication',
      projectId: 'deal-1',
      skillId: '2d362e20-0709-4ba0-bbd7-d21831148282',
      versionId: '0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6',
      digest: 'a'.repeat(64),
    });
    expect(engine.calls[0]?.body.model).toBe('sonnet');
  });

  it('sends no skill for a run that recorded no reference', async () => {
    const engine = bench(() => sse([{ type: 'done', costUsd: 0 }]));
    const job = jobFor(store, [COMMENT]);
    job.root = { ...job.root, skillId: null, versionId: null, digest: null, model: null };

    await applyCommentBatch(job, { fetchImpl: engine.fetchImpl });

    expect(engine.calls[0]?.body.skill).toBeNull();
    expect(engine.calls[0]?.body.model).toBeNull();
  });

  it('keeps an unresolved comment with its reason beside one that was applied', async () => {
    const engine = bench((sent) =>
      sse([
        {
          type: 'replacements',
          items: [
            { id: sent.body.passages[0]?.id, text: 'Revenue rose 12%.' },
            { id: sent.body.passages[1]?.id, unresolved: 'No document names the buyer.' },
          ],
        },
        { type: 'done', costUsd: 0.05, model: 'sonnet' },
      ]),
    );

    await applyCommentBatch(jobFor(store, [COMMENT, SECOND_COMMENT]), { fetchImpl: engine.fetchImpl });

    const { row, edits } = recorded(store);
    expect(row?.outcome).toBe('succeeded');
    expect(edits[1]).toEqual({
      id: expect.any(String),
      kind: 'comment',
      start: 29,
      end: 34,
      comment: 'Name the buyer.',
      status: 'unresolved',
      reason: 'No document names the buyer.',
    });
  });

  it('marks a comment unresolved when its rewrite would change the passages around it, and applies the rest', async () => {
    const engine = bench((sent) =>
      sse([
        {
          type: 'replacements',
          items: [
            { id: sent.body.passages[0]?.id, text: 'Revenue rose 12%.' },
            { id: sent.body.passages[1]?.id, text: 'two, rewritten' },
          ],
        },
        { type: 'done', costUsd: 0.05, model: 'sonnet' },
      ]),
    );

    await applyCommentBatch(jobFor(store, [COMMENT, SECOND_COMMENT]), { fetchImpl: engine.fetchImpl });

    const { row, edits } = recorded(store);
    expect(row).toMatchObject({
      outcome: 'succeeded',
      result_text: ['# Memo', '', 'Revenue rose 12%.', '', '- one', '- two'].join('\n'),
    });
    expect(edits[0]).toMatchObject({ status: 'applied' });
    expect(edits[1]).toMatchObject({ status: 'unresolved', reason: STRUCTURE_REASON });
  });

  it('records a failed attempt with the hand-edit sentence when the combined result breaks the blocks', async () => {
    const engine = bench((sent) =>
      sse([
        { type: 'replacements', items: [{ id: sent.body.passages[0]?.id, text: 'Revenue rose 12%.' }] },
        { type: 'done', costUsd: 0.05, model: 'sonnet' },
      ]),
    );

    await applyCommentBatch(
      jobFor(store, [COMMENT, { kind: 'hand', start: 29, end: 34, text: 'two, rewritten' }]),
      { fetchImpl: engine.fetchImpl },
    );

    const { row } = recorded(store);
    expect(row).toMatchObject({ outcome: 'failed', result_text: null, error_message: STRUCTURE_PROBLEM });
  });

  it('records a passage the engine skipped, or answered for under another id, as unresolved', async () => {
    const engine = bench((sent) =>
      sse([
        {
          type: 'replacements',
          items: [
            { id: sent.body.passages[0]?.id, text: 'Revenue rose 12%.' },
            { id: 'not-a-passage', text: 'Ignored.' },
          ],
        },
        { type: 'done', costUsd: 0.05 },
      ]),
    );

    await applyCommentBatch(jobFor(store, [COMMENT, SECOND_COMMENT]), { fetchImpl: engine.fetchImpl });

    expect(recorded(store).edits[1]).toMatchObject({ status: 'unresolved', reason: MISSING_REASON });
    expect(recorded(store).row?.result_text).not.toContain('Ignored.');
  });

  it('records a failed attempt with each reason when nothing could be applied', async () => {
    const engine = bench((sent) =>
      sse([
        { type: 'replacements', items: [{ id: sent.body.passages[0]?.id, unresolved: 'No source states this.' }] },
        { type: 'done', costUsd: 0.02 },
      ]),
    );

    await applyCommentBatch(jobFor(store, [COMMENT]), { fetchImpl: engine.fetchImpl });

    const { row, edits } = recorded(store);
    expect(row).toMatchObject({ outcome: 'failed', result_text: null, error_message: NOTHING_APPLIED_MESSAGE });
    expect(edits[0]).toMatchObject({ status: 'unresolved', reason: 'No source states this.' });
  });

  it('records no model on a failed attempt that never reached the engine', async () => {
    const engine = bench(() => new Response('{"error":{"code":"server_error"}}', { status: 500 }));

    await applyCommentBatch(jobFor(store, [COMMENT]), { fetchImpl: engine.fetchImpl });

    expect(recorded(store).row).toMatchObject({ outcome: 'failed', model: null });
    expect(audits(store)[0]).toMatchObject({ phase: 'recorded', outcome: 'failed', model: null });
  });

  it('records a failed row when the work before the engine call throws', async () => {
    vi.spyOn(jwt, 'mintTriggerToken').mockImplementation(() => {
      throw new Error('signing key unavailable');
    });

    await applyCommentBatch(jobFor(store, [COMMENT]));

    expect(recorded(store).row).toMatchObject({ outcome: 'failed', result_text: null, error_message: ENGINE_FAILED_MESSAGE });
    expect(recorded(store).edits[0]).toMatchObject({ status: 'failed', reason: ENGINE_FAILED_MESSAGE });
    expect(logged).toHaveBeenCalledWith('[skill-revision] the batch could not be settled', REVISION_ID, {
      code: expect.any(String),
    });
  });

  it('logs a code and the revision id when even the failed row cannot be recorded', async () => {
    store.failInsertsInto.add('deal_step_skill_runs');
    vi.spyOn(jwt, 'mintTriggerToken').mockImplementation(() => {
      throw new Error('signing key unavailable');
    });

    await applyCommentBatch(jobFor(store, [COMMENT]));

    expect(runs(store)).toHaveLength(0);
    expect(logged).toHaveBeenCalledWith('[skill-revision] a failed attempt could not be recorded', REVISION_ID);
  });

  it('records a failed attempt with the timeout message when the abort lands while the stream is read', async () => {
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof fetch;

    await applyCommentBatch(jobFor(store, [COMMENT]), { fetchImpl, timeoutMs: 5 });

    expect(recorded(store).row).toMatchObject({ outcome: 'failed', error_message: ENGINE_TIMEOUT_MESSAGE, model: null });
    expect(recorded(store).edits[0]).toMatchObject({ status: 'failed', reason: ENGINE_TIMEOUT_MESSAGE });
    expect(logged).toHaveBeenCalledWith('[skill-revision] the engine call failed', REVISION_ID, {
      code: expect.any(String),
      timedOut: true,
    });
  });

  it('records a failed attempt and logs the status when the engine refuses the call', async () => {
    const engine = bench(() => new Response('{"error":{"code":"server_error"}}', { status: 500 }));

    await applyCommentBatch(jobFor(store, [COMMENT]), { fetchImpl: engine.fetchImpl });

    const { row, edits } = recorded(store);
    expect(row).toMatchObject({ outcome: 'failed', error_message: ENGINE_FAILED_MESSAGE });
    expect(edits[0]).toMatchObject({ status: 'failed', reason: ENGINE_FAILED_MESSAGE, comment: 'It rose 12%. Say so.' });
    expect(ledger.rows).toHaveLength(0);
    expect(logged).toHaveBeenCalledWith('[skill-revision] the engine refused the call', REVISION_ID, { status: 500 });
    expect(loggedText()).not.toContain('It rose');
    expect(loggedText()).not.toContain('Revenue');
  });

  it('records a failed attempt when the turn ends without replacements, and still books the cost', async () => {
    const engine = bench(() =>
      sse([{ type: 'text', text: 'I am not sure.' }, { type: 'done', costUsd: 0.03, model: 'sonnet' }]),
    );

    await applyCommentBatch(jobFor(store, [COMMENT]), { fetchImpl: engine.fetchImpl });

    expect(recorded(store).row).toMatchObject({ outcome: 'failed', error_message: NO_REPLACEMENTS_MESSAGE, cost_usd: 0.03 });
    expect(ledger.rows).toEqual([
      expect.objectContaining({ source: 'skill_revision', externalId: REVISION_ID, costUsd: 0.03, task: 'custom:step', actorId: 'user-1' }),
    ]);
    expect(logged).toHaveBeenCalledWith('[skill-revision] the engine turn did not end cleanly', REVISION_ID, {
      finished: true,
      hadError: false,
      hadReplacements: false,
    });
    expect(loggedText()).not.toContain('I am not sure.');
  });

  it('records a failed attempt and applies nothing when the stream ends without a done frame', async () => {
    const engine = bench((sent) =>
      sse([{ type: 'replacements', items: [{ id: sent.body.passages[0]?.id, text: 'Revenue rose 12%.' }] }]),
    );

    await applyCommentBatch(jobFor(store, [COMMENT]), { fetchImpl: engine.fetchImpl });

    const { row, edits } = recorded(store);
    expect(row).toMatchObject({ outcome: 'failed', result_text: null, error_message: ENGINE_FAILED_MESSAGE });
    expect(edits[0]).toMatchObject({ status: 'failed', reason: ENGINE_FAILED_MESSAGE });
    expect(runs(store).filter((entry) => entry.outcome === 'succeeded')).toHaveLength(0);
    expect(ledger.rows).toHaveLength(0);
    expect(logged).toHaveBeenCalledWith('[skill-revision] the engine turn did not end cleanly', REVISION_ID, {
      finished: false,
      hadError: false,
      hadReplacements: true,
    });
    expect(loggedText()).not.toContain('Revenue');
    expect(loggedText()).not.toContain('It rose');
  });

  it('records a failed attempt and books the cost when the turn reported an error after submitting replacements', async () => {
    const engine = bench((sent) =>
      sse([
        { type: 'error', message: 'Model fell over on Secret Corp' },
        { type: 'replacements', items: [{ id: sent.body.passages[0]?.id, text: 'Revenue rose 12%.' }] },
        { type: 'done', costUsd: 0.06, model: 'sonnet' },
      ]),
    );

    await applyCommentBatch(jobFor(store, [COMMENT]), { fetchImpl: engine.fetchImpl });

    const { row, edits } = recorded(store);
    expect(row).toMatchObject({ outcome: 'failed', result_text: null, error_message: ENGINE_FAILED_MESSAGE, cost_usd: 0.06 });
    expect(edits[0]).toMatchObject({ status: 'failed', reason: ENGINE_FAILED_MESSAGE });
    expect(runs(store).filter((entry) => entry.outcome === 'succeeded')).toHaveLength(0);
    expect(ledger.rows).toEqual([expect.objectContaining({ source: 'skill_revision', externalId: REVISION_ID, costUsd: 0.06 })]);
    expect(logged).toHaveBeenCalledWith('[skill-revision] the engine turn did not end cleanly', REVISION_ID, {
      finished: true,
      hadError: true,
      hadReplacements: true,
    });
    expect(loggedText()).not.toContain('Secret Corp');
    expect(loggedText()).not.toContain('Revenue');
    expect(loggedText()).not.toContain('It rose');
  });

  it('records a failed attempt and logs it when the turn reported an error and no replacements', async () => {
    const engine = bench(() =>
      sse([{ type: 'error', message: 'Model fell over on Secret Corp' }, { type: 'done', costUsd: 0.01 }]),
    );

    await applyCommentBatch(jobFor(store, [COMMENT]), { fetchImpl: engine.fetchImpl });

    expect(recorded(store).row).toMatchObject({ outcome: 'failed', result_text: null, error_message: ENGINE_FAILED_MESSAGE });
    expect(logged).toHaveBeenCalledWith('[skill-revision] the engine turn did not end cleanly', REVISION_ID, {
      finished: true,
      hadError: true,
      hadReplacements: false,
    });
    expect(loggedText()).not.toContain('Secret Corp');
    expect(loggedText()).not.toContain('It rose');
  });

  it('records a failed attempt and logs the code when the connection breaks mid-stream', async () => {
    const engine = bench(() => sse([{ type: 'text', text: 'Working.' }], { breakAfter: true }));

    await applyCommentBatch(jobFor(store, [COMMENT]), { fetchImpl: engine.fetchImpl });

    expect(recorded(store).row).toMatchObject({ outcome: 'failed', error_message: ENGINE_FAILED_MESSAGE });
    expect(logged).toHaveBeenCalledWith('[skill-revision] the engine call failed', REVISION_ID, {
      code: 'unexpected',
      timedOut: false,
    });
    expect(loggedText()).not.toContain('Working.');
    expect(loggedText()).not.toContain('It rose');
  });

  it('records a failed attempt and logs the code when the call to the engine throws', async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error('connect ECONNREFUSED Revenue fell'), { code: 'ECONNREFUSED' });
    }) as unknown as typeof fetch;

    await applyCommentBatch(jobFor(store, [COMMENT]), { fetchImpl });

    expect(recorded(store).row).toMatchObject({ outcome: 'failed', error_message: ENGINE_FAILED_MESSAGE });
    expect(logged).toHaveBeenCalledWith('[skill-revision] the engine call failed', REVISION_ID, {
      code: 'ignatious_503',
      timedOut: false,
    });
    expect(loggedText()).not.toContain('Revenue');
    expect(loggedText()).not.toContain('It rose');
  });

  it('keeps teach on the recorded comment when the engine applies the batch', async () => {
    const engine = bench((sent) =>
      sse([
        { type: 'replacements', items: sent.body.passages.map((passage) => ({ id: passage.id, text: 'Replaced.\n' })) },
        { type: 'done', costUsd: 0.04, model: 'sonnet', skillMounted: true },
      ]),
    );

    await applyCommentBatch(jobFor(store, [{ ...COMMENT, teach: true }, SECOND_COMMENT]), { fetchImpl: engine.fetchImpl });

    const { edits } = recorded(store);
    expect(edits[0]?.teach).toBe(true);
    expect(edits[1]).not.toHaveProperty('teach');
  });

  it('keeps teach on the recorded comment when the batch fails', async () => {
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;

    await applyCommentBatch(jobFor(store, [{ ...COMMENT, teach: true }, SECOND_COMMENT]), { fetchImpl, timeoutMs: 5 });

    const { edits } = recorded(store);
    expect(edits[0]).toMatchObject({ status: 'failed', teach: true });
    expect(edits[1]).not.toHaveProperty('teach');
  });

  it('stops an engine call that runs past the limit and records why', async () => {
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;

    await applyCommentBatch(jobFor(store, [COMMENT]), { fetchImpl, timeoutMs: 5 });

    expect(recorded(store).row).toMatchObject({ outcome: 'failed', error_message: ENGINE_TIMEOUT_MESSAGE });
    expect(logged).toHaveBeenCalledWith('[skill-revision] the engine call failed', REVISION_ID, {
      code: 'ignatious_503',
      timedOut: true,
    });
    expect(loggedText()).not.toContain('It rose');
  });

  it('records a failed attempt when another revision took the parent during the call', async () => {
    store = fakeAdmin({
      deal_step_skill_runs: [{ id: 'winner', parent_run_id: ROOT_ID, root_run_id: ROOT_ID, outcome: 'succeeded' }],
    });
    const engine = bench((sent) =>
      sse([
        { type: 'replacements', items: [{ id: sent.body.passages[0]?.id, text: 'Revenue rose 12%.' }] },
        { type: 'done', costUsd: 0.04 },
      ]),
    );

    await applyCommentBatch(jobFor(store, [COMMENT]), { fetchImpl: engine.fetchImpl });

    const { row, edits } = recorded(store);
    expect(row).toMatchObject({ outcome: 'failed', result_text: null, error_message: HEAD_MOVED_MESSAGE });
    expect(edits[0]).toMatchObject({ status: 'failed', reason: HEAD_MOVED_MESSAGE });
    expect(ledger.rows).toHaveLength(1);
  });

  it('never writes a comment or any output text to the audit log', async () => {
    const engine = bench((sent) =>
      sse([
        { type: 'replacements', items: [{ id: sent.body.passages[0]?.id, text: 'Revenue rose 12%.' }] },
        { type: 'done', costUsd: 0.04, model: 'sonnet' },
      ]),
    );

    await applyCommentBatch(jobFor(store, [COMMENT]), { fetchImpl: engine.fetchImpl });

    const written = JSON.stringify(store.tables.audit_log);
    expect(audits(store)[0]).toMatchObject({ phase: 'recorded', revisionId: REVISION_ID, outcome: 'succeeded', edits: { applied: 1 }, model: 'sonnet' });
    expect(written).not.toContain('It rose');
    expect(written).not.toContain('Revenue');
  });

  it('keeps no revision when its audit entry is refused, and still books the cost', async () => {
    store.failInsertsInto.add('audit_log');
    const engine = bench((sent) =>
      sse([
        { type: 'replacements', items: [{ id: sent.body.passages[0]?.id, text: 'Revenue rose 12%.' }] },
        { type: 'done', costUsd: 0.04, model: 'sonnet' },
      ]),
    );

    await applyCommentBatch(jobFor(store, [COMMENT]), { fetchImpl: engine.fetchImpl });

    expect(runs(store)).toHaveLength(0);
    expect(audits(store)).toHaveLength(0);
    expect(ledger.rows).toHaveLength(1);
    expect(logged).toHaveBeenCalledWith('[skill-revision] a failed attempt could not be recorded', REVISION_ID);
  });
});
