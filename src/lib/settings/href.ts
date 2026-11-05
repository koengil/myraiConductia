import type { SettingsSectionId } from './types';

/**
 * Settings deep links. Kept apart from the section registry so nav code can
 * link into Settings without importing every section's UI.
 */
export function settingsHref(id: SettingsSectionId): string {
  return `/settings?section=${id}`;
}

/** Settings › Organization, optionally on its Permission requests or Roles tab. */
export function organizationSettingsHref(tab?: 'requests' | 'roles'): string {
  const base = settingsHref('organization');
  return tab ? `${base}&tab=${tab}` : base;
}

/**
 * Where /profile lands: Settings › Profile, carrying the rest of its query
 * along (the work account connect result, ?connected= / ?error=).
 */
export function profileRedirectTarget(
  params: Record<string, string | string[] | undefined>,
): string {
  const query = new URLSearchParams({ section: 'profile' });
  for (const [key, value] of Object.entries(params)) {
    if (key === 'section' || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) query.append(key, v);
  }
  return `/settings?${query.toString()}`;
}
