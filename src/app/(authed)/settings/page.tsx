import Link from 'next/link';

import { DealDiscoveryHashRedirect } from '@/components/settings/DealDiscoveryHashRedirect';
import { getNavUser } from '@/lib/navigation/serverNav';
import {
  resolveSettingsSection,
  settingsHref,
  settingsSectionsFor,
} from '@/lib/settings/sections';

/**
 * Settings shell: a section list on the left, the active section on the right.
 * Sections come from the registry in `src/lib/settings/sections.ts`, filtered
 * to the ones that apply to this person; deep link with
 * `/settings?section=organization`. Each section's content lives in its own
 * file under `src/lib/settings/sections/`, not here.
 */
export default async function SettingsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ section?: string | string[] }> }>) {
  const { section: raw } = await searchParams;
  // Outside parties get only the sections that apply to them; a deep link to
  // one that does not apply opens Profile.
  const sections = settingsSectionsFor(await getNavUser());
  const active = resolveSettingsSection(raw, sections);

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-[var(--space-3)] overflow-y-auto bg-[var(--surface-warm)] px-[var(--space-5)] py-[var(--space-5)]">
      <DealDiscoveryHashRedirect enabled={active.id === 'profile' && sections.some((s) => s.id === 'mail')} />
      <header>
        <h1 className="text-[length:var(--text-xl)] font-semibold text-[var(--ink)]">Settings</h1>
      </header>
      <div className="flex min-h-0 flex-col gap-[var(--space-4)] md:flex-row md:gap-[var(--space-6)]">
        <nav aria-label="Settings sections" className="shrink-0 md:w-56">
          <ul className="flex flex-row flex-wrap gap-1 md:flex-col">
            {sections.map((s) => {
              const isActive = s.id === active.id;
              return (
                <li key={s.id}>
                  <Link
                    href={settingsHref(s.id)}
                    aria-current={isActive ? 'page' : undefined}
                    className={`block rounded-[var(--radius-control)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-md)] ${
                      isActive
                        ? 'bg-[var(--surface)] font-medium text-[var(--ink)]'
                        : 'text-[var(--ink-secondary)] hover:bg-[var(--surface)]'
                    }`}
                  >
                    {s.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <section aria-labelledby="settings-section-title" className="min-w-0 flex-1">
          <h2 id="settings-section-title" className="mb-[var(--space-3)] text-[length:var(--text-lg)] font-semibold text-[var(--ink)]">
            {active.label}
          </h2>
          {active.render()}
        </section>
      </div>
    </div>
  );
}
