// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createGmailMailContentSource } from '@/lib/google/reader/mail';
import { conversationIdOf } from '@/lib/google/reader/thread';

import { NO_EXCLUSION } from './exclusion';
import { fakeGmail } from './fakeGmail';

const ROOT = '<root-001@bank.example>';
const REPLY = {
  id: 'reply',
  messageId: '<root-002@heliotrope.example>',
  internalDate: 2000,
  inReplyTo: ROOT,
  references: [ROOT],
  subject: 'Re: Project Falcon',
};

async function conversationOf(address: string, threadId: string, message: object) {
  const gmail = fakeGmail({ address, threads: [{ id: threadId, messages: [message as never] }] });
  const reader = createGmailMailContentSource({ httpFor: async () => gmail.http, exclusion: NO_EXCLUSION });
  for await (const page of reader.backfill(gmail.source, null)) {
    if (page.items.length > 0) return page.items[0].conversationId;
  }
  throw new Error('no item');
}

describe('conversationId comes from RFC 5322 headers, not the mailbox (R18)', () => {
  it("gives two mailboxes' copies of one reply the same conversationId, whatever Gmail's threadId is", async () => {
    // Gmail's threadId is per mailbox: the two copies sit in differently named threads.
    const a = await conversationOf('storm.duncan@bank.example', 'thread-aaa', REPLY);
    const b = await conversationOf('morgan.vale@bank.example', 'thread-bbb', REPLY);
    expect(a).toBe(b);
    expect(a).toBe('rfc822:<root-001@bank.example>');
    expect(a).not.toContain('thread-');
  });

  it('puts the reply and its root in one conversation, so thread continuation can key on it', () => {
    const root = conversationIdOf({ messageId: ROOT });
    const reply = conversationIdOf({ messageId: '<r2@x>', inReplyTo: ROOT, references: ROOT });
    const third = conversationIdOf({ messageId: '<r3@x>', inReplyTo: '<r2@x>', references: `${ROOT} <r2@x>` });
    expect(new Set([root, reply, third]).size).toBe(1);
  });

  it('joins a reply that dropped References but kept In-Reply-To to its parent', () => {
    const parent = conversationIdOf({ messageId: ROOT });
    expect(conversationIdOf({ messageId: '<r2@x>', inReplyTo: ROOT })).toBe(parent);
    expect(conversationIdOf({ messageId: '<r2@x>', inReplyTo: 'Re: someone <root-001@bank.example> wrote', references: '' })).toBe(parent);
  });

  it('starts its own conversation when there is neither, lowercased and prefixed so it cannot equal a Graph id', () => {
    expect(conversationIdOf({ messageId: '<Alone-1@Bank.Example>' })).toBe('rfc822:<alone-1@bank.example>');
    expect(conversationIdOf({ messageId: '<a@x>', inReplyTo: null, references: null })).toBe('rfc822:<a@x>');
    expect(conversationIdOf({ messageId: '<a@x>', inReplyTo: 'garbage', references: 'garbage' })).toBe('rfc822:<a@x>');
  });

  it('takes the first reference as the root, whatever the chain length', () => {
    const chain = '<r1@x> <r2@x> <r3@x>';
    expect(conversationIdOf({ messageId: '<r4@x>', references: chain })).toBe('rfc822:<r1@x>');
  });
});
