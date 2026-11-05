import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { GraphMessage, GraphRecipient } from '../../src/lib/graph/reader/types';
import { assertOutsideRepo, argValue } from './lib/live';
import { toJsonl, type SeedAddress, type SeedMessage } from './lib/seedFormat';

// Converts the in-repo discovery fixture (tests/fixtures/discovery/mailbox-*.json,
// Graph-shaped) into conductia.gmail-seed/v1 JSONL for the Gmail seeder (plan D9).
//
//   node --import tsx scripts/google/fixture-to-seed.ts --out <file.jsonl>
//
// The Graph conversationId is never written into any Gmail field (R18). Gmail
// threads by RFC 5322 headers, so `references` is derived from the order of the
// messages inside each Graph conversation: the root Message-ID first, then every
// earlier message. That is what makes Gmail rebuild the same threads.

/** The one message seeded into SPAM, for the after-unspam recording phase. */
export const SPAM_MESSAGE_ID = '<dinner-005@heliotrope.example>';
/** The two messages imported after the first recording, for the after-imports phase. */
export const AFTER_IMPORT_MESSAGE_IDS: readonly string[] = ['<falcon-006@bank.example>', '<falcon-007@bank.example>'];

/** The corpus the fixture reader serves. Read as plain JSON here: the converter is a data tool, and the fixture reader (a fenced reader module that demands the reader capability) is not its business. */
export const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures', 'discovery');

function loadFixtureMailboxes(dir: string): Array<{ mailbox: string; messages: GraphMessage[] }> {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as { mailbox: string; messages: GraphMessage[] })
    .filter((file) => typeof file.mailbox === 'string' && Array.isArray(file.messages));
}

const toAddress = (r: GraphRecipient): SeedAddress => {
  const name = r.emailAddress.name?.trim();
  return name ? { name, address: r.emailAddress.address } : { address: r.emailAddress.address };
};

export function fixtureToSeed(dir: string = FIXTURE_DIR): SeedMessage[] {
  const byId = new Map<string, { message: GraphMessage; mailboxes: Set<string> }>();
  for (const box of loadFixtureMailboxes(dir)) {
    for (const message of box.messages) {
      const entry = byId.get(message.internetMessageId) ?? { message, mailboxes: new Set<string>() };
      entry.mailboxes.add(box.mailbox.toLowerCase());
      byId.set(message.internetMessageId, entry);
    }
  }

  // Group by Graph conversation (only to derive headers), oldest first.
  const conversations = new Map<string, GraphMessage[]>();
  for (const { message } of byId.values()) {
    const key = message.conversationId ?? message.internetMessageId;
    conversations.set(key, [...(conversations.get(key) ?? []), message]);
  }
  const referencesOf = new Map<string, string[]>();
  for (const messages of conversations.values()) {
    const ordered = [...messages].sort(
      (a, b) =>
        Date.parse(a.sentDateTime ?? '') - Date.parse(b.sentDateTime ?? '') ||
        a.internetMessageId.localeCompare(b.internetMessageId),
    );
    ordered.forEach((message, i) => {
      referencesOf.set(
        message.internetMessageId,
        ordered.slice(0, i).map((earlier) => earlier.internetMessageId),
      );
    });
  }

  return [...byId.entries()]
    .sort(([, a], [, b]) => Date.parse(a.message.sentDateTime ?? '') - Date.parse(b.message.sentDateTime ?? ''))
    .map(([id, { message, mailboxes }]) => {
      const references = referencesOf.get(id) ?? [];
      const seed: SeedMessage = {
        messageId: id,
        date: message.sentDateTime ?? message.receivedDateTime ?? new Date(0).toISOString(),
        from: message.from ? toAddress(message.from) : { address: 'unknown@invalid.example' },
        to: message.toRecipients.map(toAddress),
        cc: message.ccRecipients.map(toAddress),
        subject: message.subject ?? '',
        body: { contentType: message.body.contentType, content: message.body.content },
        mailboxes: [...mailboxes].sort(),
      };
      if (references.length > 0) {
        seed.references = references;
        seed.inReplyTo = references[references.length - 1];
      }
      if (id === SPAM_MESSAGE_ID) seed.labels = ['SPAM'];
      seed.phase = AFTER_IMPORT_MESSAGE_IDS.includes(id) ? 'after-imports' : 'seeded';
      return seed;
    });
}

function main(): void {
  const out = argValue(process.argv, '--out');
  if (!out) throw new Error('Usage: fixture-to-seed.ts --out <file.jsonl>');
  const target = assertOutsideRepo(out, process.cwd(), ['evals/out']);
  mkdirSync(dirname(target), { recursive: true });
  const messages = fixtureToSeed();
  writeFileSync(target, toJsonl(messages), { flag: 'wx', mode: 0o600 });
  console.log(`Wrote ${messages.length} seed messages to ${target}`);
}

if (process.argv[1]?.endsWith('fixture-to-seed.ts')) {
  try {
    main();
  } catch (error) {
    console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
