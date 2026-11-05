/**
 * The one account that must exist before the product can create anything.
 *
 *   ADMIN_EMAIL=info@conductia.com ADMIN_PASSWORD='...' \
 *     node --env-file=.env.<target> --import tsx scripts/bootstrap-firm-admin.ts
 *
 * POST /api/v1/companies/onboard is firm-admin only, and there is no admin UI
 * in production (/dev-api 404s there), so the first company can only be created
 * by a caller that already holds firm_role = 'admin'. Nothing else in the repo
 * mints one: seed-team.ts writes firm_role: null for every roster member. This
 * script closes that gap and does nothing else.
 *
 * The account is SEEDED on purpose, not invited. scripts/onboard-company.ts
 * signs in with a password grant, which is AAL1, and requireApiUser demands
 * AAL2 from invite-created identities — so an admin born through the product's
 * own invite flow could never run it. The cost is that under
 * MFA_ENFORCEMENT=invite_only this identity is exempt from 2FA, which is why
 * it should be a dedicated operations address and not a person's account, and
 * why it should be suspended once the first org stands on its own.
 *
 * Idempotent: an existing auth account is left completely alone (its password
 * is NEVER reset), and only firm_role is reconciled on the profile row. Never
 * prints the password.
 */
import { createClient } from '@supabase/supabase-js';
import { DEV_TENANT_ID } from '../src/lib/db/tenant';
import { FIRM_ROLE } from '../src/lib/constants/roles';
import { TABLE } from '../src/lib/constants/tables';
import { USER_STATUS } from '../src/lib/constants/users';
import { createProvisionedUser } from '../src/lib/auth/provisioning';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

async function main(): Promise<void> {
  const url = requiredEnv('NEXT_PUBLIC_SUPABASE_URL');
  const key = requiredEnv('SUPABASE_SECRET_KEY');
  const email = requiredEnv('ADMIN_EMAIL').toLowerCase();
  const password = requiredEnv('ADMIN_PASSWORD');
  if (password.length < 12) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters');
  }

  // Same guard as onboard-company.ts: node --env-file does NOT override a
  // variable already exported in the shell, so a stale export can silently
  // beat the env file. Naming the project is what catches it.
  const ref = new URL(url).hostname.split('.')[0];
  console.log(`Target: supabase ${ref} — firm admin ${email}`);

  const db = createClient(url, key, { auth: { persistSession: false } });

  // listUsers is paginated; getUserByEmail does not exist on this client.
  let existingId: string | null = null;
  for (let page = 1; ; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) existingId = hit.id;
    if (hit || data.users.length < 1000) break;
  }

  let userId: string;
  if (existingId) {
    userId = existingId;
    console.log('Auth account already exists — left untouched.');
  } else {
    // handle_new_auth_user only contains the new identity; the profile is
    // authorized (and audited) by authorize_provisioned_profile.
    const user = await createProvisionedUser(db, {
      email,
      password,
      email_confirm: true,
      profile: {
        tenant_id: DEV_TENANT_ID,
        full_name: 'Conductia Operations',
        display_name: 'Operations',
        is_external: false,
        firm_role: FIRM_ROLE.ADMIN,
      },
    });
    userId = user.id;
    console.log('Created auth account.');
  }

  // Reconcile the profile row: authorize_provisioned_profile sets firm_role on
  // create, but an account that predates this script may not carry it.
  const { data: updated, error: updateError } = await db
    .from(TABLE.USERS)
    .update({ firm_role: FIRM_ROLE.ADMIN, status: USER_STATUS.ACTIVE })
    .eq('id', userId)
    .select('id, email, firm_role, status, tenant_id');
  if (updateError) throw updateError;
  if (!updated || updated.length !== 1) {
    throw new Error(`public.users row missing for ${email} (auth trigger did not mirror it)`);
  }

  console.log(`${email} is firm admin (tenant ${updated[0].tenant_id}).`);
  console.log('Sign in once to change the bootstrap password, then suspend this account when the first org is live.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
