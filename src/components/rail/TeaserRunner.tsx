'use client';

import * as React from 'react';

import { Orchestrator } from '@/lib/orchestration/orchestrator';
import { InMemoryJobStore } from '@/lib/orchestration/audit';
import type {
  ActorClearance,
  AuditEventType,
  DealDocument,
  Job,
  JobRecord,
  WorkflowState,
} from '@/lib/orchestration/types';
import { DEAL_ROLE } from '@/lib/constants/roles';
import { DOCUMENT_CLASSIFICATION } from '@/lib/constants/documents';
import { addDealTokens } from '@/lib/rail/deals';
import { TEASER_STEP_ID } from '@/lib/rail/dealRail';
import { UNNAMED_SELLER } from '@/lib/orchestration/agents/draft-agent';
import { PreviewBanner } from '@/components/overlay';
import { draftActionLabel, draftPlainLine } from './stepActionCopy';

/**
 * TeaserRunner: the sandbox "Draft the teaser" step of the Deal Rail.
 *
 * This is the one step on the rail wired to the in-process orchestrator
 * (`src/lib/orchestration/`). It runs the deterministic teaser workflow
 * end to end in the browser: INTERPRET → PLAN → [confirm] → RESEARCH → DRAFT
 * → COMPLIANCE_SCREEN → [sign-off] → COMPLETE. Nothing is faked — the same
 * `Orchestrator` the test suite exercises drives every transition here.
 *
 * It demonstrates allocation rule in one surface: the agent drafts,
 * but because the teaser is external-facing the machine PAUSES for a human
 * sign-off (and, for a promissory draft, the compliance supervisor BLOCKS it
 * so nothing leaves the firm).
 *
 * The draft is a fixed sample, not written from this deal's data, so it says
 * so (PreviewBanner) and its screen stays inside the runner, labelled as the
 * screen of this sample text. It never sets the shell's compliance ribbon: a
 * verdict on sample text is not this deal's compliance state.
 */

/** The brief the sandbox drafts from: clean by default. The compliance
 *  supervisor still screens every draft, so a flagged line would still hold or
 *  block it; there is no picker for planting one. */
const HEADLINE = 'Category-defining collaboration software.';

const OWNER = 'Storm Duncan, Managing Director';

const ACTOR: ActorClearance = {
  actorId: 'actor-md',
  dealId: 'deal-atlassian',
  dealRole: DEAL_ROLE.MD,
  phase: 1,
};

const DOCUMENTS: DealDocument[] = [
  {
    id: 'd-public',
    dealId: 'deal-atlassian',
    name: 'Market read',
    classification: DOCUMENT_CLASSIFICATION.PUBLIC,
    minPhase: 0,
    body: 'public',
  },
  {
    id: 'd-conf',
    dealId: 'deal-atlassian',
    name: 'Financials',
    classification: DOCUMENT_CLASSIFICATION.CONFIDENTIAL,
    minPhase: 0,
    body: 'confidential',
  },
];

function buildJob(): Job {
  // COMPLIANCE: a blind teaser never names the seller, and no visible string
  // may print the target. The seller identity stays masked here; a fully
  // deal-scoped teaser (per-deal brief) is tracked as follow-up data work.
  return {
    id: `job-teaser-${Date.now()}`,
    goal: 'Prepare the teaser',
    dealId: ACTOR.dealId,
    requestingActorId: ACTOR.actorId,
    completionCondition: 'A compliance-cleared teaser exists',
    stakes: 'high',
    brief: {
      // Unnamed: the title reads "Confidential Teaser" alone.
      sellerName: UNNAMED_SELLER,
      sector: 'Software',
      headline: HEADLINE,
    },
  };
}

/** The PreviewBanner message over the sample draft. */
export const SAMPLE_DRAFT_COPY = "Sample draft. Not written from this deal's data.";
export const SAMPLE_SCREEN_COPY = "Screen of this sample text. The deal's compliance status is unchanged.";

const STATE_COPY: Record<WorkflowState, string> = {
  INTERPRET: 'Interpreting the request',
  PLAN: 'Planning the workflow',
  AWAIT_PLAN_CONFIRM: 'Plan ready. Waiting for you to confirm.',
  RESEARCH: 'Researching comparables',
  DRAFT: 'Drafting the teaser',
  COMPLIANCE_SCREEN: 'Screening for compliance',
  AWAIT_SIGNOFF: 'Drafted. Waiting for your sign-off.',
  COMPLETE: 'Signed off. Cleared to send.',
  BLOCKED: 'Blocked by compliance',
  HALTED: 'Stopped. The draft ran past its limits.',
  FAILED: 'Failed',
};

/** The audit trail in plain words, never the workflow's own codes. */
const EVENT_COPY: Record<AuditEventType, string> = {
  JOB_CREATED: 'Request received',
  STATE_ENTERED: 'Moved on',
  AGENT_DISPATCHED: 'Work started',
  AGENT_REPORTED: 'Work reported back',
  COMPLIANCE_VERDICT: 'Compliance verdict',
  GATE_AWAITING: 'Waiting for you',
  GATE_APPROVED: 'You approved',
  AGENT_HALTED: 'Work stopped',
  JOB_COMPLETED: 'Finished',
  JOB_TERMINATED: 'Ended',
};

export function auditLine(event: { type: AuditEventType; state: WorkflowState }): string {
  return `${EVENT_COPY[event.type]} · ${STATE_COPY[event.state]}`;
}

function ctx() {
  return { actor: ACTOR, documents: DOCUMENTS };
}

export function TeaserRunner({
  dealId,
  onOutcome,
  onSignedOff,
}: {
  dealId?: string;
  /** Fires once per run when the compliance verdict lands — the unified
   *  StepRunner collapses it to a receipt on the step. */
  onOutcome?: (outcome: {
    verdict: 'compliant' | 'hold' | 'blocked';
    seconds: number;
    tokens: number;
  }) => void;
  /** Fires when the MD signs off and the run reaches COMPLETE. */
  onSignedOff?: () => void;
} = {}) {
  const [rec, setRec] = React.useState<JobRecord | null>(null);
  const [busy, setBusy] = React.useState(false);
  const engine = React.useRef<{ orch: Orchestrator; jobId: string } | null>(null);
  const startedAt = React.useRef(0);
  const outcomeFired = React.useRef(false);

  async function start() {
    setBusy(true);
    startedAt.current = Date.now();
    outcomeFired.current = false;
    const orch = new Orchestrator({ store: new InMemoryJobStore() });
    const job = buildJob();
    engine.current = { orch, jobId: job.id };
    const next = await orch.start(job, ctx());
    setRec(next);
    setBusy(false);
  }

  async function confirmPlan() {
    if (!engine.current) return;
    setBusy(true);
    const next = await engine.current.orch.approve(
      engine.current.jobId,
      'plan',
      ctx(),
    );
    setRec(next);
    // The agents (research + draft) ran during plan approval — meter + allocate.
    const used = engine.current.orch.meter.total();
    if (dealId) addDealTokens(dealId, used);
    // Verdict landed — surface the run outcome once, receipt-style.
    if (next.compliance && !outcomeFired.current) {
      outcomeFired.current = true;
      onOutcome?.({
        verdict: next.compliance.verdict,
        seconds: Math.max(1, Math.round((Date.now() - startedAt.current) / 1000)),
        tokens: used,
      });
    }
    setBusy(false);
  }

  async function signOff() {
    if (!engine.current) return;
    setBusy(true);
    const next = await engine.current.orch.approve(
      engine.current.jobId,
      'signoff',
      ctx(),
    );
    setRec(next);
    if (next.state === 'COMPLETE') onSignedOff?.();
    setBusy(false);
  }

  function reset() {
    engine.current = null;
    outcomeFired.current = false;
    setRec(null);
  }

  const state = rec?.state ?? null;
  const awaiting = rec?.awaitingGate;
  const verdict = rec?.compliance?.verdict;

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-5)] text-[var(--ink)]">
      <p className="text-[length:var(--text-sm)] text-[var(--ink)]">
        {draftPlainLine(TEASER_STEP_ID, 'Teaser')}
      </p>

      {!rec ? (
        <button
          type="button"
          onClick={start}
          disabled={busy}
          className="mt-[var(--space-4)] rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-semibold text-[var(--ink-on-dark)] transition-colors hover:bg-[var(--accent-dark)] disabled:opacity-60"
        >
          {draftActionLabel(TEASER_STEP_ID, 'Teaser')}
        </button>
      ) : null}

      {/* Run state */}
      {rec ? (
        <div className="mt-[var(--space-4)] space-y-[var(--space-4)]">
          <StateLine state={state} verdict={verdict} />

          {/* Human gate: plan confirm */}
          {awaiting === 'plan' ? (
            <GatePanel
              title="Confirm the plan before Conductia drafts"
              body="The teaser leaves the firm, so the plan waits for you. Nothing has been researched or drafted yet."
            >
              <PrimaryButton onClick={confirmPlan} disabled={busy}>
                Confirm plan
              </PrimaryButton>
            </GatePanel>
          ) : null}

          {/* Preview: handoff E39 "Deal-scoped teaser brief". The sandbox
              text is fixed, not this deal's. */}
          {rec.draft?.teaser ? (
            <PreviewBanner message={SAMPLE_DRAFT_COPY} />
          ) : null}

          {/* Drafted teaser */}
          {rec.draft?.teaser ? (
            <Field label="Drafted teaser (not yet sent)">
              <pre className="whitespace-pre-wrap font-mono text-[length:var(--text-xs)] leading-relaxed text-[var(--ink)]">
                {rec.draft.teaser}
              </pre>
            </Field>
          ) : null}

          {/* Compliance verdict */}
          {rec.compliance ? (
            <ComplianceVerdict
              sample
              verdict={rec.compliance.verdict}
              reasons={rec.compliance.reasons}
              rewrite={rec.compliance.rewrite}
            />
          ) : null}

          {/* Human gate: sign-off (routed to the owner) */}
          {awaiting === 'signoff' ? (
            <GatePanel
              title={`Routed to ${OWNER}`}
              body={
                verdict === 'hold'
                  ? 'Compliance flagged this for supervisory review (hold). It will not leave the firm until the MD signs off.'
                  : 'The draft cleared compliance. External-facing output still requires an explicit human sign-off before it can be sent.'
              }
            >
              <PrimaryButton onClick={signOff} disabled={busy}>
                Sign off &amp; clear to send
              </PrimaryButton>
            </GatePanel>
          ) : null}

          {/* Terminal: complete */}
          {state === 'COMPLETE' ? (
            <div className="rounded-[var(--radius-button)] border border-transparent bg-[var(--positive-fill)] p-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--positive-deep)]">
              Signed off. The teaser is cleared to send and the full run is in the
              audit trail below.
            </div>
          ) : null}

          {/* Terminal: blocked */}
          {state === 'BLOCKED' ? (
            <div className="rounded-[var(--radius-button)] border border-transparent bg-[var(--negative-fill)] p-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--negative-deep)]">
              Hard stop. Compliance blocked the draft, so it can never be signed
              off or sent. The MD sees the reason and the suggested rewrite.
            </div>
          ) : null}

          {/* Audit trail */}
          {rec.events.length ? (
            <details className="rounded-[var(--radius-button)] border border-[var(--stroke)] p-[var(--space-3)]">
              <summary className="cursor-pointer text-[length:var(--text-xs)] font-semibold text-[var(--ink-tertiary)]">
                Audit trail · {rec.events.length} events (replayable)
              </summary>
              <ol className="mt-[var(--space-2)] space-y-1 font-mono text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                {rec.events.map((e) => (
                  <li key={e.seq}>
                    <span className="text-[var(--ink-tertiary)]">
                      {String(e.seq).padStart(2, '0')}
                    </span>{' '}
                    {auditLine(e)}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}

          <button
            type="button"
            onClick={reset}
            className="text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)] underline underline-offset-4 hover:text-[var(--ink)]"
          >
            Reset step
          </button>
        </div>
      ) : null}
    </div>
  );
}

function StateLine({
  state,
  verdict,
}: {
  state: string | null;
  verdict?: 'compliant' | 'hold' | 'blocked';
}) {
  const dot =
    verdict === 'blocked'
      ? 'var(--negative)'
      : verdict === 'hold'
        ? 'var(--hold)'
        : verdict === 'compliant'
          ? 'var(--positive)'
          : 'var(--ai)';
  return (
    <div className="flex items-center gap-[var(--space-2)]">
      <span
        aria-hidden
        className="inline-block size-2.5 rounded-full"
        style={{ background: dot }}
      />
      <span className="text-[length:var(--text-sm)]">
        {state ? (STATE_COPY[state as WorkflowState] ?? '') : ''}
      </span>
    </div>
  );
}

function GatePanel({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[var(--radius-button)] border border-[var(--ai-soft)] bg-[var(--ai-tint)] p-[var(--space-3)]">
      <p className="text-[length:var(--text-sm)] font-semibold text-[var(--ink)]">{title}</p>
      <p className="mt-1 text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
        {body}
      </p>
      <div className="mt-[var(--space-3)]">{children}</div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[var(--radius-button)] border border-[var(--stroke)] bg-[var(--surface-subtle)] p-[var(--space-3)]">
      <p className="mb-[var(--space-2)] text-[length:var(--text-xs)] font-semibold text-[var(--ink-tertiary)]">
        {label}
      </p>
      {children}
    </div>
  );
}

function ComplianceVerdict({
  verdict,
  reasons,
  rewrite,
  sample = false,
}: {
  /** The screen ran over the sample text, not this deal's. */
  sample?: boolean;
  verdict: 'compliant' | 'hold' | 'blocked';
  reasons: string[];
  rewrite?: string;
}) {
  const tone =
    verdict === 'blocked'
      ? 'var(--negative)'
      : verdict === 'hold'
        ? 'var(--hold)'
        : 'var(--positive)';
  const fill =
    verdict === 'blocked'
      ? 'var(--negative-fill)'
      : verdict === 'hold'
        ? 'var(--hold-fill)'
        : 'var(--positive-fill)';
  const deep =
    verdict === 'blocked'
      ? 'var(--negative-deep)'
      : verdict === 'hold'
        ? 'var(--hold-deep)'
        : 'var(--positive-deep)';
  const label =
    verdict === 'blocked'
      ? 'Blocked'
      : verdict === 'hold'
        ? 'Hold for supervisory review'
        : 'Cleared';
  return (
    <div
      className="rounded-[var(--radius-button)] border border-transparent p-[var(--space-3)]"
      style={{ background: fill }}
    >
      <div className="flex items-center gap-[var(--space-2)]">
        <span
          aria-hidden
          className="inline-block size-2.5 rounded-full"
          style={{ background: tone }}
        />
        <span className="text-[length:var(--text-sm)] font-semibold" style={{ color: deep }}>
          Compliance: {label}
        </span>
      </div>
      {sample ? (
        <p className="mt-1 text-[length:var(--text-xs)]" style={{ color: deep }}>
          {SAMPLE_SCREEN_COPY}
        </p>
      ) : null}
      {reasons.length ? (
        <ul className="mt-[var(--space-2)] list-disc space-y-1 pl-5 text-[length:var(--text-xs)]" style={{ color: deep }}>
          {reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      ) : null}
      {rewrite ? (
        <p className="mt-[var(--space-2)] text-[length:var(--text-xs)]" style={{ color: deep }}>
          <span className="font-semibold">Suggested rewrite: </span>
          {rewrite}
        </p>
      ) : null}
    </div>
  );
}

function PrimaryButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-4)] py-[var(--space-2)] text-[length:var(--text-sm)] font-semibold text-[var(--ink-on-dark)] transition-colors hover:bg-[var(--accent-dark)] disabled:opacity-60"
    >
      {children}
    </button>
  );
}

export default TeaserRunner;
