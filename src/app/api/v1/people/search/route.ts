import { NextResponse } from 'next/server';

import { searchPeople } from '@/lib/api/v1/peopleSearch';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { PERSON_SEARCH_SCOPE, type PersonSearchScope } from '@/lib/people/types';

type PeopleSearchBody = {
  query?: unknown;
  dealId?: unknown;
  companyId?: unknown;
  scope?: unknown;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * POST /api/v1/people/search  { query?, dealId?, companyId?, scope? }
 *
 * Tenant-scoped people search for mail To/Cc and rail person-name fields. The
 * typed text travels in the body, never the URL, so it stays out of access logs
 * and browser history (#331).
 */
export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  let body: PeopleSearchBody;
  try {
    const parsed: unknown = await request.json();
    body = parsed && typeof parsed === 'object' ? (parsed as PeopleSearchBody) : {};
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const query = text(body.query);
  const dealId = text(body.dealId) || null;
  const companyId = text(body.companyId) || null;
  const scopeParam = text(body.scope);
  const scope: PersonSearchScope =
    scopeParam === PERSON_SEARCH_SCOPE.FIRM_NETWORK
      ? PERSON_SEARCH_SCOPE.FIRM_NETWORK
      : scopeParam === PERSON_SEARCH_SCOPE.COMPANY_EMPLOYEES
        ? PERSON_SEARCH_SCOPE.COMPANY_EMPLOYEES
        : PERSON_SEARCH_SCOPE.ALL;

  if (!query && scope !== PERSON_SEARCH_SCOPE.COMPANY_EMPLOYEES) {
    return NextResponse.json({ people: [] });
  }

  const people = await searchPeople(auth.admin, auth.user.id, {
    query,
    dealId,
    companyId,
    scope,
  });

  return NextResponse.json({ people });
}
