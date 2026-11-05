import { NextResponse } from 'next/server';

import { requireConductiaScope } from '@/lib/conductia/auth';
import { SCOPE } from '@/lib/conductia/scopes';

export async function GET(request: Request) {
  const gate = requireConductiaScope(request, undefined, SCOPE.LIBRARY_READ);
  if (!gate.ok) return gate.response;
  return NextResponse.json({ items: [] });
}
