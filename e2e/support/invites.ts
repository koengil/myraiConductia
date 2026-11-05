import { expect, type APIRequestContext } from '@playwright/test';

/** Mirrors serializeInvite in src/app/api/v1/invites/route.ts. */
export type InviteRow = {
  id: string;
  email: string;
  companyId: string;
  companyRole: string;
  dealId: string | null;
  dealRole: string | null;
  status: string;
  deliveryStatus: string;
};

export async function listInvites(
  request: APIRequestContext,
  dealRef: string,
): Promise<InviteRow[]> {
  const url = `/api/v1/invites?dealId=${encodeURIComponent(dealRef)}`;
  const response = await request.get(url);
  expect(response.status(), `GET ${url}`).toBe(200);
  return ((await response.json()) as { invites: InviteRow[] }).invites;
}

/**
 * The durable half of an invite assertion: the row exists on the deal, for
 * that exact address, in the expected state. Addresses carry the run id
 * because invites_pending_email_uniq is a GLOBAL partial unique index on
 * pending email, so a fixed address would collide with anything an earlier run
 * stranded.
 */
export async function expectInvite(
  request: APIRequestContext,
  dealRef: string,
  email: string,
  expected: { status: string; deliveryStatus?: string },
): Promise<InviteRow> {
  const invites = await listInvites(request, dealRef);
  const row = invites.find((invite) => invite.email === email.toLowerCase());
  expect(
    row,
    `no invite for ${email} on ${dealRef}; saw: ${invites
      .map((invite) => `${invite.email}=${invite.status}/${invite.deliveryStatus}`)
      .join(', ')}`,
  ).toBeTruthy();
  expect(row?.status).toBe(expected.status);
  if (expected.deliveryStatus) {
    expect(row?.deliveryStatus).toBe(expected.deliveryStatus);
  }
  return row as InviteRow;
}
