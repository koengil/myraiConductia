import type { SupabaseClient } from '@supabase/supabase-js';
import { userCanAccessDeal } from '@/lib/api/v1/access';
import { DEAL_CODE_SHAPE, isUuid } from '@/lib/api/v1/http';
import { dbFailure } from '@/lib/errors/upstream';

/**
 * What a lenient deal ref means for the caller:
 *
 *   deal    a real deal the caller can see; tag and filter by `id`.
 *   hidden  a deal-shaped ref (a UUID or PREFIX-YYYY-NNN code) that matches
 *           nothing or names a deal the caller cannot see.
 *   slug    no ref, or a ref that is not deal-shaped and matches nothing or
 *           names a deal the caller cannot see (a sandbox fixture slug such as
 *           `project-summit`, or a real deal with an unusual code): untagged
 *           mail.
 *
 * A deal the caller cannot see answers exactly like a miss of the same shape,
 * so mail never tells the two apart, whatever the code looks like (D65, #245).
 */
export type LenientDealRef = { kind: 'deal'; id: string } | { kind: 'hidden' } | { kind: 'slug' };

/**
 * Resolve a client-side deal reference for the mail surfaces, LENIENTLY:
 * distinct from the strict `resolveDealRef` in http.ts (exact-case code,
 * null on unknown), hence the explicit name.
 *
 * The mail surfaces pass the project URL segment, which is a deal CODE for
 * real deals or a fixture slug for sandbox projects, and a sandbox project
 * must never break mail. Every ref is looked up, whatever its shape: a UUID by
 * id, anything else by its canonical uppercase code. So a real deal is always
 * found, even one whose code has an unusual shape. The shape only decides
 * what a MISS, or a deal the caller cannot see, means: deal-shaped is
 * `hidden`, anything else is `slug`.
 *
 * A lookup ERROR throws: silently reading it as a slug would widen the read
 * scope (no filter) on a transient DB failure, and scope must fail loud,
 * never open.
 */
export async function resolveDealRefLenient(
  admin: SupabaseClient,
  userId: string,
  ref: unknown,
): Promise<LenientDealRef> {
  const dealRef = typeof ref === 'string' && ref ? ref : null;
  if (!dealRef) return { kind: 'slug' };
  const uuid = isUuid(dealRef);
  const base = admin.from('deals').select('id');
  const { data, error } = await (uuid
    ? base.eq('id', dealRef)
    : base.eq('code', dealRef.toUpperCase())
  ).maybeSingle();
  if (error) throw dbFailure('Deal lookup', error);
  const id = (data as { id: string } | null)?.id ?? null;
  if (id && (await userCanAccessDeal(admin, userId, id))) return { kind: 'deal', id };
  return uuid || DEAL_CODE_SHAPE.test(dealRef) ? { kind: 'hidden' } : { kind: 'slug' };
}
