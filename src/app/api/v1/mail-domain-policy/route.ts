import { NextResponse } from 'next/server';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { requireFlag } from '@/lib/flags/requireFlag';
import { loadMailDomainPolicy } from '@/lib/api/v1/mailDomainPolicy';

export async function GET() {
  const gate = await requireFlag('mail_channel');
  if (gate) return gate;
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;
  const { data: sender, error } = await auth.admin.from('users')
    .select('tenant_id, company_id').eq('id', auth.user.id).maybeSingle();
  if (error || !sender) return jsonError('Sender organization unavailable', 500);
  try {
    return NextResponse.json(await loadMailDomainPolicy(auth.admin, sender), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch {
    return jsonError('Unable to verify recipient boundary', 500);
  }
}
