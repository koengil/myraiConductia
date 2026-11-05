// Recorded model replies (format conductia.model-replies/v1). Reply text is
// keyed by the content hash of the mail it answered; a replay returns the
// recorded text and prices nothing (T13). Recordings are made by the owner-run
// recorder, never written by hand and never edited.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { ModelCallResult, ModelRequest } from './index';
import type { ModelTransport } from './transports';

export type RecordingFile = {
  format: 'conductia.model-replies/v1';
  /** The request purpose the replies answer; 'deal_proposal' is the demo-only step (#460). */
  purpose: ModelRequest['purpose'];
  promptVersion: ModelRequest['promptVersion'];
  promptHash: string;
  model: string;
  // 'stub' marks the offline stand-in built from the test double
  // (tests/helpers/stubReplies.ts) while the owner's recording is absent. It is
  // never a model output; `provenance` says so in the file itself.
  provider: 'gateway' | 'anthropic-direct' | 'stub';
  upstreamModel: string;
  provenance?: string;
  recordedAt: string;
  /** SYNTHETIC_CORPUS_DIGEST at record time. */
  corpusDigest: string;
  replies: Record<string /* contentHash */, { text: string; responseId: string }>;
  /** sha256 over the sorted replies. */
  digest: string;
};

/** sha256 over the replies, sorted by content hash, so key order never matters. */
export function recordingDigest(replies: RecordingFile['replies']): string {
  const sorted = Object.keys(replies)
    .sort()
    .map((k) => [k, replies[k].text, replies[k].responseId]);
  return `sha256:${createHash('sha256').update(JSON.stringify(sorted)).digest('hex')}`;
}

export function loadRecording(path: string): RecordingFile {
  const file = JSON.parse(readFileSync(path, 'utf8')) as RecordingFile;
  if (file?.format !== 'conductia.model-replies/v1') {
    throw new Error(`model replies: ${path}: unknown format`);
  }
  if (typeof file.replies !== 'object' || file.replies === null) {
    throw new Error(`model replies: ${path}: replies missing`);
  }
  if (file.digest !== recordingDigest(file.replies)) {
    throw new Error(`model replies: ${path}: digest mismatch, the file was edited or truncated`);
  }
  return file;
}

export function recordedTransport(file: RecordingFile): ModelTransport {
  return {
    kind: 'recorded',
    async send(req: ModelRequest): Promise<ModelCallResult> {
      const hit =
        req.purpose === file.purpose && req.promptVersion === file.promptVersion && req.model === file.model
          ? file.replies[req.contentHash]
          : undefined;
      if (!hit) {
        return { ok: false, outcome: 'failed', code: 'recording_miss', transport: 'recorded', latencyMs: 0 };
      }
      return {
        ok: true,
        text: hit.text,
        responseId: hit.responseId,
        usage: null,
        transport: 'recorded',
        latencyMs: 0,
      };
    },
  };
}
