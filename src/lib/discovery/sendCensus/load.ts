import type { SupabaseClient } from '@supabase/supabase-js';

import { errorCodeOf } from '@/lib/errors/upstream';

import type { DealContacts } from './types';

export async function loadDealContacts(
  db: SupabaseClient,
  tenantId: string,
  onError: (code: string) => void,
): Promise<DealContacts | undefined> {
  try {
    const { data, error } = await db.rpc('send_census_deal_contacts', { p_tenant: tenantId });
    if (error) {
      onError(errorCodeOf(error));
      return undefined;
    }
    const addresses = new Set<string>();
    const domains: string[] = [];
    for (const row of (data ?? []) as Array<{ kind: string; value: string | null }>) {
      const value = row.value?.trim().toLowerCase();
      if (!value) continue;
      if (row.kind === 'address') addresses.add(value);
      else if (row.kind === 'domain') domains.push(value);
    }
    return { addresses, domains };
  } catch (error) {
    onError(errorCodeOf(error));
    return undefined;
  }
}
