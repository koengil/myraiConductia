/**
 * Seeds the pre-release sandbox firms from scripts/sandbox/fixtures/cast_deals.yaml (#746).
 *
 *   npm run sandbox:seed-firm
 *   SEED_PASSWORD='…' npm run sandbox:seed-firm -- --apply
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createClient, type User } from '@supabase/supabase-js';

import { createProvisionedUser } from '../../src/lib/auth/provisioning';
import { COMPANY_TYPE, type CompanyType } from '../../src/lib/constants/companies';
import { COMPANY_ROLE, DEPARTMENT, FIRM_ROLE, type CompanyRole } from '../../src/lib/constants/roles';
import { TABLE } from '../../src/lib/constants/tables';
import { USER_STATUS } from '../../src/lib/constants/users';
import { argValue } from '../google/lib/live';
import { emailDomain } from './lib/domains';
import { parseFixture } from './lib/fixture';
import { refuseSandboxSeedInCi, assertSandboxSeedSupabaseTarget } from './lib/seedGuard';
import { assertSameTenant, patchUserSeatDrift, type UserSeatRow } from './lib/seedSeats';
import type { FixtureCastMember, FixtureOrg, SandboxFixture } from './lib/types';

const DEFAULT_FIXTURE = join(import.meta.dirname, 'fixtures', 'cast_deals.yaml');
const FIRM_A_ORG = 'firm_a';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = ReturnType<typeof createClient<any, 'public', any>>;

type FirmSeat = {
  member: FixtureCastMember;
  companyRole: CompanyRole;
  firmRole: typeof FIRM_ROLE.CCO | null;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function companyTypeForOrg(org: FixtureOrg): CompanyType {
  switch (org.kind) {
    case 'advisory_firm':
      return COMPANY_TYPE.BANK;
    case 'private_equity':
      return COMPANY_TYPE.ACQUIRER;
    case 'investment_bank':
    case 'law_firm':
      return COMPANY_TYPE.COUNTERPARTY;
    default:
      throw new Error(`Unsupported org kind ${org.kind}`);
  }
}

function firmASeats(fixture: SandboxFixture): FirmSeat[] {
  const cast = fixture.cast.filter((c) => c.org === FIRM_A_ORG);
  const byId = new Map(cast.map((c) => [c.id, c]));
  const order = ['victoria', 'morgan', 'alex', 'helen'] as const;
  return order.map((id) => {
    const member = byId.get(id);
    if (!member) throw new Error(`fixture cast missing firm_a member ${id}`);
    if (id === 'victoria') return { member, companyRole: COMPANY_ROLE.DIRECTOR, firmRole: null };
    if (id === 'helen') return { member, companyRole: COMPANY_ROLE.MEMBER, firmRole: FIRM_ROLE.CCO };
    return { member, companyRole: COMPANY_ROLE.MEMBER, firmRole: null };
  });
}

async function ensureCompany(db: Db, tenantId: string, name: string, type: CompanyType): Promise<string> {
  const { data, error } = await db
    .from(TABLE.COMPANIES)
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('name', name)
    .limit(1);
  if (error) throw error;
  if (data?.[0]?.id) return data[0].id as string;
  const { data: created, error: createError } = await db
    .from(TABLE.COMPANIES)
    .insert({ tenant_id: tenantId, name, type })
    .select('id')
    .single();
  if (createError) throw createError;
  return created.id as string;
}

async function ensureVerifiedDomain(db: Db, companyId: string, domain: string, parentDomain: string): Promise<void> {
  const normalized = domain.toLowerCase();
  if (normalized === parentDomain.toLowerCase()) {
    throw new Error(`Refusing to verify bare workspace parent ${parentDomain}`);
  }
  const { error } = await db.from(TABLE.COMPANY_VERIFIED_DOMAINS).upsert(
    { company_id: companyId, domain: normalized, source: 'platform_operations_seed' },
    { onConflict: 'company_id,domain' },
  );
  if (error) throw error;
}

async function listAuthUsersByEmail(db: Db): Promise<Map<string, User>> {
  const byEmail = new Map<string, User>();
  for (let page = 1; ; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    for (const u of data.users) if (u.email) byEmail.set(u.email.toLowerCase(), u);
    if (data.users.length < 1000) return byEmail;
  }
}

async function ensureAuthUser(
  db: Db,
  tenantId: string,
  existingByEmail: Map<string, User>,
  seat: FirmSeat,
  password: string,
): Promise<{ user: User; created: boolean }> {
  const email = seat.member.email.toLowerCase();
  const existing = existingByEmail.get(email);
  if (existing) return { user: existing, created: false };

  const profile = {
    tenant_id: tenantId,
    full_name: seat.member.display_name.replace(/\s*\[EXTERNAL\]\s*/gi, '').trim(),
    display_name: seat.member.display_name.split('(')[0]?.trim() ?? seat.member.display_name,
    department: seat.member.id === 'helen' ? null : DEPARTMENT.IB,
    is_external: false,
    firm_role: seat.firmRole,
  };
  const user = await createProvisionedUser(db, {
    email,
    password,
    email_confirm: true,
    user_metadata: profile,
    profile,
  });
  return { user, created: true };
}

function desiredSeatRow(seat: FirmSeat, tenantId: string, firmACompanyId: string): UserSeatRow {
  return {
    tenant_id: tenantId,
    company_id: firmACompanyId,
    company_role: seat.companyRole,
    status: USER_STATUS.ACTIVE,
    firm_role: seat.firmRole,
    can_invite: seat.companyRole === COMPANY_ROLE.DIRECTOR,
  };
}

async function loadUserSeat(db: Db, userId: string): Promise<UserSeatRow | null> {
  const { data, error } = await db
    .from(TABLE.USERS)
    .select('tenant_id, company_id, company_role, status, firm_role, can_invite')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return data as UserSeatRow | null;
}

async function reconcileSeat(
  db: Db,
  user: User,
  seat: FirmSeat,
  tenantId: string,
  firmACompanyId: string,
): Promise<'updated' | 'unchanged'> {
  const email = seat.member.email.toLowerCase();
  const desired = desiredSeatRow(seat, tenantId, firmACompanyId);
  const current = await loadUserSeat(db, user.id);
  if (!current) throw new Error(`public.users row missing for ${email}`);

  assertSameTenant(email, current.tenant_id, tenantId);
  const patch = patchUserSeatDrift(current, desired);
  if (Object.keys(patch).length === 0) return 'unchanged';

  const { error } = await db.from(TABLE.USERS).update(patch).eq('id', user.id);
  if (error) throw error;
  return 'updated';
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  refuseSandboxSeedInCi(apply);
  const fixturePath = resolveFixturePath(process.argv);

  const fixture = parseFixture(readFileSync(fixturePath, 'utf8'));
  const parentDomain = fixture.domain.toLowerCase();
  const seats = firmASeats(fixture);

  const orgPlans = Object.entries(fixture.orgs).map(([key, org]) => ({
    key,
    org,
    type: companyTypeForOrg(org),
    domain: org.domain.toLowerCase(),
  }));

  console.log(`Fixture: ${fixturePath}`);
  console.log(`Mode: ${apply ? 'apply' : 'dry-run (pass --apply to write)'}`);
  for (const plan of orgPlans) {
    console.log(`  org ${plan.key}: ${plan.org.name} (${plan.type}) -> ${plan.domain}`);
  }
  console.log(`  firm_a seats: ${seats.map((s) => s.member.email).join(', ')}`);

  if (!apply) return;

  const url = requiredEnv('NEXT_PUBLIC_SUPABASE_URL');
  const key = requiredEnv('SUPABASE_SECRET_KEY');
  const tenantId = requiredEnv('SANDBOX_TENANT_ID');
  const password = process.env.SEED_PASSWORD;
  if (!password || password.length < 8) {
    throw new Error('SEED_PASSWORD must be set (min 8 characters) for --apply');
  }

  const ref = assertSandboxSeedSupabaseTarget(url);
  console.log(`Target: supabase ${ref}, tenant ${tenantId}`);

  const db = createClient(url, key, { auth: { persistSession: false } });
  const companyIdByOrg = new Map<string, string>();

  for (const plan of orgPlans) {
    const companyId = await ensureCompany(db, tenantId, plan.org.name, plan.type);
    companyIdByOrg.set(plan.key, companyId);
    await ensureVerifiedDomain(db, companyId, plan.domain, parentDomain);
    console.log(`Verified ${plan.domain} on ${plan.org.name}.`);
  }

  const firmACompanyId = companyIdByOrg.get(FIRM_A_ORG);
  if (!firmACompanyId) throw new Error('firm_a company missing after seed');

  const existingByEmail = await listAuthUsersByEmail(db);
  let created = 0;
  let updated = 0;
  for (const seat of seats) {
    if (emailDomain(seat.member.email) !== fixture.orgs[FIRM_A_ORG]!.domain.toLowerCase()) {
      throw new Error(`${seat.member.email} is not on firm_a domain`);
    }
    const { user, created: isNew } = await ensureAuthUser(db, tenantId, existingByEmail, seat, password);
    if (isNew) created += 1;
    const outcome = await reconcileSeat(db, user, seat, tenantId, firmACompanyId);
    if (isNew) {
      console.log(`Created ${seat.member.email} (${seat.companyRole})`);
    } else if (outcome === 'updated') {
      updated += 1;
      console.log(`Updated ${seat.member.email} (${seat.companyRole})`);
    } else {
      console.log(`Kept   ${seat.member.email} (unchanged)`);
    }
  }

  console.log(`Done: ${orgPlans.length} orgs, ${seats.length} firm_a seats (${created} created, ${updated} updated).`);
}

export function resolveFixturePath(argv: string[]): string {
  return argValue(argv, '--fixture') ?? DEFAULT_FIXTURE;
}

if (process.argv[1]?.endsWith('seed-sandbox-firm.ts')) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
