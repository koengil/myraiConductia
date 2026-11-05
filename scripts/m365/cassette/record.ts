// First import, on purpose: it claims the reader capability before any other module loads
// (tests/mailbox-access/boot-claim.test.ts pins the order). The reader comes through that module.
import {
  graphContentSourceOver,
  type ContentSource,
  type GraphReaderContext,
  type SourceItemPage,
  type SourceRow,
} from '../../../src/lib/mailboxAccess/readers';

import { MAILBOX_PROVIDER } from '../../../src/lib/constants/discovery';
import type { GraphHttpOptions } from '../../../src/lib/graph/http';
import type { ExtractFn } from '../../../src/lib/graph/reader/drive';
import type { CassetteData, CassetteSource } from './format';
import { createRecorder } from './recordFetch';
import { RecorderRefusal } from './refusal';
import { scrub } from './scrub';

/** No text is needed to record: downloads still happen, the sandboxed parser does not run. */
export const RECORD_EXTRACT: ExtractFn = async () => ({ ok: true, text: '' });

/** The `cycle` a Graph reader's last checkpoint holds, or null when it holds none or cannot be read. */
function cycleOfCheckpoint(checkpoint: string | null): string | null {
  if (!checkpoint) return null;
  try {
    const cycle = (JSON.parse(checkpoint) as { cycle?: unknown } | null)?.cycle;
    return typeof cycle === 'string' ? cycle : null;
  } catch {
    return null;
  }
}

/**
 * A pass that stopped part-way (a folder or library not read to its deltaLink) is not a recording: the cassette
 * would replay a smaller tenant than the one read. Fixed text, never a value.
 */
function assertCycleComplete(checkpoint: string | null, pass: 'backfill' | 'delta'): void {
  if (cycleOfCheckpoint(checkpoint) !== 'complete') {
    throw new RecorderRefusal(`the ${pass} did not complete every folder or library; nothing is written`);
  }
}

/**
 * A source's full read, as the worker does it: backfill to the end, then one delta from the last checkpoint.
 * Each pass must end with its cycle `complete`, or the read throws (the recorder never keeps a partial cycle).
 */
export async function readBackfillThenDelta(reader: ContentSource, row: SourceRow) {
  const backfill: SourceItemPage[] = [];
  let checkpoint: string | null = null;
  for await (const page of reader.backfill(row, null)) {
    backfill.push(page);
    checkpoint = page.nextCheckpoint ?? checkpoint;
  }
  assertCycleComplete(checkpoint, 'backfill');
  const delta: SourceItemPage[] = [];
  let deltaCheckpoint: string | null = null;
  for await (const page of reader.delta(row, checkpoint!)) {
    delta.push(page);
    deltaCheckpoint = page.nextCheckpoint ?? deltaCheckpoint;
  }
  // A delta that yielded no page read no folder, so there is no cycle to be partial.
  if (delta.length > 0) assertCycleComplete(deltaCheckpoint, 'delta');
  return { backfill, delta };
}

export function sourceRow(source: CassetteSource, index: number): SourceRow {
  return {
    id: `record-${index}`,
    tenantId: 'record',
    kind: source.kind,
    provider: MAILBOX_PROVIDER.MICROSOFT,
    address: source.address,
    ownerUserId: null,
    deltaCheckpoint: null,
  };
}

export async function recordSources(options: {
  http: GraphHttpOptions;
  sources: CassetteSource[];
  recordedAt: string;
  extract?: ExtractFn;
  /** The recorder's capture bound; the reader's own cap is EXTRACT_MAX_BYTES. Tests inject a small one. */
  maxBytes?: number;
}): Promise<{ cassette: CassetteData; droppedHeaders: string[]; orphansDropped: number }> {
  const recorder = createRecorder(options.http.fetchImpl ?? fetch, { maxBytes: options.maxBytes });
  const context: GraphReaderContext = {
    http: { ...options.http, fetchImpl: recorder.fetch },
    extract: options.extract ?? RECORD_EXTRACT,
  };
  for (const [index, source] of options.sources.entries()) {
    await readBackfillThenDelta(
      graphContentSourceOver(source.kind, context),
      sourceRow(source, index),
    );
  }
  return scrub(recorder.raw, { sources: options.sources, recordedAt: options.recordedAt });
}
