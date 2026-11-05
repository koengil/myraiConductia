import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/api/v1/httpScoped', () => ({ requireApiUserScoped: vi.fn() }));

import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { assertActingUser, currentActingUser } from '@/lib/mailboxAccess/principal';

const scoped = vi.mocked(requireApiUserScoped);

const USER = '33333333-3333-4333-8333-333333333333';
const TENANT = '11111111-1111-4111-8111-111111111111';

/** A session client whose `users` read answers `row`, recording the filter. */
function session(row: { tenant_id: string | null } | null, error: { message: string } | null = null) {
  const eq = vi.fn();
  const builder = {
    select: vi.fn(() => builder),
    eq: (column: string, value: string) => {
      eq(column, value);
      return builder;
    },
    maybeSingle: async () => ({ data: row, error }),
  };
  const from = vi.fn(() => builder);
  scoped.mockResolvedValue({ ok: true, user: { id: USER, email: 'a@bank.example', companyId: null }, db: { from } as never });
  return { from, eq };
}

beforeEach(() => vi.clearAllMocks());

describe('currentActingUser', () => {
  it('carries the verified user id and the tenant of that user row', async () => {
    const { from, eq } = session({ tenant_id: TENANT });
    const acting = await currentActingUser();
    expect(acting).toMatchObject({ userId: USER, tenantId: TENANT });
    expect(from).toHaveBeenCalledWith('users');
    expect(eq).toHaveBeenCalledWith('id', USER);
  });

  it('is null when nobody is signed in', async () => {
    scoped.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) });
    await expect(currentActingUser()).resolves.toBeNull();
  });

  it('is null when the user has no tenant, or the row cannot be read (fail closed)', async () => {
    session({ tenant_id: null });
    await expect(currentActingUser()).resolves.toBeNull();
    session(null);
    await expect(currentActingUser()).resolves.toBeNull();
    session(null, { message: 'boom' });
    await expect(currentActingUser()).resolves.toBeNull();
  });

  it('cannot be altered after it is minted', async () => {
    session({ tenant_id: TENANT });
    const acting = await currentActingUser();
    expect(Object.isFrozen(acting)).toBe(true);
  });
});

describe('the runtime mint (round 2, item 5)', () => {
  it('accepts a user minted by currentActingUser', async () => {
    session({ tenant_id: TENANT });
    const acting = await currentActingUser();
    expect(assertActingUser(acting)).toBe(acting);
  });

  it('refuses a parsed JSON object of the same shape', async () => {
    session({ tenant_id: TENANT });
    const acting = await currentActingUser();
    const parsed = JSON.parse(JSON.stringify(acting));
    expect(parsed).toEqual({ userId: USER, tenantId: TENANT });
    expect(() => assertActingUser(parsed)).toThrow(/acts for/);
  });

  it('refuses a spread copy, a rebuilt literal, and a clone', async () => {
    session({ tenant_id: TENANT });
    const acting = await currentActingUser();
    expect(() => assertActingUser({ ...acting })).toThrow(/acts for/);
    expect(() => assertActingUser({ userId: USER, tenantId: TENANT })).toThrow(/acts for/);
    expect(() => assertActingUser(structuredClone(acting))).toThrow(/acts for/);
    expect(() => assertActingUser(Object.create(acting as object))).toThrow(/acts for/);
  });

  it('refuses null, undefined and primitives', () => {
    for (const value of [null, undefined, 'someone-else', 7, true]) {
      expect(() => assertActingUser(value)).toThrow(/acts for/);
    }
  });

  it('mints a fresh object per call, and does not mint on a failed lookup', async () => {
    session({ tenant_id: TENANT });
    const first = await currentActingUser();
    const second = await currentActingUser();
    expect(first).not.toBe(second);
    session(null);
    expect(await currentActingUser()).toBeNull();
  });
});
