// First import, on purpose: it claims the reader capability before any other module loads
// (tests/mailbox-access/boot-claim.test.ts pins the order). The Google primitives come through
// the operator door, never from a reader module (tests/mailbox-access-pins.test.ts).
import { googleOperatorKit } from '../../src/lib/mailboxAccess/readers';

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { GOOGLE_TOOL_SCOPE } from '../../src/lib/constants/googleReader';
import { announceLiveRun, argValue, assertOutsideRepo, assertSecretsFolderKeyless, requireLiveRun } from './lib/live';
import { buildMultipartRelated, newBoundary } from './lib/multipart';
import { buildRfc822 } from './lib/rfc822';
import { loadSeedingConfig, trialDomain } from './lib/seedConfig';
import { parseSeedJsonl, type SeedMessage } from './lib/seedFormat';

const { GoogleHttpError, createCallerTokenSource, createDelegatedTokenCache, googleFetch, googleJson } = googleOperatorKit();

// Seeds the Workspace trial's mailboxes from conductia.gmail-seed/v1 JSONL by
// importing raw RFC 822 messages (messages.import, dates kept, never marked
// spam). Idempotent by Message-ID. Announce the run to the owner first.
//
//   npm run google:seed-gmail -- --live --confirm-domain <trial domain> \
//     --seed <file.jsonl> --phase seeded|after-imports \
//     [--seeding-config .secrets/google/seeding.json] [--seed-log-dir <dir outside the repo>]

export type ImportPlanEntry = { persona: string; trialAddress: string; message: SeedMessage; labelIds: string[] };

/** Which copies to import for a phase, and where each lands. Refuses an unmapped persona. */
export function planImports(
  messages: SeedMessage[],
  personas: Record<string, string>,
  phase: 'seeded' | 'after-imports',
): ImportPlanEntry[] {
  const plan: ImportPlanEntry[] = [];
  for (const message of messages) {
    if ((message.phase ?? 'seeded') !== phase) continue;
    for (const persona of message.mailboxes) {
      const trialAddress = personas[persona.toLowerCase()];
      if (!trialAddress) throw new Error(`No trial address for persona ${persona} in seeding.json`);
      plan.push({ persona, trialAddress, message, labelIds: message.labels?.includes('SPAM') ? ['SPAM'] : ['INBOX'] });
    }
  }
  return plan;
}

const IMPORT_URL = (address: string): string =>
  `https://gmail.googleapis.com/upload/gmail/v1/users/${encodeURIComponent(address)}/messages/import` +
  '?internalDateSource=dateHeader&neverMarkSpam=true&uploadType=multipart';

async function main(): Promise<void> {
  const argv = process.argv;
  const seedPath = argValue(argv, '--seed');
  const phase = argValue(argv, '--phase') ?? 'seeded';
  if (!seedPath) throw new Error('--seed <file.jsonl> is required');
  if (phase !== 'seeded' && phase !== 'after-imports') throw new Error('--phase must be seeded or after-imports');

  assertSecretsFolderKeyless(resolve('.secrets'));
  const config = loadSeedingConfig(argValue(argv, '--seeding-config') ?? '.secrets/google/seeding.json');
  const domain = trialDomain(config);
  requireLiveRun(argv, domain, { testDomains: config.testDomains });

  const plan = planImports(parseSeedJsonl(readFileSync(seedPath, 'utf8')), config.personas, phase);
  const logDir = assertOutsideRepo(argValue(argv, '--seed-log-dir') ?? join(homedir(), '.conductia', 'google-seed'));
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logPath = join(logDir, `${domain}.json`);
  const done = new Set<string>(existsSync(logPath) ? (JSON.parse(readFileSync(logPath, 'utf8')) as string[]) : []);

  announceLiveRun('google:seed-gmail', domain, config.seedingServiceAccountEmail);
  const tokens = createDelegatedTokenCache({ callerToken: createCallerTokenSource() });
  const identity = { tenantId: 'seeding', serviceAccountEmail: config.seedingServiceAccountEmail };
  let imported = 0;
  let skipped = 0;
  let checkAvailable = true;

  for (const entry of plan) {
    const key = `${entry.trialAddress}|${entry.message.messageId}`;
    if (done.has(key)) {
      skipped += 1;
      continue;
    }
    const getToken = tokens.forSubject(identity, entry.trialAddress, GOOGLE_TOOL_SCOPE.GMAIL_INSERT_SEEDING);
    if (checkAvailable) {
      // gmail.insert alone may not allow a search. If it is refused, the local log is the idempotency record.
      try {
        const found = await googleJson<{ messages?: unknown[] }>(
          `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(entry.trialAddress)}/messages?includeSpamTrash=true&maxResults=1&q=${encodeURIComponent(`rfc822msgid:${entry.message.messageId.slice(1, -1)}`)}`,
          { getToken, maxAttempts: 2 },
        );
        if ((found.messages?.length ?? 0) > 0) {
          done.add(key);
          skipped += 1;
          continue;
        }
      } catch (error) {
        if (error instanceof GoogleHttpError && (error.status === 403 || error.status === 401)) checkAvailable = false;
        else throw error;
      }
    }
    const boundary = newBoundary();
    const body = buildMultipartRelated(boundary, { labelIds: entry.labelIds }, buildRfc822(entry.message), 'message/rfc822');
    await googleFetch(
      IMPORT_URL(entry.trialAddress),
      { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: body as unknown as BodyInit },
      { getToken },
    );
    done.add(key);
    imported += 1;
    writeFileSync(logPath, JSON.stringify([...done], null, 2), { mode: 0o600 });
    console.log(`imported ${entry.message.messageId} -> ${entry.trialAddress} [${entry.labelIds.join(',')}]`);
  }
  console.log(`Done (${phase}): ${imported} imported, ${skipped} already present${checkAvailable ? '' : ' (search refused; local seed log used)'}`);
}

if (process.argv[1]?.endsWith('seed-gmail.ts')) {
  main().catch((error: unknown) => {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
