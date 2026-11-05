// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { AFTER_IMPORT_MESSAGE_IDS, SPAM_MESSAGE_ID, fixtureToSeed } from '../../scripts/google/fixture-to-seed';
import { buildRfc822, quotedPrintable } from '../../scripts/google/lib/rfc822';
import { parseSeedJsonl, toJsonl } from '../../scripts/google/lib/seedFormat';
import { planImports } from '../../scripts/google/seed-gmail';
import { loadFixtureCorpus as loadFixtureMailboxes } from '@/lib/mailboxAccess/readers';

// The corpus comes through the guard folder's door, which holds this file's one capability claim: importing
// scripts/google/seed-gmail loads readers.ts too, so a second claim here would throw (#262).

const seed = fixtureToSeed();

describe('fixtureToSeed', () => {
  it('preserves every Message-ID of the fixture, once', () => {
    const expected = new Set(loadFixtureMailboxes().flatMap((b) => b.messages.map((m) => m.internetMessageId)));
    expect(seed.map((m) => m.messageId).sort()).toEqual([...expected].sort());
    expect(new Set(seed.map((m) => m.messageId)).size).toBe(seed.length);
  });

  it('takes the union of the mailboxes holding each message', () => {
    const byId = new Map(seed.map((m) => [m.messageId, m]));
    expect(byId.get('<falcon-001@bank.example>')?.mailboxes).toEqual(['morgan.vale@bank.example', 'storm.duncan@bank.example']);
    expect(byId.get('<lunch-006@bank.example>')?.mailboxes).toEqual(['alex.chen@bank.example', 'morgan.vale@bank.example']);
    expect(byId.get('<digest-007@newswire.example>')?.mailboxes).toEqual(['storm.duncan@bank.example']);
  });

  it('derives references from the order inside each conversation', () => {
    const byId = new Map(seed.map((m) => [m.messageId, m]));
    expect(byId.get('<falcon-001@bank.example>')?.references).toBeUndefined();
    expect(byId.get('<falcon-002@bank.example>')?.references).toEqual(['<falcon-001@bank.example>']);
    expect(byId.get('<falcon-002@bank.example>')?.inReplyTo).toBe('<falcon-001@bank.example>');
    expect(byId.get('<cobra-002@cobalt-systems.example>')?.references).toEqual(['<cobra-001@bank.example>']);
    expect(byId.get('<falcon-004@heliotrope.example>')?.references).toEqual(['<falcon-003@bank.example>']);
    // The third message of a conversation carries the whole chain, root first.
    expect(byId.get('<dinner-005@heliotrope.example>')?.references).toEqual([
      '<falcon-003@bank.example>',
      '<falcon-004@heliotrope.example>',
    ]);
  });

  it('never writes a Graph conversationId into the output', () => {
    const text = toJsonl(seed);
    const conversationIds = new Set(
      loadFixtureMailboxes().flatMap((b) => b.messages.map((m) => m.conversationId).filter((c): c is string => !!c)),
    );
    expect(conversationIds.size).toBeGreaterThan(0);
    for (const id of conversationIds) expect(text).not.toContain(id);
    expect(text).not.toContain('conversationId');
  });

  it('marks exactly one SPAM message and two after-imports messages', () => {
    expect(seed.filter((m) => m.labels?.includes('SPAM')).map((m) => m.messageId)).toEqual([SPAM_MESSAGE_ID]);
    expect(seed.filter((m) => m.phase === 'after-imports').map((m) => m.messageId).sort()).toEqual(
      [...AFTER_IMPORT_MESSAGE_IDS].sort(),
    );
  });

  it('round-trips through the JSONL format', () => {
    expect(parseSeedJsonl(toJsonl(seed))).toEqual(seed);
    expect(() => parseSeedJsonl('{"messageId":"nope"}')).toThrow(/invalid fields/);
    expect(() => parseSeedJsonl('not json')).toThrow(/not JSON/);
  });
});

describe('planImports', () => {
  const personas = {
    'storm.duncan@bank.example': 'storm@trial.example',
    'morgan.vale@bank.example': 'morgan@trial.example',
    'alex.chen@bank.example': 'alex@trial.example',
  };

  it('plans one copy per mailbox, by phase, and puts the SPAM message in SPAM', () => {
    const seeded = planImports(seed, personas, 'seeded');
    const later = planImports(seed, personas, 'after-imports');
    expect(later.map((e) => e.message.messageId).sort()).toEqual([...AFTER_IMPORT_MESSAGE_IDS].sort());
    expect(seeded.every((e) => e.message.phase === 'seeded')).toBe(true);
    expect(seeded.find((e) => e.message.messageId === SPAM_MESSAGE_ID)?.labelIds).toEqual(['SPAM']);
    expect(seeded.filter((e) => e.labelIds[0] === 'SPAM')).toHaveLength(1);
    expect(seeded.filter((e) => e.message.messageId === '<falcon-001@bank.example>').map((e) => e.trialAddress).sort()).toEqual([
      'morgan@trial.example',
      'storm@trial.example',
    ]);
  });

  it('refuses a persona with no trial address', () => {
    expect(() => planImports(seed, { 'storm.duncan@bank.example': 'storm@trial.example' }, 'seeded')).toThrow(/No trial address/);
  });
});

describe('buildRfc822', () => {
  const message = seed.find((m) => m.messageId === '<falcon-002@bank.example>')!;
  const text = new TextDecoder().decode(buildRfc822(message));

  it('keeps the Message-ID and the threading headers verbatim, with CRLF line ends', () => {
    expect(text).toContain('Message-ID: <falcon-002@bank.example>\r\n');
    expect(text).toContain('In-Reply-To: <falcon-001@bank.example>\r\n');
    expect(text).toContain('References: <falcon-001@bank.example>\r\n');
    expect(text).toContain('Content-Transfer-Encoding: quoted-printable\r\n');
    expect(text).not.toMatch(/[^\r]\n/);
  });

  it('encodes non-ASCII text as quoted-printable and keeps lines short', () => {
    expect(quotedPrintable('Café = ok')).toBe('Caf=C3=A9 =3D ok');
    expect(quotedPrintable('trailing space ')).toBe('trailing space=20');
    const long = quotedPrintable('x'.repeat(200));
    expect(long.split('\r\n').every((l) => l.length <= 76)).toBe(true);
    expect(long.replace(/=\r\n/g, '')).toBe('x'.repeat(200));
  });
});
