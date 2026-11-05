import type { SupabaseClient } from '@supabase/supabase-js';
import {
  gate0NotifyRoleLabel,
  type Gate0NotifyRecipient,
} from '@/lib/rail/gate0';

type RecipientRow = {
  user_id: string;
  display_name: string | null;
  full_name: string | null;
  firm_role: string | null;
  company_role: string | null;
};

export function mapGate0NotifyRow(row: RecipientRow): Gate0NotifyRecipient {
  return {
    id: row.user_id,
    name:
      row.display_name?.trim() ||
      row.full_name?.trim() ||
      'Compliance officer',
    role: gate0NotifyRoleLabel(row),
  };
}

export async function listGate0NotifyRecipients(
  admin: SupabaseClient,
  tenantId: string,
  bankId: string,
): Promise<Gate0NotifyRecipient[] | null> {
  const { data, error } = await admin.rpc('gate0_notify_recipients', {
    p_tenant_id: tenantId,
    p_bank_id: bankId,
  });
  if (error || !Array.isArray(data)) return null;
  return (data as RecipientRow[]).map(mapGate0NotifyRow);
}
