import { NextResponse } from 'next/server';
import { userCanViewCompanyLeadMaps } from '@/lib/api/v1/access';
import { emailFromContactInfo, upsertCrmPerson } from '@/lib/api/v1/crmPeople';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import {
  RELATIONSHIP_SOURCES,
  RELATIONSHIP_TYPES,
  STRENGTH_LEVELS,
} from '@/lib/constants/leadMaps';

type RouteContext = { params: Promise<{ companyId: string }> };

const RELATIONSHIP_SELECT =
  'id, company_id, person_name, title, person_company, contact_info, relationship_type, ' +
  'strength, source, confidence, last_verified, owner, basis, created_at';

/**
 * GET /api/v1/companies/{companyId}/relationships — lead CRM relationships.
 *
 * COMPLIANCE (Chinese wall): gated by the same predicate as company search
 * (`userCanViewCompanyLeadMaps`) since relationships expose named contacts tied
 * to a masked company identity. Tenant + company scoped.
 */
export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { companyId } = await context.params;

  const allowed = await userCanViewCompanyLeadMaps(auth.admin, auth.user.id, companyId);
  if (!allowed) return jsonError('Not permitted to access company relationships', 403);

  const { data: profile, error: profileError } = await auth.admin
    .from('users')
    .select('tenant_id')
    .eq('id', auth.user.id)
    .single();
  if (profileError || !profile) return jsonError('User profile not found', 404);

  const { data: company, error: companyError } = await auth.admin
    .from('companies')
    .select('id')
    .eq('id', companyId)
    .eq('tenant_id', profile.tenant_id)
    .maybeSingle();
  if (companyError) return jsonError(companyError.message, 500);
  if (!company) return jsonError('Company not found', 404);

  const { data, error } = await auth.admin
    .from('lead_relationships')
    .select(RELATIONSHIP_SELECT)
    .eq('tenant_id', profile.tenant_id)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false });
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ relationships: data ?? [] });
}

type RelationshipCreateBody = {
  person_name?: string;
  title?: string;
  person_company?: string;
  contact_info?: string;
  relationship_type?: string;
  strength?: string;
  source?: string;
  confidence?: string;
  last_verified?: string;
  owner?: string;
  basis?: string;
};

/** An explicit empty/whitespace value is treated as "not provided". */
function trimmedOrUndefined(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * POST /api/v1/companies/{companyId}/relationships — add a lead CRM contact.
 *
 * Same access gate as GET. Enum fields default to the first option when
 * omitted/blank and are validated when provided.
 */
export async function POST(request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { companyId } = await context.params;

  const allowed = await userCanViewCompanyLeadMaps(auth.admin, auth.user.id, companyId);
  if (!allowed) return jsonError('Not permitted to access company relationships', 403);

  let body: RelationshipCreateBody;
  try {
    body = (await request.json()) as RelationshipCreateBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const person_name = body.person_name?.trim();
  if (!person_name) return jsonError('person_name is required', 400);

  const relationship_type = trimmedOrUndefined(body.relationship_type) ?? RELATIONSHIP_TYPES[0];
  if (!RELATIONSHIP_TYPES.includes(relationship_type as (typeof RELATIONSHIP_TYPES)[number])) {
    return jsonError(`invalid relationship_type "${relationship_type}"`, 400);
  }

  const strength = trimmedOrUndefined(body.strength) ?? STRENGTH_LEVELS[0];
  if (!STRENGTH_LEVELS.includes(strength as (typeof STRENGTH_LEVELS)[number])) {
    return jsonError(`invalid strength "${strength}"`, 400);
  }

  const source = trimmedOrUndefined(body.source) ?? 'banker asserted';
  if (!RELATIONSHIP_SOURCES.includes(source as (typeof RELATIONSHIP_SOURCES)[number])) {
    return jsonError(`invalid source "${source}"`, 400);
  }

  const confidence = trimmedOrUndefined(body.confidence) ?? STRENGTH_LEVELS[0];
  if (!STRENGTH_LEVELS.includes(confidence as (typeof STRENGTH_LEVELS)[number])) {
    return jsonError(`invalid confidence "${confidence}"`, 400);
  }

  const title = trimmedOrUndefined(body.title) ?? null;
  const person_company = trimmedOrUndefined(body.person_company) ?? null;
  const contact_info = trimmedOrUndefined(body.contact_info) ?? null;
  const owner = trimmedOrUndefined(body.owner) ?? null;
  const basis = trimmedOrUndefined(body.basis) ?? null;
  // A blank date must become NULL, not ''. Postgres rejects ''::date, so an
  // empty string here (the register form's default for an unset date) would
  // 500 the insert. Normalize it like the other optional fields.
  const last_verified = trimmedOrUndefined(body.last_verified) ?? null;

  const { data: profile, error: profileError } = await auth.admin
    .from('users')
    .select('tenant_id, company_id')
    .eq('id', auth.user.id)
    .single();
  if (profileError || !profile) return jsonError('User profile not found', 404);

  const { data: company, error: companyError } = await auth.admin
    .from('companies')
    .select('id, registered_by_company_id')
    .eq('id', companyId)
    .eq('tenant_id', profile.tenant_id)
    .maybeSingle();
  if (companyError) return jsonError(companyError.message, 500);
  if (!company) return jsonError('Company not found', 404);

  const registeredByCompanyId =
    (company.registered_by_company_id as string | null) ??
    (profile.company_id as string | null) ??
    null;

  const person_id = await upsertCrmPerson(auth.admin, {
    tenantId: profile.tenant_id as string,
    registeredByCompanyId,
    name: person_name,
    email: emailFromContactInfo(contact_info),
    title,
    org: person_company,
  });

  const { data, error } = await auth.admin
    .from('lead_relationships')
    .insert({
      tenant_id: profile.tenant_id,
      company_id: companyId,
      person_id,
      person_name,
      title,
      person_company,
      contact_info,
      relationship_type,
      strength,
      source,
      confidence,
      last_verified,
      owner,
      basis,
    })
    .select(RELATIONSHIP_SELECT)
    .single();
  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ relationship: data }, { status: 201 });
}
