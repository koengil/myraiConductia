import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { recordableItems } from '../scripts/discovery/lib/demoPipeline';
import { DEV_TENANT_ID } from '@/lib/db/tenant';
import { parseMilestoneReply } from '@/lib/discovery/extract/parse';
import { DEFAULT_EXTRACT_MODEL } from '@/lib/modelGateway/processorGate';
import { PROMPT_HASH, PROMPT_VERSION } from '@/lib/modelGateway/prompts/milestoneExtract.v1';
import { loadRecording, recordedTransport, type RecordingFile } from '@/lib/modelGateway/record';
import { SYNTHETIC_CORPUS_DIGEST } from '@/lib/modelGateway/syntheticCorpus.generated';

import { RECORDING_PATH as E2E_RECORDING_PATH, STUB_PATH as E2E_STUB_PATH } from '../e2e/support/recording';
import { DEMO_LATE_DIR } from './discovery/demoCorpus';
import {
  buildStubRecording,
  RECORDING_PATH,
  serializeStub,
  STUB_PATH,
} from './helpers/stubReplies';

// Two replies files can drive the demo. The owner's recording (T2) is the real
// one and is absent until the owner records it: its checks are pending, not
// failed, while it is. The stub is the offline stand-in built from the test
// double and is always checked, so the journey has a current file to run on.

const root = process.cwd();
const items = recordableItems(DEMO_LATE_DIR);

/** The same three expectations for either file. */
function describeReplies(label: string, file: () => RecordingFile): void {
  it(`${label} was made for the pinned prompt and model, from this corpus`, () => {
    const f = file();
    expect(f.promptVersion).toBe(PROMPT_VERSION);
    expect(f.promptHash).toBe(PROMPT_HASH);
    expect(f.model).toBe(DEFAULT_EXTRACT_MODEL);
    expect(f.corpusDigest).toBe(SYNTHETIC_CORPUS_DIGEST);
  });

  it(`${label} covers every item the batch can select`, () => {
    const f = file();
    const missing = items.filter((i) => !f.replies[i.item.contentHash]).map((i) => i.item.internetMessageId);
    expect(missing).toEqual([]); // a corpus edit without a re-recording fails here, not in the journey
  });

  it(`${label} holds replies that parse against their own bodies`, () => {
    const f = file();
    for (const { item } of items) {
      const reply = f.replies[item.contentHash];
      const parsed = parseMilestoneReply(reply.text, item.bodyText);
      expect(parsed.ok, `${item.internetMessageId}: ${parsed.ok ? '' : parsed.error}`).toBe(true);
    }
  });
}

describe('the stub replies (offline stand-in, not a recording)', () => {
  it('is committed at its own path, current with the corpus and the double, and says what it is', () => {
    expect(existsSync(join(root, STUB_PATH)), `${STUB_PATH} is missing: node --import tsx tests/helpers/stubReplies.ts`).toBe(true);
    expect(readFileSync(join(root, STUB_PATH), 'utf8')).toBe(serializeStub(buildStubRecording(root)));
    const file = loadRecording(join(root, STUB_PATH));
    expect(file.provider).toBe('stub');
    expect(file.provenance).toMatch(/^STUB, not a model recording/);
    expect(STUB_PATH).not.toBe(RECORDING_PATH);
  });

  describeReplies('the stub', () => loadRecording(join(root, STUB_PATH)));

  it('is named the same way by the journey and by this helper', () => {
    expect(E2E_STUB_PATH).toBe(STUB_PATH);
    expect(E2E_RECORDING_PATH).toBe(RECORDING_PATH);
  });

  it('replays through the recorded transport for an item it holds', async () => {
    const file = loadRecording(join(root, STUB_PATH));
    const { item } = items[0];
    const result = await recordedTransport(file).send({
      purpose: 'milestone_extract',
      promptVersion: PROMPT_VERSION,
      model: DEFAULT_EXTRACT_MODEL,
      tenantId: DEV_TENANT_ID,
      sourceItemId: item.internetMessageId,
      contentHash: item.contentHash,
      input: { subject: item.subject, sentAt: item.sentAt, body: item.bodyText },
    });
    expect(result.ok).toBe(true);
  });
});

const recorded = existsSync(join(root, RECORDING_PATH));

describe.skipIf(!recorded)("the owner's recording (T2)", () => {
  it('is a model recording, never the stub', () => {
    const file = loadRecording(join(root, RECORDING_PATH));
    expect(file.provider).not.toBe('stub');
    expect(file.provenance).toBeUndefined();
  });

  describeReplies('the recording', () => loadRecording(join(root, RECORDING_PATH)));
});

describe.skipIf(recorded)("the owner's recording (T2)", () => {
  // PENDING, not failed: the recording does not exist yet. The journey and CI run
  // on the stub and say so; these become real checks the moment the file lands.
  it.todo(`pending T2: ${RECORDING_PATH} was made for the pinned prompt and model, from this corpus`);
  it.todo(`pending T2: ${RECORDING_PATH} covers every item the batch can select`);
  it.todo(`pending T2: ${RECORDING_PATH} holds replies that parse against their own bodies`);
});
