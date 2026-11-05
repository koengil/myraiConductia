// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { DetectItem, DetectStore } from '@/lib/discovery/detect/store';
import type { AssessStore } from '@/lib/discovery/extract/run';
import { OperatorCopyError } from '@/lib/errors/upstream';

import { main, parseExtractArgs } from '../../worker/extract';

// worker/extract.ts --rules (#173 G-07 slice 3b, the image's `detect` entry): it runs alone, builds no transport, loads
// the tenant's milestone_rules approvals before any mail, and prints one JSON line of integers and fixed codes.

const TENANT = '00000000-0000-4000-8000-0000000000aa';
const BODY = 'The LOI for Project Kestrel was signed today, 18 September 2026.';

function rulesDeps(firms: string[], items: DetectItem[]) {
  const lines: string[] = [];
  const asked: string[] = [];
  let transportBuilt = false;
  let extractStoreBuilt = false;
  const pending = [...items];
  const store: DetectStore & AssessStore = {
    detectBatch: async () => pending.splice(0),
    recordDetection: async (_t, d) => `det-${d.sourceItemId}`,
    recordTeamPass: async () => {},
    candidatesToAssess: async () => [],
    completeRequests: async () => {},
    saveAssessment: async () => true,
  };
  const deps = {
    transportFor: () => {
      transportBuilt = true;
      throw new Error('no transport in --rules');
    },
    store: () => {
      extractStoreBuilt = true;
      throw new Error('no extract store in --rules');
    },
    print: (l: string) => lines.push(l),
    rules: () => ({
      store,
      approvedFirms: async (tenantId: string) => {
        asked.push(tenantId);
        return firms;
      },
    }),
  };
  return { deps, lines, asked, built: () => ({ transportBuilt, extractStoreBuilt }) };
}

describe('worker/extract.ts --rules', () => {
  it('runs alone', () => {
    expect(parseExtractArgs(['--rules'])).toMatchObject({ rules: true, estimate: false, watch: false });
    for (const other of [['--estimate'], ['--watch'], ['--once'], ['--transport', 'gateway'], ['--replies', 'x.json'], ['--strict']]) {
      expect(() => parseExtractArgs(['--rules', ...other]), other.join(' ')).toThrow(OperatorCopyError);
    }
  });

  it('with no approval prints capability_not_approved and counts, and builds no transport', async () => {
    const r = rulesDeps([], [{ id: 'i-1', contentHash: 'h', sentAt: '2026-09-18T17:30:00Z', bodyText: BODY, teamMailboxIds: [] }]);
    await main(['--rules', '--tenant', TENANT], r.deps);
    expect(r.asked).toEqual([TENANT]);
    expect(r.built()).toEqual({ transportBuilt: false, extractStoreBuilt: false });
    expect(r.lines).toHaveLength(1);
    expect(JSON.parse(r.lines[0])).toMatchObject({ mode: 'rules', code: 'capability_not_approved', firms: 0, selected: 0 });
  });

  it('registers the stop handler, so a SIGTERM ends the run between items (audit round on #753)', async () => {
    const r = rulesDeps(['firm-a'], [{ id: 'i-1', contentHash: 'h', sentAt: '2026-09-18T17:30:00Z', bodyText: BODY, teamMailboxIds: [] }]);
    let stop: (() => void) | null = null;
    await main(['--rules', '--tenant', TENANT], { ...r.deps, onStop: (fn) => { stop = fn; fn(); } });
    expect(stop).not.toBeNull();
    expect(JSON.parse(r.lines[0])).toMatchObject({ code: 'stopped', selected: 0 });
  });

  it('approved, prints one line of integers and codes, never the text it read', async () => {
    const r = rulesDeps(['firm-a'], [{ id: 'i-1', contentHash: 'h', sentAt: '2026-09-18T17:30:00Z', bodyText: BODY, teamMailboxIds: ['tm-1'] }]);
    await main(['--rules', '--tenant', TENANT], r.deps);
    expect(r.lines).toHaveLength(1);
    expect(JSON.parse(r.lines[0])).toMatchObject({ code: 'ok', firms: 1, selected: 1, detected: 1, events: 1, teamPasses: 1 });
    expect(r.lines[0]).not.toMatch(/LOI|Kestrel|signed|i-1|tm-1/);
    expect(r.built()).toEqual({ transportBuilt: false, extractStoreBuilt: false });
  });
});
