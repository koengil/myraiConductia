// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { runDetectOnce } from '@/lib/discovery/detect/run';
import { RULES_VERSION } from '@/lib/discovery/detect/rules.v1';
import { DetectionRefusedError, TeamPassRefusedError, type DetectItem, type DetectStore } from '@/lib/discovery/detect/store';
import type { AssessStore } from '@/lib/discovery/extract/run';

// One run of the rule detector (#173 G-07 slice 3b, the worker's --rules mode) over fake stores. The approval is
// loaded before any mail is read; without one the run reads no batch and only drains the recompute outbox. Its
// summary is integers and fixed codes, never a sentence.

const BODY = 'Team, good news. The LOI for Project Kestrel was signed today, 18 September 2026. Next: diligence.';
const item = (id: string, over: Partial<DetectItem> = {}): DetectItem => ({
  id,
  contentHash: `h-${id}`,
  sentAt: '2026-09-18T17:30:00Z',
  bodyText: BODY,
  teamMailboxIds: [],
  ...over,
});

function fakeStores(items: DetectItem[], opts: { refuseAt?: string; refusePass?: string; failAt?: string; onWrite?: (n: number) => void } = {}) {
  const pending = [...items];
  const calls = {
    batches: 0,
    detections: [] as Array<{ id: string; types: string[]; dates: string[]; version: string }>,
    passes: [] as Array<{ team: string; runId: string; items: number; events: number }>,
    touched: [] as string[][],
  };
  const store: DetectStore & AssessStore = {
    async detectBatch(_tenant, version, limit) {
      calls.batches++;
      expect(version).toBe(RULES_VERSION);
      return pending.slice(0, limit);
    },
    async recordDetection(_tenant, d, events) {
      if (d.sourceItemId === opts.refuseAt) throw new DetectionRefusedError();
      if (d.sourceItemId === opts.failAt) throw new Error('record detection failed (57014)');
      pending.splice(pending.findIndex((p) => p.id === d.sourceItemId), 1);
      calls.detections.push({ id: d.sourceItemId, types: events.map((e) => e.type), dates: events.map((e) => e.occurredAt), version: d.rulesVersion });
      opts.onWrite?.(calls.detections.length);
      return `det-${d.sourceItemId}`;
    },
    async recordTeamPass(_tenant, team, runId, counts) {
      if (team === opts.refusePass) throw new TeamPassRefusedError();
      calls.passes.push({ team, runId, ...counts });
    },
    async candidatesToAssess(_tenant, touched) {
      calls.touched.push(touched);
      return [];
    },
    async completeRequests() {},
    async saveAssessment() {
      return true;
    },
  };
  return { store, calls };
}

describe('runDetectOnce (#173 G-07 slice 3b)', () => {
  it('reads no mail without an approved firm, and still drains the recompute outbox', async () => {
    const { store, calls } = fakeStores([item('i-1')]);
    const s = await runDetectOnce({ tenantId: 't', store, approvedFirms: async () => [], runId: 'r' });
    expect(s).toMatchObject({ mode: 'rules', code: 'capability_not_approved', firms: 0, selected: 0, detected: 0 });
    expect(calls.batches).toBe(0);
    expect(calls.touched).toEqual([[]]);
  });

  it('counts an approvals read that throws as no approval', async () => {
    const { store, calls } = fakeStores([item('i-1')]);
    const s = await runDetectOnce({
      tenantId: 't',
      store,
      approvedFirms: async () => {
        throw new Error('read approvals failed');
      },
      runId: 'r',
    });
    expect(s.code).toBe('capability_not_approved');
    expect(calls.batches).toBe(0);
  });

  it('detects, settles every item, records one pass per team inbox and assesses what it touched', async () => {
    const { store, calls } = fakeStores([
      item('i-team', { teamMailboxIds: ['tm-1'] }),
      item('i-mixed', { teamMailboxIds: ['tm-1', 'tm-2'] }),
      item('i-none', { bodyText: 'Thanks, noted.' }),
    ]);
    const s = await runDetectOnce({ tenantId: 't', store, approvedFirms: async () => ['firm-a'], runId: 'run-1', batch: 2 });
    expect(s).toMatchObject({ code: 'ok', firms: 1, selected: 3, detected: 3, events: 2, teamPasses: 2, teamPassesRefused: 0 });
    expect(calls.detections).toEqual([
      { id: 'i-team', types: ['loi_signed'], dates: ['2026-09-18'], version: RULES_VERSION },
      { id: 'i-mixed', types: ['loi_signed'], dates: ['2026-09-18'], version: RULES_VERSION },
      { id: 'i-none', types: [], dates: [], version: RULES_VERSION },
    ]);
    expect(calls.passes).toEqual([
      { team: 'tm-1', runId: 'run-1', items: 2, events: 2 },
      { team: 'tm-2', runId: 'run-1', items: 1, events: 1 },
    ]);
    expect(calls.touched).toEqual([['i-team', 'i-mixed', 'i-none']]);
  });

  it('stops writing at a revoke, keeps what it wrote, and assesses that', async () => {
    const { store, calls } = fakeStores([item('i-1'), item('i-2'), item('i-3')], { refuseAt: 'i-2' });
    const s = await runDetectOnce({ tenantId: 't', store, approvedFirms: async () => ['firm-a'], runId: 'r' });
    expect(s).toMatchObject({ code: 'capability_not_approved', selected: 2, detected: 1 });
    expect(calls.detections.map((d) => d.id)).toEqual(['i-1']);
    expect(calls.touched).toEqual([['i-1']]);
  });

  it('skips the pass of an inbox refused since the batch, and fails on any other write error', async () => {
    const refused = fakeStores([item('i-1', { teamMailboxIds: ['tm-gone'] })], { refusePass: 'tm-gone' });
    const s = await runDetectOnce({ tenantId: 't', store: refused.store, approvedFirms: async () => ['f'], runId: 'r' });
    expect(s).toMatchObject({ teamPasses: 0, teamPassesRefused: 1, detected: 1 });
    const failing = fakeStores([item('i-1')], { failAt: 'i-1' });
    await expect(runDetectOnce({ tenantId: 't', store: failing.store, approvedFirms: async () => ['f'], runId: 'r' })).rejects.toThrow(
      /57014/,
    );
  });

  it('answers integers and fixed codes only, never a sentence', async () => {
    const { store } = fakeStores([item('i-1', { teamMailboxIds: ['tm-1'] })]);
    const s = await runDetectOnce({ tenantId: 't', store, approvedFirms: async () => ['f'], runId: 'r' });
    for (const [key, value] of Object.entries(s)) {
      if (key === 'mode' || key === 'code') expect(value).toMatch(/^[a-z_]+$/);
      else expect(Number.isInteger(value), key).toBe(true);
    }
    expect(JSON.stringify(s)).not.toMatch(/LOI|Kestrel|signed/);
  });

  it('stops between items on a stop, and the pass rows cover exactly the items read (audit round on #753)', async () => {
    const stop = new AbortController();
    const items = Array.from({ length: 6 }, (_, i) => item(`i-${i}`, { teamMailboxIds: ['tm-1'] }));
    const { store, calls } = fakeStores(items, { onWrite: (n) => n === 3 && stop.abort() });
    const s = await runDetectOnce({ tenantId: 't', store, approvedFirms: async () => ['f'], runId: 'r', batch: 2, signal: stop.signal });
    expect(s).toMatchObject({ code: 'stopped', selected: 3, detected: 3, teamPasses: 1 });
    expect(calls.detections.map((d) => d.id)).toEqual(['i-0', 'i-1', 'i-2']);
    expect(calls.passes).toEqual([{ team: 'tm-1', runId: 'r', items: 3, events: 3 }]);
    expect(calls.touched).toEqual([['i-0', 'i-1', 'i-2']]);
  });

  it('still writes the pass rows of what it read when a write fails, and ends with that failure', async () => {
    const items = [item('i-0', { teamMailboxIds: ['tm-1'] }), item('i-1', { teamMailboxIds: ['tm-1'] }), item('i-2', { teamMailboxIds: ['tm-1'] })];
    const { store, calls } = fakeStores(items, { failAt: 'i-1' });
    await expect(runDetectOnce({ tenantId: 't', store, approvedFirms: async () => ['f'], runId: 'r' })).rejects.toThrow(/57014/);
    expect(calls.passes).toEqual([{ team: 'tm-1', runId: 'r', items: 2, events: 2 }]);
  });

  it('stops at the run bound, so the next run carries on', async () => {
    const { store, calls } = fakeStores([item('i-1'), item('i-2'), item('i-3')]);
    const s = await runDetectOnce({ tenantId: 't', store, approvedFirms: async () => ['f'], runId: 'r', maxItems: 2 });
    expect(s.selected).toBe(2);
    expect(calls.detections.map((d) => d.id)).toEqual(['i-1', 'i-2']);
  });
});
