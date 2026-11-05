import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The guard builds its own service client (audit round 1, item 2): its answers
// come from `guardAnswers` through the admin-client module, never from the
// `db` a caller passes to the accessor, which serves the reads only.
const admin = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseAdminClient: () => ({ rpc: admin.rpc }),
}));

// The only way to obtain an ActingUser is currentActingUser(), which reads the
// verified session (round 2, item 5): the tests mint theirs through it, by
// mocking the session, never by a cast.
vi.mock('@/lib/api/v1/httpScoped', () => ({ requireApiUserScoped: vi.fn() }));

import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { MAILBOX_GUARD_PURPOSE, MAILBOX_PROVIDER, MAILBOX_REFUSAL_REASON } from '@/lib/constants/discovery';
import { TABLE } from '@/lib/constants/tables';
import { MailboxAccessRefusedError } from '@/lib/mailboxAccess';
import { readMailboxItemsForTool, type ToolPurpose } from '@/lib/mailboxAccess/accessors';
import { currentActingUser, type ActingUser } from '@/lib/mailboxAccess/principal';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const SOURCE = { id: 'source-1', owner_user_id: OWNER, provider: 'microsoft' };

/** Mint an acting user the only way production does: from a (mocked) verified session. */
async function mint(userId: string, tenantId: string): Promise<ActingUser> {
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: { tenant_id: tenantId }, error: null }),
  };
  vi.mocked(requireApiUserScoped).mockResolvedValue({
    ok: true,
    user: { id: userId, email: 'a@bank.example', companyId: null },
    db: { from: () => builder } as never,
  });
  const acting = await currentActingUser();
  if (!acting) throw new Error('the session mock did not mint an acting user');
  return acting;
}

// The tenant belongs to the acting user (audit round 1, item 21)
let ACTING: ActingUser;
beforeAll(async () => {
  ACTING = await mint(USER, TENANT);
});
const PURPOSES: ToolPurpose[] = [
  MAILBOX_GUARD_PURPOSE.AGENT_TOOL,
  MAILBOX_GUARD_PURPOSE.SEARCH,
  MAILBOX_GUARD_PURPOSE.RETRIEVAL,
];

beforeEach(() => {
  admin.rpc.mockReset();
});

type Fake = {
  db: SupabaseClient;
  /** The reads' rpcs on the caller's db; the guard's calls are `guardCalls`. */
  rpcs: Array<{ name: string; args: Record<string, unknown> }>;
  froms: string[];
  selects: Array<{ table: string; columns: string }>;
  eqs: Array<{ table: string; column: string; value: unknown }>;
};

/**
 * A fake service-role client. `guard` answers each mailbox_guard_check call in
 * order (the last answer repeats); `tables` holds what each table returns.
 */
function fakeDb(config: {
  guard: Array<string | null>;
  source?: { id: string; owner_user_id: string | null; provider?: string; team_mailbox_id?: string | null } | null;
  links?: string[];
  visible?: string[];
  items?: Array<{ id: string; subject: string | null; sent_at: string | null }>;
}): Fake {
  const rpcs: Fake['rpcs'] = [];
  const froms: string[] = [];
  const selects: Fake['selects'] = [];
  const eqs: Fake['eqs'] = [];
  let guardCallCount = 0;
  admin.rpc.mockImplementation(async (name: string) => {
    if (name !== 'mailbox_guard_check') throw new Error(`unexpected guard rpc ${name}`);
    const answer = config.guard[Math.min(guardCallCount, config.guard.length - 1)];
    guardCallCount += 1;
    return { data: answer, error: null };
  });
  const db = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      if (name === 'mailbox_items_visible_to') return { data: config.visible ?? [], error: null };
      throw new Error(`unexpected rpc ${name}`);
    },
    from: (table: string) => {
      froms.push(table);
      const result = () => {
        if (table === TABLE.CONTENT_SOURCES) return { data: config.source ?? null, error: null };
        if (table === TABLE.SOURCE_ITEM_SOURCES) {
          return { data: (config.links ?? []).map((id) => ({ source_item_id: id })), error: null };
        }
        if (table === TABLE.SOURCE_ITEMS) return { data: config.items ?? [], error: null };
        throw new Error(`unexpected table ${table}`);
      };
      const builder: Record<string, unknown> = {
        select: (columns: string) => {
          selects.push({ table, columns });
          return builder;
        },
        eq: (column: string, value: unknown) => {
          eqs.push({ table, column, value });
          return builder;
        },
        ilike: () => builder,
        in: () => builder,
        limit: () => builder,
        maybeSingle: async () => result(),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { db, rpcs, froms, selects, eqs };
}

const request = (address = 'Storm.Duncan@bank.example') => ({
  address,
  caller: 'agent-tool:test',
  onBehalfOf: ACTING,
});
const guardCalls = () =>
  admin.rpc.mock.calls.map(([name, args]) => ({ name: name as string, args: args as Record<string, unknown> }));

describe.each(PURPOSES)('readMailboxItemsForTool as %s', (purpose) => {
  it('refuses at the guard and reads no provenance, item or text', async () => {
    const fake = fakeDb({ guard: [MAILBOX_REFUSAL_REASON.NO_CONSENT], source: SOURCE, links: ['item-1'] });
    const error = await readMailboxItemsForTool(fake.db, request(), purpose).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailboxAccessRefusedError);
    expect(error).toMatchObject({ reason: MAILBOX_REFUSAL_REASON.NO_CONSENT, purpose });
    // Only the source registry (id and owner) is read before the guard answers.
    expect(fake.froms).toEqual([TABLE.CONTENT_SOURCES]);
    expect(guardCalls()).toHaveLength(1);
    expect(guardCalls()[0].args).toMatchObject({ p_purpose: purpose, p_address: 'storm.duncan@bank.example' });
  });

  it('looks the source up, then guards once, always bound to the source owner', async () => {
    const fake = fakeDb({ guard: [null], source: SOURCE, links: [] });
    await readMailboxItemsForTool(fake.db, request(), purpose);
    const calls = guardCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toMatchObject({
      p_purpose: purpose,
      p_check_owner: true,
      p_owner_user_id: OWNER,
      p_provider: 'microsoft',
    });
    expect(fake.froms[0]).toBe(TABLE.CONTENT_SOURCES);
  });

  it('refuses an owner mismatch and reads no provenance', async () => {
    const fake = fakeDb({ guard: [MAILBOX_REFUSAL_REASON.OWNER_MISMATCH], source: SOURCE, links: ['item-1'] });
    const error = await readMailboxItemsForTool(fake.db, request(), purpose).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailboxAccessRefusedError);
    expect(error).toMatchObject({ reason: MAILBOX_REFUSAL_REASON.OWNER_MISMATCH });
    expect(fake.froms).not.toContain(TABLE.SOURCE_ITEM_SOURCES);
    expect(fake.froms).not.toContain(TABLE.SOURCE_ITEMS);
  });

  it('is not answered by the db the caller passes: a db that allows everything changes nothing', async () => {
    const fake = fakeDb({ guard: [MAILBOX_REFUSAL_REASON.NO_CONSENT], source: SOURCE, links: ['item-1'] });
    const permissive = {
      ...fake.db,
      rpc: async () => ({ data: null, error: null }),
      from: (fake.db as unknown as { from: SupabaseClient['from'] }).from,
    } as unknown as SupabaseClient;
    await expect(readMailboxItemsForTool(permissive, request(), purpose)).rejects.toBeInstanceOf(
      MailboxAccessRefusedError,
    );
    expect(guardCalls()).toHaveLength(1);
  });
});

describe('readMailboxItemsForTool', () => {
  it('takes the tenant from the acting user, for the guard and for every read', async () => {
    const other = '44444444-4444-4444-8444-444444444444';
    const acting = await mint(USER, other);
    const fake = fakeDb({
      guard: [null],
      source: SOURCE,
      links: ['item-1'],
      visible: ['item-1'],
      items: [{ id: 'item-1', subject: 'Project Atlas', sent_at: null }],
    });
    await readMailboxItemsForTool(fake.db, { address: 'storm.duncan@bank.example', caller: 'agent-tool:test', onBehalfOf: acting }, 'search');
    expect(guardCalls()[0].args).toMatchObject({ p_tenant_id: other });
    const tenantFilters = fake.eqs.filter((e) => e.column === 'tenant_id');
    expect(tenantFilters.length).toBeGreaterThanOrEqual(2); // the source lookup and the item read
    for (const filter of tenantFilters) expect(filter.value).toBe(other);
  });

  it('cannot be handed a tenant by the caller', async () => {
    const fake = fakeDb({ guard: [null], source: SOURCE, links: [] });
    await readMailboxItemsForTool(
      fake.db,
      // @ts-expect-error a tenant argument is not part of the request: the acting user's tenant is the only one
      { ...request(), tenantId: '99999999-9999-4999-8999-999999999999' },
      'search',
    );
    // A stray tenantId is ignored at run time as well.
    expect(guardCalls()[0].args).toMatchObject({ p_tenant_id: TENANT });
    expect(fake.eqs.filter((e) => e.column === 'tenant_id').every((e) => e.value === TENANT)).toBe(true);
  });

  it('passes the provider of the source row it read', async () => {
    const google = fakeDb({ guard: [null], source: { ...SOURCE, provider: MAILBOX_PROVIDER.GOOGLE }, links: [] });
    await readMailboxItemsForTool(google.db, request(), 'search');
    expect(guardCalls()[0].args).toMatchObject({ p_provider: 'google' });
    expect(google.selects[0]).toEqual({
      table: TABLE.CONTENT_SOURCES,
      columns: 'id, owner_user_id, provider, team_mailbox_id',
    });
  });

  it('surfaces provider_mismatch from the guard and reads nothing further', async () => {
    const fake = fakeDb({ guard: [MAILBOX_REFUSAL_REASON.PROVIDER_MISMATCH], source: SOURCE, links: ['item-1'] });
    await expect(readMailboxItemsForTool(fake.db, request(), 'retrieval')).rejects.toMatchObject({
      reason: 'provider_mismatch',
    });
    expect(fake.froms).toEqual([TABLE.CONTENT_SOURCES]);
  });

  it.each(PURPOSES)(
    'asks the guard about an address with no source (so the refusal is audited) and refuses no_source, as %s',
    async (purpose) => {
      const fake = fakeDb({ guard: [MAILBOX_REFUSAL_REASON.NO_SOURCE], source: null, links: ['item-1'] });
      const error = await readMailboxItemsForTool(fake.db, request(), purpose).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MailboxAccessRefusedError);
      expect(error).toMatchObject({ reason: 'no_source', purpose });
      expect(guardCalls()).toHaveLength(1);
      // No source, so no owner and no provider of its own: the guard refuses before it compares either.
      expect(guardCalls()[0].args).toMatchObject({ p_check_owner: true, p_owner_user_id: null, p_provider: 'microsoft' });
      expect(fake.froms).toEqual([TABLE.CONTENT_SOURCES]);
    },
  );

  it.each(PURPOSES)('refuses no_source even when a guard answers allowed for a sourceless address, as %s', async (purpose) => {
    const fake = fakeDb({ guard: [null], source: null, links: ['item-1'], visible: ['item-1'] });
    const error = await readMailboxItemsForTool(fake.db, request(), purpose).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailboxAccessRefusedError);
    expect(error).toMatchObject({ reason: 'no_source', purpose });
    expect(fake.froms).toEqual([TABLE.CONTENT_SOURCES]);
    expect(fake.rpcs).toEqual([]);
  });

  it('rejects provider_read at runtime, even through a cast', async () => {
    const fake = fakeDb({ guard: [null] });
    await expect(
      readMailboxItemsForTool(fake.db, request(), 'provider_read' as unknown as ToolPurpose),
    ).rejects.toThrow('not a tool purpose');
    expect(fake.rpcs).toEqual([]);
    expect(fake.froms).toEqual([]);
  });

  it('refuses anything that was not minted from the session, before any read or guard call', async () => {
    const fake = fakeDb({ guard: [null], source: SOURCE, links: ['item-1'] });
    const forgeries: Array<[string, unknown]> = [
      ['a JSON-parsed object of the same shape', JSON.parse(JSON.stringify(ACTING))],
      ['a spread copy', { ...ACTING }],
      ['a rebuilt literal', { userId: USER, tenantId: TENANT }],
      ['a structured clone', structuredClone(ACTING)],
    ];
    for (const [label, forged] of forgeries) {
      await expect(
        readMailboxItemsForTool(fake.db, { ...request(), onBehalfOf: forged as ActingUser }, 'search'),
        label,
      ).rejects.toThrow('acts for');
    }
    expect(guardCalls()).toEqual([]);
    expect(fake.rpcs).toEqual([]);
    expect(fake.froms).toEqual([]);
  });

  it('throws before any read when no acting user is given', async () => {
    const fake = fakeDb({ guard: [null] });
    await expect(
      readMailboxItemsForTool(fake.db, { ...request(), onBehalfOf: undefined as unknown as ActingUser }, 'search'),
    ).rejects.toThrow('acts for');
    expect(fake.rpcs).toEqual([]);
    expect(fake.froms).toEqual([]);
  });

  it('keeps only the items the acting user may see, and selects metadata only', async () => {
    const fake = fakeDb({
      guard: [null],
      source: SOURCE,
      links: ['item-1', 'item-2'],
      visible: ['item-2'],
      items: [{ id: 'item-2', subject: 'Project Atlas', sent_at: '2026-09-01T10:00:00Z' }],
    });
    const items = await readMailboxItemsForTool(fake.db, request(), 'retrieval');
    expect(items).toEqual([{ id: 'item-2', subject: 'Project Atlas', sentAt: '2026-09-01T10:00:00Z' }]);
    const visibility = fake.rpcs.find((r) => r.name === 'mailbox_items_visible_to');
    expect(visibility?.args).toEqual({ p_user: USER, p_items: ['item-1', 'item-2'] });
    expect(fake.selects.find((s) => s.table === TABLE.SOURCE_ITEMS)?.columns).toBe('id, subject, sent_at');
    expect(fake.froms).not.toContain(TABLE.SOURCE_ITEM_TEXTS);
  });

  it('returns [] without selecting items when the visible set is empty', async () => {
    const fake = fakeDb({ guard: [null], source: SOURCE, links: ['item-1'], visible: [] });
    await expect(readMailboxItemsForTool(fake.db, request(), 'search')).resolves.toEqual([]);
    expect(fake.froms).not.toContain(TABLE.SOURCE_ITEMS);
  });

  it('is typed so a plain string is not an ActingUser, and refused at run time as well', async () => {
    const fake = fakeDb({ guard: [null] });
    // The compile-time half: tsc fails this line if a string ever type-checks as an ActingUser.
    // @ts-expect-error a tool argument or request body value cannot stand in for the acting user
    const attempt = readMailboxItemsForTool(fake.db, { ...request(), onBehalfOf: 'someone-else' }, 'search');
    // The run-time half: a cast does not get past the mint check, and nothing is read or asked.
    await expect(attempt).rejects.toThrow('acts for');
    expect(fake.rpcs).toEqual([]);
    expect(fake.froms).toEqual([]);
  });
});

// A team inbox (#581) belongs to the firm: its source has no owner. A tool reads it for a person, so the
// acting user (from the verified session, never from the caller) is the owner the guard is asked about, and
// the guard answers for a reader (null) or a non-reader (owner_mismatch). The membership test itself is SQL's
// (supabase/tests/team_mailboxes.sql, section 14); these pin what the accessor sends and what it does next.
describe('readMailboxItemsForTool on a team source', () => {
  const TEAM = '55555555-5555-4555-8555-555555555555';
  const TEAM_SOURCE = { id: 'team-source-1', owner_user_id: null, provider: MAILBOX_PROVIDER.GOOGLE, team_mailbox_id: TEAM };

  it.each(PURPOSES)('names the acting user as the guard owner, as %s, since the source has none', async (purpose) => {
    const fake = fakeDb({ guard: [null], source: TEAM_SOURCE, links: [] });
    await readMailboxItemsForTool(fake.db, request('deals@bank.example'), purpose);
    const calls = guardCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toMatchObject({
      p_purpose: purpose,
      p_check_owner: true,
      p_owner_user_id: USER,
      p_provider: 'google',
      p_address: 'deals@bank.example',
    });
  });

  it('never sends a null owner for a team source, which the guard admits to the worker alone', async () => {
    const fake = fakeDb({ guard: [null], source: TEAM_SOURCE, links: [] });
    await readMailboxItemsForTool(fake.db, request('deals@bank.example'), 'search');
    expect(guardCalls().every((call) => call.args.p_owner_user_id !== null)).toBe(true);
  });

  it('takes the acting user from the session: another session names another owner', async () => {
    const other = '66666666-6666-4666-8666-666666666666';
    const acting = await mint(other, TENANT);
    const fake = fakeDb({ guard: [null], source: TEAM_SOURCE, links: [] });
    await readMailboxItemsForTool(
      fake.db,
      { address: 'deals@bank.example', caller: 'agent-tool:test', onBehalfOf: acting },
      'retrieval',
    );
    expect(guardCalls()[0].args).toMatchObject({ p_owner_user_id: other });
  });

  it('reads a reader\'s items: the guard allows, then only what the user may see is kept', async () => {
    const fake = fakeDb({
      guard: [null],
      source: TEAM_SOURCE,
      links: ['item-1', 'item-2'],
      visible: ['item-1'],
      items: [{ id: 'item-1', subject: 'Project Heron', sent_at: '2026-09-01T10:00:00Z' }],
    });
    const items = await readMailboxItemsForTool(fake.db, request('deals@bank.example'), 'agent_tool');
    expect(items).toEqual([{ id: 'item-1', subject: 'Project Heron', sentAt: '2026-09-01T10:00:00Z' }]);
    expect(fake.rpcs.find((r) => r.name === 'mailbox_items_visible_to')?.args).toEqual({
      p_user: USER,
      p_items: ['item-1', 'item-2'],
    });
  });

  it.each(PURPOSES)('refuses a non-reader at the guard and reads no provenance, item or text, as %s', async (purpose) => {
    const fake = fakeDb({ guard: [MAILBOX_REFUSAL_REASON.OWNER_MISMATCH], source: TEAM_SOURCE, links: ['item-1'], visible: ['item-1'] });
    const error = await readMailboxItemsForTool(fake.db, request('deals@bank.example'), purpose).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailboxAccessRefusedError);
    expect(error).toMatchObject({ reason: MAILBOX_REFUSAL_REASON.OWNER_MISMATCH, purpose });
    expect(fake.froms).toEqual([TABLE.CONTENT_SOURCES]);
    expect(fake.rpcs).toEqual([]);
  });

  it('refuses a stale or paused team inbox the same way, with nothing read', async () => {
    for (const reason of [MAILBOX_REFUSAL_REASON.TEAM_MAILBOX_UNVERIFIED, MAILBOX_REFUSAL_REASON.SOURCE_PAUSED]) {
      const fake = fakeDb({ guard: [reason], source: TEAM_SOURCE, links: ['item-1'] });
      await expect(readMailboxItemsForTool(fake.db, request('deals@bank.example'), 'search')).rejects.toMatchObject({ reason });
      expect(fake.froms).toEqual([TABLE.CONTENT_SOURCES]);
    }
  });

  it('keeps binding a personal source to its own owner, a team column or not', async () => {
    const withNull = fakeDb({ guard: [null], source: { ...SOURCE, team_mailbox_id: null }, links: [] });
    await readMailboxItemsForTool(withNull.db, request(), 'search');
    expect(guardCalls()[0].args).toMatchObject({ p_owner_user_id: OWNER });
    admin.rpc.mockReset();
    const without = fakeDb({ guard: [null], source: SOURCE, links: [] });
    await readMailboxItemsForTool(without.db, request(), 'search');
    expect(guardCalls()[0].args).toMatchObject({ p_owner_user_id: OWNER });
  });
});
