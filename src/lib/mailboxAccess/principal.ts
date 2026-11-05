// The user a tool acts for (#262, R22), and that user's tenant (audit round 1,
// item 21). The service role can ask the RLS helpers about any user and read
// any tenant, so the accessor must never take a principal or a tenant from a
// tool argument, a request body, or any value a caller hands in. The only
// mint takes no argument: it reads the signed-in session itself, and the
// tenant comes from that user's own row, read under the session's RLS.
// tests/agent-surfaces.test.ts flags any `as ActingUser` or `as ScopedApiUser`
// outside this file.
//
// The brand is a type-level fence, and a cast can walk around it, so the mint is
// also a run-time fact (audit round 2, item 5): every ActingUser is recorded in
// a module-private WeakSet by currentActingUser(), and the accessor calls
// assertActingUser(), which refuses anything not in the set. A JSON-parsed
// object, a spread copy, a structured clone or a hand-built literal of the same
// shape is not in the set. The set is private, so nothing outside this module can
// add to it, and there is no test-only mint: tests obtain theirs the same way
// production does, from a (mocked) session. A minted ActingUser is not tied to a
// request, so principals must not be cached across requests: mint one per request.

import { requireApiUserScoped } from '@/lib/api/v1/httpScoped';
import { TABLE } from '@/lib/constants/tables';

// Filled only by currentActingUser(); never exported.
const minted = new WeakSet<object>();

declare const actingUser: unique symbol;
export type ActingUser = {
  readonly userId: string;
  readonly tenantId: string;
  readonly [actingUser]: true;
};

/**
 * The signed-in caller of this request and their tenant, or null when there is
 * no caller or the caller has no readable tenant (fail closed).
 */
export async function currentActingUser(): Promise<ActingUser | null> {
  const auth = await requireApiUserScoped();
  if (!auth.ok) return null;
  const { data, error } = await auth.db.from(TABLE.USERS).select('tenant_id').eq('id', auth.user.id).maybeSingle();
  const tenantId = (data as { tenant_id: string | null } | null)?.tenant_id;
  if (error || !tenantId) return null;
  const acting = Object.freeze({ userId: auth.user.id, tenantId }) as ActingUser;
  minted.add(acting);
  return acting;
}

/**
 * The value itself when currentActingUser() minted it, else a throw. An accessor
 * calls this before it reads anything, and takes the user and tenant from the
 * returned value only.
 */
export function assertActingUser(value: unknown): ActingUser {
  if (typeof value !== 'object' || value === null || !minted.has(value)) {
    throw new Error('a mailbox tool read needs the user it acts for, minted from the verified session');
  }
  return value as ActingUser;
}
