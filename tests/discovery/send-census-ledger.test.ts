// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { dedupeObservations, normalizeMessage, type NormalizedItem } from '@/lib/discovery/normalize';
import { collisionLedgerRows, ledgerRows, skippedLedgerRows } from '@/lib/discovery/persist';
import type { MailMessage } from '@/lib/discovery/source/types';

const send = { sentAt: '2026-10-05T12:00:00.000Z', recipient: null };
const item: NormalizedItem = { internetMessageId: '<one@example.test>', conversationId: null, subject: '', threadSubject: '', sentAt: null, participants: [], bodyText: '', contentHash: 'hash' };

describe('per-source send facts (#425)', () => {
  it('retains the fact on its sighting, not the deduplicated item', () => {
    const out = dedupeObservations([
      { sourceId: 'A', providerItemId: 'one', send, item },
      { sourceId: 'B', providerItemId: 'two', item },
    ]);
    expect(out.items[0].observations).toEqual([{ sourceId: 'A', providerItemId: 'one', send }, { sourceId: 'B', providerItemId: 'two' }]);
    expect(out.items[0].item).not.toHaveProperty('send');
    const rows = ledgerRows([{ ...out.items[0], routes: [] }], 'run');
    expect(rows.map((row) => [row.sent_at, row.sent_recipient])).toEqual([[send.sentAt, null], [null, null]]);
  });

  it('ledgers policy skips and collisions, with nulls for unsent rows', () => {
    expect(skippedLedgerRows([{ sourceId: 'A', providerItemId: 'one', itemHash: 'hash', reason: 'policy_excluded', providerThreadId: 'thread', policy: { version: 1, ruleId: 'rule' }, send }], 'run')[0].sent_at).toBe(send.sentAt);
    expect(collisionLedgerRows([{ sourceId: 'A', providerItemId: 'one', itemHash: 'hash', key: 'key', similarity: 0, lengthRatio: 0, send }], 'run')[0].sent_at).toBe(send.sentAt);
    expect(skippedLedgerRows([{ sourceId: 'B', providerItemId: 'two', itemHash: 'hash', reason: 'id_collision' }], 'run')[0].sent_at).toBeNull();
  });

  it('never normalizes the send fact into a stored item', () => {
    const message = { id: 'one', internetMessageId: '<one@example.test>', conversationId: null, subject: '', sentDateTime: null, from: null, toRecipients: [], ccRecipients: [], body: { contentType: 'text', content: '' }, send } as MailMessage;
    expect(normalizeMessage(message)).not.toHaveProperty('send');
  });
});
