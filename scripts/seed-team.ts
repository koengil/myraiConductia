/**
 * Team seed for a fresh Conductia database (Aug 28, 2026, agreed with Rob,
 * Charles and Martín): the Conductia bank company and the real team accounts,
 * without the e-mail invitation flow (Resend is not configured yet).
 *
 *   node --env-file=.env.<target>.local --import tsx scripts/seed-team.ts
 *   SEED_ROSTER=prod node --env-file=.env.<target>.local --import tsx scripts/seed-team.ts
 *
 * Roster (mirrors reality):
 *   directors — Storm (his company; MD on each deal as it is created) and
 *               Marcelo (second director so the dev team can manage roles,
 *               access and invites without waiting for Storm)
 *   members   — Rob, Charles, Martín with the full company permission set;
 *               Lance and Dan with directory + leads view.
 *
 * Idempotent and SAFE TO RE-RUN on a live database:
 *   - an auth account that already exists is left untouched (its password is
 *     NEVER reset; people change the temporary one on first sign-in);
 *   - the company is matched case-insensitively and reused;
 *   - company role / status are reconciled; direct permissions AND any
 *     UI-assigned company roles are replaced with the roster's set through
 *     the same RPC the access UI uses (roles cleared on purpose: the roster
 *     is the source of truth for these accounts);
 *   - conductia.com is recorded as the company's verified domain so invites
 *     from this company do not hit the "unverified domain" confirmation.
 *
 * Requires SEED_PASSWORD (temporary password for NEW accounts only, min 8).
 * Never prints passwords.
 *
 * SEED_ROSTER picks who gets seeded. 'dev' (the default) is the whole team
 * above; 'prod' is Storm and Dan ONLY (weekly sync, Sep 1: the production
 * database launches with just the two of them). Any other value refuses
 * loudly rather than guessing who belongs on a database.
 */
import { createClient, type User } from '@supabase/supabase-js';
import { DEV_TENANT_ID } from '../src/lib/db/tenant';
import { COMPANY_TYPE } from '../src/lib/constants/companies';
import { COMPANY_PERMISSION, type CompanyPermission } from '../src/lib/constants/companyPermissions';
import { COMPANY_ROLE, DEPARTMENT, type CompanyRole, type Department } from '../src/lib/constants/roles';
import { TABLE } from '../src/lib/constants/tables';
import { USER_STATUS } from '../src/lib/constants/users';
import { createProvisionedUser } from '../src/lib/auth/provisioning';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = ReturnType<typeof createClient<any, 'public', any>>;

const COMPANY_NAME = process.env.TEAM_COMPANY_NAME ?? 'Conductia';
const COMPANY_DOMAIN = process.env.TEAM_COMPANY_DOMAIN ?? 'conductia.com';

type TeamMember = {
  email: string;
  fullName: string;
  displayName: string;
  department: Department | null;
  companyRole: CompanyRole;
  /** Direct company permissions (members only; directors are access roots). */
  permissions: readonly CompanyPermission[];
};

const ALL_PERMISSIONS = Object.values(COMPANY_PERMISSION) as CompanyPermission[];
const VIEW_PERMISSIONS: CompanyPermission[] = [
  COMPANY_PERMISSION.DIRECTORY_VIEW_ALL,
  COMPANY_PERMISSION.LEADS_VIEW,
];

const TEAM: TeamMember[] = [
  { email: 'storm@conductia.com', fullName: 'Storm Duncan', displayName: 'Storm', department: DEPARTMENT.IB, companyRole: COMPANY_ROLE.DIRECTOR, permissions: [] },
  { email: 'marcelo@conductia.com', fullName: 'Marcelo Gumiero', displayName: 'Marcelo', department: DEPARTMENT.ADMIN, companyRole: COMPANY_ROLE.DIRECTOR, permissions: [] },
  { email: 'roberto@conductia.com', fullName: 'Roberto Di Lillo', displayName: 'Rob', department: DEPARTMENT.ADMIN, companyRole: COMPANY_ROLE.MEMBER, permissions: ALL_PERMISSIONS },
  { email: 'charles@conductia.com', fullName: 'Charles Willian', displayName: 'Charles', department: DEPARTMENT.ADMIN, companyRole: COMPANY_ROLE.MEMBER, permissions: ALL_PERMISSIONS },
  { email: 'martin@conductia.com', fullName: 'Martín Casado', displayName: 'Martín', department: DEPARTMENT.ADMIN, companyRole: COMPANY_ROLE.MEMBER, permissions: ALL_PERMISSIONS },
  { email: 'martin.casado@futureproofing.dev', fullName: 'Martín Casado', displayName: 'Martín', department: DEPARTMENT.ADMIN, companyRole: COMPANY_ROLE.MEMBER, permissions: ALL_PERMISSIONS },
  { email: 'lance@futureproofing.dev', fullName: 'Lance Marks', displayName: 'Lance', department: null, companyRole: COMPANY_ROLE.MEMBER, permissions: VIEW_PERMISSIONS },
  { email: 'dan@conductia.com', fullName: 'Dan Dima-ala', displayName: 'Dan', department: null, companyRole: COMPANY_ROLE.MEMBER, permissions: VIEW_PERMISSIONS },
];

const PROD_ROSTER_EMAILS = ['storm@conductia.com', 'dan@conductia.com'];

function rosterFor(mode: string): TeamMember[] {
  if (mode === 'dev') return TEAM;
  if (mode === 'prod') {
    const roster = TEAM.filter((m) => PROD_ROSTER_EMAILS.includes(m.email));
    if (roster.length !== PROD_ROSTER_EMAILS.length) {
      throw new Error('prod roster emails no longer match the TEAM list');
    }
    return roster;
  }
  throw new Error(`SEED_ROSTER must be 'dev' or 'prod', got '${mode}'`);
}

async function ensureCompany(db: Db): Promise<string> {
  const { data, error } = await db
    .from(TABLE.COMPANIES)
    .select('id')
    .eq('tenant_id', DEV_TENANT_ID)
    .eq('type', COMPANY_TYPE.BANK) // a CRM lead may share the name; never bind the team to it
    .ilike('name', COMPANY_NAME)
    .limit(1);
  if (error) throw error;
  if (data?.[0]?.id) return data[0].id as string;
  const { data: created, error: createError } = await db
    .from(TABLE.COMPANIES)
    .insert({ tenant_id: DEV_TENANT_ID, name: COMPANY_NAME, type: COMPANY_TYPE.BANK })
    .select('id')
    .single();
  if (createError) throw createError;
  console.log(`Created company ${COMPANY_NAME} (bank).`);
  return created.id as string;
}

async function ensureVerifiedDomain(db: Db, companyId: string): Promise<void> {
  const { error } = await db
    .from(TABLE.COMPANY_VERIFIED_DOMAINS)
    .upsert(
      { company_id: companyId, domain: COMPANY_DOMAIN, source: 'platform_operations_seed' },
      { onConflict: 'company_id,domain' },
    );
  if (error) throw error;
}

/** Every auth account, across pages, keyed by lower-cased e-mail. */
async function listAuthUsersByEmail(db: Db): Promise<Map<string, User>> {
  const byEmail = new Map<string, User>();
  for (let page = 1; ; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    for (const u of data.users) if (u.email) byEmail.set(u.email.toLowerCase(), u);
    if (data.users.length < 1000) return byEmail;
  }
}

/** Create the auth account only if it does not exist. An existing account is
 *  returned as is: its password and metadata are never touched. */
async function ensureAuthUser(
  db: Db,
  existingByEmail: Map<string, User>,
  member: TeamMember,
  password: string,
): Promise<{ user: User; created: boolean }> {
  const existing = existingByEmail.get(member.email.toLowerCase());
  if (existing) return { user: existing, created: false };

  const profile = {
    tenant_id: DEV_TENANT_ID,
    full_name: member.fullName,
    display_name: member.displayName,
    department: member.department,
    is_external: false,
    firm_role: null,
  };
  const user = await createProvisionedUser(db, {
    email: member.email,
    password,
    email_confirm: true,
    user_metadata: profile,
    profile,
  });
  return { user, created: true };
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  const password = process.env.SEED_PASSWORD;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set');
  if (!password || password.length < 8) throw new Error('SEED_PASSWORD must be set (min 8 characters)');
  const rosterMode = (process.env.SEED_ROSTER ?? 'dev').trim().toLowerCase();
  const team = rosterFor(rosterMode);
  console.log(`Roster: ${rosterMode} — ${team.map((m) => m.displayName).join(', ')}`);
  const db = createClient(url, key, { auth: { persistSession: false } });

  const companyId = await ensureCompany(db);
  await ensureVerifiedDomain(db, companyId);
  const existingByEmail = await listAuthUsersByEmail(db);

  // Directors first so the >=1-director invariant holds before members attach.
  const ordered = [
    ...team.filter((m) => m.companyRole === COMPANY_ROLE.DIRECTOR),
    ...team.filter((m) => m.companyRole !== COMPANY_ROLE.DIRECTOR),
  ];
  if (ordered[0]?.companyRole !== COMPANY_ROLE.DIRECTOR) {
    throw new Error('the selected roster has no director; refusing (the RPC actor must be an access root)');
  }
  const ids = new Map<string, string>();
  let created = 0;
  for (const member of ordered) {
    const { user, created: isNew } = await ensureAuthUser(db, existingByEmail, member, password);
    ids.set(member.email, user.id);
    if (isNew) created += 1;
    // can_invite is the legacy projection of company:invites:send; directors
    // always hold it. Written from the roster so a re-run never strips it
    // (the access RPC only rewrites it when the permission set CHANGES).
    const canInvite =
      member.companyRole === COMPANY_ROLE.DIRECTOR ||
      member.permissions.includes(COMPANY_PERMISSION.INVITES_SEND);
    const { data: updated, error } = await db
      .from(TABLE.USERS)
      .update({
        company_id: companyId,
        company_role: member.companyRole,
        status: USER_STATUS.ACTIVE,
        can_invite: canInvite,
      })
      .eq('id', user.id)
      .select('id');
    if (error) throw error;
    if (!updated || updated.length !== 1) {
      throw new Error(`public.users row missing for ${member.email} (auth trigger did not mirror it)`);
    }
    console.log(`${isNew ? 'Created' : 'Kept   '} ${member.email} — ${member.companyRole}`);
  }

  // Direct permissions for members, through the same RPC the access UI uses
  // (directors are access roots and need none). Actor = the first director.
  const actorId = ids.get(ordered[0].email)!;
  for (const member of ordered) {
    if (member.companyRole === COMPANY_ROLE.DIRECTOR) continue;
    const userId = ids.get(member.email)!;
    const { data: access, error: accessError } = await db
      .from(TABLE.COMPANY_MEMBER_ACCESS)
      .select('version')
      .eq('company_id', companyId)
      .eq('user_id', userId)
      .maybeSingle();
    if (accessError) throw accessError;
    const { error } = await db.rpc('replace_company_member_access', {
      p_actor_id: actorId,
      p_company_id: companyId,
      p_user_id: userId,
      p_expected_version: Number(access?.version ?? 0),
      p_role_ids: [],
      p_direct_permission_keys: [...member.permissions],
    });
    if (error) throw error;
    console.log(`         ${member.email} — ${member.permissions.length} direct permission(s)`);
  }

  console.log(`\n${COMPANY_NAME}: ${team.length} accounts (${created} created, ${team.length - created} kept).`);
  if (created > 0) console.log('New accounts sign in with the temporary SEED_PASSWORD; change it on first sign-in.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
