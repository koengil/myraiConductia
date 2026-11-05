'use client';

import * as React from 'react';
import Link from 'next/link';

import {
  DECISION_ROLES,
  MOTIVATIONS,
  PATH_TYPES,
  RELATIONSHIP_TYPES,
  STANCES,
  STRENGTH_LEVELS,
} from '@/lib/constants/leadMaps';
import { useDealTargetCompany } from '@/lib/leads/useDealTargetCompany';
import { logAudit } from '@/lib/audit/store';
import { useActiveDeal } from '@/lib/deals/useDeals';
import { RELATIONSHIP_PATHING_STEP_ID } from '@/lib/rail/dealRail';
import { useFlag } from '@/lib/flags/FlagsContext';
import { Markdown } from '@/components/atoms';
import { PersonCombobox } from '@/components/people/PersonCombobox';
import { PERSON_SEARCH_SCOPE } from '@/lib/people/types';
import { PATHING_BRIEF_FIELD, STEP_WORK_EVENT } from '@/lib/ignatious/stepSkillIo';
import { COMPLETE_CURRENT_FIRST, SEAT_CANNOT_ACT } from './stepActionCopy';

type Relationship = {
  id: string;
  person_name: string;
  relationship_type: string;
  strength: string;
  confidence?: string;
};

type Stakeholder = {
  id: string;
  name: string;
  role_in_decision: string;
  motivation: string;
  stance: string;
  board_seat?: boolean;
  investor?: boolean;
};

type WarmPath = {
  id: string;
  stakeholder_id: string;
  relationship_id: string | null;
  path_type: string;
  approved: boolean;
  approved_by: string | null;
  approved_on: string | null;
};

export interface RelationshipPathingPanelProps {
  dealId: string;
  /** When false, paths can be drafted but not approved (cursor not on this step). */
  canApprove?: boolean;
  /** The viewer's seat cannot complete this step (an Observer): say so, never offer it. */
  seatBlocked?: boolean;
  /** Completed step: show the filed paths, no add or approve. */
  readOnly?: boolean;
  /** Called after the banker approves at least one path. */
  onApproved?: (currentStepId?: string | null) => void;
}

const COLD_VALUE = '__cold__';

/**
 * RelationshipPathingPanel — Seq 8 live surface. Loads the lead's stakeholders,
 * firm-side relationships, and saved paths from /api/v1, lets the MD pick an
 * introducer per target stakeholder, and approves the path before outreach.
 */
export function RelationshipPathingPanel({
  dealId,
  canApprove: cursorHere = true,
  seatBlocked = false,
  readOnly = false,
  onApproved,
}: RelationshipPathingPanelProps) {
  const [refused, setRefused] = React.useState(false);
  const canApprove = cursorHere && !seatBlocked && !refused;
  const approveReasonId = React.useId();
  const actionErrorId = React.useId();
  const deal = useActiveDeal(dealId);
  const target = useDealTargetCompany(dealId);
  const apiEnabled = useFlag('gate0_api_create');
  const [relationships, setRelationships] = React.useState<Relationship[]>([]);
  const [stakeholders, setStakeholders] = React.useState<Stakeholder[]>([]);
  const [paths, setPaths] = React.useState<WarmPath[]>([]);
  const [loadStatus, setLoadStatus] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [savingStakeholderId, setSavingStakeholderId] = React.useState<string | null>(null);
  const [approving, setApproving] = React.useState(false);
  const [skillBrief, setSkillBrief] = React.useState('');

  const companyId = target.status === 'ready' ? target.companyId : null;

  React.useEffect(() => {
    function briefFromWork(work: Record<string, unknown> | undefined): string {
      const raw = work?.[PATHING_BRIEF_FIELD];
      return typeof raw === 'string' ? raw.trim() : '';
    }

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/v1/deals/${encodeURIComponent(dealId)}/steps/${RELATIONSHIP_PATHING_STEP_ID}`,
          { credentials: 'include', headers: { Accept: 'application/json' } },
        );
        if (!res.ok) return;
        const body = (await res.json()) as { step?: { work?: Record<string, unknown> } };
        if (!cancelled) setSkillBrief(briefFromWork(body.step?.work));
      } catch {
        // Step work is optional; the maps still render.
      }
    })();

    function onSkillWork(event: Event) {
      const detail = (
        event as CustomEvent<{
          dealId: string;
          stepId: string;
          work: Record<string, unknown>;
          applied?: boolean;
        }>
      ).detail;
      if (detail?.dealId !== dealId || detail.stepId !== RELATIONSHIP_PATHING_STEP_ID) return;
      if (!detail.applied) return;
      setSkillBrief(briefFromWork(detail.work));
    }
    window.addEventListener(STEP_WORK_EVENT, onSkillWork);
    return () => {
      cancelled = true;
      window.removeEventListener(STEP_WORK_EVENT, onSkillWork);
    };
  }, [dealId]);

  React.useEffect(() => {
    if (!companyId) return;
    let cancelled = false;

    void (async () => {
      setLoadStatus('loading');
      setActionError(null);

      try {
        const [relData, stkData, pathData] = await Promise.all([
          fetch(`/api/v1/companies/${companyId}/relationships`, {
            headers: { Accept: 'application/json' },
          }).then(async (res) => {
            if (!res.ok) throw new Error(`relationships: ${res.status}`);
            return (await res.json()) as { relationships?: Relationship[] };
          }),
          fetch(`/api/v1/companies/${companyId}/stakeholders`, {
            headers: { Accept: 'application/json' },
          }).then(async (res) => {
            if (!res.ok) throw new Error(`stakeholders: ${res.status}`);
            return (await res.json()) as { stakeholders?: Stakeholder[] };
          }),
          fetch(`/api/v1/companies/${companyId}/paths`, {
            headers: { Accept: 'application/json' },
          }).then(async (res) => {
            if (!res.ok) throw new Error(`paths: ${res.status}`);
            return (await res.json()) as { paths?: WarmPath[] };
          }),
        ]);
        if (cancelled) return;
        setRelationships(relData.relationships ?? []);
        setStakeholders(stkData.stakeholders ?? []);
        setPaths(pathData.paths ?? []);
        setLoadStatus('ready');
      } catch {
        if (cancelled) return;
        setLoadStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [companyId]);

  const pathByStakeholder = React.useMemo(() => {
    const map = new Map<string, WarmPath>();
    for (const path of paths) map.set(path.stakeholder_id, path);
    return map;
  }, [paths]);

  const relationshipById = React.useMemo(() => {
    const map = new Map<string, Relationship>();
    for (const rel of relationships) map.set(rel.id, rel);
    return map;
  }, [relationships]);

  const approvedCount = paths.filter((p) => p.approved).length;
  const decisionMakers = stakeholders.filter((s) => s.role_in_decision === 'decision-maker');
  const pendingPaths = stakeholders.filter((s) => {
    const path = pathByStakeholder.get(s.id);
    return Boolean(path && !path.approved);
  });
  const unmappedCount = stakeholders.filter((s) => !pathByStakeholder.has(s.id)).length;
  // Every path approved but the step still open (a completion that failed, or
  // a reload after one): the button completes the step on its own (#250).
  const readyToComplete =
    pendingPaths.length === 0 && unmappedCount === 0 && approvedCount > 0;
  const approveDisabled =
    !canApprove || approving || (pendingPaths.length === 0 && !readyToComplete);
  // The visible reason a disabled approve has, linked by aria-describedby.
  const blockedReason = seatBlocked || refused ? SEAT_CANNOT_ACT : !cursorHere ? COMPLETE_CURRENT_FIRST : null;
  const approveDisabledTitle = blockedReason
    ? blockedReason
    : unmappedCount > 0
      ? 'Choose an introducer or Cold for each stakeholder first'
      : pendingPaths.length === 0 && !readyToComplete
        ? 'No drafted paths to approve'
        : undefined;
  const approveHint = blockedReason
    ? ''
    : unmappedCount > 0
      ? ` · Choose an introducer or Cold for ${unmappedCount} stakeholder${unmappedCount === 1 ? '' : 's'}`
      : '';

  async function savePath(
    stakeholderId: string,
    selection: string,
    approve = false,
  ): Promise<boolean> {
    if (!companyId) return false;
    setSavingStakeholderId(stakeholderId);
    setActionError(null);

    const isCold = selection === COLD_VALUE;
    const body = {
      stakeholder_id: stakeholderId,
      path_type: isCold ? PATH_TYPES[1] : PATH_TYPES[0],
      relationship_id: isCold ? null : selection,
      approve,
    };

    try {
      const res = await fetch(`/api/v1/companies/${companyId}/paths`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setActionError('That path could not be saved. Try again.');
        return false;
      }
      const { path } = (await res.json()) as { path: WarmPath };
      setPaths((rows) => {
        const rest = rows.filter((r) => r.stakeholder_id !== stakeholderId);
        return [path, ...rest];
      });
      if (approve) {
        logAudit('step', 'Approved relationship path', stakeholderId, {
          deal: deal.codename,
        });
      }
      return true;
    } catch {
      setActionError('That path could not be saved. Try again.');
      return false;
    } finally {
      setSavingStakeholderId(null);
    }
  }

  async function handleApproveAll() {
    if (!canApprove) return;
    const pending = stakeholders.filter((s) => {
      const path = pathByStakeholder.get(s.id);
      return path && !path.approved;
    });
    if (!pending.length && !readyToComplete) return;

    setApproving(true);
    setActionError(null);
    let ok = true;
    for (const stakeholder of pending) {
      const path = pathByStakeholder.get(stakeholder.id)!;
      const selection =
        path.path_type === 'cold' || !path.relationship_id
          ? COLD_VALUE
          : path.relationship_id;
      const saved = await savePath(stakeholder.id, selection, true);
      if (!saved) ok = false;
    }
    setApproving(false);
    if (ok) {
      let currentStepId: string | null | undefined;
      if (canApprove && apiEnabled) {
        // Advance only when the server accepted the completion (#250): a
        // refused or failed PATCH would otherwise move the rail client-side.
        const completed = await fetch(
          `/api/v1/deals/${encodeURIComponent(dealId)}/steps/${RELATIONSHIP_PATHING_STEP_ID}`,
          {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ complete: true }),
          },
        )
          .then(async (res) =>
            res.ok
              ? { ok: true as const, body: (await res.json()) as { currentStepId: string | null } }
              : { ok: false as const, status: res.status },
          )
          .catch(() => ({ ok: false as const, status: 0 }));
        if (!completed.ok) {
          // The copy follows what actually happened: a 403 is the
          // seat; "The paths are saved" only when paths were saved just now.
          if (completed.status === 403) {
            setRefused(true);
            setActionError(SEAT_CANNOT_ACT);
          } else {
            setActionError(
              pending.length > 0
                ? 'The paths are saved, but the step could not be completed. Try again.'
                : 'The step could not be completed. Try again.',
            );
          }
          return;
        }
        currentStepId = completed.body.currentStepId;
      }
      onApproved?.(currentStepId);
    }
  }

  if (target.status === 'loading' || (target.status === 'ready' && loadStatus === 'loading')) {
    return (
      <p role="status" className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        Loading relationship paths…
      </p>
    );
  }

  if (target.status === 'none') {
    return (
      <div className="rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface-subtle)] p-[var(--space-4)]">
        <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">{target.reason}</p>
        <Link
          href="/leads"
          className="mt-[var(--space-3)] inline-block text-[length:var(--text-sm)] font-medium text-[var(--accent)] underline underline-offset-4"
        >
          Register a lead
        </Link>
      </div>
    );
  }

  if (target.status === 'error' || loadStatus === 'error') {
    return (
      <p role="alert" className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
        Could not load relationship paths. Try again shortly.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-[var(--space-4)]" aria-label="Relationship pathing">
      <div className="flex flex-wrap items-baseline justify-between gap-[var(--space-2)]">
        <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          Target:{' '}
          <span className="font-medium text-[var(--ink)]">{target.companyName}</span>
          {readOnly ? ' · Filed paths for outreach. The draft below is advice, not the record.' : null}
        </p>
        <Link
          href="/leads"
          className="text-[length:var(--text-xs)] font-medium text-[var(--accent)] underline underline-offset-4"
        >
          Edit on Leads
        </Link>
      </div>

      <div className="grid gap-[var(--space-4)] lg:grid-cols-2">
        <MapSection title="Target stakeholders">
          {stakeholders.length === 0 ? (
            <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
              No stakeholders yet. Add the decision-makers and influencers at the target.
            </p>
          ) : (
            <ul className="flex list-none flex-col gap-[var(--space-3)] p-0">
              {stakeholders.map((stakeholder) => {
                  const path = pathByStakeholder.get(stakeholder.id);
                  const selected = !path
                    ? ''
                    : path.path_type === 'cold' || !path.relationship_id
                      ? COLD_VALUE
                      : path.relationship_id;
                  const introducer =
                    path?.relationship_id != null
                      ? relationshipById.get(path.relationship_id)
                      : undefined;

                  return (
                    <li
                      key={stakeholder.id}
                      className="rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)]"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-[var(--space-2)]">
                        <div>
                          <p className="text-[length:var(--text-sm)] font-semibold text-[var(--ink)]">
                            {stakeholder.name}
                          </p>
                          <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                            {stakeholder.role_in_decision} · {stakeholder.stance}
                            {stakeholder.investor ? ' · investor' : ''}
                            {stakeholder.board_seat ? ' · board' : ''}
                          </p>
                        </div>
                        {path?.approved ? (
                          <span className="rounded-[6px] bg-[var(--positive-fill)] px-2 py-0.5 text-[length:var(--text-xxs)] font-medium text-[var(--positive-deep)]">
                            Approved
                          </span>
                        ) : null}
                      </div>

                      <label className="mt-[var(--space-3)] flex flex-col gap-1">
                        <span className="bank-label">Warm path</span>
                        <select
                          value={selected}
                          disabled={
                            readOnly ||
                            path?.approved ||
                            savingStakeholderId === stakeholder.id
                          }
                          onChange={(e) => void savePath(stakeholder.id, e.target.value)}
                          className="rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-60"
                        >
                          <option value="">Select an introducer…</option>
                          {relationships.map((rel) => (
                            <option key={rel.id} value={rel.id}>
                              via {rel.person_name} ({rel.relationship_type}, {rel.strength})
                            </option>
                          ))}
                          <option value={COLD_VALUE}>Cold / no warm path</option>
                        </select>
                      </label>

                      {path && introducer && (introducer.confidence || path.approved_by) ? (
                        <p className="mt-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                          {introducer.confidence ? `${introducer.confidence} confidence` : null}
                          {path.approved_by
                            ? `${introducer.confidence ? ' · ' : ''}Approved by ${path.approved_by}`
                            : null}
                          {path.approved_on
                            ? `${introducer.confidence || path.approved_by ? ' · ' : ''}${path.approved_on}`
                            : null}
                        </p>
                      ) : path?.path_type === 'cold' ? (
                        <p className="mt-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                          Cold outreach. No firm-side introducer on record.
                          {path.approved_by ? ` Approved by ${path.approved_by}` : null}
                          {path.approved_on ? ` · ${path.approved_on}` : null}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
          )}
          {readOnly ? null : (
            <AddStakeholderForm
              companyId={companyId!}
              onCreated={(stakeholder) => setStakeholders((rows) => [stakeholder, ...rows])}
            />
          )}
        </MapSection>

        <MapSection title="Firm relationships">
          {relationships.length === 0 ? (
            <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
              No firm-side relationships yet. Add who at your firm can open the door.
            </p>
          ) : (
            <ul className="flex list-none flex-col gap-[var(--space-2)] p-0">
              {relationships.map((rel) => (
                  <li
                    key={rel.id}
                    className="rounded-[var(--radius-input)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-2)]"
                  >
                    <p className="text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
                      {rel.person_name}
                    </p>
                    <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                      {rel.relationship_type} · {rel.strength}
                    </p>
                  </li>
                ))}
              </ul>
          )}
          {readOnly ? null : (
            <AddRelationshipForm
              companyId={companyId!}
              onCreated={(relationship) => setRelationships((rows) => [relationship, ...rows])}
            />
          )}
        </MapSection>
      </div>

      {skillBrief ? (
        <section aria-label="Skill brief" className="flex flex-col gap-[var(--space-2)]">
          <h3 className="bank-label">Draft</h3>
          <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
            {readOnly
              ? 'Advice used when the path was drafted. The filed paths are above.'
              : 'Advice only. It does not file a path. Pick an introducer above, then approve.'}
          </p>
          <Markdown className="max-h-72 overflow-auto rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)]">
            {skillBrief}
          </Markdown>
        </section>
      ) : null}

      {actionError ? (
        <p id={actionErrorId} role="alert" className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
          {actionError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-[var(--space-3)] border-t border-[var(--stroke)] pt-[var(--space-3)]">
        <p className="text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          {approvedCount} path{approvedCount === 1 ? '' : 's'} approved
          {decisionMakers.length
            ? ` · ${decisionMakers.length} decision-maker${decisionMakers.length === 1 ? '' : 's'} mapped`
            : ''}
          {readOnly ? '' : approveHint}
        </p>
        {!readOnly && blockedReason && !refused ? (
          <p id={approveReasonId} className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
            {blockedReason}
          </p>
        ) : null}
        {readOnly ? null : (
          <button
            type="button"
            title={approveDisabledTitle}
            disabled={approveDisabled}
            // After a 403 the reason is the alert itself; otherwise the reason line.
            aria-describedby={refused ? actionErrorId : blockedReason ? approveReasonId : undefined}
            onClick={() => void handleApproveAll()}
            className="rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-semibold text-[var(--ink-on-dark)] transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {approving ? 'Approving…' : readyToComplete ? 'Complete step' : 'Approve paths'}
          </button>
        )}
      </div>
    </div>
  );
}

function MapSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-[var(--space-2)]">
      <h3 className="bank-label">{title}</h3>
      {children}
    </section>
  );
}

function AddStakeholderForm({
  companyId,
  onCreated,
}: {
  companyId: string;
  onCreated: (stakeholder: Stakeholder) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState('');
  const [roleInDecision, setRoleInDecision] = React.useState<string>(DECISION_ROLES[0]);
  const [motivation, setMotivation] = React.useState<string>(MOTIVATIONS[0]);
  const [stance, setStance] = React.useState<string>(STANCES[1]);

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    const res = await fetch(`/api/v1/companies/${companyId}/stakeholders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: trimmed,
        role_in_decision: roleInDecision,
        motivation,
        stance,
      }),
    });
    if (!res.ok) return;
    const { stakeholder } = (await res.json()) as { stakeholder: Stakeholder };
    onCreated(stakeholder);
    setName('');
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-xs)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
      >
        Add stakeholder
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-[var(--space-2)] rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)]">
      <PersonCombobox
        value={name}
        onChange={setName}
        companyId={companyId}
        placeholder="Name"
      />
      <div className="grid grid-cols-1 gap-[var(--space-2)] sm:grid-cols-3">
        <select
          value={roleInDecision}
          onChange={(e) => setRoleInDecision(e.target.value)}
          className="rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          {DECISION_ROLES.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        <select
          value={motivation}
          onChange={(e) => setMotivation(e.target.value)}
          className="rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          {MOTIVATIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        <select
          value={stance}
          onChange={(e) => setStance(e.target.value)}
          className="rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          {STANCES.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </div>
      <div className="flex gap-[var(--space-2)]">
        <button
          type="button"
          disabled={!name.trim()}
          onClick={() => void handleSave()}
          className="rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-xs)] font-semibold text-[var(--ink-on-dark)] disabled:opacity-60"
        >
          Save stakeholder
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function AddRelationshipForm({
  companyId,
  onCreated,
}: {
  companyId: string;
  onCreated: (relationship: Relationship) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [personName, setPersonName] = React.useState('');
  const [personSelected, setPersonSelected] = React.useState(false);
  const [relationshipType, setRelationshipType] = React.useState<string>(RELATIONSHIP_TYPES[0]);
  const [strength, setStrength] = React.useState<string>(STRENGTH_LEVELS[1]);

  async function handleSave() {
    const trimmed = personName.trim();
    if (!trimmed) return;
    const res = await fetch(`/api/v1/companies/${companyId}/relationships`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        person_name: trimmed,
        relationship_type: relationshipType,
        strength,
        confidence: strength,
      }),
    });
    if (!res.ok) return;
    const { relationship } = (await res.json()) as { relationship: Relationship };
    onCreated(relationship);
    setPersonName('');
    setPersonSelected(false);
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-xs)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
      >
        Add relationship
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-[var(--space-2)] rounded-[var(--radius-input)] border border-[var(--stroke)] p-[var(--space-3)]">
      <PersonCombobox
        value={personName}
        onChange={(value, selected) => {
          setPersonName(value);
          setPersonSelected(selected === true);
        }}
        scope={PERSON_SEARCH_SCOPE.COMPANY_EMPLOYEES}
        requireSelection
        placeholder="Select an employee"
      />
      <div className="grid grid-cols-1 gap-[var(--space-2)] sm:grid-cols-2">
        <select
          value={relationshipType}
          onChange={(e) => setRelationshipType(e.target.value)}
          className="rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          {RELATIONSHIP_TYPES.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        <select
          value={strength}
          onChange={(e) => setStrength(e.target.value)}
          className="rounded-[var(--radius-input)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          {STRENGTH_LEVELS.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </div>
      <div className="flex gap-[var(--space-2)]">
        <button
          type="button"
          disabled={!personName.trim() || !personSelected}
          onClick={() => void handleSave()}
          className="rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-xs)] font-semibold text-[var(--ink-on-dark)] disabled:opacity-60"
        >
          Save relationship
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-1)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export default RelationshipPathingPanel;
