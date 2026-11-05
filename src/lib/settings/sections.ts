import { mailSection } from './sections/mail';
import { notificationsSection } from './sections/notifications';
import { organizationSection } from './sections/organization';
import { profileSection } from './sections/profile';
import { railsSection } from './sections/rails';
import { isBankSideUser, type NavUser } from '@/lib/navigation/navPolicy';
import type { SettingsSection, SettingsSectionId } from './types';

export { settingsHref, organizationSettingsHref } from './href';

/**
 * Settings sections registry. Each section lives in its own file under
 * ./sections/; this file only orders them (the order of the section list).
 */
export type { SettingsSection, SettingsSectionId };

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  profileSection,
  organizationSection,
  mailSection,
  railsSection,
  notificationsSection,
];

const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'profile';

/**
 * The sections that apply to this person. Mail (the firm's mailbox reading
 * and sending) is bank side only. So is Rails: its one switch is the rail's
 * edit prompt, and the rail is bank internal, so an outside party never sees
 * that prompt. Both use isBankSideUser, which also admits an external firm
 * ADMIN or CCO; the rail's API applies the stricter not-external wall.
 * Organization is for the bank side and for outside parties who belong to a
 * company (a client company's director runs their people there); a seller or
 * buyer seat with no company has no organization to show. Display only: each
 * section's API still decides.
 * While the viewer is unknown, every section is listed, as the shell does.
 */
export function settingsSectionsFor(viewer: NavUser | null): readonly SettingsSection[] {
  if (!viewer || isBankSideUser(viewer)) return SETTINGS_SECTIONS;
  return SETTINGS_SECTIONS.filter(
    (s) => s.id !== 'mail' && s.id !== 'rails' && (s.id !== 'organization' || viewer.company_id !== null),
  );
}

/**
 * Resolve a `?section=` value to one of `sections`; unknown, or not listed for
 * this person, falls back to the default.
 */
export function resolveSettingsSection(
  raw: string | string[] | null | undefined,
  sections: readonly SettingsSection[] = SETTINGS_SECTIONS,
): SettingsSection {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (
    sections.find((s) => s.id === value) ??
    SETTINGS_SECTIONS.find((s) => s.id === DEFAULT_SETTINGS_SECTION)!
  );
}
