export type UserSeatRow = {
  tenant_id: string;
  company_id: string | null;
  company_role: string | null;
  status: string;
  firm_role: string | null;
  can_invite: boolean;
};

export function assertSameTenant(email: string, currentTenantId: string, targetTenantId: string): void {
  if (currentTenantId !== targetTenantId) {
    throw new Error(`Refusing: ${email} belongs to tenant ${currentTenantId}, not ${targetTenantId}`);
  }
}

export function patchUserSeatDrift(current: UserSeatRow, desired: UserSeatRow): Partial<UserSeatRow> {
  const patch: Partial<UserSeatRow> = {};
  if (current.tenant_id !== desired.tenant_id) patch.tenant_id = desired.tenant_id;
  if (current.company_id !== desired.company_id) patch.company_id = desired.company_id;
  if (current.company_role !== desired.company_role) patch.company_role = desired.company_role;
  if (current.status !== desired.status) patch.status = desired.status;
  if (current.firm_role !== desired.firm_role) patch.firm_role = desired.firm_role;
  if (current.can_invite !== desired.can_invite) patch.can_invite = desired.can_invite;
  return patch;
}
