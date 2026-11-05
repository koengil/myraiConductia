// readExport validates every row (second review): the views filter on the
// known states, so an unknown one used to drop out of the metrics silently.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ExportError, readExport, validateRows, type DiscoveryExport } from '../src/exportData.ts';
import { removeTempDirs, scenario, tempDir, writeExport } from './synthetic.ts';

after(removeTempDirs);

type Rows = Record<string, Array<Record<string, unknown>>>;

/** The scenario export with one row of one file changed. */
function withRow(file: keyof Omit<DiscoveryExport, 'manifest'>, index: number, change: (row: Record<string, unknown>) => void): DiscoveryExport {
  const { data } = scenario();
  const copy = JSON.parse(JSON.stringify(data)) as DiscoveryExport & Rows;
  change((copy as unknown as Rows)[file][index]);
  return copy;
}

function refuses(data: DiscoveryExport, pattern: RegExp): void {
  assert.throws(() => validateRows(data), (e: unknown) => e instanceof ExportError && pattern.test(e.message));
  const dir = writeExport(join(tempDir(), 'export'), data);
  assert.throws(() => readExport(dir), (e: unknown) => e instanceof ExportError && pattern.test(e.message));
}

describe('readExport validates every row', () => {
  it('accepts the exporter\'s rows', () => {
    const { data } = scenario();
    const read = readExport(writeExport(join(tempDir(), 'export'), data));
    assert.equal(read.candidates.length, data.candidates.length);
  });

  it('refuses a candidate state it does not know, in any case', () => {
    // The degenerate cases: "archived" duplicates and "Proposed" junk dropped out of both views.
    for (const state of ['archived', 'Proposed', '', null]) {
      refuses(withRow('candidates', 0, (r) => (r.discoveryState = state)), /candidates\.jsonl line 1: discoveryState must be one of proposed, confirmed, rejected, merged_into/);
    }
  });

  it('refuses every other value outside its enum', () => {
    refuses(withRow('links', 0, (r) => (r.state = 'Rejected')), /links\.jsonl line 1: state must be one of proposed, confirmed, rejected/);
    refuses(withRow('links', 0, (r) => (r.routeTier = 'model')), /routeTier must be one of firm, tentative/);
    refuses(withRow('links', 0, (r) => (r.method = 'Project Falcon codename')), /links\.jsonl line 1: method must be one of codename, alias, thread_continuation/);
    refuses(withRow('ledger', 4, (r) => (r.skipReason = 'looked like a Falcon NDA')), /ledger\.jsonl line 5: skipReason must be one of image_only/);
    refuses(withRow('ledger', 0, (r) => (r.decision = 'ignored')), /decision must be one of routed, unrouted, skipped/);
    refuses(withRow('items', 0, (r) => (r.kind = 'event')), /items\.jsonl line 1: kind must be one of message, document/);
    refuses(withRow('items', 0, (r) => (r.sensitivity = 'secret')), /sensitivity must be one of standard, restricted/);
    refuses(withRow('sources', 0, (r) => (r.kind = 'onedrive')), /sources\.jsonl line 1: kind must be one of mailbox, sharepoint_site/);
    refuses(withRow('candidates', 0, (r) => (r.dealSide = 'sell-side')), /dealSide must be one of sell, buy, unknown/);
  });

  it('reads the exclusion policy\'s skips, and holds them to the ledger\'s shape (#263)', () => {
    const policy = (r: Record<string, unknown>) => {
      r.skipReason = 'policy_excluded';
      r.policyVersion = 2;
      r.exclusionRule = 'privileged-label';
      r.providerThreadId = 'thread-1';
    };
    const { data } = scenario();
    const ok = JSON.parse(JSON.stringify(data)) as DiscoveryExport & Rows;
    policy((ok as unknown as Rows).ledger[4]);
    assert.doesNotThrow(() => validateRows(ok));
    for (const reason of ['policy_thread_excluded', 'policy_unevaluable', 'policy_excluded_after_fetch']) {
      const copy = JSON.parse(JSON.stringify(ok)) as DiscoveryExport & Rows;
      (copy as unknown as Rows).ledger[4].skipReason = reason;
      assert.doesNotThrow(() => validateRows(copy), reason);
    }
    // A policy reason without its version, rule or thread id, and a version or rule on any other reason, are refused.
    const shape = /policyVersion, exclusionRule and providerThreadId are all set exactly when skipReason is a policy reason/;
    refuses(withRow('ledger', 4, (r) => { policy(r); r.policyVersion = null; }), shape);
    refuses(withRow('ledger', 4, (r) => { policy(r); r.exclusionRule = null; }), shape);
    refuses(withRow('ledger', 4, (r) => { policy(r); r.providerThreadId = null; }), shape);
    refuses(withRow('ledger', 4, (r) => { r.policyVersion = 1; r.exclusionRule = 'x'; r.providerThreadId = 't'; }), shape);
  });

  it('refuses a missing or unknown field, and a value of the wrong type', () => {
    refuses(withRow('candidates', 0, (r) => delete r.parties), /candidates\.jsonl line 1: parties is missing/);
    refuses(withRow('candidates', 0, (r) => (r.archivedAt = '2026-01-01')), /candidates\.jsonl line 1: unknown field "archivedAt"/);
    refuses(withRow('links', 0, (r) => (r.confidence = '1')), /links\.jsonl line 1: confidence must be a number, or null/);
    refuses(withRow('sources', 0, (r) => (r.ownerAssigned = 'true')), /ownerAssigned must be true or false/);
    refuses(withRow('candidates', 0, (r) => (r.firstSeenAt = '2026-02-30T00:00:00Z')), /firstSeenAt must be an ISO timestamp, or null/);
    refuses(withRow('candidates', 0, (r) => (r.parties = [{ name: 'Heliotrope' }])), /parties must be an array of \{ name, domain \} strings/);
    refuses(withRow('items', 0, (r) => (r.id = '')), /items\.jsonl line 1: id must be a non-empty string/);
  });

  it('refuses a row that breaks a constraint between its fields', () => {
    refuses(withRow('ledger', 0, (r) => (r.method = null)), /method is set exactly when decision is routed/);
    refuses(withRow('ledger', 4, (r) => (r.skipReason = null)), /skipReason is set exactly when decision is skipped/);
    refuses(withRow('candidates', 5, (r) => (r.discoveryState = 'merged_into')), /mergedIntoId is set exactly when discoveryState is merged_into/);
    refuses(withRow('links', 0, (r) => (r.dealId = 'd-1')), /exactly one of candidateId and dealId is set/);
  });

  it('refuses a reference to a row the export does not hold, and a repeated id', () => {
    refuses(withRow('links', 0, (r) => (r.candidateId = 'ca-missing')), /links\.jsonl line 1: candidateId names no exported candidate/);
    refuses(withRow('links', 0, (r) => (r.sourceItemId = 'it-missing')), /sourceItemId names no exported item/);
    refuses(withRow('provenance', 0, (r) => (r.sourceId = 'src-missing')), /provenance\.jsonl line 1: sourceId names no exported source/);
    const { data } = scenario();
    refuses({ ...data, candidates: [...data.candidates, data.candidates[0]] }, /candidates\.jsonl line 7: repeats the id of an earlier row/);
  });

  it('never quotes a value in its errors', () => {
    try {
      validateRows(withRow('candidates', 0, (r) => (r.discoveryState = 'Project Falcon')));
      assert.fail('should refuse');
    } catch (e) {
      assert.ok(e instanceof ExportError && !e.message.includes('Falcon'));
    }
  });

  it('refuses a manifest with an unknown field or counts that do not name the six files', () => {
    const { data } = scenario();
    const dir = writeExport(join(tempDir(), 'export'), data);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, filter: 'proposed' }));
    assert.throws(() => readExport(dir), /manifest\.json does not match .*unknown field "filter"/);
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ ...manifest, counts: { ...manifest.counts, 'extra.jsonl': 0 } }));
    assert.throws(() => readExport(dir), /counts must give a row count for each of/);
  });
});
