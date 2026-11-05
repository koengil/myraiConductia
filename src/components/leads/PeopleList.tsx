'use client';

import * as React from 'react';

import { Gate0LeadLoader } from '@/components/wizard/Gate0LeadLoader';
import type { CrmScopeContext } from '@/lib/leads/crmScope';

type CrmPerson = {
  id: string;
  name: string;
  email: string | null;
  title: string | null;
  org: string | null;
};

function PeopleListBody({ scope }: { scope?: CrmScopeContext }) {
  const [people, setPeople] = React.useState<CrmPerson[]>([]);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');

  React.useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/crm-people', {
      headers: { Accept: 'application/json' },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`crm-people: ${res.status}`);
        return (await res.json()) as { people?: CrmPerson[] };
      })
      .then((data) => {
        if (cancelled) return;
        setPeople(data.people ?? []);
        setStatus('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      {status === 'loading' ? (
        <Gate0LeadLoader />
      ) : status === 'error' ? (
        <p className="text-[length:var(--text-sm)] text-[var(--negative)]">
          Could not load people. Try again shortly.
        </p>
      ) : people.length === 0 ? (
        <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          {scope?.orgName
            ? `No people in ${scope.orgName}'s catalog yet. Add stakeholders or relationships on a lead company.`
            : 'No people yet. Add stakeholders or relationships on a lead company to populate this catalog.'}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-[var(--stroke)]">
          {people.map((person) => (
            <li
              key={person.id}
              className="flex flex-col gap-0.5 py-[var(--space-3)] first:pt-0 last:pb-0"
            >
              <span className="font-medium text-[var(--ink)]">{person.name}</span>
              <span className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
                {[person.title, person.org, person.email].filter(Boolean).join(' · ') ||
                  'No details yet'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export interface PeopleListProps {
  reloadKey?: number;
  scope?: CrmScopeContext;
}

/**
 * PeopleList — CRM people catalog for /leads. Populated when stakeholders or
 * relationship contacts are saved on a lead map.
 */
export function PeopleList({ reloadKey = 0, scope }: PeopleListProps) {
  return (
    <section
      aria-label="CRM people"
      className="flex flex-col gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-5)]"
    >
      <div className="flex flex-col gap-1">
        <span className="eyebrow">Catalog</span>
        <h2 className="font-sans text-[length:var(--text-lg)] font-medium text-[var(--ink)]">
          People
        </h2>
        <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          Contacts from lead stakeholder and relationship maps in{' '}
          {scope?.orgName ? `${scope.orgName}'s catalog` : 'your organization catalog'}. Each save
          adds or updates a person here.
        </p>
      </div>

      <PeopleListBody key={reloadKey} scope={scope} />
    </section>
  );
}
