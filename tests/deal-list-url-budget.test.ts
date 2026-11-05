// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';

import { listDealsForUser, listMemberDealSummaries } from '@/lib/api/v1/access';

/*
 * #160: a deal list must not build a request URL that grows with the caller's
 * seat count. Kong rejects a request line over 8 KiB with 414 "URI too long",
 * which the old member branch (membership ids sent as `.in('id', ids)`) hit at
 * about 207 seats.
 *
 * Both deal lists are covered: listDealsForUser (GET /api/v1/deals) and
 * listMemberDealSummaries (the external-user /projects picker).
 *
 * This drives the real supabase-js query builder, not a mock of its call
 * chain, so it checks the bytes that would go on the wire. The client's fetch
 * is a capture stub that answers by table path and hands back 320 seats to any
 * code that reads them, so an id list built from those seats in any form
 * (`.in()`, `.filter('id', 'in', …)`, `.or('id.in.(…)')`) blows the budget.
 * The join shape itself (the `deal_memberships!inner(user_id)` embed and the
 * `deal_memberships.user_id` filter) is pinned for both functions by
 * tests/api-v1-access.test.ts.
 */

const SEATS = 320;
/** The joined member list is ~587 bytes; 2,000 still fails at about 40 ids. */
const URL_BUDGET = 2_000;

const seatRows = Array.from({ length: SEATS }, (_, i) => ({
  deal_id: `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
}));

function captureClient() {
  const urls: string[] = [];
  const captureFetch: typeof fetch = async (input) => {
    const raw = input instanceof Request ? input.url : String(input);
    urls.push(raw);
    const { pathname } = new URL(raw);
    const body = pathname.endsWith('/users')
      ? { firm_role: null, tenant_id: 't1' } // member branch; read with .single()
      : pathname.endsWith('/deal_memberships')
        ? seatRows // what the pre-#237 code read before building its id list
        : [];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = createClient('http://stub.local', 'k', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: captureFetch },
  });
  return { client, urls };
}

function expectWithinBudget(urls: string[]) {
  // A percent-encoded URL is ASCII, so its length is its byte count.
  for (const url of urls) {
    expect(url.length, `request URL grows with seats: ${url.slice(0, 120)}…`).toBeLessThan(URL_BUDGET);
  }
  // The test must not pass by sending nothing.
  expect(urls.some((url) => new URL(url).pathname.endsWith('/deals'))).toBe(true);
}

describe('deal-list request URLs (#160)', () => {
  it('keeps every deal-list request under the URL budget at 320 seats', async () => {
    const { client, urls } = captureClient();

    await listDealsForUser(client, 'u1');

    expectWithinBudget(urls);
  });

  it('keeps the external picker query under the URL budget at 320 seats', async () => {
    const { client, urls } = captureClient();

    await listMemberDealSummaries(client, 'u1');

    expectWithinBudget(urls);
  });
});
