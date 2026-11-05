import { createProvisionedUser, type ProvisioningClient } from '@/lib/auth/provisioning';

/**
 * admin.auth.admin.createUser's shape for fixtures that seed a working account
 * from `user_metadata.tenant_id` / `department`. New auth users are contained
 * (#316), so the profile is authorized through createProvisionedUser.
 */
export async function createUserProvisioned(
  admin: ProvisioningClient,
  attributes: { email: string; password?: string; email_confirm?: boolean; user_metadata: { tenant_id: string; department?: string } },
) {
  try {
    const { tenant_id, department } = attributes.user_metadata;
    const user = await createProvisionedUser(admin, { ...attributes, profile: { tenant_id, department } });
    return { data: { user }, error: null };
  } catch (error) {
    return { data: { user: null }, error: { message: (error as Error).message } };
  }
}
