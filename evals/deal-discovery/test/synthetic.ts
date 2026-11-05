// Synthetic inputs for the harness tests, written to a temp directory at test
// time. Nothing here is, or is derived from, a real answer key: the deals are
// the fixture corpus's (Falcon, Cobra) plus invented ones that exercise every
// metric and every miss bucket.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ANSWER_KEY_FORMAT } from '../src/answerKey.ts';
import {
  EXPORT_FILES,
  EXPORT_FORMAT,
  type DiscoveryExport,
  type ExportCandidate,
  type ExportItem,
  type ExportLedgerRow,
  type ExportLink,
  type ExportSource,
} from '../src/exportData.ts';

// Every directory tempDir() makes in this test file's process. Each test file
// that calls tempDir() registers `after(removeTempDirs)`, so a run leaves
// nothing behind in the system temp directory.
const created: string[] = [];

export function tempDir(prefix = 'dd-eval-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export const TENANT = '00000000-0000-4000-8000-00000000e001';
const MAILBOX = '00000000-0000-4000-8000-0000000000a1';
const SITE = '00000000-0000-4000-8000-0000000000b1';
const RUN = '00000000-0000-4000-8000-0000000000c1';

let seq = 0;
function uuid(prefix: string): string {
  seq += 1;
  return `${prefix}${String(seq).padStart(4, '0')}-0000-4000-8000-000000000000`;
}

export function source(kind: ExportSource['kind'], id: string): ExportSource {
  return { id, kind, status: 'active', ownerAssigned: true, backfillCompletedAt: '2026-03-01T00:00:00Z', lastSyncedAt: '2026-03-01T00:00:00Z' };
}

export function candidate(partial: Partial<ExportCandidate> & { proposedName: string }): ExportCandidate {
  return {
    id: uuid('ca'),
    clusterKey: `codename:${partial.proposedName.toLowerCase()}`,
    discoveryState: 'proposed',
    mergedIntoId: null,
    promotedDealId: null,
    codenameGuess: partial.proposedName,
    parties: [],
    firstSeenAt: '2026-02-03T09:00:00Z',
    lastSeenAt: '2026-02-20T16:00:00Z',
    dealSide: 'unknown',
    confidence: 1,
    ...partial,
  };
}

export function message(internetMessageId: string, conversationId: string | null): ExportItem {
  return {
    id: uuid('it'),
    kind: 'message',
    internetMessageId,
    conversationId,
    driveItemKey: null,
    drivePath: null,
    sentAt: '2026-02-10T10:00:00Z',
    sensitivity: 'standard',
  };
}

export function document(drivePath: string, driveItemId: string): ExportItem {
  return {
    id: uuid('it'),
    kind: 'document',
    internetMessageId: null,
    conversationId: null,
    driveItemKey: `b!drive:${driveItemId}`,
    drivePath,
    sentAt: '2026-02-10T10:00:00Z',
    sensitivity: 'standard',
  };
}

export function link(candidateId: string, sourceItemId: string, state: ExportLink['state'] = 'proposed'): ExportLink {
  return {
    id: uuid('li'),
    candidateId,
    dealId: null,
    sourceItemId,
    method: 'codename',
    confidence: 1,
    routeTier: 'firm',
    state,
  };
}

export function ledger(partial: Partial<ExportLedgerRow> & { providerItemId: string; decision: ExportLedgerRow['decision'] }): ExportLedgerRow {
  return {
    sourceId: MAILBOX,
    method: null,
    confidence: null,
    skipReason: null,
    conversationId: null,
    internetMessageId: null,
    providerThreadId: null,
    policyVersion: null,
    exclusionRule: null,
    runId: RUN,
    recordedAt: '2026-03-01T00:00:00Z',
    ...partial,
  };
}

/**
 * The scenario the score tests assert on.
 *
 * Deals: T01 Falcon (found), T02 Cobra (found), T03 Heron (never discovered),
 * T04 Osprey (split across two candidates). Candidates: Falcon, Cobra, two
 * Osprey fragments, and "Management" (matches nothing).
 *
 * Falcon's key items, one per outcome:
 *   <f1>            stored, linked to Falcon           recovered
 *   <f2>            stored, linked to Cobra            routed_elsewhere
 *   <f3>            unrouted, conversation conv-f1     unrouted_late_thread
 *   <f4>            unrouted, conversation conv-lone   unrouted_other
 *   <f5>            unrouted, attachmentOnly           attachment_only
 *   <f6>            stored, no link                    routed_unlinked
 *   Falcon/CIM.pdf  stored, linked to Falcon           recovered
 *   Falcon/scan.pdf ledger skipped image_only          skipped_document
 *   Falcon/notes.docx  no driveItemId, not stored      document_unresolved
 *   Falcon/memo.docx   ledger unrouted (driveItemId)   unrouted_other
 * Heron: <h1> no ledger row                           never_read
 * Negative: <lunch> belongs to no deal, but is linked to "Management".
 * Not in the key: <stray>, linked to "Management".
 */
export function scenario() {
  const falcon = candidate({ proposedName: 'Project Falcon', codenameGuess: 'Project Falcon', parties: [{ name: 'Heliotrope', domain: 'heliotrope.example' }] });
  const cobra = candidate({ proposedName: 'Project Cobra', codenameGuess: 'Project Cobra', parties: [{ name: 'Cobalt Systems', domain: 'cobalt-systems.example' }], firstSeenAt: '2025-11-04T15:00:00Z', lastSeenAt: '2025-11-06T09:20:00Z' });
  const ospreyA = candidate({ proposedName: 'Project Osprey', clusterKey: 'codename:osprey' });
  const ospreyB = candidate({ proposedName: 'Osprey', clusterKey: 'codename:osprey#2', firstSeenAt: '2026-03-01T00:00:00Z', lastSeenAt: '2026-03-02T00:00:00Z' });
  const management = candidate({ proposedName: 'Management', parties: [{ name: 'Newswire', domain: 'newswire.example' }] });
  const rejected = candidate({ proposedName: 'Project Falcon', discoveryState: 'rejected', clusterKey: 'codename:falcon#9' });

  const f1 = message('<f1@bank.example>', 'conv-f1');
  const f2 = message('<f2@bank.example>', 'conv-f2');
  const f6 = message('<f6@bank.example>', 'conv-f6');
  const cim = document('/Falcon/CIM.pdf', 'D-CIM');
  const c1 = message('<c1@bank.example>', 'conv-c1');
  const o1 = message('<o1@bank.example>', 'conv-o1');
  const o2 = message('<o2@bank.example>', 'conv-o2');
  const lunch = message('<lunch@bank.example>', 'conv-lunch');
  const stray = message('<stray@bank.example>', 'conv-stray');

  const data: DiscoveryExport = {
    manifest: { format: EXPORT_FORMAT, tenantId: TENANT, exportedAt: '2026-09-26T10:15:00.000Z', counts: {} },
    sources: [source('mailbox', MAILBOX), source('sharepoint_site', SITE)],
    items: [f1, f2, f6, cim, c1, o1, o2, lunch, stray],
    provenance: [f1, f2, f6, c1, o1, o2, lunch, stray].map((i) => ({ sourceItemId: i.id, sourceId: MAILBOX, providerItemId: `p-${i.id}` })),
    candidates: [falcon, cobra, ospreyA, ospreyB, management, rejected],
    links: [
      link(falcon.id, f1.id),
      link(falcon.id, cim.id),
      link(cobra.id, f2.id),
      link(cobra.id, c1.id),
      link(ospreyA.id, o1.id),
      link(ospreyB.id, o2.id),
      link(management.id, lunch.id),
      link(management.id, stray.id),
      link(falcon.id, c1.id, 'rejected'),
    ],
    ledger: [
      ledger({ providerItemId: 'p-f1', decision: 'routed', method: 'codename', confidence: 1 }),
      ledger({ providerItemId: 'p-f3', decision: 'unrouted', internetMessageId: '<f3@bank.example>', conversationId: 'conv-f1' }),
      ledger({ providerItemId: 'p-f4', decision: 'unrouted', internetMessageId: '<f4@bank.example>', conversationId: 'conv-lone' }),
      ledger({ providerItemId: 'p-f5', decision: 'unrouted', internetMessageId: '<f5@bank.example>', conversationId: 'conv-f5' }),
      ledger({ sourceId: SITE, providerItemId: 'D-SCAN', decision: 'skipped', skipReason: 'image_only' }),
      ledger({ sourceId: SITE, providerItemId: 'D-OTHER', decision: 'skipped', skipReason: 'unsupported_type' }),
      ledger({ sourceId: SITE, providerItemId: 'D-MEMO', decision: 'unrouted' }),
    ],
  };

  const key = {
    format: ANSWER_KEY_FORMAT,
    itemCoverage: 'complete',
    deals: [
      { id: 'T01', name: 'Project Falcon', codename: 'Falcon', parties: [{ name: 'Heliotrope Inc', domains: ['heliotrope.example'] }], window: { start: '2026-01-15', end: '2026-06-30' } },
      { id: 'T02', name: 'Project Cobra', codename: 'Cobra', parties: [{ name: 'Cobalt Systems', domains: ['cobalt-systems.example'] }], window: { start: '2025-10-01', end: '2025-12-31' } },
      { id: 'T03', name: 'Project Heron', codename: 'Heron', window: { start: '2026-01-01' } },
      { id: 'T04', name: 'Project Osprey', codename: 'Osprey', aliases: ['Osprey refinancing'] },
    ],
    items: [
      { kind: 'message', internetMessageId: '<f1@bank.example>', dealIds: ['T01'] },
      { kind: 'message', internetMessageId: 'f2@bank.example', dealIds: ['T01'] },
      { kind: 'message', internetMessageId: '<f3@bank.example>', dealIds: ['T01'] },
      { kind: 'message', internetMessageId: '<F4@bank.example>', dealIds: ['T01'] },
      { kind: 'message', internetMessageId: '<f5@bank.example>', dealIds: ['T01'], attachmentOnly: true },
      { kind: 'message', internetMessageId: '<f6@bank.example>', dealIds: ['T01'] },
      { kind: 'document', path: 'Falcon/CIM.pdf', dealIds: ['T01'] },
      { kind: 'document', path: 'Falcon/scan.pdf', driveItemId: 'D-SCAN', dealIds: ['T01'] },
      { kind: 'document', path: 'Falcon/notes.docx', dealIds: ['T01'] },
      { kind: 'document', path: 'Falcon/memo.docx', driveItemId: 'D-MEMO', dealIds: ['T01'] },
      { kind: 'message', internetMessageId: '<c1@bank.example>', dealIds: ['T02'] },
      { kind: 'message', internetMessageId: '<h1@bank.example>', dealIds: ['T03'] },
      { kind: 'message', internetMessageId: '<o1@bank.example>', dealIds: ['T04'] },
      { kind: 'message', internetMessageId: '<o2@bank.example>', dealIds: ['T04'] },
      { kind: 'message', internetMessageId: '<lunch@bank.example>', dealIds: [] },
    ],
  };

  return { data, key, ids: { falcon, cobra, ospreyA, ospreyB, management, rejected, f1, f2, stray } };
}

// ── The review's degenerate table: a 5-deal key and systems built on it ─────

export const FIVE = ['Falcon', 'Cobra', 'Heron', 'Osprey', 'Kestrel'] as const;
const LAW_FIRM = { name: 'Baker Stone LLP', domains: ['bakerstone.example'] };

/**
 * A 5-deal key (T01..T05) with `perDeal` messages each and `negatives`
 * messages of no deal. Every deal names its target and, as a real firm's
 * deals would, the same law firm. Returns the key, every message as a stored
 * item, and a helper that builds an export from a list of candidates, each
 * with the indexes of the items it links.
 */
export function fiveDeals(perDeal = 4, negatives = 5) {
  const deals = FIVE.map((codename, i) => ({
    id: `T0${i + 1}`,
    name: `Project ${codename}`,
    codename,
    parties: [{ name: `${codename} Target Inc`, domains: [`${codename.toLowerCase()}-target.example`] }, LAW_FIRM],
    window: { start: '2026-01-01', end: '2026-06-30' },
  }));
  const dealItems = FIVE.map((codename, d) =>
    Array.from({ length: perDeal }, (_, k) => message(`<${codename.toLowerCase()}-${k}@bank.example>`, `conv-${d}-${k}`)),
  );
  const negativeItems = Array.from({ length: negatives }, (_, k) => message(`<weekly-${k}@bank.example>`, `conv-weekly-${k}`));
  const key = {
    format: ANSWER_KEY_FORMAT,
    itemCoverage: 'complete',
    deals,
    items: [
      ...dealItems.flatMap((items, d) => items.map((i) => ({ kind: 'message', internetMessageId: i.internetMessageId, dealIds: [deals[d].id] }))),
      ...negativeItems.map((i) => ({ kind: 'message', internetMessageId: i.internetMessageId, dealIds: [] })),
    ],
  };
  /** The candidate a correct system would propose for deal d. */
  const named = (d: number, partial: Partial<ExportCandidate> = {}) =>
    candidate({
      proposedName: `Project ${FIVE[d]}`,
      codenameGuess: FIVE[d],
      parties: [{ name: `${FIVE[d]} Target`, domain: `${FIVE[d].toLowerCase()}-target.example` }],
      ...partial,
    });
  /**
   * An export of the given candidates. An item a system links that the key
   * does not list (junk) is exported and ledgered like any other.
   */
  const exportOf = (systems: Array<{ candidate: ExportCandidate; items: ExportItem[]; linkState?: ExportLink['state'] }>): DiscoveryExport => {
    const linked = new Set(systems.flatMap((s) => s.items.map((i) => i.id)));
    const listed = [...dealItems.flat(), ...negativeItems];
    const listedIds = new Set(listed.map((i) => i.id));
    const junk = [...new Map(systems.flatMap((s) => s.items).filter((i) => !listedIds.has(i.id)).map((i) => [i.id, i])).values()];
    const all = [...listed, ...junk];
    return {
      manifest: { format: EXPORT_FORMAT, tenantId: TENANT, exportedAt: '2026-09-26T10:15:00.000Z', counts: {} },
      sources: [source('mailbox', MAILBOX)],
      items: all.filter((i) => linked.has(i.id)),
      provenance: [],
      candidates: systems.map((s) => s.candidate),
      links: systems.flatMap((s) => s.items.map((i) => link(s.candidate.id, i.id, s.linkState))),
      ledger: all.map((i) =>
        linked.has(i.id)
          ? ledger({ providerItemId: `p-${i.id}`, decision: 'routed', method: 'codename', confidence: 1 })
          : ledger({ providerItemId: `p-${i.id}`, decision: 'unrouted', internetMessageId: i.internetMessageId, conversationId: i.conversationId }),
      ),
    };
  };
  return { key, deals, dealItems, negativeItems, named, exportOf };
}

/** A seeded shuffle (mulberry32), so a shuffled test is the same on every run. */
export function shuffled<T>(values: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...values];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Writes an export directory the way scripts/discovery-export.ts does. */
export function writeExport(dir: string, data: DiscoveryExport): string {
  mkdirSync(dir, { recursive: true });
  const counts: Record<string, number> = {};
  for (const [key, file] of Object.entries(EXPORT_FILES)) {
    const rows = data[key as keyof typeof EXPORT_FILES] as unknown[];
    counts[file] = rows.length;
    writeFileSync(join(dir, file), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  }
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify({ ...data.manifest, counts }, null, 2)}\n`);
  return dir;
}

export function writeKey(dir: string, key: unknown, name = 'answer-key.json'): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(key, null, 2));
  return path;
}
