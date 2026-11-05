import { createClient, type User } from '@supabase/supabase-js';
import { DEV_TENANT_ID } from '../src/lib/db/tenant';
import { COMPANY_TYPE, PARTY_ROLE, type CompanyType } from '../src/lib/constants/companies';
import { DEAL_STATUS } from '../src/lib/constants/deals';
import { DOCUMENT_ROOM } from '../src/lib/constants/documents';
import { COMPANY_ROLE, DEAL_ROLE } from '../src/lib/constants/roles';
import { COMPANY_PERMISSION } from '../src/lib/constants/companyPermissions';
import { USER_STATUS } from '../src/lib/constants/users';
import { TABLE } from '../src/lib/constants/tables';
import { RAIL_CENSUS_VERSION, STEP_STATUS } from '../src/lib/constants/dealSteps';
import { MVP_DEAL_RAIL, railSeedRows } from '../src/lib/rail/dealRail';
import { seedDataroomsForDeal } from '../src/lib/dataroom/steps';
import {
  SEED_COMPANIES,
  SEED_DEALS,
  SEED_USERS,
  seedEmail,
  type SeedDealDef,
  type SeedVerifiedDomainDef,
  type SeedUserDef,
} from './seed-data';
import { createProvisionedUser } from '../src/lib/auth/provisioning';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = ReturnType<typeof createClient<any, 'public', any>>;

async function ensureAuthUser(db: Db, def: SeedUserDef, password: string): Promise<User> {
  const email = seedEmail(def.emailSlug);
  const metadata = {
    tenant_id: DEV_TENANT_ID,
    full_name: def.fullName,
    display_name: def.displayName,
    department: def.department,
    is_external: def.isExternal,
    firm_role: def.firmRole,
  };

  const { data: listed, error: listError } = await db.auth.admin.listUsers();
  if (listError) throw listError;

  const existing = listed.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
  if (existing) {
    const { data, error } = await db.auth.admin.updateUserById(existing.id, {
      password,
      email_confirm: true,
      user_metadata: metadata,
    });
    if (error) throw error;
    return data.user;
  }

  return createProvisionedUser(db, {
    email,
    password,
    email_confirm: true,
    user_metadata: metadata,
    profile: metadata,
  });
}

/** Idempotent company lookup-or-create, scoped to the dev tenant. Matches the
 *  name case-insensitively so it never creates a duplicate that the new
 *  (tenant_id, lower(name)) unique index (G23) would reject. */
async function ensureCompany(db: Db, name: string, type: CompanyType): Promise<string> {
  const { data, error } = await db
    .from(TABLE.COMPANIES)
    .select('id')
    .eq('tenant_id', DEV_TENANT_ID)
    .ilike('name', name)
    .limit(1);
  if (error) throw error;
  if (data?.[0]?.id) return data[0].id as string;

  const { data: created, error: createError } = await db
    .from(TABLE.COMPANIES)
    .insert({ tenant_id: DEV_TENANT_ID, name, type })
    .select('id')
    .single();
  if (createError) throw createError;
  console.log(`Created company ${name} (${type}).`);
  return created.id as string;
}

/** Reconcile only explicitly declared operations reference data. Account
 * emails never participate in this path. */
async function ensureVerifiedDomains(
  db: Db,
  companyId: string,
  domains: SeedVerifiedDomainDef[],
): Promise<void> {
  for (const domain of domains) {
    const { error } = await db.from(TABLE.COMPANY_VERIFIED_DOMAINS).upsert(
      {
        company_id: companyId,
        domain: domain.domain,
        source: domain.source,
      },
      { onConflict: 'company_id,domain' },
    );
    if (error) throw error;
  }
}

/** Idempotent deal lookup-or-create, keyed on the immutable deal code. Also
 *  reconciles the Gate 0 lifecycle fields (entry/current step, gate0_completed_at)
 *  so re-running the seed keeps a Gate 0-complete deal in its intended state. */
async function ensureDeal(
  db: Db,
  deal: SeedDealDef,
  bankId: string,
  mandateOwnerId: string,
): Promise<string> {
  const entryStepSeq = deal.entryStepSeq ?? 1;
  const gate0Fields = {
    entry_step_seq: entryStepSeq,
    current_step_seq: entryStepSeq,
    gate0_completed_at: deal.gate0Complete ? new Date().toISOString() : null,
  };

  const { data, error } = await db.from(TABLE.DEALS).select('id').eq('code', deal.code).limit(1);
  if (error) throw error;
  if (data?.[0]?.id) {
    const dealId = data[0].id as string;
    const { error: updateError } = await db.from(TABLE.DEALS).update(gate0Fields).eq('id', dealId);
    if (updateError) throw updateError;
    return dealId;
  }

  const { data: created, error: createError } = await db
    .from(TABLE.DEALS)
    .insert({
      tenant_id: DEV_TENANT_ID,
      code: deal.code,
      codename: deal.codename,
      bank_id: bankId,
      mandate_owner_id: mandateOwnerId,
      status: DEAL_STATUS.INTAKE,
      ...gate0Fields,
    })
    .select('id')
    .single();
  if (createError) throw createError;
  console.log(`Created deal ${deal.code} (${deal.codename}).`);
  return created.id as string;
}

/** Per-step rail state for a seeded deal, mirroring what create_deal_gate0
 *  materialises on a real create: pre-entry steps skipped_entry, the entry step
 *  current, the rest pending. Insert-only, so an existing row is never touched. */
async function ensureDealSteps(db: Db, dealId: string, entryStepSeq: number): Promise<void> {
  const { data: existing, error } = await db
    .from(TABLE.DEAL_STEPS)
    .select('step_id')
    .eq('deal_id', dealId);
  if (error) throw error;
  const seeded = new Set((existing ?? []).map((row) => row.step_id as string));

  const rows = railSeedRows(MVP_DEAL_RAIL)
    .filter((step) => !seeded.has(step.stepId))
    .map((step) => ({
      deal_id: dealId,
      step_id: step.stepId,
      seq: step.seq,
      phase_index: step.phaseIndex,
      display_order: step.displayOrder,
      status:
        step.seq === entryStepSeq
          ? STEP_STATUS.CURRENT
          : step.seq < entryStepSeq
            ? STEP_STATUS.SKIPPED_ENTRY
            : STEP_STATUS.PENDING,
      census_version: RAIL_CENSUS_VERSION,
    }));
  if (rows.length > 0) {
    const { error: insertError } = await db.from(TABLE.DEAL_STEPS).insert(rows);
    if (insertError) throw insertError;
  }

  const { data: current, error: currentError } = await db
    .from(TABLE.DEAL_STEPS)
    .select('id')
    .eq('deal_id', dealId)
    .eq('status', STEP_STATUS.CURRENT)
    .order('display_order')
    .limit(1);
  if (currentError) throw currentError;

  const { error: cursorError } = await db
    .from(TABLE.DEALS)
    .update({ current_deal_step_id: current?.[0]?.id ?? null })
    .eq('id', dealId);
  if (cursorError) throw cursorError;
}

/** Idempotent `deal_created` notification seed (keyed on deal+recipient+event).
 *  COMPLIANCE: payload carries the deal code + code name + actor, never the
 *  target company name. */
async function ensureDealCreatedNotification(
  db: Db,
  dealId: string,
  recipientId: string,
  payload: { code: string; codename: string; actor: string },
): Promise<void> {
  const { data, error } = await db
    .from(TABLE.NOTIFICATIONS)
    .select('id')
    .eq('deal_id', dealId)
    .eq('recipient_id', recipientId)
    .eq('event_type', 'deal_created')
    .limit(1);
  if (error) throw error;
  if (data?.[0]?.id) return;

  const { error: insertError } = await db.from(TABLE.NOTIFICATIONS).insert({
    tenant_id: DEV_TENANT_ID,
    deal_id: dealId,
    recipient_id: recipientId,
    event_type: 'deal_created',
    payload,
  });
  if (insertError) throw insertError;
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  const password = process.env.SEED_PASSWORD;

  if (!url || !key) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set (see .env.example)',
    );
  }
  if (!password || password.length < 8) {
    throw new Error('SEED_PASSWORD must be set in .env.local (min 8 characters)');
  }

  const db = createClient(url, key, { auth: { persistSession: false } });

  // 1. Managed companies (orgs whose people hold accounts).
  const companyIdByKey = new Map<string, string>();
  for (const company of SEED_COMPANIES) {
    const companyId = await ensureCompany(db, company.name, company.type);
    companyIdByKey.set(company.key, companyId);
    await ensureVerifiedDomains(db, companyId, company.verifiedDomains);
  }

  // 2. Auth users (+ public.users row created by the auth trigger).
  const userIds = new Map<string, string>();
  for (const def of SEED_USERS) {
    const user = await ensureAuthUser(db, def, password);
    userIds.set(def.emailSlug, user.id);
    console.log(`Seeded auth user ${seedEmail(def.emailSlug)}`);
  }

  // 3. Backfill company membership. Directors across ALL companies are assigned
  //    first so the >=1-director invariant holds before any member attaches.
  const withCompany = SEED_USERS.filter((d) => d.companyKey && d.companyRole);
  const directorsFirst = [
    ...withCompany.filter((d) => d.companyRole === COMPANY_ROLE.DIRECTOR),
    ...withCompany.filter((d) => d.companyRole !== COMPANY_ROLE.DIRECTOR),
  ];
  for (const def of directorsFirst) {
    const userId = userIds.get(def.emailSlug);
    const companyId = companyIdByKey.get(def.companyKey!);
    if (!userId || !companyId) continue;
    const { error } = await db
      .from(TABLE.USERS)
      .update({
        company_id: companyId,
        company_role: def.companyRole,
        status: USER_STATUS.ACTIVE,
        can_invite: def.canInvite ?? false,
      })
      .eq('id', userId);
    if (error) throw error;
  }
  console.log(`Assigned ${directorsFirst.length} users to managed companies (directors first).`);

  // 3b. Delegated invite authority is the company:invites:send PERMISSION, not
  //     the can_invite flag (the flag is its read-model projection). Grant it
  //     through the same access RPC the Team drawer uses, so the sandbox
  //     delegate shows the grant in the drawer and create_invite agrees with
  //     the UI (#296). Actor = a director of the same company (an access root).
  for (const def of SEED_USERS.filter((d) => d.canInvite && d.companyKey)) {
    const userId = userIds.get(def.emailSlug);
    const companyId = companyIdByKey.get(def.companyKey!);
    const director = SEED_USERS.find(
      (d) => d.companyKey === def.companyKey && d.companyRole === COMPANY_ROLE.DIRECTOR,
    );
    const actorId = director ? userIds.get(director.emailSlug) : undefined;
    if (!userId || !companyId || !actorId) {
      throw new Error(`Cannot grant ${COMPANY_PERMISSION.INVITES_SEND} to ${def.emailSlug}: no seeded director to act`);
    }
    const { data: access, error: accessError } = await db
      .from(TABLE.COMPANY_MEMBER_ACCESS)
      .select('version')
      .eq('company_id', companyId)
      .eq('user_id', userId)
      .maybeSingle();
    if (accessError) throw accessError;
    // The RPC replaces the whole assignment, so carry the delegate's current
    // roles and direct permissions along with the grant (a re-run must not
    // delete anything else assigned to it).
    const { data: heldRoles, error: rolesHeldError } = await db
      .from(TABLE.COMPANY_MEMBER_ROLES)
      .select('role_id')
      .eq('company_id', companyId)
      .eq('user_id', userId);
    if (rolesHeldError) throw rolesHeldError;
    const { data: heldPermissions, error: permissionsHeldError } = await db
      .from(TABLE.COMPANY_MEMBER_PERMISSIONS)
      .select('permission_key')
      .eq('company_id', companyId)
      .eq('user_id', userId);
    if (permissionsHeldError) throw permissionsHeldError;
    const { error: grantError } = await db.rpc('replace_company_member_access', {
      p_actor_id: actorId,
      p_company_id: companyId,
      p_user_id: userId,
      p_expected_version: Number(access?.version ?? 0),
      p_role_ids: [...new Set((heldRoles ?? []).map((r) => r.role_id as string))],
      p_direct_permission_keys: [
        ...new Set([
          ...(heldPermissions ?? []).map((p) => p.permission_key as string),
          COMPANY_PERMISSION.INVITES_SEND,
        ]),
      ],
    });
    if (grantError) throw grantError;
    console.log(`Granted ${COMPANY_PERMISSION.INVITES_SEND} to ${seedEmail(def.emailSlug)}.`);
  }

  // 4. Role slug → id map (deal_memberships.role_id).
  const { data: roleRows, error: rolesError } = await db.from(TABLE.ROLES).select('id, slug');
  if (rolesError) throw rolesError;
  const roleBySlug = new Map<string, string>(roleRows.map((r) => [r.slug as string, r.id as string]));

  // 5. Deals — each with its target party, memberships, and documents.
  for (const deal of SEED_DEALS) {
    const bankId = companyIdByKey.get(deal.ownerCompanyKey);
    if (!bankId) throw new Error(`Owner company "${deal.ownerCompanyKey}" not seeded`);

    const mdMember = deal.members.find((m) => m.dealRole === DEAL_ROLE.MD);
    const mdUserId = mdMember ? userIds.get(mdMember.emailSlug) : undefined;
    if (!mdUserId) throw new Error(`Deal ${deal.code} has no MD member`);

    const targetId = await ensureCompany(db, deal.targetName, COMPANY_TYPE.TARGET);
    await ensureVerifiedDomains(db, targetId, deal.targetVerifiedDomains);
    const dealId = await ensureDeal(db, deal, bankId, mdUserId);
    await ensureDealSteps(db, dealId, deal.entryStepSeq ?? 1);

    const { error: partyError } = await db.from(TABLE.DEAL_PARTIES).upsert(
      { deal_id: dealId, company_id: targetId, party_role: PARTY_ROLE.TARGET },
      { onConflict: 'deal_id,company_id,party_role' },
    );
    if (partyError) throw partyError;

    for (const member of deal.members) {
      const userId = userIds.get(member.emailSlug);
      const roleId = roleBySlug.get(member.dealRole);
      if (!userId || !roleId) continue;
      const addedBy = member.addedBySlug ? userIds.get(member.addedBySlug) : mdUserId;

      const { error } = await db.from(TABLE.DEAL_MEMBERSHIPS).upsert(
        {
          deal_id: dealId,
          user_id: userId,
          role_id: roleId,
          deal_role: member.dealRole,
          added_by: addedBy ?? mdUserId,
          access_scope: member.canManageMembers ? { can_manage_members: true } : null,
        },
        { onConflict: 'deal_id,user_id' },
      );
      if (error) throw error;
    }

    for (const doc of deal.documents) {
      const { data: docRows, error: docLookupError } = await db
        .from(TABLE.DOCUMENTS)
        .select('id')
        .eq('deal_id', dealId)
        .eq('name', doc.name)
        .limit(1);
      if (docLookupError) throw docLookupError;
      if (docRows?.[0]?.id) continue;

      const { error } = await db.from(TABLE.DOCUMENTS).insert({
        deal_id: dealId,
        name: doc.name,
        classification: doc.classification,
        min_phase: doc.minPhase,
        uploaded_by: mdUserId,
        room: DOCUMENT_ROOM.INTERNAL,
      });
      if (error) throw error;
    }

    await seedDataroomsForDeal(db, dealId);

    // Gate 0 notifications (e.g. the CCO's deal_created alert).
    const mdName = SEED_USERS.find((u) => u.emailSlug === mdMember?.emailSlug)?.displayName ?? 'The MD';
    for (const recipientSlug of deal.notifyRecipientSlugs ?? []) {
      const recipientId = userIds.get(recipientSlug);
      if (!recipientId) continue;
      await ensureDealCreatedNotification(db, dealId, recipientId, {
        code: deal.code,
        codename: deal.codename,
        actor: mdName,
      });
    }

    console.log(
      `Deal ${deal.code}: ${deal.members.length} members, ${deal.documents.length} documents` +
        `${deal.notifyRecipientSlugs?.length ? `, ${deal.notifyRecipientSlugs.length} notification(s)` : ''}.`,
    );
  }

  console.log(`\nSeeded ${SEED_USERS.length} dev users across ${SEED_COMPANIES.length} companies.`);
  console.log(`Sign in as ${seedEmail('md')} (Project Atlas) or ${seedEmail('nw-director')} (Project Northwind).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
