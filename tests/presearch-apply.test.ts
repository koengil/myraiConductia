import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/v1/crmPeople', () => ({ upsertCrmPerson: vi.fn(async () => 'person-1') }));

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  applyPresearchToLead,
  extractPeopleFromMemo,
  MAX_APPLY_ATTEMPTS,
  PresearchApplyExhausted,
  PresearchApplyPending,
} from '@/lib/ignatious/applyPresearch';

describe('extractPeopleFromMemo', () => {
  it('pulls attendee names from the presearch profile form', () => {
    const memo = `
### Who is in the room

**Nathan Ellery** — CEO, Halyard Commerce
**Elliot Sandoval**, Partner at Brookmere

### Company context
The company sells OMS software.
`;
    expect(extractPeopleFromMemo(memo)).toEqual([
      { name: 'Nathan Ellery', title: 'CEO, Halyard Commerce' },
      { name: 'Elliot Sandoval', title: 'Partner at Brookmere' },
    ]);
  });

  it('skips section headings that look like titles', () => {
    const memo = [
      '## One-Page Brief',
      '## Framing: What Kind of Meeting Is This',
      '## Who Is in the Room, and Who Actually Decides',
      '## Value-Maximization Frame and Optionality Map',
      '## Call Execution Plan (IG-12)',
      '## Verify Before We Walk In',
      '### Our Connections to Founders and Investors (three sources checked)',
      '### Company context',
      '',
      'No people here.',
    ].join('\n');
    expect(extractPeopleFromMemo(memo)).toEqual([]);
  });

  it('keeps named people from a Figma-style room section and drops funds', () => {
    const memo = `
## Who Is in the Room, and Who Actually Decides

**Real decision-maker: Dylan Field**, sole and total.

**Not in the room, but relevant:**
- **John Lilly (Lead Independent Director, General Partner at Greylock, a Figma investor since 2014).**
- **Danny Rimer (Index Ventures) and Andrew Reed (Sequoia)**, both board members.
- **Findell Capital Management**, the activist fund pressing for cost discipline.
- **Bill McDermott (ServiceNow Chair/CEO, Figma board member since July 2025).**
- **Mike Krieger**, former Figma board member, resigned April 14, 2026.

### Dylan Field, Co-Founder, Chair, CEO and President, Figma
`;
    expect(extractPeopleFromMemo(memo).map((person) => person.name).sort()).toEqual([
      'Andrew Reed',
      'Bill McDermott',
      'Danny Rimer',
      'Dylan Field',
      'John Lilly',
      'Mike Krieger',
    ]);
  });
});

type Resp = { data: unknown; error: { code?: string; message: string } | null; count?: number };

/** Responses queued per `table.op`; each call to that table and op takes the next. */
const updates: unknown[] = [];
beforeEach(() => {
  updates.length = 0;
});

function stubAdmin(queued: Record<string, Resp[]>) {
  const writes: string[] = [];
  const filters: string[] = [];
  const from = (table: string) => {
    let op = 'select';
    const builder: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'is']) {
      builder[k] = (...args: unknown[]) => {
        if (k !== 'select') filters.push(`${table}.${op}.${k}(${args.map(String).join(',')})`);
        return builder;
      };
    }
    for (const k of ['insert', 'update']) {
      builder[k] = (values: unknown) => {
        op = k;
        writes.push(`${table}.${k}`);
        if (k === 'update') {
          filters.push(`${table}.update ${JSON.stringify(Object.keys(values as object))}`);
          updates.push(values);
        }
        return builder;
      };
    }
    const resp = (): Resp => queued[`${table}.${op}`]?.shift() ?? { data: [], error: null };
    builder.single = () => Promise.resolve(resp());
    builder.then = (f: (v: Resp) => unknown) => Promise.resolve(resp()).then(f);
    return builder;
  };
  return { admin: { from } as unknown as SupabaseClient, writes, filters };
}

const taken = { data: null, error: { code: '23505', message: 'duplicate' } };
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const claimedAt = '2026-09-29T10:00:00.000Z';
const owned = { data: [{ id: 'r1' }], error: null };
const counted = (count: number) => ({ data: null, error: null, count });

const opts = (admin: SupabaseClient, memo = '**Nathan Ellery** — CEO, Halyard Commerce') => ({
  admin,
  companyId: 'c1',
  tenantId: 't1',
  registeredByCompanyId: null,
  actorId: 'u1',
  executionId: 'exec-1',
  memo,
});

describe('applyPresearchToLead (#249)', () => {
  it('records artifact loading failures against the owned claim', async () => {
    const { admin, writes } = stubAdmin({
      'lead_research.insert': [{ data: { id: 'r1', claimed_at: claimedAt }, error: null }],
      'lead_research.update': [owned],
    });
    await expect(applyPresearchToLead({ ...opts(admin), memo: async () => { throw new Error('Artifact missing'); } }))
      .rejects.toThrow('Artifact missing');
    expect(writes).toEqual(['lead_research.insert', 'lead_research.update']);
    expect(updates).toContainEqual(expect.objectContaining({ attempts: 1, last_error: 'Artifact missing' }));
  });

  it('stops after the last empty artifact attempt', async () => {
    const { admin } = stubAdmin({
      'lead_research.insert': [taken],
      'lead_research.select': [{ data: { id: 'r1', claimed_at: ago(600_000), completed_at: null, attempts: MAX_APPLY_ATTEMPTS - 1 }, error: null }],
      'lead_research.update': [{ data: [{ id: 'r1', claimed_at: claimedAt }], error: null }, owned],
    });
    await expect(applyPresearchToLead({ ...opts(admin), memo: async () => '   ' })).rejects.toBeInstanceOf(PresearchApplyExhausted);
    expect(updates).toContainEqual(expect.objectContaining({ attempts: MAX_APPLY_ATTEMPTS, last_error: 'presearch memo is empty' }));
  });

  it('claims the execution first, then adds people and marks it complete', async () => {
    const memo = '**Nathan Ellery** — CEO';
    const { admin, writes, filters } = stubAdmin({
      'lead_research.insert': [{ data: { id: 'r1', claimed_at: claimedAt }, error: null }],
      'lead_stakeholders.select': [{ data: [], error: null }, counted(1)],
      'lead_research.update': [owned],
    });
    const loadMemo = vi.fn(async () => {
      expect(writes).toEqual(['lead_research.insert']);
      return memo;
    });
    await expect(applyPresearchToLead({ ...opts(admin), memo: loadMemo })).resolves.toEqual({
      peopleAdded: 1,
      alreadyApplied: false,
    });
    expect(writes).toEqual(['lead_research.insert', 'lead_stakeholders.insert', 'lead_research.update']);
    expect(updates).toContainEqual(expect.objectContaining({ memo_md: memo, people_added: 1 }));
    // Completion is conditional on the claim this apply holds.
    expect(filters).toEqual(
      expect.arrayContaining([
        'lead_research.update ["memo_md","people_added","completed_at"]',
        `lead_research.update.eq(claimed_at,${claimedAt})`,
        'lead_research.update.is(completed_at,null)',
      ]),
    );
  });

  it('adds nobody when the execution was already applied', async () => {
    const { admin, writes } = stubAdmin({
      'lead_research.insert': [taken],
      'lead_research.select': [
        { data: { id: 'r1', claimed_at: ago(0), completed_at: ago(0) }, error: null },
      ],
    });
    await expect(applyPresearchToLead(opts(admin))).resolves.toEqual({
      peopleAdded: 0,
      alreadyApplied: true,
    });
    expect(writes).toEqual(['lead_research.insert']);
  });

  it('throws, so the next poll retries, while another apply holds a live claim', async () => {
    const { admin, writes } = stubAdmin({
      'lead_research.insert': [taken],
      'lead_research.select': [{ data: { id: 'r1', claimed_at: ago(1000), completed_at: null }, error: null }],
    });
    await expect(applyPresearchToLead(opts(admin))).rejects.toBeInstanceOf(PresearchApplyPending);
    expect(writes).toEqual(['lead_research.insert']);
  });

  it('finishes a stale claim with its own claim token and counts every person the execution added', async () => {
    const takeover = '2026-09-29T11:00:00.000Z';
    const { admin, writes, filters } = stubAdmin({
      'lead_research.insert': [taken],
      'lead_research.select': [
        { data: { id: 'r1', claimed_at: ago(10 * 60_000), completed_at: null }, error: null },
      ],
      'lead_research.update': [{ data: [{ id: 'r1', claimed_at: takeover }], error: null }, owned],
      // The dead run already added Nathan Ellery; this run adds nobody new.
      'lead_stakeholders.select': [{ data: [{ name: 'Nathan Ellery' }], error: null }, counted(1)],
    });
    await expect(applyPresearchToLead(opts(admin))).resolves.toEqual({
      peopleAdded: 1,
      alreadyApplied: false,
    });
    expect(writes).toEqual(['lead_research.insert', 'lead_research.update', 'lead_research.update']);
    expect(filters).toContain(`lead_research.update.eq(claimed_at,${takeover})`);
  });

  it('counts nobody twice when a slow first owner already inserted the person', async () => {
    const { admin } = stubAdmin({
      'lead_research.insert': [taken],
      'lead_research.select': [
        { data: { id: 'r1', claimed_at: ago(10 * 60_000), completed_at: null }, error: null },
      ],
      'lead_research.update': [{ data: [{ id: 'r1', claimed_at: claimedAt }], error: null }, owned],
      // The known-names read ran before the first owner's insert landed.
      'lead_stakeholders.select': [{ data: [], error: null }, counted(1)],
      'lead_stakeholders.insert': [taken],
    });
    await expect(applyPresearchToLead(opts(admin))).resolves.toEqual({
      peopleAdded: 1,
      alreadyApplied: false,
    });
  });

  it('saves the memo and other people even when one stakeholder cannot be inserted', async () => {
    const { admin, writes } = stubAdmin({
      'lead_research.insert': [{ data: { id: 'r1', claimed_at: claimedAt }, error: null }],
      'lead_stakeholders.select': [{ data: [], error: null }, counted(1)],
      'lead_stakeholders.insert': [{ data: null, error: { message: 'invalid person' } }, { data: null, error: null }],
      'lead_research.update': [owned],
    });
    const memo = '**Nathan Ellery** — CEO\n**Elliot Sandoval**, Partner';
    await expect(applyPresearchToLead(opts(admin, memo))).resolves.toEqual({ peopleAdded: 1, peopleSkipped: 1, alreadyApplied: false });
    expect(writes.filter((w) => w === 'lead_stakeholders.insert')).toHaveLength(2);
    expect(updates).toEqual([expect.objectContaining({ memo_md: memo, people_added: 1, completed_at: expect.any(String) })]);
  });

  it.each([[0, 30_000], [1, 60_000], [2, 120_000], [3, 240_000]])('backs off after %i previous failures', async (attempts, delay) => {
    const started = Date.now();
    const { admin } = stubAdmin({
      'lead_research.insert': [taken],
      'lead_research.select': [{ data: { id: 'r1', claimed_at: ago(600_000), attempts }, error: null }],
      'lead_research.update': [{ data: [{ id: 'r1', claimed_at: claimedAt }], error: null }, owned],
    });
    await expect(applyPresearchToLead({ ...opts(admin), memo: async () => { throw new Error('artifact outage'); } })).rejects.toThrow('artifact outage');
    const retry = updates.at(-1) as { retry_at: string; attempts: number };
    expect(retry.attempts).toBe(attempts + 1);
    expect(Date.parse(retry.retry_at)).toBeGreaterThanOrEqual(started + delay);
    expect(Date.parse(retry.retry_at)).toBeLessThanOrEqual(Date.now() + delay);
  });

  it('does not load artifacts or spend attempts during persisted backoff, then recovers', async () => {
    vi.useFakeTimers();
    try {
      const retryAt = new Date(Date.now() + 30_000).toISOString();
      const held = { id: 'r1', claimed_at: ago(600_000), attempts: 1, retry_at: retryAt };
      const memo = vi.fn(async () => 'Recovered memo');
      for (let i = 0; i < 10; i++) {
        const { admin, writes } = stubAdmin({ 'lead_research.insert': [taken], 'lead_research.select': [{ data: held, error: null }] });
        await expect(applyPresearchToLead({ ...opts(admin), memo })).rejects.toThrow(/retry scheduled/);
        expect(writes).toEqual(['lead_research.insert']);
        await vi.advanceTimersByTimeAsync(2500);
      }
      expect(memo).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5000);
      const { admin } = stubAdmin({
        'lead_research.insert': [taken], 'lead_research.select': [{ data: held, error: null }],
        'lead_research.update': [{ data: [{ id: 'r1', claimed_at: new Date().toISOString() }], error: null }, owned],
      });
      await expect(applyPresearchToLead({ ...opts(admin), memo })).resolves.toMatchObject({ alreadyApplied: false });
      expect(memo).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('gives up for good when the failed attempt was the last one', async () => {
    const takeover = '2026-09-29T11:00:00.000Z';
    const { admin } = stubAdmin({
      'lead_research.insert': [taken],
      'lead_research.select': [
        {
          data: { id: 'r1', claimed_at: new Date(0).toISOString(), completed_at: null, attempts: MAX_APPLY_ATTEMPTS - 1 },
          error: null,
        },
      ],
      'lead_stakeholders.select': [{ data: null, error: { message: 'down' } }],
      'lead_research.update': [{ data: [{ id: 'r1', claimed_at: takeover }], error: null }, owned],
    });
    await expect(applyPresearchToLead(opts(admin))).rejects.toBeInstanceOf(PresearchApplyExhausted);
    expect(updates).toContainEqual(expect.objectContaining({ attempts: MAX_APPLY_ATTEMPTS }));
  });

  it('does not retry a run whose attempts are spent', async () => {
    const { admin, writes } = stubAdmin({
      'lead_research.insert': [taken],
      'lead_research.select': [
        { data: { id: 'r1', claimed_at: ago(0), completed_at: null, attempts: MAX_APPLY_ATTEMPTS }, error: null },
      ],
    });
    await expect(applyPresearchToLead(opts(admin))).rejects.toBeInstanceOf(PresearchApplyExhausted);
    expect(writes).toEqual(['lead_research.insert']);
  });

  it('scopes the claim read, takeover and completion to the company', async () => {
    const { admin, filters } = stubAdmin({
      'lead_research.insert': [taken],
      'lead_research.select': [
        { data: { id: 'r1', claimed_at: ago(10 * 60_000), completed_at: null }, error: null },
      ],
      'lead_research.update': [{ data: [{ id: 'r1', claimed_at: claimedAt }], error: null }, owned],
      'lead_stakeholders.select': [{ data: [{ name: 'Nathan Ellery' }], error: null }, counted(1)],
    });
    await applyPresearchToLead(opts(admin));
    expect(filters.filter((f) => f === 'lead_research.select.eq(company_id,c1)')).toHaveLength(1);
    expect(filters.filter((f) => f === 'lead_research.update.eq(company_id,c1)')).toHaveLength(2);
  });

  it('does not report success, or release, when another apply now owns the claim', async () => {
    const { admin, writes } = stubAdmin({
      'lead_research.insert': [{ data: { id: 'r1', claimed_at: claimedAt }, error: null }],
      'lead_stakeholders.select': [{ data: [], error: null }, counted(1)],
      'lead_research.update': [{ data: [], error: null }],
    });
    await expect(applyPresearchToLead(opts(admin))).rejects.toBeInstanceOf(PresearchApplyPending);
    expect(writes.filter((w) => w === 'lead_research.update')).toHaveLength(1);
  });

  it('throws, adding nobody, when the claim fails for another reason', async () => {
    const { admin, writes } = stubAdmin({ 'lead_research.insert': [{ data: null, error: { message: 'down' } }] });
    await expect(applyPresearchToLead(opts(admin))).rejects.toThrow(/claim failed/);
    expect(writes).toEqual(['lead_research.insert']);
  });

  it('leaves the claim open when completion cannot be recorded', async () => {
    const { admin } = stubAdmin({
      'lead_research.insert': [{ data: { id: 'r1', claimed_at: claimedAt }, error: null }],
      'lead_stakeholders.select': [{ data: [], error: null }, counted(1)],
      'lead_research.update': [{ data: null, error: { message: 'down' } }, owned],
    });
    await expect(applyPresearchToLead(opts(admin))).rejects.toThrow(/completion not recorded/);
    expect(updates).toContainEqual(expect.objectContaining({ attempts: 1 }));
  });
});
