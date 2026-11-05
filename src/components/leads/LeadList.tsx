'use client';

import * as React from 'react';
import { Plus } from 'lucide-react';

import { AccessNeededPanel } from '@/components/access/AccessNeededPanel';
import { Gate0LeadLoader } from '@/components/wizard/Gate0LeadLoader';
import { LeadDetail } from '@/components/leads/LeadDetail';
import { LeadSkillDialog } from '@/components/leads/LeadSkillDialog';
import { LeadSkillSelector } from '@/components/leads/LeadSkillSelector';
import { RegisterLeadDialog } from '@/components/leads/RegisterLeadDialog';
import { ACCESS_DESTINATION } from '@/lib/constants/accessRequests';
import { COMPANY_TYPE } from '@/lib/constants/companies';
import type { CrmScopeContext } from '@/lib/leads/crmScope';
import { freshCanCreateLead } from '@/lib/leads/freshCanCreateLead';
import type { LeadSkillId } from '@/lib/leads/leadSkills';

type LeadCompany = { id: string; name: string; type: string };

function LeadRow({
  lead,
  expanded,
  onToggle,
  highlightPersonName,
}: {
  lead: LeadCompany;
  expanded: boolean;
  onToggle: () => void;
  highlightPersonName?: string;
}) {
  const [skillId, setSkillId] = React.useState<LeadSkillId | null>(null);
  const [mapsEpoch, setMapsEpoch] = React.useState(0);

  return (
    <li className="border-b border-[var(--stroke)] px-[var(--space-2)] py-[var(--space-2)] last:border-b-0">
      <div className="flex items-center justify-between gap-[var(--space-3)]">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-h-[44px] min-w-0 flex-1 items-center text-left text-[length:var(--text-sm)] font-medium text-[var(--ink)]"
        >
          <span className="min-w-0 truncate" title={lead.name}>
            {lead.name}
          </span>
        </button>
        {expanded ? <LeadSkillSelector leadName={lead.name} onSelect={setSkillId} /> : null}
      </div>
      {expanded ? (
        <LeadDetail
          leadId={lead.id}
          leadName={lead.name}
          highlightPersonName={highlightPersonName}
          reloadKey={mapsEpoch}
        />
      ) : null}
      <LeadSkillDialog
        skillId={skillId}
        companyId={lead.id}
        companyName={lead.name}
        onClose={() => setSkillId(null)}
        onApplied={() => setMapsEpoch((key) => key + 1)}
      />
    </li>
  );
}

export interface LeadListProps {
  /** Bump to force a refetch (e.g. after a new lead is registered elsewhere). */
  reloadKey?: number;
  /** When true, the + control opens the create form; otherwise the permission wall. */
  canCreate?: boolean;
  scope?: CrmScopeContext;
  focusLeadId?: string;
  focusPersonName?: string;
}

type LeadListBodyProps = {
  scope?: CrmScopeContext;
  focusLeadId?: string;
  focusPersonName?: string;
  expandedId: string | null;
  onExpandedIdChange: (id: string | null) => void;
  onRegisterOpen: () => void;
};

function LeadListBody({
  scope,
  focusLeadId,
  focusPersonName,
  expandedId,
  onExpandedIdChange,
  onRegisterOpen,
}: LeadListBodyProps) {
  const [leads, setLeads] = React.useState<LeadCompany[]>([]);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error' | 'forbidden'>(
    'loading',
  );

  React.useEffect(() => {
    let cancelled = false;
    fetch(`/api/v1/companies?type=${COMPANY_TYPE.CLIENT}`, {
      headers: { Accept: 'application/json' },
    })
      .then(async (res) => {
        // A 403 on a page that was already open means the permission was
        // revoked under the session: that is an access answer, not an outage.
        if (res.status === 403) return null;
        if (!res.ok) throw new Error(`leads: ${res.status}`);
        return (await res.json()) as { companies?: LeadCompany[] };
      })
      .then((data) => {
        if (cancelled) return;
        if (data === null) {
          setStatus('forbidden');
          return;
        }
        setLeads(data.companies ?? []);
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

  if (status === 'forbidden') {
    return <AccessNeededPanel destination={ACCESS_DESTINATION.LEADS} headingLevel={2} />;
  }

  return (
    <section
      aria-label="Registered leads"
      className="flex flex-col gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-5)]"
    >
      <div className="flex items-start justify-between gap-[var(--space-3)]">
        <div className="flex flex-col gap-1">
          <span className="eyebrow">Registered</span>
          <h2 className="font-sans text-[length:var(--text-lg)] font-medium text-[var(--ink)]">
            Leads
          </h2>
        </div>
        <button
          type="button"
          onClick={onRegisterOpen}
          aria-label="Register a lead"
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-button)] border border-[var(--stroke)] text-[var(--ink)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
        >
          <Plus className="size-4" aria-hidden="true" />
        </button>
      </div>

      {status === 'loading' ? (
        <Gate0LeadLoader />
      ) : status === 'error' ? (
        <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative)]">
          Could not load leads. Try again shortly.
        </p>
      ) : leads.length === 0 ? (
        <p role="status" className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          {scope?.orgName
            ? `No lead companies registered for ${scope.orgName} yet.`
            : 'No leads registered yet.'}
        </p>
      ) : (
        <ul className="flex list-none flex-col p-0">
          {leads.map((lead) => (
            <LeadRow
              key={lead.id}
              lead={lead}
              expanded={expandedId === lead.id}
              onToggle={() => onExpandedIdChange(expandedId === lead.id ? null : lead.id)}
              highlightPersonName={focusLeadId === lead.id ? focusPersonName : undefined}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * LeadList — the registered-leads list for /leads (Task 2). Reads
 * GET /api/v1/companies?type=client, tenant-scoped server-side. No search or
 * pagination here (YAGNI): that is the platform-level /companies surface's
 * job; this is a simple confirmation list for the lead-registration flow.
 */
export function LeadList({
  reloadKey: reloadKeyProp = 0,
  canCreate = false,
  scope,
  focusLeadId,
  focusPersonName,
}: LeadListProps) {
  const [registerOpen, setRegisterOpen] = React.useState(false);
  const [allowed, setAllowed] = React.useState(canCreate);
  const [prevCanCreate, setPrevCanCreate] = React.useState(canCreate);
  if (canCreate !== prevCanCreate) {
    setPrevCanCreate(canCreate);
    setAllowed(canCreate);
  }
  const [reloadKey, setReloadKey] = React.useState(reloadKeyProp);
  const [prevReloadKeyProp, setPrevReloadKeyProp] = React.useState(reloadKeyProp);
  if (reloadKeyProp !== prevReloadKeyProp) {
    setPrevReloadKeyProp(reloadKeyProp);
    setReloadKey(reloadKeyProp);
  }

  const [expandedId, setExpandedId] = React.useState<string | null>(focusLeadId ?? null);
  const [prevFocusLeadId, setPrevFocusLeadId] = React.useState(focusLeadId);
  if (focusLeadId !== prevFocusLeadId) {
    setPrevFocusLeadId(focusLeadId);
    if (focusLeadId) setExpandedId(focusLeadId);
  }

  return (
    <>
      <LeadListBody
        key={reloadKey}
        scope={scope}
        focusLeadId={focusLeadId}
        focusPersonName={focusPersonName}
        expandedId={expandedId}
        onExpandedIdChange={setExpandedId}
        onRegisterOpen={() => {
          void (async () => {
            const next = await freshCanCreateLead();
            if (next) setAllowed(true);
            setRegisterOpen(true);
          })();
        }}
      />

      <RegisterLeadDialog
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        allowed={allowed}
        onGranted={() => setAllowed(true)}
        onCreated={() => {
          setReloadKey((key) => key + 1);
          setRegisterOpen(false);
        }}
      />
    </>
  );
}

export default LeadList;
