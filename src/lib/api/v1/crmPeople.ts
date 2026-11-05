import type { SupabaseClient } from '@supabase/supabase-js';

export function emailFromContactInfo(contactInfo: string | null | undefined): string | null {
  if (!contactInfo) return null;
  const token = contactInfo.split(/[\s,;]+/).find((part) => part.includes('@'));
  return token?.trim().toLowerCase() ?? null;
}

export type UpsertCrmPersonInput = {
  tenantId: string;
  registeredByCompanyId: string | null;
  name: string;
  email?: string | null;
  title?: string | null;
  org?: string | null;
};

/**
 * Upsert a CRM person scoped to the registering customer org. Dedupes on
 * tenant + registrar + normalized name + email so stakeholders and
 * relationships converge on one node for future network views.
 */
export async function upsertCrmPerson(
  admin: SupabaseClient,
  input: UpsertCrmPersonInput,
): Promise<string | null> {
  const name = input.name.trim();
  if (!name) return null;

  const email = input.email?.trim().toLowerCase() ?? null;
  const title = input.title?.trim() || null;
  const org = input.org?.trim() || null;

  let lookup = admin
    .from('crm_people')
    .select('id, title, org')
    .eq('tenant_id', input.tenantId)
    .ilike('name', name);

  if (input.registeredByCompanyId) {
    lookup = lookup.eq('registered_by_company_id', input.registeredByCompanyId);
  } else {
    lookup = lookup.is('registered_by_company_id', null);
  }

  if (email) {
    lookup = lookup.eq('email', email);
  } else {
    lookup = lookup.is('email', null);
  }

  const { data: existing, error: lookupError } = await lookup.maybeSingle();
  if (lookupError) return null;

  if (existing?.id) {
    const updates: Record<string, string> = {};
    if (title && !existing.title) updates.title = title;
    if (org && !existing.org) updates.org = org;
    if (Object.keys(updates).length > 0) {
      await admin
        .from('crm_people')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', existing.id as string);
    }
    return existing.id as string;
  }

  const { data: inserted, error: insertError } = await admin
    .from('crm_people')
    .insert({
      tenant_id: input.tenantId,
      registered_by_company_id: input.registeredByCompanyId,
      name,
      email,
      title,
      org,
    })
    .select('id')
    .single();

  if (insertError || !inserted?.id) return null;
  return inserted.id as string;
}
