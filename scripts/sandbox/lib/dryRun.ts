import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { GenerationPlan, SandboxMessage } from './types';
import { buildSandboxRfc822, toBase64Url } from './rfc822';

export type DryRunResult = { outDir: string; messageCount: number; manifestPath: string };

function safeName(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

/** Writes generated messages and manifest to disk (no network). */
export async function writeDryRun(outDir: string, plan: GenerationPlan, runTag: string): Promise<DryRunResult> {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const messagesDir = join(outDir, 'messages');
  mkdirSync(messagesDir, { recursive: true, mode: 0o700 });

  for (const message of plan.messages) {
    await writeMessageFiles(messagesDir, message);
  }

  const manifestPath = join(outDir, 'manifest.json');
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        runTag,
        messageCount: plan.messages.length,
        deliberateMistakes: plan.manifest.filter((m) => m.tags.includes('deliberate_mistake')),
        entries: plan.manifest,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  return { outDir, messageCount: plan.messages.length, manifestPath };
}

async function writeMessageFiles(dir: string, message: SandboxMessage): Promise<void> {
  const base = join(dir, safeName(message.key));
  const raw = await buildSandboxRfc822(message);
  writeFileSync(`${base}.eml.b64url`, toBase64Url(raw), { mode: 0o600 });
  writeFileSync(
    `${base}.json`,
    JSON.stringify(
      {
        key: message.key,
        deal: message.dealCode,
        messageId: message.messageId,
        threadKey: message.threadKey,
        from: message.from,
        to: message.to,
        cc: message.cc,
        subject: message.subject,
        inReplyTo: message.inReplyTo,
        references: message.references,
        triggerId: message.triggerId,
        expected: message.expectedOutcome,
        tags: message.tags,
        attachments: message.attachments.map((a) => a.filename),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
