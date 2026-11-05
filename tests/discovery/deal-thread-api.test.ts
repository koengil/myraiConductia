// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  DEAL_THREAD_LIMIT,
  MAX_REPLY_REFERENCES,
  readDealThread,
  replyThreading,
  type DealThread,
} from '@/lib/discovery/api';

// readDealThread over a fake client (#339). Each table answers the rows RLS would
// have returned for the caller, filtered by the eq and in filters the read
// carries, and every read is recorded. The discovery_item_metadata definer is
// faked the way the SQL answers: the caller owns an item when it has a
// source_item_texts row, and a colleague's item comes back with subject and
// participants nulled. discovery_own_mailbox_items answers every owned item
// as the caller's own mailbox's (rows.mailbox_address, storm@bank.example by
// default) except those in rows.team_items, a team inbox the caller reads.

type Call = { table: string; select?: string; filters: Array<[string, string, unknown]> };
type Row = Record<string, unknown>;
type Rows = Record<string, Row[]>;

function fakeDb(rows: Rows, failOn?: string) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, filters: [] };
    calls.push(call);
    const matching = () =>
      (rows[table] ?? []).filter((row) =>
        call.filters.every(([op, column, value]) => {
          if (!(column in row)) return true;
          if (op === 'eq') return row[column] === value;
          if (op === 'in') return (value as unknown[]).includes(row[column]);
          return true;
        }),
      );
    const result = () => (failOn === table ? { data: null, error: { message: 'boom' } } : { data: matching(), error: null });
    const builder: Record<string, unknown> = {};
    builder.select = (columns: string) => {
      call.select = columns;
      return builder;
    };
    for (const m of ['eq', 'neq', 'in']) {
      builder[m] = (column: string, value: unknown) => {
        call.filters.push([m, column, value]);
        return builder;
      };
    }
    builder.order = () => builder;
    builder.range = () => builder;
    builder.limit = () => builder;
    builder.maybeSingle = async () => {
      const r = result();
      return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : null, error: r.error };
    };
    builder.then = (resolve: (v: unknown) => void) => resolve(result());
    return builder;
  };
  const rpc = async (name: string, args: { p_items: string[] }) => {
    calls.push({ table: `rpc:${name}`, filters: [['in', 'id', args.p_items]] });
    if (failOn === `rpc:${name}`) return { data: null, error: { message: 'boom' } };
    const owned = new Set((rows.source_item_texts ?? []).map((t) => t.source_item_id));
    if (name === 'discovery_own_mailbox_items') {
      const team = new Set((rows.team_items ?? []).map((t) => t.id));
      const address = (rows.mailbox_address?.[0]?.address as string | undefined) ?? 'storm@bank.example';
      return {
        data: args.p_items.filter((id) => owned.has(id) && !team.has(id)).map((id) => ({ id, mailbox_address: address })),
        error: null,
      };
    }
    const data = (rows.source_items ?? [])
      .filter((r) => args.p_items.includes(r.id as string))
      .map((r) => {
        const own = owned.has(r.id);
        return {
          id: r.id,
          kind: r.kind ?? 'message',
          sent_at: r.sent_at,
          own,
          subject: own ? r.subject : null,
          participants: own ? r.participants : null,
          sender_domain: null,
        };
      });
    return { data, error: null };
  };
  return { db: { from, rpc } as unknown as SupabaseClient, calls };
}

const CONV = 'rfc822:<root@northwind.example>';
const MIKE = { role: 'from', address: 'mike@northwind.example', name: 'Mike Cannon' };
const STORM_TO = { role: 'to', address: 'storm@bank.example', name: 'Storm Duncan' };
const STORM_FROM = { role: 'from', address: 'storm@bank.example', name: 'Storm Duncan' };
const MIKE_TO = { role: 'to', address: 'mike@northwind.example', name: null };
const PAT_CC = { role: 'cc', address: 'pat@northwind.example', name: 'Pat CFO' };

const item = (id: string, sentAt: string | null, participants: Row[], extra: Row = {}): Row => ({
  id,
  kind: 'message',
  subject: 'Project Kestrel',
  sent_at: sentAt,
  participants,
  conversation_id: CONV,
  internet_message_id: `<${id}@mail.example>`,
  ...extra,
});

function rows(over: Rows = {}): Rows {
  return {
    deals: [{ id: 'deal-1', code: 'KESTR-2026-412' }],
    deal_candidates: [{ id: 'cand-1' }],
    evidence_links: [
      { source_item_id: 'i-1' },
      { source_item_id: 'i-2' },
      { source_item_id: 'i-colleague' },
    ],
    source_items: [
      item('i-1', '2026-09-18T15:00:00Z', [MIKE, STORM_TO, PAT_CC]),
      item('i-2', '2026-09-19T09:00:00Z', [STORM_FROM, MIKE_TO], { subject: 'Re: Project Kestrel' }),
      item('i-colleague', '2026-09-20T09:00:00Z', [MIKE, { role: 'to', address: 'alice@bank.example' }], {
        subject: 'Secret colleague subject',
      }),
      // Same conversation, not linked to the deal.
      item('i-unlinked', '2026-09-21T09:00:00Z', [MIKE, STORM_TO], { subject: 'Unlinked subject' }),
    ],
    source_item_texts: [
      { source_item_id: 'i-1', body_text: 'We signed the LOI.' },
      { source_item_id: 'i-2', body_text: 'Congratulations, next steps attached.' },
      { source_item_id: 'i-unlinked', body_text: 'Not on this deal.' },
    ],
    ...over,
  };
}

describe('readDealThread', () => {
  it("returns the caller's own deal-linked messages of the conversation, oldest first, with bodies and addresses", async () => {
    const { db } = fakeDb(rows());
    const result = await readDealThread(db, 'KESTR-2026-412', 'i-2', ['Storm@Bank.example']);
    if (!result.ok) throw new Error('expected ok');
    expect(result.thread).toEqual({
      conversationId: CONV,
      messages: [
        {
          sourceItemId: 'i-1',
          sentAt: '2026-09-18T15:00:00Z',
          from: { address: 'mike@northwind.example', name: 'Mike Cannon' },
          to: [{ address: 'storm@bank.example', name: 'Storm Duncan' }],
          cc: [{ address: 'pat@northwind.example', name: 'Pat CFO' }],
          subject: 'Project Kestrel',
          body: 'We signed the LOI.',
          internetMessageId: '<i-1@mail.example>',
          fromSelf: false,
        },
        {
          sourceItemId: 'i-2',
          sentAt: '2026-09-19T09:00:00Z',
          from: { address: 'storm@bank.example', name: 'Storm Duncan' },
          to: [{ address: 'mike@northwind.example', name: null }],
          cc: [],
          subject: 'Re: Project Kestrel',
          body: 'Congratulations, next steps attached.',
          internetMessageId: '<i-2@mail.example>',
          fromSelf: true,
        },
      ],
    });
  });

  it("leaves out a colleague's message and a message not linked to the deal, even in the same conversation", async () => {
    const { db } = fakeDb(rows());
    const result = await readDealThread(db, 'KESTR-2026-412', 'i-1');
    const text = JSON.stringify(result);
    expect(text).not.toContain('i-colleague');
    expect(text).not.toContain('Secret colleague subject');
    expect(text).not.toContain('alice@bank.example');
    expect(text).not.toContain('i-unlinked');
    expect(text).not.toContain('Not on this deal.');
  });

  it("answers null for a colleague's message, an unlinked message, an unknown item and an unseen deal alike", async () => {
    for (const [deal, id] of [
      ['KESTR-2026-412', 'i-colleague'],
      ['KESTR-2026-412', 'i-unlinked'],
      ['KESTR-2026-412', 'i-missing'],
      ['OTHER-DEAL', 'i-1'],
    ]) {
      const { db } = fakeDb(rows());
      expect(await readDealThread(db, deal, id), `${deal} ${id}`).toEqual({ ok: true, thread: null });
    }
  });

  it('does not read the conversation or any body when the item is not linked to the deal', async () => {
    const { db, calls } = fakeDb(rows());
    await readDealThread(db, 'KESTR-2026-412', 'i-unlinked');
    expect(calls.map((c) => c.table)).not.toContain('source_items');
    expect(calls.map((c) => c.table)).not.toContain('source_item_texts');
  });

  it('reads walled columns only through the definer: source_items is asked for id, conversation and message id', async () => {
    const { db, calls } = fakeDb(rows());
    await readDealThread(db, 'KESTR-2026-412', 'i-1');
    for (const call of calls.filter((c) => c.table === 'source_items')) {
      expect(call.select).toBe('id, conversation_id, internet_message_id');
    }
    const texts = calls.find((c) => c.table === 'source_item_texts');
    expect(texts?.select).toBe('source_item_id, body_text');
    expect(texts?.filters).toEqual([['in', 'source_item_id', ['i-1', 'i-2']]]);
  });

  it('returns the message alone when it has no conversation id', async () => {
    const lone = rows();
    lone.source_items = lone.source_items.map((r) => (r.id === 'i-1' ? { ...r, conversation_id: null } : r));
    const { db } = fakeDb(lone);
    const result = await readDealThread(db, 'KESTR-2026-412', 'i-1');
    if (!result.ok || !result.thread) throw new Error('expected a thread');
    expect(result.thread.conversationId).toBeNull();
    expect(result.thread.messages.map((m) => m.sourceItemId)).toEqual(['i-1']);
  });

  it(`keeps the newest ${DEAL_THREAD_LIMIT} of a long thread, oldest first, an undated message counted as the oldest`, async () => {
    const many: Row[] = [];
    const texts: Row[] = [];
    const links: Row[] = [];
    for (let n = 0; n < DEAL_THREAD_LIMIT + 5; n += 1) {
      const id = `m-${String(n).padStart(3, '0')}`;
      many.push(item(id, `2026-09-01T00:${String(n).padStart(2, '0')}:00Z`, [MIKE, STORM_TO]));
      texts.push({ source_item_id: id, body_text: `body ${n}` });
      links.push({ source_item_id: id });
    }
    many.push(item('m-undated', null, [MIKE, STORM_TO]));
    texts.push({ source_item_id: 'm-undated', body_text: 'undated' });
    links.push({ source_item_id: 'm-undated' });
    const { db } = fakeDb(rows({ source_items: many, source_item_texts: texts, evidence_links: links }));
    const result = await readDealThread(db, 'KESTR-2026-412', 'm-010');
    if (!result.ok || !result.thread) throw new Error('expected a thread');
    const ids = result.thread.messages.map((m) => m.sourceItemId);
    expect(ids).toHaveLength(DEAL_THREAD_LIMIT);
    // The undated message sorts first and is the first dropped; the newest dated message stays last.
    expect(ids).not.toContain('m-undated');
    expect(ids[0]).toBe('m-005');
    expect(ids.at(-1)).toBe('m-054');
  });

  it('answers null for an owned message whose body was never stored, rather than an empty thread', async () => {
    const pending = rows();
    pending.source_item_texts = pending.source_item_texts.filter((t) => t.source_item_id !== 'i-2');
    const { db } = fakeDb(pending);
    expect(await readDealThread(db, 'KESTR-2026-412', 'i-2')).toEqual({ ok: true, thread: null });
    const other = await readDealThread(fakeDb(pending).db, 'KESTR-2026-412', 'i-1');
    if (!other.ok || !other.thread) throw new Error('expected a thread');
    expect(other.thread.messages.map((m) => m.sourceItemId)).toEqual(['i-1']);
  });

  // Martín's review of PR #650 (N2): a team inbox the caller reads as a member is owned (PR #614), but a reply from a
  // personal address into a team conversation needs its own decision, so team items stay out of the thread.
  it('leaves out a team inbox item, and answers null when it is the one opened', async () => {
    const team = rows({ team_items: [{ id: 'i-2' }] });
    expect(await readDealThread(fakeDb(team).db, 'KESTR-2026-412', 'i-2', ['storm@bank.example'])).toEqual({
      ok: true,
      thread: null,
    });
    const other = await readDealThread(fakeDb(team).db, 'KESTR-2026-412', 'i-1', ['storm@bank.example']);
    if (!other.ok || !other.thread) throw new Error('expected a thread');
    expect(other.thread.messages.map((m) => m.sourceItemId)).toEqual(['i-1']);
  });

  it("marks a send from the caller's connected mailbox address as their own, when it is not the sign-in address", async () => {
    const alias = { role: 'from', address: 'S.Duncan@bank.example', name: 'Storm Duncan' };
    const aliased = rows({ mailbox_address: [{ address: 's.duncan@bank.example' }] });
    aliased.source_items = aliased.source_items.map((r) => (r.id === 'i-2' ? { ...r, participants: [alias, MIKE_TO] } : r));
    const result = await readDealThread(fakeDb(aliased).db, 'KESTR-2026-412', 'i-2', ['storm@bank.example']);
    if (!result.ok || !result.thread) throw new Error('expected a thread');
    expect(result.thread.messages.find((m) => m.sourceItemId === 'i-2')?.fromSelf).toBe(true);
  });

  it.each(['deals', 'deal_candidates', 'evidence_links', 'source_items', 'rpc:discovery_item_metadata', 'rpc:discovery_own_mailbox_items', 'source_item_texts'])(
    'fails closed when the %s read fails',
    async (table) => {
      const { db } = fakeDb(rows(), table);
      expect(await readDealThread(db, 'KESTR-2026-412', 'i-1')).toEqual({ ok: false });
    },
  );
});

describe('replyThreading', () => {
  const msg = (n: number, id: string | null) => ({
    sourceItemId: `i-${n}`,
    sentAt: null,
    from: null,
    to: [],
    cc: [],
    subject: 's',
    body: 'b',
    internetMessageId: id,
    fromSelf: false,
  });
  const thread = (conversationId: string | null, ids: Array<string | null>): DealThread => ({
    conversationId,
    messages: ids.map((id, n) => msg(n, id)),
  });

  it('answers the newest message and starts References at the conversation root', () => {
    expect(replyThreading(thread('rfc822:<root@x>', ['<a@x>', '<b@x>']))).toEqual({
      inReplyTo: '<b@x>',
      references: ['<root@x>', '<a@x>', '<b@x>'],
    });
  });

  it('does not repeat a root the thread already holds, in any case', () => {
    expect(replyThreading(thread('rfc822:<a@x>', ['<A@x>', '<b@x>']))?.references).toEqual(['<A@x>', '<b@x>']);
  });

  it(`keeps the root and the newest when the chain passes ${MAX_REPLY_REFERENCES}`, () => {
    const ids = Array.from({ length: 60 }, (_, n) => `<m${n}@x>`);
    const refs = replyThreading(thread('rfc822:<root@x>', ids))?.references ?? [];
    expect(refs).toHaveLength(MAX_REPLY_REFERENCES);
    expect(refs[0]).toBe('<root@x>');
    expect(refs.at(-1)).toBe('<m59@x>');
  });

  it('drops malformed ids and threads nothing when the newest has no usable id', () => {
    expect(replyThreading(thread(null, ['bare@x', '<b@x>']))?.references).toEqual(['<b@x>']);
    expect(replyThreading(thread(null, ['<a@x>', null]))).toBeNull();
    expect(replyThreading(thread(null, ['<a@x>', '<b@x> <c@x>']))).toBeNull();
    expect(replyThreading(thread(null, []))).toBeNull();
  });
});

describe('readDealThread participants', () => {
  it("lists everyone on the caller's own messages of the thread, and the caller's own addresses, lowercased", async () => {
    const result = await readDealThread(fakeDb(rows()).db, 'KESTR-2026-412', 'i-2', ['Storm.Signin@Bank.example']);
    if (!result.ok || !result.thread) throw new Error('expected a thread');
    expect([...(result.participants ?? [])].sort()).toEqual(
      ['mike@northwind.example', 'pat@northwind.example', 'storm.signin@bank.example', 'storm@bank.example'],
    );
  });

  it(`counts someone only on a message older than the newest ${DEAL_THREAD_LIMIT} shown`, async () => {
    const ids = Array.from({ length: DEAL_THREAD_LIMIT + 5 }, (_, n) => `i-long-${String(n).padStart(2, '0')}`);
    const long = rows({
      evidence_links: ids.map((id) => ({ source_item_id: id })),
      source_items: ids.map((id, n) =>
        item(id, `2026-09-01T${String(n % 24).padStart(2, '0')}:${String(n).padStart(2, '0')}:00Z`,
          n === 0 ? [MIKE, STORM_TO, { role: 'cc', address: 'counsel@northwind.example' }] : [MIKE, STORM_TO]),
      ),
      source_item_texts: ids.map((id) => ({ source_item_id: id, body_text: 'b' })),
    });
    const newest = ids.at(-1) as string;
    const result = await readDealThread(fakeDb(long).db, 'KESTR-2026-412', newest, []);
    if (!result.ok || !result.thread) throw new Error('expected a thread');
    expect(result.thread.messages.some((m) => m.sourceItemId === 'i-long-00')).toBe(false);
    expect(result.participants).toContain('counsel@northwind.example');
  });
});
