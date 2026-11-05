import type { SupabaseClient } from '@supabase/supabase-js';
import type { MailDomainPolicy } from '@/lib/mail/recipientBoundary';

type Sender = { tenant_id: string | null; company_id?: string | null };

/** The actor profile is loaded by the authenticated server, never supplied by the client. */
export async function loadMailDomainPolicy(admin: SupabaseClient, sender: Sender): Promise<MailDomainPolicy> {
  if (!sender.tenant_id) throw new Error('Sender organization unavailable');
  if (!sender.company_id) return { verifiedDomains: [] };
  const { data: company, error: companyError } = await admin.from('companies')
    .select('tenant_id').eq('id', sender.company_id).maybeSingle();
  if (companyError || !company || company.tenant_id !== sender.tenant_id) throw new Error('Sender organization unavailable');
  const { data: rows, error } = await admin.from('company_verified_domains')
    .select('domain').eq('company_id', sender.company_id).eq('tenant_id', sender.tenant_id);
  if (error) throw new Error('Unable to verify recipient boundary');
  return { verifiedDomains: (rows ?? []).map((row) => row.domain as string) };
}
