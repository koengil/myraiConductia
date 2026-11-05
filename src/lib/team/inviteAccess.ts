import type { InviteResendResult } from '@/components/wizard/inviteQueue';
import { DEAL_ROLE } from '@/lib/constants/roles';
import { canAddDealMembers, navUserFromProfile } from '@/lib/navigation/navPolicy';

/**
 * Who may open which invite, decided from what the server already answered.
 *
 * Two entries share one invite form (`InviteModal`):
 * - `internal`, "Invite to deal" on Team: colleagues at the viewer's own firm.
 * - `data-room`, "Give data room access" in the Data Room: people at an outside
 *   party (seller or buyer), on the existing external seat.
 *
 * Nothing here grants anything. `POST /api/v1/invites` runs every rule again;
 * these checks only keep a button off screen when the server would refuse it.
 */

export type InviteScope = 'internal' | 'data-room';

/** The viewer fields the invite entries need from GET /api/v1/me. */
export type Viewer = {
  id: string;
  isExternal: boolean;
  firmRole: string | null;
  companyId: string | null;
  companyRole: string | null;
  companyPermissions?: Array<{ permissionKey: string }>;
  /** True when the viewer holds the MD seat on this deal or is a firm admin. */
  isDealMd: boolean;
};

/** The GET /api/v1/me fields read here. */
export type MeBody = {
  user: {
    id: string;
    is_external: boolean;
    firm_role: string | null;
    company_id: string | null;
    company_role: string | null;
  };
  memberships: Array<{ deal_id: string; deal_role: string; deal_code?: string | null }>;
  company_permissions?: Array<{ permissionKey: string }>;
};

export function viewerFromMe(body: MeBody, dealId: string): Viewer {
  const isDealMd =
    body.user.firm_role === 'admin' ||
    body.memberships.some(
      // The route prop may be the deal code (project URLs) or the UUID.
      (m) => (m.deal_id === dealId || m.deal_code === dealId) && m.deal_role === DEAL_ROLE.MD,
    );
  return {
    id: body.user.id,
    isExternal: body.user.is_external,
    firmRole: body.user.firm_role,
    companyId: body.user.company_id,
    companyRole: body.user.company_role,
    companyPermissions: body.company_permissions,
    isDealMd,
  };
}

/**
 * Whether the viewer gets the invite button for `scope`.
 *
 * `inviteListAllowed` is the answer of GET /api/v1/invites?dealId: the list is
 * served only to viewers who may manage deal members, the same check the
 * invite POST runs (#396). `null` means not known yet, or failed for a reason
 * other than 403; the button stays hidden until it is known.
 *
 * - internal: bank users the list was served to; external members with
 *   add-people permission, or external directors growing their own firm.
 * - data-room: bank users the list was served to. Outside parties do not
 *   invite other outside parties.
 */
export function canOpenInvite(
  viewer: Viewer | null,
  inviteListAllowed: boolean | null,
  scope: InviteScope,
): boolean {
  if (!viewer) return false;
  if (!viewer.isExternal) return inviteListAllowed === true;
  if (scope === 'data-room') return false;
  return (
    viewer.companyRole === 'director' ||
    canAddDealMembers(
      navUserFromProfile(
        {
          is_external: viewer.isExternal,
          firm_role: viewer.firmRole,
          company_id: viewer.companyId,
          company_role: viewer.companyRole,
        },
        viewer.companyPermissions,
      ),
    )
  );
}

/** The resend failure every invite surface shows when delivery fails again. */
export const RESEND_UNDELIVERED = 'The emails could not be delivered. Try resending again.';

/** POST /api/v1/invites/{id}/resend, read into the shape the invite form takes. */
export async function resendInviteRequest(inviteId: string): Promise<InviteResendResult> {
  try {
    const res = await fetch(`/api/v1/invites/${inviteId}/resend`, { method: 'POST' });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      deliveryStatus?: 'sent' | 'unsent';
    };
    if (!res.ok) return { ok: false, error: body.error ?? `Request failed (${res.status})` };
    if (body.deliveryStatus !== 'sent') {
      return { ok: true, deliveryStatus: 'unsent', error: RESEND_UNDELIVERED };
    }
    return { ok: true, deliveryStatus: 'sent' };
  } catch {
    return { ok: false, error: 'The resend request failed.' };
  }
}
