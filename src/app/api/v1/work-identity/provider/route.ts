import { NextResponse } from 'next/server';
import { requireApiUser } from '@/lib/api/v1/http';
import { requireFlag } from '@/lib/api/v1/requireFlag';

/**
 * The work account provider the caller can still connect, so the profile menu
 * offers only a connect begin_work_identity_connect will accept. Both decisions
 * come from one SQL rule (#406: work_identity_connectable_provider): null with
 * no firm or firm provider, an inactive profile, or a bound account carrying
 * the firm's current organization and no refused new account.
 */
export async function GET() {
  const gate = await requireFlag('work_identity_onboarding');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { data, error } = await auth.admin.rpc('work_identity_connectable_provider', { p_user: auth.user.id });
  if (error) return NextResponse.json({ error: 'Unable to load the provider' }, { status: 500 });
  return NextResponse.json({ provider: data as string | null });
}
