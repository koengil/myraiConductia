import { isUuid, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { TABLE } from '@/lib/constants/tables';
import { requireTemplateActor } from '@/lib/rail/railTemplateAccess';

type Auth = Awaited<ReturnType<typeof requireApiUser>>;

export type TemplateDraftAccess =
  | { ok: true; admin: Extract<Auth, { ok: true }>['admin']; userId: string; companyId: string }
  | { ok: false; response: Response };

export async function requireTemplateDraftAccess(templateId: string): Promise<TemplateDraftAccess> {
  const flag = await requireFlag('skill_authoring');
  if (flag) return { ok: false, response: flag };
  const auth = await requireApiUser();
  if (!auth.ok) return { ok: false, response: auth.response };
  const actor = await requireTemplateActor(auth.admin, auth.user.id);
  if (!actor.ok) return { ok: false, response: jsonError(actor.error, actor.status) };
  if (templateId === 'default' || !isUuid(templateId)) {
    return { ok: false, response: jsonError('Template not found.', 404) };
  }
  const { data, error } = await auth.admin
    .from(TABLE.RAIL_CATALOG_TEMPLATES)
    .select('id')
    .eq('id', templateId)
    .eq('company_id', actor.companyId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) return { ok: false, response: jsonError('Could not read the template.', 503) };
  if (!data) return { ok: false, response: jsonError('Template not found.', 404) };
  return { ok: true, admin: auth.admin, userId: auth.user.id, companyId: actor.companyId };
}
