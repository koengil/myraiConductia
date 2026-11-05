'use client';

import * as React from 'react';

import { CrmNetworkGraph } from '@/components/leads/CrmNetworkGraph';
import { Gate0LeadLoader } from '@/components/wizard/Gate0LeadLoader';
import type { CrmNetworkPayload } from '@/lib/leads/crmNetwork';
import { networkClusterCompanies } from '@/lib/leads/crmNetwork';
import type { CrmScopeContext } from '@/lib/leads/crmScope';

const EMPTY_NETWORK: CrmNetworkPayload = {
  clientCompany: null,
  companies: [],
  people: [],
  edges: [],
};

function CrmNetworkPreviewBody({ scope }: { scope?: CrmScopeContext }) {
  const [network, setNetwork] = React.useState<CrmNetworkPayload>(EMPTY_NETWORK);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');

  React.useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/crm-network', {
      headers: { Accept: 'application/json' },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`crm-network: ${res.status}`);
        return (await res.json()) as CrmNetworkPayload;
      })
      .then((data) => {
        if (cancelled) return;
        setNetwork(data);
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

  const legendCompanies = networkClusterCompanies(network);

  return (
    <>
      {status === 'loading' ? (
        <Gate0LeadLoader />
      ) : status === 'error' ? (
        <p className="text-[length:var(--text-sm)] text-[var(--negative)]">
          Could not load the network. Try again shortly.
        </p>
      ) : network.people.length === 0 ? (
        <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          {scope?.orgName
            ? `No network yet for ${scope.orgName}. Add stakeholders or relationships on a lead company to populate this view.`
            : 'No network yet. Add stakeholders or relationships on a lead company to populate this view.'}
        </p>
      ) : (
        <>
          <ul
            aria-label="Company color legend"
            className="flex list-none flex-wrap gap-[var(--space-4)] p-0 text-[length:var(--text-xs)] text-[var(--ink-secondary)]"
          >
            {legendCompanies.map((company) => (
              <li key={company.id} className="inline-flex items-center gap-[var(--space-2)]">
                <span
                  aria-hidden="true"
                  className="inline-block size-2.5 rounded-full"
                  style={{ backgroundColor: company.color }}
                />
                {company.kind === 'client' ? `${company.name} (your organization)` : company.name}
              </li>
            ))}
          </ul>

          <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
            Scroll to zoom. Hold Cmd or Ctrl and drag to pan.
          </p>

          <CrmNetworkGraph network={network} />
        </>
      )}
    </>
  );
}

/**
 * CrmNetworkPreview — live CRM relationship graph for the /leads Network tab.
 */
export function CrmNetworkPreview({
  scope,
  reloadKey = 0,
}: {
  scope?: CrmScopeContext;
  reloadKey?: number;
}) {
  return (
    <section
      aria-label="CRM network"
      className="flex flex-col gap-[var(--space-4)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-5)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-[var(--space-3)]">
        <div className="flex flex-col gap-1">
          <span className="eyebrow">Catalog</span>
          <h2 className="font-sans text-[length:var(--text-lg)] font-medium text-[var(--ink)]">
            Network
          </h2>
          <p className="max-w-[52ch] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
            {scope?.orgName
              ? `${scope.orgName} employees cluster under your organization; lead companies appear as labeled hubs. Dashed lines show who covers which lead; solid lines are warm paths between people.`
              : 'Employees cluster under your organization; lead companies appear as labeled hubs. Dashed lines show who covers which lead; solid lines are warm paths between people.'}
          </p>
        </div>
      </div>

      <CrmNetworkPreviewBody key={reloadKey} scope={scope} />
    </section>
  );
}
