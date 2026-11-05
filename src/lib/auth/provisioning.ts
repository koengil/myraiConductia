import type { User } from '@supabase/supabase-js';
import { errorCodeOf } from '@/lib/errors/upstream';

/**
 * Trusted server provisioning (issue #316, plan 1a). Every new auth user gets
 * a contained profile from handle_new_auth_user (no tenant, no company, not
 * active); metadata is never read. A seed, bootstrap or test that needs a
 * working account creates the auth user and then authorizes THAT id through
 * the service-role-only `authorize_provisioned_profile` RPC, which audits
 * `profile_provisioned`. createUser errors on an existing email, so the id is
 * always this call's own creation.
 */
export type ProvisionedProfile = {
  tenant_id: string;
  full_name?: string | null;
  display_name?: string | null;
  firm_role?: string | null;
  department?: string | null;
  is_external?: boolean;
  company_id?: string | null;
  company_role?: string | null;
  status?: 'active' | 'invited' | 'suspended';
};

export type ProvisionedUserInput = {
  email: string;
  password?: string;
  email_confirm?: boolean;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
  profile: ProvisionedProfile;
};

type RpcResult = PromiseLike<{ error: { message: string; code?: string } | null }>;

/** The slice of a service-role Supabase client this helper uses. */
export type ProvisioningClient = {
  auth: {
    admin: {
      createUser(attributes: Omit<ProvisionedUserInput, 'profile'>): Promise<{
        data: { user: User | null };
        error: { message: string; code?: string } | null;
      }>;
      deleteUser(id: string): Promise<unknown>;
    };
  };
  rpc(fn: 'authorize_provisioned_profile', args: { p_user_id: string; p_profile: ProvisionedProfile }): RpcResult;
};

export async function createProvisionedUser(
  admin: ProvisioningClient,
  { profile, ...attributes }: ProvisionedUserInput,
): Promise<User> {
  const { data, error } = await admin.auth.admin.createUser(attributes);
  if (error || !data.user) {
    throw new Error(`auth user create failed (${error ? errorCodeOf(error) : 'no_user'})`);
  }
  const user = data.user;
  const { error: authorizeError } = await admin.rpc('authorize_provisioned_profile', {
    p_user_id: user.id,
    p_profile: { status: 'active', ...profile },
  });
  if (authorizeError) {
    // Remove the contained identity so a retry can create the email again.
    await admin.auth.admin.deleteUser(user.id);
    throw new Error(`profile authorization failed (${errorCodeOf(authorizeError)})`);
  }
  return user;
}
