import type { CompanyMemberAccess } from '@/components/company/companyAccessUi';
import type { CompanyPermission } from '@/lib/constants/companyPermissions';

/**
 * "Set access" for several people at once. There is no bulk endpoint, and
 * this adds none: it calls the existing single-person
 * PATCH /api/v1/companies/{id}/members/{userId}/access once per person, each
 * with that person's own expectedVersion, and reports every person's result.
 * The server decides every write exactly as it does for one person.
 */

export type BulkAccessTarget = {
  userId: string;
  name: string;
  /** The access version the viewer last saw; the write is refused if it moved. */
  version: number;
};

export type BulkAccessChoice = {
  roleIds: string[];
  directPermissions: CompanyPermission[];
};

export type BulkAccessResult =
  | { userId: string; name: string; status: 'updated'; access: CompanyMemberAccess }
  /** Someone changed this person's access first. `access` is the reloaded copy. */
  | { userId: string; name: string; status: 'stale'; access: CompanyMemberAccess }
  /**
   * Someone changed this person's access first, and the reload failed: there is
   * no newer version to write against, so this row is not retried until Set
   * access is reopened.
   */
  | { userId: string; name: string; status: 'stale_unread' }
  | { userId: string; name: string; status: 'failed'; message: string };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** At most this many requests in flight, so a few hundred people do not flood the server. */
export const ACCESS_CONCURRENCY = 4;

/**
 * Run `fn` over `items` with at most ACCESS_CONCURRENCY in flight; results in
 * input order. Shared by the bulk write and the roster's per-person access reads.
 */
export async function mapWithAccessLimit<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(ACCESS_CONCURRENCY, items.length) }, worker));
  return results;
}

/**
 * Plain copy for a failed one-person access write, by status, never the
 * server's own text. A 409 that is not "Protected" is a stale version, which
 * the caller reloads instead.
 */
export function accessWriteFailureCopy(status: number, error: string | undefined): string | null {
  if (status === 409 && error?.startsWith('Protected')) return BULK_ACCESS_COPY.protected;
  if (status === 403) return BULK_ACCESS_COPY.forbidden;
  if (status === 404) return BULK_ACCESS_COPY.gone;
  return null;
}

export const BULK_ACCESS_COPY = {
  stale: 'Someone else changed their access while you worked. Their latest access is loaded.',
  staleUnread:
    'Changed by someone else. Their latest access could not be loaded. Close and reopen Set access.',
  unread: 'Their current access could not be read.',
  protected: 'Directors and firm administrators have every permission. Their access is fixed.',
  forbidden: 'Not changed. This includes a permission you cannot give.',
  gone: 'Not changed. They are no longer in this organization.',
  network: 'Not changed. Check your connection and try again.',
  other: 'Not changed.',
} as const;

function accessUrl(companyId: string, userId: string) {
  return `/api/v1/companies/${companyId}/members/${userId}/access`;
}

async function readJson(response: Response): Promise<{ access?: CompanyMemberAccess; error?: string } | null> {
  return (await response.json().catch(() => null)) as { access?: CompanyMemberAccess; error?: string } | null;
}

async function reload(companyId: string, userId: string, fetchImpl: FetchLike) {
  try {
    const response = await fetchImpl(accessUrl(companyId, userId));
    if (!response.ok) return null;
    return (await readJson(response))?.access ?? null;
  } catch {
    return null;
  }
}

async function setOne(
  companyId: string,
  target: BulkAccessTarget,
  choice: BulkAccessChoice,
  fetchImpl: FetchLike,
): Promise<BulkAccessResult> {
  const { userId, name } = target;
  let response: Response;
  try {
    response = await fetchImpl(accessUrl(companyId, userId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedVersion: target.version,
        roleIds: choice.roleIds,
        directPermissions: choice.directPermissions,
      }),
    });
  } catch {
    return { userId, name, status: 'failed', message: BULK_ACCESS_COPY.network };
  }
  const body = await readJson(response);
  if (response.ok && body?.access) return { userId, name, status: 'updated', access: body.access };
  if (response.status === 409) {
    // The route answers 409 for two things: a stale version, and a protected
    // director or firm administrator. Only the first is worth a reload.
    if (body?.error?.startsWith('Protected')) {
      return { userId, name, status: 'failed', message: BULK_ACCESS_COPY.protected };
    }
    const latest = await reload(companyId, userId, fetchImpl);
    return latest
      ? { userId, name, status: 'stale', access: latest }
      : { userId, name, status: 'stale_unread' };
  }
  if (response.status === 403) return { userId, name, status: 'failed', message: BULK_ACCESS_COPY.forbidden };
  if (response.status === 404) return { userId, name, status: 'failed', message: BULK_ACCESS_COPY.gone };
  return { userId, name, status: 'failed', message: BULK_ACCESS_COPY.other };
}

/**
 * Writes `choice` for every target and resolves with one result per target,
 * in input order. Never rejects: a failure for one person is that person's
 * result, and the others still run.
 */
export async function setAccessForMembers(
  companyId: string,
  targets: readonly BulkAccessTarget[],
  choice: BulkAccessChoice,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<BulkAccessResult[]> {
  return mapWithAccessLimit(targets, (target) => setOne(companyId, target, choice, fetchImpl));
}

/** "Access set for 3 of 4 people." */
export function bulkSummary(results: readonly BulkAccessResult[]): string {
  const updated = results.filter((result) => result.status === 'updated').length;
  const total = results.length;
  if (updated === total) {
    return total === 1 ? 'Access set for 1 person.' : `Access set for all ${total} people.`;
  }
  return `Access set for ${updated} of ${total} ${total === 1 ? 'person' : 'people'}.`;
}
