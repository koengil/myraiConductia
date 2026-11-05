import { NextResponse } from 'next/server';
import { userCanViewCompany } from '@/lib/api/v1/access';
import { listGate0NotifyRecipients } from '@/lib/api/v1/gate0Notify';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { COMPANY_TYPE } from '@/lib/constants/companies';

type RouteContext = { params: Promise<{ companyId: string }> };

/**
 * GET /api/v1/companies/{companyId}/notify-recipients
 * Bank-only. The people create_deal_gate0 will notify when a mandate opens.
 */
export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { companyId } = await context.params;
  const allowed = await userCanViewCompany(auth.admin, auth.user.id, companyId);
  if (!allowed) return jsonError('Not permitted to view this company roster', 403);

  const { data: company, error: companyError } = await auth.admin
    .from('companies')
    .select('id, type, tenant_id')
    .eq('id', companyId)
    .maybeSingle();
  if (companyError) return jsonError(companyError.message, 500);
  if (!company) return jsonError('Company not found', 404);
  if (company.type !== COMPANY_TYPE.BANK) {
    return jsonError('Notify recipients are configured on the bank', 400);
  }

  const recipients = await listGate0NotifyRecipients(
    auth.admin,
    company.tenant_id as string,
    company.id as string,
  );
  if (!recipients) return jsonError('Unable to resolve notify recipients', 500);

  return NextResponse.json({ recipients });
}
