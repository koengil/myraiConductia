'use client';

import * as React from 'react';

export type LeadsCrmTab = 'companies' | 'people' | 'network';

const TAB_ITEMS: { id: LeadsCrmTab; label: string }[] = [
  { id: 'companies', label: 'Companies' },
  { id: 'people', label: 'People' },
  { id: 'network', label: 'Network' },
];

export function LeadsCrmTabs({
  value,
  onChange,
}: {
  value: LeadsCrmTab;
  onChange: (tab: LeadsCrmTab) => void;
}) {
  const tabClass = (selected: boolean) =>
    `inline-flex min-h-[36px] items-center rounded-[var(--radius-pill)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium transition-colors ${
      selected
        ? 'bg-[var(--surface-subtle)] text-[var(--ink)]'
        : 'text-[var(--ink-secondary)] hover:text-[var(--ink)]'
    }`;

  return (
    <nav aria-label="CRM catalog" className="flex gap-[var(--space-2)]">
      {TAB_ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          aria-controls={`leads-crm-panel-${item.id}`}
          id={`leads-crm-tab-${item.id}`}
          onClick={() => onChange(item.id)}
          className={tabClass(value === item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
