// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { DEAL_EMAIL_LIMIT, listDealEmail } from '@/lib/discovery/api';

// listDealEmail over a fake client. Each table answers a fixed row set (the rows
// RLS would have returned for the caller) and every builder call is recorded, so
// this tests how the rows are assembled and redacted, which columns are asked for
// (never body_text), and which filters the reads carry. The items come from the
// discovery_item_metadata definer, faked below the way the SQL answers: the
// caller owns an item when it has a source_item_texts row, and a colleague's item
// comes back with subject and participants nulled and the sender's domain only.

type Call = {
  table: string;
  select?: string;
  filters: Array<[string, string, unknown]>;
  range?: [number, number];
  limit?: number;
};

/** PostgREST answers at most max_rows (supabase/config.toml) rows per request, paged or not. */
const MAX_ROWS = 1000;
type Rows = Record<string, unknown[]>;

function fakeDb(rows: Rows, failOn?: string) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, filters: [] };
    calls.push(call);
    // An `in (...)` filter keeps the rows whose column is in the list, as PostgREST would.
    // A `gt` filter keeps the rows past the key, as PostgREST would; rows are given in key order.
    const matching = () =>
      (rows[table] ?? []).filter((row) =>
        call.filters.every(([op, column, value]) => {
          const cell = (row as Record<string, unknown>)[column];
          if (op === 'gt') return String(cell) > String(value);
          return op !== 'in' || !(column in (row as object)) || (value as unknown[]).includes(cell);
        }),
      );
    const result = () => {
      if (failOn === table) return { data: null, error: { message: 'boom' } };
      const all = matching();
      const [start, end] = call.range ?? [0, all.length - 1];
      return { data: all.slice(start, end + 1).slice(0, call.limit ?? MAX_ROWS).slice(0, MAX_ROWS), error: null };
    };
    const builder: Record<string, unknown> = {};
    builder.select = (columns: string) => {
      call.select = columns;
      return builder;
    };
    builder.limit = (count: number) => {
      call.limit = count;
      return builder;
    };
    for (const m of ['eq', 'neq', 'in', 'gt']) {
      builder[m] = (column: string, value: unknown) => {
        call.filters.push([m, column, value]);
        return builder;
      };
    }
    builder.order = () => builder;
    builder.range = (start: number, end: number) => {
      call.range = [start, end];
      return builder;
    };
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
    const owned = new Set((rows.source_item_texts ?? []).map((t) => (t as { source_item_id: string }).source_item_id));
    // The own-mailbox filter: every owned item is the caller's own mailbox's, except rows.team_items.
    if (name === 'discovery_own_mailbox_items') {
      const team = new Set((rows.team_items ?? []).map((t) => (t as { id: string }).id));
      return {
        data: args.p_items.filter((id) => owned.has(id) && !team.has(id)).map((id) => ({ id, mailbox_address: 'storm@bank.example' })),
        error: null,
      };
    }
    if (name !== 'discovery_item_metadata') throw new Error(`unexpected rpc ${name}`);
    const data = (rows.source_items ?? [])
      .map((r) => r as { id: string; kind?: string; subject: string | null; sent_at: string | null; participants: unknown })
      .filter((r) => args.p_items.includes(r.id))
      .map((r) => {
        const own = owned.has(r.id);
        return {
          id: r.id,
          kind: r.kind ?? 'message',
          sent_at: r.sent_at,
          own,
          subject: own ? r.subject : null,
          participants: own ? r.participants : null,
          sender_domain: senderDomain(r.participants),
        };
      });
    return { data, error: null };
  };
  return { db: { from, rpc } as unknown as SupabaseClient, calls };
}

/** The SQL's sender_domain: the first 'from' participant's address, lowercased after its last '@'. */
function senderDomain(participants: unknown): string | null {
  if (!Array.isArray(participants)) return null;
  const from = participants.find((p) => p && p.role === 'from' && typeof p.address === 'string' && p.address);
  if (!from) return null;
  const match = /^.+@([^@]+)$/.exec(from.address as string);
  return match ? match[1].toLowerCase() : null;
}

const FROM = (address: string, name: string | null = null) => ({ role: 'from', address, name });
const TO = { role: 'to', address: 'storm@bank.example', name: 'Storm Duncan' };

const OWN = {
  id: 'i-own',
  subject: 'Project Kestrel: LOI signed',
  sent_at: '2026-09-18T15:00:00Z',
  participants: [FROM('Mike@Northwind-Robotics.example', 'Mike Cannon'), TO],
};
const COLLEAGUE = {
  id: 'i-colleague',
  subject: 'Secret colleague subject',
  sent_at: '2026-09-19T09:30:00Z',
  participants: [FROM('cfo@northwind-robotics.example', 'Pat CFO'), TO],
};

function rows(over: Rows = {}): Rows {
  return {
    deals: [{ id: 'deal-1' }],
    deal_candidates: [{ id: 'cand-1' }],
    evidence_links: [{ source_item_id: 'i-own' }, { source_item_id: 'i-colleague' }],
    source_items: [OWN, COLLEAGUE],
    source_item_texts: [{ source_item_id: 'i-own' }],
    ...over,
  };
}

describe('listDealEmail', () => {
  it('keeps subject and sender for the caller\'s own mail and nulls them for a colleague\'s', async () => {
    const { db } = fakeDb(rows());
    const result = await listDealEmail(db, 'KESTR-2026-412');
    if (!result.ok) throw new Error('expected ok');
    expect(result.items).toEqual([
      // Newest first.
      {
        sourceItemId: 'i-colleague',
        sentDay: '2026-09-19',
        fromDomain: 'northwind-robotics.example',
        sender: null,
        subject: null,
        own: false,
        opensThread: false,
      },
      {
        sourceItemId: 'i-own',
        sentDay: '2026-09-18',
        fromDomain: 'northwind-robotics.example',
        sender: 'Mike Cannon',
        subject: 'Project Kestrel: LOI signed',
        own: true,
        opensThread: true,
      },
    ]);
    expect(result.truncated).toBe(false);
    // Redaction is on the server: a colleague's subject appears nowhere in the payload.
    expect(JSON.stringify(result)).not.toContain('Secret colleague subject');
    expect(JSON.stringify(result)).not.toContain('Pat CFO');
  });

  // Martín's review of PR #650 (N2): a team inbox item is owned (PR #614) and shows sender and subject, but its
  // thread does not open, so the row is not a control.
  it('lists a team inbox item as owned but not opening a thread', async () => {
    const { db } = fakeDb(rows({ team_items: [{ id: 'i-own' }] }));
    const result = await listDealEmail(db, 'KESTR-2026-412');
    if (!result.ok) throw new Error('expected ok');
    expect(result.items.find((item) => item.sourceItemId === 'i-own')).toMatchObject({ own: true, opensThread: false });
  });

  it('redacts a non-owner row by its own flag, even if the definer were to send the content', async () => {
    const { db } = fakeDb(rows());
    // A definer that leaks: the colleague's row carries its subject and participants despite own = false.
    (db as unknown as { rpc: unknown }).rpc = async () => ({
      data: [
        {
          id: 'i-colleague',
          kind: 'message',
          sent_at: COLLEAGUE.sent_at,
          own: false,
          subject: COLLEAGUE.subject,
          participants: COLLEAGUE.participants,
          sender_domain: 'northwind-robotics.example',
        },
      ],
      error: null,
    });
    const result = await listDealEmail(db, 'KESTR-2026-412');
    if (!result.ok) throw new Error('expected ok');
    expect(result.items).toEqual([
      {
        sourceItemId: 'i-colleague',
        sentDay: '2026-09-19',
        fromDomain: 'northwind-robotics.example',
        sender: null,
        subject: null,
        own: false,
        opensThread: false,
      },
    ]);
    const payload = JSON.stringify(result);
    expect(payload).not.toContain('Secret colleague subject');
    expect(payload).not.toContain('Pat CFO');
    expect(payload).not.toContain('cfo@');
  });

  it('falls back to the sender address when the display name is missing', async () => {
    const { db } = fakeDb(rows({ source_items: [{ ...OWN, participants: [FROM('mike@northwind-robotics.example')] }] }));
    const result = await listDealEmail(db, 'KESTR-2026-412');
    if (!result.ok) throw new Error('expected ok');
    expect(result.items[0]).toMatchObject({ sender: 'mike@northwind-robotics.example', fromDomain: 'northwind-robotics.example' });
  });

  it('reads the items through the owner-only definer, never source_items or source_item_texts directly', async () => {
    const { db, calls } = fakeDb(rows());
    await listDealEmail(db, 'KESTR-2026-412');
    expect(calls.filter((c) => c.table === 'rpc:discovery_item_metadata')).toHaveLength(1);
    expect(calls.filter((c) => c.table === 'source_items' || c.table === 'source_item_texts')).toEqual([]);
    expect(JSON.stringify(calls)).not.toContain('body_text');
  });

  it('lists messages only: a site document the definer answers is left out', async () => {
    const { db } = fakeDb(rows({ source_items: [OWN, { ...COLLEAGUE, kind: 'document' }] }));
    const result = await listDealEmail(db, 'X');
    if (!result.ok) throw new Error('expected ok');
    expect(result.items.map((i) => i.sourceItemId)).toEqual(['i-own']);
  });

  it('reads the non-rejected links of the deal\'s promoted candidates', async () => {
    const { db, calls } = fakeDb(rows());
    await listDealEmail(db, 'KESTR-2026-412');
    const by = (table: string) => calls.find((c) => c.table === table)!;
    expect(by('deals').filters).toContainEqual(['eq', 'code', 'KESTR-2026-412']);
    expect(by('deal_candidates').filters).toContainEqual(['eq', 'promoted_deal_id', 'deal-1']);
    expect(by('evidence_links').filters).toContainEqual(['in', 'candidate_id', ['cand-1']]);
    expect(by('evidence_links').filters).toContainEqual(['neq', 'state', 'rejected']);
  });

  it('answers an empty list for an unknown or unseen deal, without reading further', async () => {
    const { db, calls } = fakeDb(rows({ deals: [] }));
    expect(await listDealEmail(db, 'NOPE-0000-000')).toEqual({ ok: true, items: [], truncated: false });
    expect(calls.map((c) => c.table)).toEqual(['deals']);
  });

  it('answers an empty list for a deal with no promoted candidate or no live link', async () => {
    expect(await listDealEmail(fakeDb(rows({ deal_candidates: [] })).db, 'X')).toEqual({ ok: true, items: [], truncated: false });
    expect(await listDealEmail(fakeDb(rows({ evidence_links: [] })).db, 'X')).toEqual({ ok: true, items: [], truncated: false });
  });

  it('sorts undated messages last and reads a message with no from participant as domain-less', async () => {
    const { db } = fakeDb(
      rows({
        evidence_links: [{ source_item_id: 'i-own' }, { source_item_id: 'i-colleague' }, { source_item_id: 'i-undated' }],
        source_items: [
          { ...COLLEAGUE, id: 'i-undated', sent_at: null, participants: [TO] },
          OWN,
          COLLEAGUE,
        ],
      }),
    );
    const result = await listDealEmail(db, 'X');
    if (!result.ok) throw new Error('expected ok');
    expect(result.items.map((i) => i.sourceItemId)).toEqual(['i-colleague', 'i-own', 'i-undated']);
    expect(result.items[2]).toMatchObject({ sentDay: null, fromDomain: null });
  });

  it('caps at 200 and says so', async () => {
    const many = Array.from({ length: DEAL_EMAIL_LIMIT + 5 }, (_, i) => ({
      id: `i-${String(i).padStart(3, '0')}`,
      subject: 's',
      sent_at: `2026-09-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
      participants: [FROM('a@x.example')],
    }));
    const { db } = fakeDb(rows({ evidence_links: many.map((m) => ({ source_item_id: m.id })), source_items: many, source_item_texts: [] }));
    const result = await listDealEmail(db, 'X');
    if (!result.ok) throw new Error('expected ok');
    expect(result.items).toHaveLength(DEAL_EMAIL_LIMIT);
    expect(result.truncated).toBe(true);
  });

  it('is not truncated at exactly the cap', async () => {
    const exact = Array.from({ length: DEAL_EMAIL_LIMIT }, (_, i) => ({
      id: `i-${i}`,
      subject: 's',
      sent_at: '2026-09-01T00:00:00Z',
      participants: [FROM('a@x.example')],
    }));
    const { db } = fakeDb(rows({ evidence_links: exact.map((m) => ({ source_item_id: m.id })), source_items: exact, source_item_texts: [] }));
    const result = await listDealEmail(db, 'X');
    if (!result.ok) throw new Error('expected ok');
    expect(result.items).toHaveLength(DEAL_EMAIL_LIMIT);
    expect(result.truncated).toBe(false);
  });

  it('reads long id lists in batches so no request line grows with the deal\'s history', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `i-${i}`);
    const { db, calls } = fakeDb(rows({ evidence_links: ids.map((id) => ({ source_item_id: id })), source_items: [], source_item_texts: [] }));
    await listDealEmail(db, 'X');
    const batches = calls.filter((c) => c.table === 'rpc:discovery_item_metadata').map((c) => (c.filters.find((f) => f[0] === 'in')![2] as string[]).length);
    expect(batches).toEqual([100, 100, 50]);
  });

  it('pages the evidence links, so mail past the max_rows cap is still read and the newest shows first', async () => {
    const total = MAX_ROWS + 200;
    // Link order is not date order: the newest message is the last link.
    const many = Array.from({ length: total }, (_, i) => ({
      id: `i-${String(i).padStart(4, '0')}`,
      subject: 's',
      sent_at: i === total - 1 ? '2026-10-01T00:00:00Z' : '2026-09-01T00:00:00Z',
      participants: [FROM('a@x.example')],
    }));
    const links = many.map((m, i) => ({ id: `l-${String(i).padStart(4, '0')}`, source_item_id: m.id }));
    const { db, calls } = fakeDb(rows({ evidence_links: links, source_items: many, source_item_texts: [] }));
    const result = await listDealEmail(db, 'X');
    if (!result.ok) throw new Error('expected ok');
    expect(result.items[0].sourceItemId).toBe(`i-${String(total - 1).padStart(4, '0')}`);
    expect(result.truncated).toBe(true);
    // By key, not offset (#581): each page starts after the last id the one before it read, so RLS judges each row once.
    const pages = calls
      .filter((c) => c.table === 'evidence_links')
      .map((c) => [c.filters.find((f) => f[0] === 'gt')?.[2] ?? null, c.limit, c.range ?? null]);
    expect(pages).toEqual([
      [null, 500, null],
      ['l-0499', 500, null],
      ['l-0999', 500, null],
    ]);
  });

  it.each(['deals', 'deal_candidates', 'evidence_links', 'rpc:discovery_item_metadata'])('fails closed when the %s read fails', async (table) => {
    const { db } = fakeDb(rows(), table);
    expect(await listDealEmail(db, 'X')).toEqual({ ok: false });
  });
});
