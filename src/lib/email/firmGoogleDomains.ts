import type { SupabaseClient } from '@supabase/supabase-js';

import { dbFailure } from '@/lib/errors/upstream';

/**
 * Who a Google account must be to send as a banker (#490 R19, T14). Both reads
 * are read only: the tables are Martin's work-identity and invite safeguard
 * tables, and nothing here writes them.
 *
 * firmGoogleDomains: the Workspace domains the id_token's hd claim may take.
 *   1. The company's firm_identity_providers row with provider google: its
 *      organization_id is the primary Workspace domain, the same value the
 *      work-identity start route sends to Google as hd. When it exists it
 *      wins, alone.
 *   2. Otherwise the company's company_verified_domains (operations-supplied;
 *      the table's CHECK keeps consumer domains out).
 *   Empty when the banker has no company or neither source yields a domain:
 *   there is then nothing to check hd against, so a connect is refused.
 *
 * boundGoogleSubject: the sub of the banker's bound Google work identity, if
 * they have one (one binding per user and provider), which a sending grant's
 * sub must equal.
 *
 * A read error throws (a DbError carrying a code only), so a connect fails
 * closed rather than reading as "no domain" or "no binding".
 */

const domainOf = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const domain = value.trim().toLowerCase();
  return domain || null;
};

export async function firmGoogleDomains(admin: SupabaseClient, companyId: string | null): Promise<string[]> {
  if (!companyId) return [];

  const { data: idp, error: idpError } = await admin
    .from('firm_identity_providers')
    .select('organization_id')
    .eq('company_id', companyId)
    .eq('provider', 'google')
    .maybeSingle();
  if (idpError) throw dbFailure('Firm identity provider read', idpError);
  const hd = domainOf((idp as { organization_id?: unknown } | null)?.organization_id);
  if (hd) return [hd];

  const { data: rows, error: domainsError } = await admin
    .from('company_verified_domains')
    .select('domain')
    .eq('company_id', companyId);
  if (domainsError) throw dbFailure('Verified domains read', domainsError);
  const domains = ((rows ?? []) as Array<{ domain?: unknown }>).map((row) => domainOf(row.domain));
  return [...new Set(domains.filter((domain): domain is string => domain !== null))];
}

export async function boundGoogleSubject(admin: SupabaseClient, userId: string): Promise<string | undefined> {
  const { data, error } = await admin
    .from('work_identity_bindings')
    .select('provider_subject')
    .eq('user_id', userId)
    .eq('provider', 'google')
    .maybeSingle();
  if (error) throw dbFailure('Work identity link read', error);
  const subject = (data as { provider_subject?: unknown } | null)?.provider_subject;
  return typeof subject === 'string' && subject ? subject : undefined;
}
