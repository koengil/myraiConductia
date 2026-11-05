'use client';

import Link from 'next/link';

import { organizationSettingsHref } from '@/lib/settings/href';

export type CompanyTab = 'roster' | 'requests' | 'roles';

export function parseCompanyMembersTab(searchParams: {
  get(name: string): string | null;
}): Exclude<CompanyTab, 'roles'> {
  return searchParams.get('tab') === 'requests' ? 'requests' : 'roster';
}

export function companyMembersHref(companyId: string, tab: Exclude<CompanyTab, 'roles'> = 'roster') {
  const base = `/companies/${companyId}/members`;
  return tab === 'requests' ? `${base}?tab=requests` : base;
}

function tabHref(companyId: string, tab: CompanyTab, inSettings: boolean): string {
  if (inSettings) return organizationSettingsHref(tab === 'roster' ? undefined : tab);
  return tab === 'roles' ? `/companies/${companyId}/roles` : companyMembersHref(companyId, tab);
}

export function CompanyTabs({
  companyId,
  current,
  inSettings = false,
}: {
  companyId: string;
  current: CompanyTab;
  /** Inside Settings › Organization the tabs stay in Settings. */
  inSettings?: boolean;
}) {
  const tabClass = (selected: boolean) =>
    `rounded-[var(--radius-pill)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
      selected
        ? 'bg-[var(--surface-subtle)] text-[var(--ink)]'
        : 'text-[var(--ink-secondary)] hover:text-[var(--ink)]'
    }`;

  return (
    <nav aria-label="Company administration" className="flex gap-[var(--space-2)]">
      <Link
        href={tabHref(companyId, 'roster', inSettings)}
        aria-current={current === 'roster' ? 'page' : undefined}
        className={tabClass(current === 'roster')}
      >
        Roster
      </Link>
      <Link
        href={tabHref(companyId, 'requests', inSettings)}
        aria-current={current === 'requests' ? 'page' : undefined}
        className={tabClass(current === 'requests')}
      >
        Permission requests
      </Link>
      <Link
        href={tabHref(companyId, 'roles', inSettings)}
        aria-current={current === 'roles' ? 'page' : undefined}
        className={tabClass(current === 'roles')}
      >
        Roles
      </Link>
    </nav>
  );
}
