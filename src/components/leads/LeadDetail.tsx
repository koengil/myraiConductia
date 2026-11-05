'use client';

import * as React from 'react';

import {
  RELATIONSHIP_TYPES,
  STRENGTH_LEVELS,
  DECISION_ROLES,
  MOTIVATIONS,
  STANCES,
} from '@/lib/constants/leadMaps';
import { crmPersonFocusId } from '@/lib/leads/crmLeadsNavigation';
import { PERSON_SEARCH_SCOPE } from '@/lib/people/types';
import { PersonCombobox } from '@/components/people/PersonCombobox';

/**
 * The lead-map endpoints answered 403. Several predicates deny here (a
 * revoked View Leads, a research/trading wall, a lead owned by another
 * company), so the copy states the outcome, never the cause.
 */
class LeadMapsForbiddenError extends Error {}

type Relationship = {
  id: string;
  person_name: string;
  relationship_type: string;
  strength: string;
};

type Stakeholder = {
  id: string;
  name: string;
  role_in_decision: string;
  motivation: string;
  stance: string;
};

function personNameMatches(actual: string, target: string | undefined): boolean {
  if (!target) return false;
  return actual.trim().toLowerCase() === target.trim().toLowerCase();
}

function highlightedRowClass(selected: boolean): string {
  return selected
    ? 'border-[var(--accent)] bg-[var(--surface-warm)] ring-1 ring-[var(--accent)]'
    : 'border-[var(--stroke)] bg-[var(--surface)]';
}

export interface LeadDetailProps {
  leadId: string;
  leadName: string;
  highlightPersonName?: string;
  /** Bump after a skill writes people back onto the maps. */
  reloadKey?: number;
}

/**
 * LeadDetail — the per-lead expansion panel mounted from LeadList (Task 4b).
 * Loads the lead's persisted relationship map + stakeholder map on mount,
 * renders them, and lets the MD add (POST) or remove (DELETE) entries
 * against this existing lead. No confidentiality gating and no edit-in-place
 * (add and remove only), matching the register-form's row shape.
 */
export function LeadDetail({
  leadId,
  leadName,
  highlightPersonName,
  reloadKey = 0,
}: LeadDetailProps) {
  const [relationships, setRelationships] = React.useState<Relationship[]>([]);
  const [stakeholders, setStakeholders] = React.useState<Stakeholder[]>([]);
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'error' | 'forbidden'>(
    'loading',
  );

  React.useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`/api/v1/companies/${leadId}/relationships`, {
        headers: { Accept: 'application/json' },
      }).then(async (res) => {
        if (res.status === 403) throw new LeadMapsForbiddenError();
        if (!res.ok) throw new Error(`relationships: ${res.status}`);
        return (await res.json()) as { relationships?: Relationship[] };
      }),
      fetch(`/api/v1/companies/${leadId}/stakeholders`, {
        headers: { Accept: 'application/json' },
      }).then(async (res) => {
        if (res.status === 403) throw new LeadMapsForbiddenError();
        if (!res.ok) throw new Error(`stakeholders: ${res.status}`);
        return (await res.json()) as { stakeholders?: Stakeholder[] };
      }),
    ])
      .then(([relData, stkData]) => {
        if (cancelled) return;
        setRelationships(relData.relationships ?? []);
        setStakeholders(stkData.stakeholders ?? []);
        setStatus('ready');
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setStatus(reason instanceof LeadMapsForbiddenError ? 'forbidden' : 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [leadId, reloadKey]);

  React.useEffect(() => {
    if (!highlightPersonName || status !== 'ready') return;
    const element = document.getElementById(crmPersonFocusId(highlightPersonName));
    element?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [highlightPersonName, status, relationships, stakeholders]);

  return (
    <div
      aria-label={`Detail for ${leadName}`}
      className="mt-[var(--space-2)] flex flex-col gap-[var(--space-4)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface-raised)] p-[var(--space-4)]"
    >
      {status === 'loading' ? (
        <p role="status" className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          Loading…
        </p>
      ) : status === 'forbidden' ? (
        <p role="alert" className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          This account cannot view this lead&apos;s maps.
        </p>
      ) : status === 'error' ? (
        <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative)]">
          Could not load this lead&apos;s maps. Try again shortly.
        </p>
      ) : (
        <>
          <RelationshipsSection
            leadId={leadId}
            relationships={relationships}
            setRelationships={setRelationships}
            highlightPersonName={highlightPersonName}
          />
          <StakeholdersSection
            leadId={leadId}
            stakeholders={stakeholders}
            setStakeholders={setStakeholders}
            highlightPersonName={highlightPersonName}
          />
        </>
      )}
    </div>
  );
}

function RelationshipsSection({
  leadId,
  relationships,
  setRelationships,
  highlightPersonName,
}: {
  leadId: string;
  relationships: Relationship[];
  setRelationships: React.Dispatch<React.SetStateAction<Relationship[]>>;
  highlightPersonName?: string;
}) {
  const [formOpen, setFormOpen] = React.useState(false);
  const [personName, setPersonName] = React.useState('');
  const [personSelected, setPersonSelected] = React.useState(false);
  const [relationshipType, setRelationshipType] = React.useState<string>(RELATIONSHIP_TYPES[0]);
  const [strength, setStrength] = React.useState<string>(STRENGTH_LEVELS[1]);
  const [error, setError] = React.useState<string | null>(null);

  function resetForm() {
    setPersonName('');
    setPersonSelected(false);
    setRelationshipType(RELATIONSHIP_TYPES[0]);
    setStrength(STRENGTH_LEVELS[1]);
    setError(null);
    setFormOpen(false);
  }

  async function handleSave() {
    const trimmed = personName.trim();
    if (!trimmed) return;
    setError(null);
    try {
      const res = await fetch(`/api/v1/companies/${leadId}/relationships`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          person_name: trimmed,
          relationship_type: relationshipType,
          strength,
        }),
      });
      if (!res.ok) {
        setError('That relationship could not be saved. Try again.');
        return;
      }
      const { relationship } = (await res.json()) as { relationship: Relationship };
      setRelationships((rows) => [relationship, ...rows]);
      resetForm();
    } catch {
      setError('That relationship could not be saved. Try again.');
    }
  }

  async function handleRemove(entry: Relationship) {
    try {
      const res = await fetch(`/api/v1/companies/${leadId}/relationships/${entry.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        setError('That relationship could not be removed. Try again.');
        return;
      }
      setRelationships((rows) => rows.filter((r) => r.id !== entry.id));
    } catch {
      setError('That relationship could not be removed. Try again.');
    }
  }

  return (
    <div className="flex flex-col gap-[var(--space-2)]">
      <h3 className="bank-label">Relationships</h3>

      {relationships.length === 0 ? (
        <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">No relationships yet.</p>
      ) : (
        <ul className="flex list-none flex-col gap-[var(--space-2)] p-0">
          {relationships.map((r) => {
            const selected = personNameMatches(r.person_name, highlightPersonName);
            return (
            <li
              key={r.id}
              id={selected ? crmPersonFocusId(r.person_name) : undefined}
              aria-current={selected ? 'true' : undefined}
              className={`flex min-h-[44px] items-center justify-between gap-[var(--space-3)] rounded-[var(--radius-input)] border px-[var(--space-3)] py-[var(--space-2)] ${highlightedRowClass(selected)}`}
            >
              <div className="flex flex-col">
                <span className="text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
                  {r.person_name}
                </span>
                <span className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                  {r.relationship_type} · {r.strength}
                </span>
              </div>
              <button
                type="button"
                onClick={() => handleRemove(r)}
                aria-label={`Remove relationship ${r.person_name}`}
                className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-xs)] text-[var(--ink-secondary)] transition-colors hover:border-[var(--negative)] hover:text-[var(--negative)]"
              >
                Remove
              </button>
            </li>
            );
          })}
        </ul>
      )}

      {error ? (
        <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative)]">
          {error}
        </p>
      ) : null}

      {formOpen ? (
        <div className="flex flex-col gap-[var(--space-3)] rounded-[var(--radius-input)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-3)]">
          <div className="grid grid-cols-1 gap-[var(--space-3)] sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="bank-label">Person</span>
              <PersonCombobox
                aria-label="Person"
                value={personName}
                onChange={(value, selected) => {
                  setPersonName(value);
                  setPersonSelected(selected === true);
                }}
                scope={PERSON_SEARCH_SCOPE.COMPANY_EMPLOYEES}
                requireSelection
                placeholder="Select an employee"
                className="w-full"
              />
            </label>
            <SelectField
              label="Relationship type"
              value={relationshipType}
              onChange={setRelationshipType}
              options={RELATIONSHIP_TYPES}
            />
            <SelectField
              label="Strength"
              value={strength}
              onChange={setStrength}
              options={STRENGTH_LEVELS}
            />
          </div>
          <div className="flex gap-[var(--space-2)]">
            <button
              type="button"
              onClick={handleSave}
              disabled={!personName.trim() || !personSelected}
              className="rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-xs)] font-semibold text-white transition-colors hover:bg-[var(--accent-dark)] disabled:opacity-60"
            >
              Save relationship
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button
            type="button"
            onClick={() => setFormOpen(true)}
            className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            Add relationship
          </button>
        </div>
      )}
    </div>
  );
}

function StakeholdersSection({
  leadId,
  stakeholders,
  setStakeholders,
  highlightPersonName,
}: {
  leadId: string;
  stakeholders: Stakeholder[];
  setStakeholders: React.Dispatch<React.SetStateAction<Stakeholder[]>>;
  highlightPersonName?: string;
}) {
  const [formOpen, setFormOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [roleInDecision, setRoleInDecision] = React.useState<string>(DECISION_ROLES[0]);
  const [motivation, setMotivation] = React.useState<string>(MOTIVATIONS[0]);
  const [stance, setStance] = React.useState<string>(STANCES[1]);
  const [error, setError] = React.useState<string | null>(null);

  function resetForm() {
    setName('');
    setRoleInDecision(DECISION_ROLES[0]);
    setMotivation(MOTIVATIONS[0]);
    setStance(STANCES[1]);
    setError(null);
    setFormOpen(false);
  }

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    try {
      const res = await fetch(`/api/v1/companies/${leadId}/stakeholders`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: trimmed,
          role_in_decision: roleInDecision,
          motivation,
          stance,
        }),
      });
      if (!res.ok) {
        setError('That stakeholder could not be saved. Try again.');
        return;
      }
      const { stakeholder } = (await res.json()) as { stakeholder: Stakeholder };
      setStakeholders((rows) => [stakeholder, ...rows]);
      resetForm();
    } catch {
      setError('That stakeholder could not be saved. Try again.');
    }
  }

  async function handleRemove(entry: Stakeholder) {
    try {
      const res = await fetch(`/api/v1/companies/${leadId}/stakeholders/${entry.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        setError('That stakeholder could not be removed. Try again.');
        return;
      }
      setStakeholders((rows) => rows.filter((s) => s.id !== entry.id));
    } catch {
      setError('That stakeholder could not be removed. Try again.');
    }
  }

  return (
    <div className="flex flex-col gap-[var(--space-2)]">
      <h3 className="bank-label">Stakeholders</h3>

      {stakeholders.length === 0 ? (
        <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">No stakeholders yet.</p>
      ) : (
        <ul className="flex list-none flex-col gap-[var(--space-2)] p-0">
          {stakeholders.map((s) => {
            const selected = personNameMatches(s.name, highlightPersonName);
            return (
            <li
              key={s.id}
              id={selected ? crmPersonFocusId(s.name) : undefined}
              aria-current={selected ? 'true' : undefined}
              className={`flex min-h-[44px] items-center justify-between gap-[var(--space-3)] rounded-[var(--radius-input)] border px-[var(--space-3)] py-[var(--space-2)] ${highlightedRowClass(selected)}`}
            >
              <div className="flex flex-col">
                <span className="text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
                  {s.name}
                </span>
                <span className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                  {s.role_in_decision} · {s.stance}
                </span>
              </div>
              <button
                type="button"
                onClick={() => handleRemove(s)}
                aria-label={`Remove stakeholder ${s.name}`}
                className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-xs)] text-[var(--ink-secondary)] transition-colors hover:border-[var(--negative)] hover:text-[var(--negative)]"
              >
                Remove
              </button>
            </li>
            );
          })}
        </ul>
      )}

      {error ? (
        <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative)]">
          {error}
        </p>
      ) : null}

      {formOpen ? (
        <div className="flex flex-col gap-[var(--space-3)] rounded-[var(--radius-input)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-3)]">
          <div className="grid grid-cols-1 gap-[var(--space-3)] sm:grid-cols-2">
            <TextField label="Name" value={name} onChange={setName} />
            <SelectField
              label="Role in decision"
              value={roleInDecision}
              onChange={setRoleInDecision}
              options={DECISION_ROLES}
            />
            <SelectField
              label="Motivation"
              value={motivation}
              onChange={setMotivation}
              options={MOTIVATIONS}
            />
            <SelectField label="Stance" value={stance} onChange={setStance} options={STANCES} />
          </div>
          <div className="flex gap-[var(--space-2)]">
            <button
              type="button"
              onClick={handleSave}
              disabled={!name.trim()}
              className="rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-xs)] font-semibold text-white transition-colors hover:bg-[var(--accent-dark)] disabled:opacity-60"
            >
              Save stakeholder
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button
            type="button"
            onClick={() => setFormOpen(true)}
            className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
          >
            Add stakeholder
          </button>
        </div>
      )}
    </div>
  );
}

// --- Small field primitives, local to this panel (token-driven, matching the
// LeadRegistration input pattern) --------------------------------------------

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="bank-label">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-[var(--radius-input)] border-0 bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-base)] text-[var(--ink)] placeholder:text-[var(--ink-quiet)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]"
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="bank-label">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-[var(--radius-input)] border-0 bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-base)] text-[var(--ink)] placeholder:text-[var(--ink-quiet)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]"
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </label>
  );
}

export default LeadDetail;
