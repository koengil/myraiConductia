/**
 * Configure (or remove) the work sign-in provider for a firm (#316).
 *
 *   EXPECT_SUPABASE_REF=<project ref> \
 *   ACTOR_ID=<firm admin uuid> COMPANY_ID=<bank company uuid> \
 *   PROVIDER=google ORGANIZATION_ID=<Workspace hd domain> \
 *     node --env-file=.env.<target> --import tsx scripts/set-firm-identity-provider.ts
 *
 * PROVIDER is `google` (ORGANIZATION_ID = the Google Workspace hosted domain)
 * or `azure` (ORGANIZATION_ID = the Microsoft Entra tenant id). PROVIDER=none
 * removes the row, so new invitations for the firm fall back to the email-code
 * method. The set_firm_identity_provider RPC checks the actor's authority and
 * writes identity_provider_configured / identity_provider_removed in the same
 * transaction. New invitations use the work method only while the
 * work_identity_onboarding flag is on.
 *
 * A hosted target needs EXPECT_SUPABASE_REF: the script exits before any call
 * when the URL's project ref differs (scripts/lib/supabaseTarget.ts).
 */
import { createClient } from '@supabase/supabase-js';
import { isWorkIdentityProvider } from '../src/lib/constants/workIdentity';
import { assertSupabaseTarget } from './lib/supabaseTarget';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

async function main(): Promise<void> {
  const url = requiredEnv('NEXT_PUBLIC_SUPABASE_URL');
  const key = requiredEnv('SUPABASE_SECRET_KEY');
  const actor = requiredEnv('ACTOR_ID');
  const companyId = requiredEnv('COMPANY_ID');
  const providerInput = requiredEnv('PROVIDER').toLowerCase();
  const provider = providerInput === 'none' ? null : providerInput;
  if (provider !== null && !isWorkIdentityProvider(provider)) {
    throw new Error('PROVIDER must be google, azure or none');
  }
  const organizationId = provider === null ? null : requiredEnv('ORGANIZATION_ID');

  const { ref } = assertSupabaseTarget(url, process.env.EXPECT_SUPABASE_REF);
  console.log(`Target: supabase ${ref}, company ${companyId}, provider ${provider ?? 'none'}`);

  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await db.rpc('set_firm_identity_provider', {
    p_actor: actor,
    p_company_id: companyId,
    p_provider: provider,
    p_organization_id: organizationId,
  });
  if (error) throw new Error(`set_firm_identity_provider failed: ${error.message}`);
  console.log(JSON.stringify(data));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
