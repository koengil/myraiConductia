// The live capture's read loop (#318 5/6): each source the readiness check marked ready is read, backfill then one
// delta, through a guarded recording session. It holds the one rule that says what a refusal costs:
//
//   refused before the source's first observed response -> the source is skipped and counted. Nothing of it is in the
//     recording, so the cassette is whole without it. (The binding check and the guard's own asks are not observed.)
//   refused after one                                   -> the run aborts and nothing is written. Part of the
//     source is in the recording, and a cassette must not hold half a mailbox.
//
// Any other failure (a malformed page, an incomplete cycle, a Graph error, a wiring fault) is not a refusal and aborts.
//
// It takes the session as a parameter and never imports createGuardedRecording, which only record-graph.ts may
// (tests/mailbox-access-pins.test.ts, RECORDING_IMPORTERS_ALLOWED). It prints nothing and names no value.

// First import, on purpose: it claims the reader capability before any other module loads
// (tests/mailbox-access/boot-claim.test.ts pins the order, for any script that reaches the readers module).
import '../../../src/lib/mailboxAccess/readers';

import { MAILBOX_PROVIDER, type SourceKind, type SourceRefusalReason } from '../../../src/lib/constants/discovery';
import { MailboxAccessRefusedError } from '../../../src/lib/mailboxAccess/guard';
import type { ContentSource, GuardedReaderContext, ReaderRegistration } from '../../../src/lib/mailboxAccess/readers';
import type { CassetteSource } from './format';
import type { ReadySource } from './readiness';
import { readBackfillThenDelta } from './record';
import { RecorderRefusal } from './refusal';

/** What a recording session hands out: the shape of createGuardedRecording's result, without naming the door. */
export type RecordingSession = {
  sourceFor(
    target: { kind: SourceKind; provider: typeof MAILBOX_PROVIDER.MICROSOFT },
    ctx: GuardedReaderContext & { graphRegistration: ReaderRegistration },
  ): ContentSource;
};

export type CaptureOutcome = {
  /** The sources read, as the manifest names them: a mailbox under the UPN it was read by (replay asks the same URLs). */
  sources: CassetteSource[];
  /** The sources refused before their first observed response, by the guard's reason. */
  skipped: Partial<Record<SourceRefusalReason, number>>;
};

export async function captureReady(options: {
  session: RecordingSession;
  ready: ReadySource[];
  ctx: GuardedReaderContext & { graphRegistration: ReaderRegistration };
  /** How many responses the recording has observed so far. */
  observed: () => number;
}): Promise<CaptureOutcome> {
  const { session, ready, ctx, observed } = options;
  const sources: CassetteSource[] = [];
  const skipped: Partial<Record<SourceRefusalReason, number>> = {};
  for (const { row, recordAs } of ready) {
    const before = observed();
    try {
      await readBackfillThenDelta(session.sourceFor({ kind: row.kind, provider: MAILBOX_PROVIDER.MICROSOFT }, ctx), row);
    } catch (error) {
      // no_capability is a wiring fault, not a verdict about the source.
      if (!(error instanceof MailboxAccessRefusedError) || error.reason === 'no_capability') throw error;
      if (observed() !== before) {
        throw new RecorderRefusal('the guard refused a source after part of it was recorded; nothing is written');
      }
      skipped[error.reason] = (skipped[error.reason] ?? 0) + 1;
      continue;
    }
    sources.push({ kind: row.kind, address: recordAs });
  }
  return { sources, skipped };
}

/** Fixed words, reason codes and counts: the lines the capture prints for the sources it skipped. Nothing when none. */
export function skippedLines(skipped: CaptureOutcome['skipped']): string[] {
  const reasons = Object.entries(skipped).sort(([a], [b]) => a.localeCompare(b));
  const total = reasons.reduce((sum, [, count]) => sum + count, 0);
  return total === 0 ? [] : [`sources skipped ${total}`, ...reasons.map(([reason, count]) => `  ${reason} ${count}`)];
}
