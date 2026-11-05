import { NextResponse } from 'next/server';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';

export async function GET() {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { admin } = auth;

  const { data, error } = await admin.from('roles').select('id, slug, label, permissions').order('slug');
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ roles: data });
}
