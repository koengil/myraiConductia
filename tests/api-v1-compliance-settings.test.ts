import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requireApiUser, firmMailAccess } = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  firmMailAccess: vi.fn(),
}));
vi.mock('@/lib/api/v1/http', async (original) => ({
  ...(await original<typeof import('@/lib/api/v1/http')>()),
  requireApiUser,
}));
vi.mock('@/lib/api/v1/access', () => ({ firmMailAccess }));

import { GET, PUT } from '@/app/api/v1/compliance-settings/route';

/*
 * /api/v1/compliance-settings (Issue #94, Issue #95; D105): the firm's risk
 * thresholds and send friction. Read by its CCO or admin, changed by its CCO
 * only. The save and its audit row are one transaction in
 * firm_compliance_settings_save(); the firm's other CCOs and admins are notified.
 */

type Call = { table: string; op: string; args: unknown[] };
const stored = { queued_from: 85, sampled_from: 50, unchecked_floor: 'sampled', send_friction: 'confirm_external', updated_at: '2026-10-20T12:00:00Z' };
const previous = { queuedFrom: 85, sampledFrom: 50, uncheckedFloor: 'sampled', sendFriction: 'confirm_external' };

function signedIn(
  firmRole: string | null,
  opts: {
    row?: Record<string, unknown> | null;
    reach?: boolean;
    rpc?: { data: unknown; error: { message: string } | null };
    ccos?: Array<{ id: string }>;
  } = {},
) {
  const calls: Call[] = [];
  const client = {
    rpc: (fn: string, args: unknown) => {
      calls.push({ table: fn, op: 'rpc', args: [args] });
      return Promise.resolve(opts.rpc ?? { data: previous, error: null });
    },
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const op of ['select', 'eq', 'in', 'upsert', 'insert']) {
        builder[op] = (...args: unknown[]) => {
          calls.push({ table, op, args });
          return builder;
        };
      }
      builder.maybeSingle = () =>
        Promise.resolve({ data: table === 'users' ? { display_name: 'Dana CCO' } : (opts.row ?? null), error: null });
      builder.then = (f: (v: unknown) => unknown) =>
        Promise.resolve({ data: table === 'users' ? (opts.ccos ?? []) : null, error: null }).then(f);
      return builder;
    },
  };
  requireApiUser.mockResolvedValue({ ok: true, user: { id: 'u-1', email: 'x@bank.test' }, admin: client });
  const reach = opts.reach ?? true;
  firmMailAccess.mockResolvedValue({ ok: reach, tenantId: reach ? 'tenant-1' : null, firmRole });
  return calls;
}

const put = (body: unknown) =>
  PUT(new Request('http://x/api/v1/compliance-settings', { method: 'PUT', body: JSON.stringify(body) }));
const valid = { queuedFrom: 90, sampledFrom: 60, uncheckedFloor: 'queued', sendFriction: 'one_click' };
const saves = (calls: Call[]) => calls.filter((c) => c.op === 'rpc' || c.op === 'upsert');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/compliance-settings', () => {
  it('answers the shipped defaults when the firm never saved any', async () => {
    signedIn('cco');
    expect(await (await GET()).json()).toEqual({
      settings: { queuedFrom: 70, sampledFrom: 40, uncheckedFloor: 'routine', sendFriction: 'one_click' },
      isDefault: true,
      updatedAt: null,
      canEdit: true,
    });
  });

  it("answers the firm's own settings, read-only for an admin", async () => {
    signedIn('admin', { row: stored });
    expect(await (await GET()).json()).toEqual({
      settings: { queuedFrom: 85, sampledFrom: 50, uncheckedFloor: 'sampled', sendFriction: 'confirm_external' },
      isDefault: false,
      updatedAt: '2026-10-20T12:00:00Z',
      canEdit: false,
    });
  });

  it('refuses a banker, and a walled or external CCO', async () => {
    signedIn(null);
    expect((await GET()).status).toBe(403);
    signedIn('cco', { reach: false });
    expect((await GET()).status).toBe(403);
  });
});

describe('PUT /api/v1/compliance-settings', () => {
  it('saves and audits in one call to firm_compliance_settings_save', async () => {
    const calls = signedIn('cco', { row: stored });
    const res = await put(valid);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settings: valid, isDefault: false, canEdit: true });
    expect(saves(calls)).toEqual([
      {
        table: 'firm_compliance_settings_save',
        op: 'rpc',
        args: [{
          p_tenant: 'tenant-1', p_actor: 'u-1', p_queued_from: 90, p_sampled_from: 60,
          p_unchecked_floor: 'queued', p_send_friction: 'one_click',
        }],
      },
    ]);
    // The audit row is the function's: the route writes none of its own.
    expect(calls.some((c) => c.table === 'audit_log')).toBe(false);
  });

  it('answers 500 when the save rolled back, and notifies no one', async () => {
    const calls = signedIn('cco', { rpc: { data: null, error: { message: 'audit write failed' } }, ccos: [{ id: 'cco-2' }] });
    expect((await put(valid)).status).toBe(500);
    expect(calls.some((c) => c.table === 'notifications')).toBe(false);
  });

  it("notifies the firm's other CCOs and admins with the before and after values", async () => {
    const calls = signedIn('cco', { ccos: [{ id: 'u-1' }, { id: 'cco-2' }] });
    expect((await put(valid)).status).toBe(200);
    const roles = calls.find((c) => c.table === 'users' && c.op === 'in' && c.args[0] === 'firm_role');
    expect(roles?.args).toEqual(['firm_role', ['cco', 'admin']]);
    const insert = calls.find((c) => c.table === 'notifications' && c.op === 'insert');
    expect(insert?.args[0]).toEqual([
      {
        tenant_id: 'tenant-1',
        deal_id: null,
        recipient_id: 'cco-2',
        event_type: 'compliance_settings_changed',
        payload: { destinationLabel: "Dana CCO changed the firm's compliance settings", from: previous, to: valid },
      },
    ]);
  });

  it.each([
    [{ ...valid, queuedFrom: 0 }],
    [{ ...valid, queuedFrom: 91 }],
    [{ ...valid, queuedFrom: 100, sampledFrom: 100 }],
    [{ ...valid, sampledFrom: 81 }],
    [{ ...valid, sampledFrom: 55.5 }],
    [{ ...valid, queuedFrom: 60, sampledFrom: 70 }],
    [{ ...valid, uncheckedFloor: 'severe' }],
    [{ ...valid, sendFriction: 'human_approval' }],
    [{ queuedFrom: 90 }],
    [null],
  ])('refuses %j', async (body) => {
    const calls = signedIn('cco');
    expect((await put(body)).status).toBe(400);
    expect(saves(calls)).toEqual([]);
  });

  it('accepts the ceilings themselves: Queued from 90, Sampled from 80', async () => {
    signedIn('cco');
    expect((await put({ ...valid, queuedFrom: 90, sampledFrom: 80 })).status).toBe(200);
  });

  it('refuses an admin: only the CCO may change the bar', async () => {
    const calls = signedIn('admin', { row: stored });
    expect((await put(valid)).status).toBe(403);
    expect(saves(calls)).toEqual([]);
  });

  it('refuses a banker', async () => {
    const calls = signedIn(null);
    expect((await put(valid)).status).toBe(403);
    expect(saves(calls)).toEqual([]);
  });
});
