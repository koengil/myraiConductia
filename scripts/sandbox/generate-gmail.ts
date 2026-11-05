#!/usr/bin/env node
/**
 * Sandbox Gmail generator (#658): reads scripts/sandbox/fixtures/cast_deals.yaml and
 * imports realistic deal mail into conductia-sandbox.com mailboxes.
 *
 *   npm run sandbox:generate-gmail -- --dry-run --out /tmp/sandbox-mail
 *   npm run sandbox:generate-gmail -- --live --confirm-domain conductia-sandbox.com --deal OSPREY
 */
import { googleOperatorKit } from '../../src/lib/mailboxAccess/readers';

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { argValue, requireLiveRun } from '../google/lib/live';
import { assertSandboxRecipients } from './lib/allowlist';
import { refuseSandboxLiveInCi } from './lib/ciGuard';
import { writeDryRun } from './lib/dryRun';
import { SANDBOX_WORKSPACE_DOMAIN } from './lib/domains';
import { readFixture } from './lib/fixture';
import { assertVolume, generatePlan } from './lib/generate';
import { createSandboxGmailDeliverer } from './lib/gmailDeliver';

const DEFAULT_FIXTURE = join(import.meta.dirname, 'fixtures', 'cast_deals.yaml');

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function parseRunStart(value: string | null): Date {
  if (!value) return new Date('2026-10-01T12:00:00Z');
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error('--run-start must be an ISO date');
  return d;
}

async function main(): Promise<void> {
  const argv = process.argv;
  const live = hasFlag(argv, '--live');
  refuseSandboxLiveInCi(live);

  const fixturePath = resolve(argValue(argv, '--fixture') ?? DEFAULT_FIXTURE);
  if (!existsSync(fixturePath)) throw new Error(`fixture not found: ${fixturePath}`);

  const fixture = readFixture(fixturePath);
  const runTag = argValue(argv, '--run-tag') ?? 'sandbox-v1';
  const seed = Number(argValue(argv, '--seed') ?? '65842');
  if (!Number.isFinite(seed)) throw new Error('--seed must be a number');
  const dealArg = argValue(argv, '--deal');
  const dealFilter = dealArg ? dealArg.split(',').map((d) => d.trim().toUpperCase()) : undefined;
  const runStart = parseRunStart(argValue(argv, '--run-start'));

  const plan = generatePlan({ fixture, runStart, runTag, seed, dealFilter });
  assertSandboxRecipients(fixture, plan.messages);
  assertVolume(plan);

  if (hasFlag(argv, '--dry-run')) {
    const out = resolve(argValue(argv, '--out') ?? join(process.cwd(), '.sandbox-mail-out'));
    const result = await writeDryRun(out, plan, runTag);
    console.log(`Dry run: ${result.messageCount} messages -> ${result.outDir}`);
    console.log(`Manifest: ${result.manifestPath}`);
    return;
  }

  requireLiveRun(argv, SANDBOX_WORKSPACE_DOMAIN);

  const kit = googleOperatorKit();
  const { deliverMessages, resetRunMailboxes, callerSa } = createSandboxGmailDeliverer(kit);

  if (hasFlag(argv, '--reset')) {
    const castEmails = fixture.cast.map((c) => c.email);
    console.log(`Resetting mail tagged ${runTag} across ${castEmails.length} mailboxes (as ${callerSa})`);
    const trashed = await resetRunMailboxes(castEmails, runTag);
    console.log(`Trashed ${trashed} messages`);
  }

  console.log(`Live import: ${plan.messages.length} messages, runTag=${runTag}, SA=${callerSa}`);
  const stats = await deliverMessages(plan.messages, { runTag });
  console.log(`Done: sent=${stats.sent} skipped=${stats.skipped} failed=${stats.failed}`);
  if (stats.errors.length > 0) {
    for (const line of stats.errors) console.error(line);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith('generate-gmail.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
