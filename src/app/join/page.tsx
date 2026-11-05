import { notFound } from 'next/navigation';
import { isFlagEnabled } from '@/lib/api/v1/requireFlag';
import { isUuid } from '@/lib/api/v1/http';
import { workIdentityErrorCopy } from '@/lib/auth/workIdentity';
import { isWorkIdentityProvider } from '@/lib/constants/workIdentity';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import JoinPageClient from './page.client';

export const dynamic = 'force-dynamic';

type JoinPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined): string | null {
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

/**
 * The invited firm's provider, so the single action names it. Only resolved
 * for a matching invitation id and nonce; any miss renders the generic label.
 */
async function firmProvider(invite: string | null, nonce: string | null) {
  if (!invite || !nonce || !isUuid(invite) || !isUuid(nonce)) return null;
  try {
    const admin = createSupabaseAdminClient();
    const { data: row } = await admin
      .from('invites')
      .select('company_id, credential_nonce')
      .eq('id', invite)
      .maybeSingle();
    if (!row?.company_id || row.credential_nonce !== nonce) return null;
    const { data: mapping } = await admin
      .from('firm_identity_providers')
      .select('provider')
      .eq('company_id', row.company_id)
      .maybeSingle();
    return isWorkIdentityProvider(mapping?.provider) ? mapping.provider : null;
  } catch {
    return null;
  }
}

/**
 * Work-identity invitation landing (#316 section 4). The link in the email is
 * `/join?invite=<id>&k=<nonce>`; provider round trips return here with
 * `error`, and the connect detour with `step=connect` or `connected=1`.
 * Recovery copy is resolved on the server.
 */
export default async function JoinPage({ searchParams }: JoinPageProps) {
  if (!(await isFlagEnabled('work_identity_onboarding'))) notFound();
  const params = await searchParams;
  const errorCode = first(params.error);
  const invite = first(params.invite);
  const nonce = first(params.k);
  return (
    <JoinPageClient
      invite={invite}
      nonce={nonce}
      provider={await firmProvider(invite, nonce)}
      error={errorCode ? workIdentityErrorCopy(errorCode) : null}
      step={first(params.step) === 'connect' ? 'connect' : null}
      connected={first(params.connected) === '1'}
    />
  );
}
