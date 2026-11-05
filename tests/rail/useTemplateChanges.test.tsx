import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import type { TemplateChangeSet } from '@/lib/railTemplates/changeReview';

import { TEMPLATE_CHANGE_SET, decided } from './templateChangeSetFixture';

const flags = { review: true };

vi.mock('@/lib/flags/FlagsContext', () => ({
  useFlag: (key: string) => (key === 'template_change_review' ? flags.review : false),
}));

import { useTemplateChanges } from '@/lib/railTemplates/useTemplateChanges';

type Call = { url: string; method: string; body: unknown };

const server = {
  calls: [] as Call[],
  changeSet: TEMPLATE_CHANGE_SET as TemplateChangeSet | null,
  decisionStatus: 200,
  decisionBody: { error: 'This change is no longer offered' } as unknown,
};

function respond(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function respondWithText(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  } as unknown as Response;
}

const DECISION_URL = '/api/v1/deals/deal-1/rail/template-changes/added%3Acustom-fairness/decision';

describe('useTemplateChanges', () => {
  beforeEach(() => {
    flags.review = true;
    server.calls = [];
    server.changeSet = TEMPLATE_CHANGE_SET;
    server.decisionStatus = 200;
    server.decisionBody = { error: 'This change is no longer offered' };
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
      server.calls.push({ url, method, body });
      if (method === 'GET') return respond(200, { changeSet: server.changeSet });
      if (server.decisionStatus !== 200) {
        if (server.decisionBody === 'not-json') return respondWithText(server.decisionStatus);
        return respond(server.decisionStatus, server.decisionBody);
      }
      const changeId = decodeURIComponent(url.split('/template-changes/')[1].split('/')[0]);
      const decision = method === 'POST' ? (body as { decision: 'accepted' | 'discarded' }).decision : null;
      server.changeSet = server.changeSet && decided(server.changeSet, { [changeId]: decision });
      return respond(200, { changeSet: server.changeSet });
    }) as unknown as typeof fetch;
  });

  it('offers nothing and never calls the server with the flag off', () => {
    flags.review = false;
    const { result } = renderHook(() => useTemplateChanges('deal-1'));
    expect(result.current.changeSet).toBeNull();
    expect(result.current.pending).toEqual([]);
    expect(server.calls).toEqual([]);
  });

  it('refresh reads the change set again', async () => {
    const { result } = renderHook(() => useTemplateChanges('deal-1'));
    await waitFor(() => expect(result.current.changeSet).not.toBeNull());

    server.changeSet = null;
    await act(() => result.current.refresh());

    expect(result.current.changeSet).toBeNull();
    expect(server.calls.filter((call) => call.method === 'GET')).toHaveLength(2);
  });

  it('refresh does nothing with the flag off', async () => {
    flags.review = false;
    const { result } = renderHook(() => useTemplateChanges('deal-1'));
    await act(() => result.current.refresh());
    expect(server.calls).toEqual([]);
  });

  it('reads the change set and lists what is pending', async () => {
    const { result } = renderHook(() => useTemplateChanges('deal-1'));
    await waitFor(() => expect(result.current.changeSet).not.toBeNull());
    expect(server.calls[0]).toEqual({
      url: '/api/v1/deals/deal-1/rail/template-changes',
      method: 'GET',
      body: null,
    });
    expect(result.current.pending.map((c) => c.id)).toEqual([
      'added:custom-fairness',
      'added:custom-sanctions',
      'removed:p5-s53',
    ]);
  });

  it('posts a decision, takes the returned change set and reports it applied', async () => {
    const onApplied = vi.fn();
    const { result } = renderHook(() => useTemplateChanges('deal-1', { onApplied }));
    await waitFor(() => expect(result.current.changeSet).not.toBeNull());

    await act(() => result.current.decide('added:custom-fairness', 'accepted'));

    expect(server.calls[1]).toEqual({ url: DECISION_URL, method: 'POST', body: { decision: 'accepted', revisionId: 'revision-4' } });
    expect(result.current.pending.map((c) => c.id)).toEqual(['added:custom-sanctions', 'removed:p5-s53']);
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it('reopens a discarded change with DELETE', async () => {
    server.changeSet = decided(TEMPLATE_CHANGE_SET, { 'added:custom-fairness': 'discarded' });
    const { result } = renderHook(() => useTemplateChanges('deal-1'));
    await waitFor(() => expect(result.current.changeSet).not.toBeNull());
    expect(result.current.pending).toHaveLength(2);

    await act(() => result.current.reopen('added:custom-fairness'));

    expect(server.calls[1]).toEqual({ url: DECISION_URL, method: 'DELETE', body: null });
    expect(result.current.pending).toHaveLength(3);
  });

  it('states a stale decision, reloads the list and reports the rail changed', async () => {
    const onApplied = vi.fn();
    const { result } = renderHook(() => useTemplateChanges('deal-1', { onApplied }));
    await waitFor(() => expect(result.current.changeSet).not.toBeNull());
    server.decisionStatus = 409;
    server.changeSet = decided(TEMPLATE_CHANGE_SET, { 'added:custom-fairness': 'accepted' });

    await act(() => result.current.decide('added:custom-fairness', 'accepted'));

    expect(result.current.error).toBe(
      'The template or this decision changed. The list now shows the latest state.',
    );
    expect(server.calls.at(-1)?.method).toBe('GET');
    expect(result.current.pending.map((c) => c.id)).toEqual(['added:custom-sanctions', 'removed:p5-s53']);
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it('shows the re-read change set after a conflict and posts its revision on the next decision', async () => {
    const { result } = renderHook(() => useTemplateChanges('deal-1'));
    await waitFor(() => expect(result.current.changeSet).not.toBeNull());
    server.decisionStatus = 409;
    server.changeSet = {
      ...TEMPLATE_CHANGE_SET,
      currentRevision: { ...TEMPLATE_CHANGE_SET.currentRevision, id: 'revision-5', label: 'v5' },
    };

    await act(() => result.current.decide('added:custom-fairness', 'accepted'));

    expect(result.current.changeSet?.currentRevision).toMatchObject({ id: 'revision-5', label: 'v5' });
    expect(result.current.error).toBe(
      'The template or this decision changed. The list now shows the latest state.',
    );

    server.decisionStatus = 200;
    await act(() => result.current.decide('added:custom-sanctions', 'discarded'));

    expect(server.calls.at(-1)?.body).toEqual({ decision: 'discarded', revisionId: 'revision-5' });
  });

  it('keeps the list when a decision fails', async () => {
    const onApplied = vi.fn();
    const { result } = renderHook(() => useTemplateChanges('deal-1', { onApplied }));
    await waitFor(() => expect(result.current.changeSet).not.toBeNull());
    server.decisionStatus = 500;

    await act(() => result.current.decide('added:custom-fairness', 'accepted'));

    expect(result.current.error).toBe('The decision could not be saved. Try again.');
    expect(result.current.pending).toHaveLength(3);
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('shows the server sentence for a refused skill step and leaves the list alone', async () => {
    const onApplied = vi.fn();
    const { result } = renderHook(() => useTemplateChanges('deal-1', { onApplied }));
    await waitFor(() => expect(result.current.changeSet).not.toBeNull());
    server.decisionStatus = 409;
    server.decisionBody = {
      error: 'Skills are not enabled here, so this step was not added.',
      code: 'skill_step_not_added',
    };

    await act(() => result.current.decide('added:custom-fairness', 'accepted'));

    expect(result.current.error).toBe('Skills are not enabled here, so this step was not added.');
    expect(server.calls.filter((call) => call.method === 'GET')).toHaveLength(1);
    expect(onApplied).not.toHaveBeenCalled();
    expect(result.current.pending).toHaveLength(3);
    expect(result.current.busy).toBe(false);
  });

  it('shows the server sentence for a skill step refused with a 503', async () => {
    const { result } = renderHook(() => useTemplateChanges('deal-1'));
    await waitFor(() => expect(result.current.changeSet).not.toBeNull());
    server.decisionStatus = 503;
    server.decisionBody = {
      error: 'The skill service did not answer, so the step was not added.',
      code: 'skill_step_not_added',
    };

    await act(() => result.current.decide('added:custom-fairness', 'accepted'));

    expect(result.current.error).toBe('The skill service did not answer, so the step was not added.');
  });

  it('never shows a sentence that carries no code', async () => {
    const { result } = renderHook(() => useTemplateChanges('deal-1'));
    await waitFor(() => expect(result.current.changeSet).not.toBeNull());
    server.decisionStatus = 500;
    server.decisionBody = { error: 'Could not read this change.' };

    await act(() => result.current.decide('added:custom-fairness', 'accepted'));

    expect(result.current.error).toBe('The decision could not be saved. Try again.');
  });

  it('ignores a coded answer whose sentence is empty', async () => {
    const { result } = renderHook(() => useTemplateChanges('deal-1'));
    await waitFor(() => expect(result.current.changeSet).not.toBeNull());
    server.decisionStatus = 500;
    server.decisionBody = { error: '', code: 'skill_step_not_added' };

    await act(() => result.current.decide('added:custom-fairness', 'accepted'));

    expect(result.current.error).toBe('The decision could not be saved. Try again.');
  });

  it('keeps the stale behaviour for a 409 whose body is not JSON', async () => {
    const onApplied = vi.fn();
    const { result } = renderHook(() => useTemplateChanges('deal-1', { onApplied }));
    await waitFor(() => expect(result.current.changeSet).not.toBeNull());
    server.decisionStatus = 409;
    server.decisionBody = 'not-json';

    await act(() => result.current.decide('added:custom-fairness', 'accepted'));

    expect(result.current.error).toBe(
      'The template or this decision changed. The list now shows the latest state.',
    );
    expect(server.calls.at(-1)?.method).toBe('GET');
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it('keeps the failure line for a 502 whose body is not JSON', async () => {
    const { result } = renderHook(() => useTemplateChanges('deal-1'));
    await waitFor(() => expect(result.current.changeSet).not.toBeNull());
    server.decisionStatus = 502;
    server.decisionBody = 'not-json';

    await act(() => result.current.decide('added:custom-fairness', 'accepted'));

    expect(result.current.error).toBe('The decision could not be saved. Try again.');
  });

  it('treats a body that is not an object as no body', async () => {
    const { result } = renderHook(() => useTemplateChanges('deal-1'));
    await waitFor(() => expect(result.current.changeSet).not.toBeNull());
    server.decisionStatus = 500;
    server.decisionBody = null;

    await act(() => result.current.decide('added:custom-fairness', 'accepted'));

    expect(result.current.error).toBe('The decision could not be saved. Try again.');
  });
});
