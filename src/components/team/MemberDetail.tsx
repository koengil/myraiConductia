'use client';

import * as React from 'react';

import { PerimeterPreview } from '@/components/onboarding/PerimeterPreview';
import { accessPhaseName, accessPhaseOptions, accessSummary } from '@/lib/team/accessPhase';
import type { LiveMember } from '@/lib/team/roster';

/**
 * MemberDetail: one person's detail, opened inline under their Team row.
 *
 * In plain words: which side they are on, what they can see (phase names,
 * not numbers) and that they have joined.
 * Name, role and email are on the row above, so they are not repeated here.
 *
 * The MD widens an outside party's access here. The server takes a phase
 * number, only ever upward (it rejects a lower one with 409 and this shows the
 * server's message as is). The select starts on the person's current phase,
 * so nothing reads as a change until one is chosen. "Everyone at <firm>"
 * sends one PATCH per person with a status chip each, the server's reason
 * under any "Failed", and an "Updated N of M" line; an equal-phase PATCH
 * changes nothing, so retrying only the failures is safe. Internal seats show
 * no control: phase never gates your own firm's people.
 *
 * Render one per person with `key={member.userId}` so nothing typed for one
 * person carries over to the next.
 */

type FanoutState = Record<string, 'pending' | 'done' | 'failed'>;

const FANOUT_LABEL: Record<FanoutState[string], string> = {
  pending: 'Updating',
  done: 'Updated',
  failed: 'Failed',
};

async function patchPhase(
  dealId: string,
  userId: string,
  phase: number,
): Promise<{ ok: boolean; message: string | null }> {
  try {
    const res = await fetch(`/api/v1/deals/${dealId}/members/${userId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phase }),
    });
    if (res.ok) return { ok: true, message: null };
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the status-derived message.
    }
    return { ok: false, message };
  } catch {
    return { ok: false, message: 'The request failed to reach the server.' };
  }
}

/** "Updated 4 of 5 people." The fan-out's line, in the bulk access wording. */
function fanoutSummary(done: number, total: number): string {
  if (done === total) return total === 1 ? 'Updated 1 person.' : `Updated all ${total} people.`;
  return `Updated ${done} of ${total} ${total === 1 ? 'person' : 'people'}.`;
}

/** One phase past the current one when there is one, else the current one. */
function nextPhase(phase: number): number {
  const options = accessPhaseOptions(phase);
  return (options[1] ?? options[0]).value;
}

const SELECT_CLASS =
  'rounded-[var(--radius-button)] border border-transparent bg-[var(--surface-subtle)] px-[var(--space-3)] py-[8px] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]';
const PRIMARY_CLASS =
  'rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-3)] py-[8px] text-[length:var(--text-xs)] font-medium text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-dark)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 disabled:opacity-60';

export function MemberDetail({
  dealId,
  member,
  companyMembers,
  viewerIsMd,
  onChanged,
}: {
  dealId: string;
  member: LiveMember;
  /** Everyone seated under this person's firm, for "Everyone at <firm>". */
  companyMembers: LiveMember[];
  viewerIsMd: boolean;
  onChanged: () => void;
}) {
  // Starts on what they have now: Update access waits for a different choice.
  const [phaseInput, setPhaseInput] = React.useState(member.phase);
  const [phaseBusy, setPhaseBusy] = React.useState(false);
  const [phaseError, setPhaseError] = React.useState<string | null>(null);
  const [phaseDone, setPhaseDone] = React.useState(false);

  const [companyPhaseInput, setCompanyPhaseInput] = React.useState(() => nextPhase(member.phase));
  const [fanout, setFanout] = React.useState<FanoutState>({});
  /** The server's reason for each refused person, shown under their chip. */
  const [fanoutReason, setFanoutReason] = React.useState<Record<string, string>>({});
  const [fanoutBusy, setFanoutBusy] = React.useState(false);

  const firm = member.companyName ?? 'this firm';
  const canChange = viewerIsMd && member.isExternal;
  // "Everyone at <firm>" only when there is a firm: people with no company
  // are not one firm, so they are never raised together.
  const canChangeFirm = canChange && member.companyId !== null;
  const options = accessPhaseOptions(member.phase);
  // After a reload the options restart at the person's new phase. A choice
  // that is no longer offered falls back to the first option, so the value on
  // screen is always the value sent.
  const offered = (value: number) =>
    options.some((option) => option.value === value) ? value : options[0].value;
  const memberPhase = offered(phaseInput);
  const companyPhase = offered(companyPhaseInput);

  async function raiseMember() {
    setPhaseBusy(true);
    setPhaseError(null);
    setPhaseDone(false);
    const result = await patchPhase(dealId, member.userId, memberPhase);
    setPhaseBusy(false);
    if (result.ok) {
      setPhaseDone(true);
      onChanged();
    } else {
      setPhaseError(result.message);
    }
  }

  async function runFanout(targets: LiveMember[]) {
    setFanoutBusy(true);
    setFanout((prev) => {
      const next: FanoutState = { ...prev };
      for (const t of targets) next[t.userId] = 'pending';
      return next;
    });
    // Sequential fan-out keeps the request pattern simple and the chips
    // legible; PATCH is idempotent at equal phase so any rerun is safe.
    for (const t of targets) {
      const result = await patchPhase(dealId, t.userId, companyPhase);
      setFanout((prev) => ({
        ...prev,
        [t.userId]: result.ok ? 'done' : 'failed',
      }));
      setFanoutReason((prev) => {
        const next = { ...prev };
        if (result.ok) delete next[t.userId];
        else next[t.userId] = result.message ?? 'Not changed.';
        return next;
      });
    }
    setFanoutBusy(false);
    onChanged();
  }

  const failed = companyMembers.filter((m) => fanout[m.userId] === 'failed');
  const hasFanout = Object.keys(fanout).length > 0;
  const fanoutRows = companyMembers.filter((m) => fanout[m.userId]);
  const fanoutDone = fanoutRows.filter((m) => fanout[m.userId] === 'done').length;

  return (
    <div className="flex flex-col gap-[var(--space-4)] pt-[var(--space-1)]">
      <dl className="grid grid-cols-[auto_1fr] gap-x-[var(--space-4)] gap-y-[var(--space-2)] text-[length:var(--text-sm)]">
        <dt className="text-[var(--ink-tertiary)]">Side</dt>
        <dd className="text-[var(--ink)]">
          {member.isExternal ? 'Outside party' : 'Advisory bank'}
        </dd>
        <dt className="text-[var(--ink-tertiary)]">What they can see</dt>
        <dd className="text-[var(--ink)]">{accessSummary(member)}</dd>
        <dt className="text-[var(--ink-tertiary)]">Status</dt>
        <dd className="text-[var(--ink)]">Joined</dd>
      </dl>

      {canChange ? (
        <div className="flex flex-col gap-[var(--space-4)] border-t border-[var(--stroke)] pt-[var(--space-4)]">
          <section aria-label="Change access" className="flex flex-col gap-[var(--space-2)]">
            <h3 className="eyebrow">Change access</h3>
            <div className="flex flex-wrap items-center gap-[var(--space-2)]">
              <label className="flex items-center gap-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                Access up to
                <select
                  value={memberPhase}
                  onChange={(e) => {
                    setPhaseInput(Number(e.target.value));
                    setPhaseDone(false);
                  }}
                  className={SELECT_CLASS}
                >
                  {options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={phaseBusy || memberPhase === member.phase}
                onClick={() => void raiseMember()}
                className={PRIMARY_CLASS}
              >
                Update access
              </button>
            </div>
            {phaseError ? (
              <p role="alert" className="text-[length:var(--text-xs)] text-[var(--negative,red)]">
                {phaseError}
              </p>
            ) : null}
            {phaseDone ? (
              <p className="text-[length:var(--text-xs)] text-[var(--positive-deep,green)]">
                Access updated.
              </p>
            ) : null}

            {/* B11: the same preview, before committing a change. It reads the
                chosen phase, so what it shows is what the button would give. */}
            <PerimeterPreview
              mode="member"
              dealId={dealId}
              userId={member.userId}
              phase={memberPhase}
              heading={`Up to ${accessPhaseName(memberPhase)}, they can see`}
            />
          </section>

          {canChangeFirm ? (
            <section
              aria-label={`Change access for everyone at ${firm}`}
              className="flex flex-col gap-[var(--space-2)]"
            >
              <h3 className="eyebrow">Everyone at {firm}</h3>
              <div className="flex flex-wrap items-center gap-[var(--space-2)]">
                <label className="flex items-center gap-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                  <span>
                    Access up to
                    <span className="sr-only">, everyone at {firm}</span>
                  </span>
                  <select
                    value={companyPhase}
                    onChange={(e) => setCompanyPhaseInput(Number(e.target.value))}
                    className={SELECT_CLASS}
                  >
                    {options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={fanoutBusy}
                  onClick={() => void runFanout(companyMembers)}
                  className={PRIMARY_CLASS}
                >
                  Update everyone
                </button>
                {failed.length > 0 && !fanoutBusy ? (
                  <button
                    type="button"
                    onClick={() => void runFanout(failed)}
                    className="rounded-[var(--radius-button)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-3)] py-[8px] text-[length:var(--text-xs)] font-medium text-[var(--ink)] transition-colors hover:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  >
                    Retry failed
                  </button>
                ) : null}
              </div>
              {hasFanout && !fanoutBusy ? (
                <p role="status" className="text-[length:var(--text-xs)] font-medium text-[var(--ink)]">
                  {fanoutSummary(fanoutDone, fanoutRows.length)}
                </p>
              ) : null}
              {hasFanout ? (
                <ul className="m-0 flex list-none flex-col gap-[var(--space-1)] p-0">
                  {companyMembers.map((m) => {
                    const state = fanout[m.userId];
                    if (!state) return null;
                    const label = m.displayName ?? m.fullName ?? m.email ?? m.userId;
                    return (
                      <li
                        key={m.userId}
                        className="flex flex-wrap items-center justify-between gap-x-[var(--space-2)] gap-y-[var(--space-1)] text-[length:var(--text-xs)]"
                      >
                        <span className="truncate text-[var(--ink-secondary)]">{label}</span>
                        <span
                          className={[
                            'rounded-[6px] px-[var(--space-2)] py-[var(--space-1)] font-sans text-[length:var(--text-xs)] font-medium leading-none',
                            state === 'done'
                              ? 'bg-[var(--positive-fill)] text-[var(--positive-deep)]'
                              : state === 'failed'
                                ? 'bg-[var(--negative-fill)] text-[var(--negative-deep)]'
                                : 'bg-[var(--surface-subtle)] text-[var(--ink-secondary)]',
                          ].join(' ')}
                        >
                          {FANOUT_LABEL[state]}
                        </span>
                        {state === 'failed' && fanoutReason[m.userId] ? (
                          <span className="basis-full text-[var(--negative-deep,red)]">
                            {fanoutReason[m.userId]}
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default MemberDetail;
