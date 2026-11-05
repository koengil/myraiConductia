// Owner-run recorder (T2). Records the model's milestone replies for the
// committed synthetic demo mail, so every later run replays them offline.
// Run by the owner only, on their machine, with the key in the shell. It is
// never run in CI and never on an agent host.
//
//   node --import tsx scripts/discovery/record-extract-replies.ts \
//     [--provider gateway|anthropic-direct] \
//     --out tests/fixtures/discovery/demo/model-replies/extract.v1.json [--force]
//
//   gateway:          AI_GATEWAY_API_KEY, the AI Gateway with zero data retention
//   anthropic-direct: ANTHROPIC_API_KEY, T2's fallback, claude-sonnet-5 direct
//
// It writes no database row, so it writes no ai_usage row; the cost it prints
// is the owner's record.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { costForUsage, pricingKeyFor } from '@/lib/ai/pricing';
import { DEV_TENANT_ID } from '@/lib/db/tenant';
import { parseMilestoneReply } from '@/lib/discovery/extract/parse';
import { callModel } from '@/lib/modelGateway';
import { DEFAULT_EXTRACT_MODEL, isSyntheticItem } from '@/lib/modelGateway/processorGate';
import { PROMPT_HASH, PROMPT_VERSION } from '@/lib/modelGateway/prompts/milestoneExtract.v1';
import { recordingDigest, type RecordingFile } from '@/lib/modelGateway/record';
import { SYNTHETIC_CORPUS_DIGEST } from '@/lib/modelGateway/syntheticCorpus.generated';
import { gatewayTransport, type ModelTransport } from '@/lib/modelGateway/transports';

import { ANTHROPIC_DIRECT_MODEL, anthropicDirectTransport } from './lib/anthropicDirect';
import { recordableItems } from './lib/demoPipeline';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function die(message: string): never {
  console.error(`record-extract-replies: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const appEnv = process.env.NEXT_PUBLIC_APP_ENV?.trim().toLowerCase();
  if (appEnv === 'prod' || appEnv === 'production') die(`refused: NEXT_PUBLIC_APP_ENV=${appEnv}`);
  const out = arg('out');
  if (!out) die('--out <path> is required');
  if (existsSync(out) && !process.argv.includes('--force')) die(`refused: ${out} exists (pass --force to replace it)`);
  const provider = (arg('provider') ?? 'gateway') as RecordingFile['provider'];
  if (provider !== 'gateway' && provider !== 'anthropic-direct') die(`unknown --provider ${provider}`);

  // The superset, so beat 7 (the triage reply and the late mail) is covered.
  const items = recordableItems(join(process.cwd(), 'tests/fixtures/discovery/demo/graph-after-imports'));
  const outside = items.filter((i) => !isSyntheticItem(i.item.internetMessageId));
  if (outside.length) {
    die(`refused before any call: not committed synthetic mail: ${outside.map((i) => i.item.internetMessageId).join(', ')}`);
  }

  let transport: ModelTransport;
  let upstreamModel: string;
  if (provider === 'gateway') {
    transport = gatewayTransport();
    upstreamModel = DEFAULT_EXTRACT_MODEL;
  } else {
    transport = anthropicDirectTransport();
    upstreamModel = ANTHROPIC_DIRECT_MODEL;
  }

  const replies: RecordingFile['replies'] = {};
  let calls = 0;
  let usd = 0;
  let unpriced = false;
  for (const { item } of items) {
    const call = await callModel(
      {
        purpose: 'milestone_extract',
        promptVersion: PROMPT_VERSION,
        // The recording is keyed to the pinned gateway id whichever provider answered.
        model: DEFAULT_EXTRACT_MODEL,
        // Synthetic mail belongs to no customer: the dev tenant, for the log line only.
        tenantId: DEV_TENANT_ID,
        sourceItemId: item.internetMessageId,
        contentHash: item.contentHash,
        input: { subject: item.subject, sentAt: item.sentAt, body: item.bodyText },
      },
      transport,
    );
    calls++;
    if (!call.ok) die(`${item.internetMessageId}: call failed (${call.code})`);
    const parsed = parseMilestoneReply(call.text, item.bodyText);
    if (!parsed.ok) die(`${item.internetMessageId}: reply rejected (${parsed.error})`);
    replies[item.contentHash] = { text: call.text, responseId: call.responseId };
    if (call.usage) {
      const model = call.usage.model.replace(/^anthropic\//, '');
      const cost = pricingKeyFor(model) ? costForUsage(model, call.usage) : null;
      if (cost === null) unpriced = true;
      else usd += cost;
    }
  }

  const file: RecordingFile = {
    format: 'conductia.model-replies/v1',
    purpose: 'milestone_extract',
    promptVersion: PROMPT_VERSION,
    promptHash: PROMPT_HASH,
    model: DEFAULT_EXTRACT_MODEL,
    provider,
    upstreamModel,
    recordedAt: new Date().toISOString(),
    corpusDigest: SYNTHETIC_CORPUS_DIGEST,
    replies,
    digest: recordingDigest(replies),
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
  console.log(
    `recorded ${calls} replies to ${out}; token-priced cost ${usd.toFixed(4)} USD${unpriced ? ' (some usage unpriced)' : ''}`,
  );
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
