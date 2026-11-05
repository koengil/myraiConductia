'use client';

import * as React from 'react';

import { COMPANY_TYPE } from '@/lib/constants/companies';
import {
  DUPLICATE_COMPANY_NAME_CODE,
  LEAD_NAME_MAX_LENGTH,
  checkLeadName,
} from '@/lib/validation/inputPolicy';
import {
  RELATIONSHIP_TYPES,
  STRENGTH_LEVELS,
  DECISION_ROLES,
  MOTIVATIONS,
  STANCES,
} from '@/lib/constants/leadMaps';

/** Map a POST /api/v1/companies failure to a decisive, MD-facing message. No
 *  em-dashes in visible copy (brand voice). */
function errorMessageFor(status: number): string {
  switch (status) {
    case 400:
      return 'Enter a lead name to continue.';
    case 403:
      return 'You do not have permission to register a lead.';
    case 409:
      return 'Your organization already has a lead with this name.';
    default:
      return status >= 500
        ? 'Something went wrong registering the lead. Try again.'
        : 'The lead could not be registered. Review the name and try again.';
  }
}

type RelationshipDraft = {
  key: string;
  person_name: string;
  title: string;
  person_company: string;
  contact_info: string;
  relationship_type: string;
  strength: string;
  confidence: string;
  last_verified: string;
  owner: string;
  basis: string;
};

type StakeholderDraft = {
  key: string;
  name: string;
  title: string;
  org: string;
  role_in_decision: string;
  equity_pct: string;
  motivation: string;
  stance: string;
  board_seat: boolean;
  investor: boolean;
  likely_objections: string;
};

function blankRelationship(): RelationshipDraft {
  return {
    key: crypto.randomUUID(),
    person_name: '',
    title: '',
    person_company: '',
    contact_info: '',
    relationship_type: RELATIONSHIP_TYPES[0],
    strength: STRENGTH_LEVELS[1],
    confidence: STRENGTH_LEVELS[1],
    last_verified: '',
    owner: '',
    basis: '',
  };
}

function blankStakeholder(): StakeholderDraft {
  return {
    key: crypto.randomUUID(),
    name: '',
    title: '',
    org: '',
    role_in_decision: DECISION_ROLES[0],
    equity_pct: '',
    motivation: MOTIVATIONS[0],
    stance: STANCES[1],
    board_seat: false,
    investor: false,
    likely_objections: '',
  };
}

async function postRow(url: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface LeadRegistrationProps {
  /** Called once the lead is registered (POST 201), so the host can refresh the list. */
  onCreated?: () => void;
  /** When set, renders a cancel control (dialog layout). */
  onCancel?: () => void;
  /** Page embed vs modal dialog — dialog drops the outer card chrome. */
  layout?: 'page' | 'dialog';
}

/**
 * LeadRegistration — the /leads intake form (Task 2, extended by Task 4a).
 * The lead name persists via POST /api/v1/companies with the CLIENT type.
 * The relationship map and stakeholder map are repeatable row lists: each
 * filled-in row is POSTed to the company's nested /relationships or
 * /stakeholders endpoint once the company is created.
 */
export function LeadRegistration({ onCreated, onCancel, layout = 'page' }: LeadRegistrationProps) {
  const [name, setName] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [duplicateWarning, setDuplicateWarning] = React.useState<string | null>(null);
  const [confirmDuplicate, setConfirmDuplicate] = React.useState(false);

  const [relationships, setRelationships] = React.useState<RelationshipDraft[]>([]);
  const [stakeholders, setStakeholders] = React.useState<StakeholderDraft[]>([]);

  const addRelationship = () => setRelationships((rows) => [...rows, blankRelationship()]);
  const removeRelationship = (key: string) =>
    setRelationships((rows) => rows.filter((r) => r.key !== key));
  const updateRelationship = (key: string, patch: Partial<RelationshipDraft>) =>
    setRelationships((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const addStakeholder = () => setStakeholders((rows) => [...rows, blankStakeholder()]);
  const removeStakeholder = (key: string) =>
    setStakeholders((rows) => rows.filter((s) => s.key !== key));
  const updateStakeholder = (key: string, patch: Partial<StakeholderDraft>) =>
    setStakeholders((rows) => rows.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const named = checkLeadName(name);
    if (!named.ok) {
      setError(named.message);
      return;
    }
    const trimmed = named.value;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/companies', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: trimmed,
          type: COMPANY_TYPE.CLIENT,
          ...(confirmDuplicate ? { confirmDuplicate: true } : {}),
        }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: string; code?: string }
          | null;
        if (res.status === 409 && payload?.code === DUPLICATE_COMPANY_NAME_CODE) {
          setDuplicateWarning(payload.error ?? 'A company with this name is already on the platform.');
          setSubmitting(false);
          return;
        }
        setError(payload?.error ?? errorMessageFor(res.status));
        setSubmitting(false);
        return;
      }
      const { company } = (await res.json()) as { company: { id: string } };

      const rels = relationships.filter((r) => r.person_name.trim());
      const stks = stakeholders.filter((s) => s.name.trim());
      let failures = 0;

      for (const r of rels) {
        const ok = await postRow(`/api/v1/companies/${company.id}/relationships`, {
          person_name: r.person_name.trim(),
          title: r.title,
          person_company: r.person_company,
          contact_info: r.contact_info,
          relationship_type: r.relationship_type,
          strength: r.strength,
          confidence: r.confidence,
          last_verified: r.last_verified,
          owner: r.owner,
          basis: r.basis,
        });
        if (!ok) failures += 1;
      }
      for (const s of stks) {
        const ok = await postRow(`/api/v1/companies/${company.id}/stakeholders`, {
          name: s.name.trim(),
          title: s.title,
          org: s.org,
          role_in_decision: s.role_in_decision,
          equity_pct: s.equity_pct,
          motivation: s.motivation,
          stance: s.stance,
          board_seat: s.board_seat,
          investor: s.investor,
          likely_objections: s.likely_objections,
        });
        if (!ok) failures += 1;
      }

      // The lead is created; reset the whole form (name + rows). Keeping failed
      // rows behind while clearing the name would let them be re-POSTed to a
      // DIFFERENT lead the MD types next (misattribution). Failed rows are
      // re-added from the leads list (LeadDetail), per the message below.
      setName('');
      setRelationships([]);
      setStakeholders([]);
      setDuplicateWarning(null);
      setConfirmDuplicate(false);
      if (failures > 0) {
        setError(
          `The lead was registered. ${failures} ${failures === 1 ? 'entry' : 'entries'} did not save. Add them from the leads list below.`,
        );
      }
      setSubmitting(false);
      onCreated?.();
    } catch {
      setError('Network error. Check your connection and try again.');
      setSubmitting(false);
    }
  }

  const shellClass =
    layout === 'dialog'
      ? 'flex flex-col gap-[var(--space-4)]'
      : 'flex flex-col gap-[var(--space-4)] rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-5)]';
  const Shell = layout === 'dialog' ? 'div' : 'section';

  return (
    <Shell aria-label="Register a lead" className={shellClass}>
      <div className="flex flex-col gap-[var(--space-1)]">
        {/* In a dialog, the Dialog's eyebrow and title name it. */}
        {layout === 'dialog' ? null : (
          <>
            <span className="eyebrow">Leads</span>
            <h1 className="font-sans text-[length:var(--text-xl)] font-medium tracking-tight text-[var(--ink)]">
              Register a lead
            </h1>
          </>
        )}
        <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          Add the relationships and stakeholders you already know. They save
          with the lead.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-[var(--space-4)]">
        <label className="flex max-w-[420px] flex-col gap-1">
          <span className="bank-label">Lead name</span>
          <input
            type="text"
            value={name}
            maxLength={LEAD_NAME_MAX_LENGTH}
            onChange={(e) => {
              setName(e.target.value);
              setDuplicateWarning(null);
              setConfirmDuplicate(false);
            }}
            placeholder="Company name (e.g. Atlassian)"
            className="rounded-[var(--radius-input)] border-0 bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-base)] text-[var(--ink)] placeholder:text-[var(--ink-quiet)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]"
          />
        </label>

        <fieldset className="flex flex-col gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke)] p-[var(--space-4)]">
          <legend className="bank-label px-1">
            Relationship map (who-knows-whom)
          </legend>
          {relationships.map((r, i) => (
            <div
              key={r.key}
              className="flex flex-col gap-[var(--space-3)] rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)]"
            >
              <div className="grid grid-cols-1 gap-[var(--space-3)] sm:grid-cols-2">
                <TextField
                  label="Person"
                  value={r.person_name}
                  onChange={(v) => updateRelationship(r.key, { person_name: v })}
                  placeholder="Full name"
                />
                <TextField
                  label="Title"
                  value={r.title}
                  onChange={(v) => updateRelationship(r.key, { title: v })}
                  placeholder="Role or title"
                />
                <TextField
                  label="Company"
                  value={r.person_company}
                  onChange={(v) => updateRelationship(r.key, { person_company: v })}
                  placeholder="Where they work"
                />
                <TextField
                  label="Contact info"
                  value={r.contact_info}
                  onChange={(v) => updateRelationship(r.key, { contact_info: v })}
                  placeholder="Email or phone"
                />
                <SelectField
                  label="Relationship type"
                  value={r.relationship_type}
                  onChange={(v) => updateRelationship(r.key, { relationship_type: v })}
                  options={RELATIONSHIP_TYPES}
                />
                <SelectField
                  label="Strength"
                  value={r.strength}
                  onChange={(v) => updateRelationship(r.key, { strength: v })}
                  options={STRENGTH_LEVELS}
                />
                <SelectField
                  label="Confidence"
                  value={r.confidence}
                  onChange={(v) => updateRelationship(r.key, { confidence: v })}
                  options={STRENGTH_LEVELS}
                />
                <TextField
                  label="Last verified"
                  type="date"
                  value={r.last_verified}
                  onChange={(v) => updateRelationship(r.key, { last_verified: v })}
                />
                <TextField
                  label="Owner"
                  value={r.owner}
                  onChange={(v) => updateRelationship(r.key, { owner: v })}
                  placeholder="Banker holding the relationship"
                />
              </div>
              <TextAreaField
                label="Basis / evidence"
                value={r.basis}
                onChange={(v) => updateRelationship(r.key, { basis: v })}
                placeholder="Why this relationship exists"
              />
              <div>
                <button
                  type="button"
                  onClick={() => removeRelationship(r.key)}
                  aria-label={`Remove relationship ${i + 1}`}
                  className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-xs)] text-[var(--ink-secondary)] transition-colors hover:border-[var(--negative)] hover:text-[var(--negative)]"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          <div>
            <button
              type="button"
              onClick={addRelationship}
              className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              Add relationship
            </button>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-[var(--space-3)] rounded-[var(--radius-card)] border border-[var(--stroke)] p-[var(--space-4)]">
          <legend className="bank-label px-1">Stakeholder map</legend>
          {stakeholders.map((s, i) => (
            <div
              key={s.key}
              className="flex flex-col gap-[var(--space-3)] rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)]"
            >
              <div className="grid grid-cols-1 gap-[var(--space-3)] sm:grid-cols-2">
                <TextField
                  label="Name"
                  value={s.name}
                  onChange={(v) => updateStakeholder(s.key, { name: v })}
                  placeholder="Full name"
                />
                <TextField
                  label="Title"
                  value={s.title}
                  onChange={(v) => updateStakeholder(s.key, { title: v })}
                  placeholder="Role or title"
                />
                <TextField
                  label="Org"
                  value={s.org}
                  onChange={(v) => updateStakeholder(s.key, { org: v })}
                  placeholder="Organization"
                />
                <SelectField
                  label="Role in decision"
                  value={s.role_in_decision}
                  onChange={(v) => updateStakeholder(s.key, { role_in_decision: v })}
                  options={DECISION_ROLES}
                />
                <TextField
                  label="Equity %"
                  type="number"
                  value={s.equity_pct}
                  onChange={(v) => updateStakeholder(s.key, { equity_pct: v })}
                  placeholder="0"
                />
                <SelectField
                  label="Motivation"
                  value={s.motivation}
                  onChange={(v) => updateStakeholder(s.key, { motivation: v })}
                  options={MOTIVATIONS}
                />
                <SelectField
                  label="Stance toward us"
                  value={s.stance}
                  onChange={(v) => updateStakeholder(s.key, { stance: v })}
                  options={STANCES}
                />
              </div>
              <div className="flex flex-wrap items-center gap-[var(--space-4)]">
                <label className="flex items-center gap-2 text-[length:var(--text-sm)] text-[var(--ink)]">
                  <input
                    type="checkbox"
                    checked={s.board_seat}
                    onChange={(e) => updateStakeholder(s.key, { board_seat: e.target.checked })}
                    className="size-4 accent-[var(--accent)]"
                  />
                  Board seat
                </label>
                <label className="flex items-center gap-2 text-[length:var(--text-sm)] text-[var(--ink)]">
                  <input
                    type="checkbox"
                    checked={s.investor}
                    onChange={(e) => updateStakeholder(s.key, { investor: e.target.checked })}
                    className="size-4 accent-[var(--accent)]"
                  />
                  Investor
                </label>
              </div>
              <TextAreaField
                label="Likely objections"
                value={s.likely_objections}
                onChange={(v) => updateStakeholder(s.key, { likely_objections: v })}
                placeholder="What they may push back on"
              />
              <div>
                <button
                  type="button"
                  onClick={() => removeStakeholder(s.key)}
                  aria-label={`Remove stakeholder ${i + 1}`}
                  className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-xs)] text-[var(--ink-secondary)] transition-colors hover:border-[var(--negative)] hover:text-[var(--negative)]"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          <div>
            <button
              type="button"
              onClick={addStakeholder}
              className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              Add stakeholder
            </button>
          </div>
        </fieldset>

        {duplicateWarning ? (
          <div
            role="alert"
            className="flex flex-col gap-[var(--space-2)] rounded-[var(--radius-input)] bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)]"
          >
            <span>{duplicateWarning}</span>
            <div>
              <button
                type="button"
                onClick={() => {
                  setConfirmDuplicate(true);
                  setDuplicateWarning(null);
                }}
                className="rounded-[var(--radius-button)] border border-[var(--stroke-strong)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-xs)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
              >
                Register anyway
              </button>
            </div>
          </div>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="rounded-[var(--radius-input)] bg-[var(--negative-fill)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--negative-deep)]"
          >
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-[var(--space-2)]">
          <button
            type="submit"
            disabled={submitting || !name.trim()}
            className="rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-semibold text-white transition-colors hover:bg-[var(--accent-dark)] disabled:opacity-60"
          >
            {submitting ? 'Registering…' : 'Register lead'}
          </button>
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--ink-secondary)] transition-colors hover:border-[var(--ink-tertiary)] hover:text-[var(--ink)] disabled:opacity-60"
            >
              Cancel
            </button>
          ) : null}
        </div>
      </form>
    </Shell>
  );
}

// --- Small field primitives, local to this form (token-driven, matching the
// Gate0Wizard input pattern) -------------------------------------------------

function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="bank-label">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="rounded-[var(--radius-input)] border-0 bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-base)] text-[var(--ink)] placeholder:text-[var(--ink-quiet)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]"
      />
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="bank-label">{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={2}
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

export default LeadRegistration;
