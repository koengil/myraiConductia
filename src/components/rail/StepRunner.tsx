'use client';

import * as React from 'react';

import {
  estimateTokens,
  MD_BRIEFING_STEP_ID,
  stepAgentFeatures,
  TEASER_STEP_ID,
  type AgentFeature,
  type RailStep,
} from '@/lib/rail/dealRail';
import type { ProjectRailStep } from '@/lib/rail/projectRail';
import { addDealTokens } from '@/lib/rail/deals';
import { useActiveDeal } from '@/lib/deals/useDeals';
import { useFlag } from '@/lib/flags/FlagsContext';
import { logAudit } from '@/lib/audit/store';
import { screenMessage } from '@/lib/compliance/screen';
import { useSession } from '@/lib/session/store';
import type { ComplianceCheckResult } from '@/lib/api/types';
import {
  addReceipt,
  appendVersion,
  receiptChecks,
  receiptVerdict,
  ribbonStatus,
} from './railRunState';
import { processTagForRailStep } from '@/lib/ignatious/processTag';
import { SkillStepRunner } from './SkillStepRunner';
import { MdBriefingRunner } from './MdBriefingRunner';
import { TeaserRunner } from './TeaserRunner';

/**
 * StepRunner — ONE run surface for every step on the rail:
 *
 *   • The Teaser step (seq 36) routes to the sandbox TeaserRunner only while
 *     `teaser_sandbox_runner` is on; otherwise it runs its bound skill.
 *   • The live MD Briefing step (seq 9) routes to MdBriefingRunner — Ignatious.
 *   • Tagged steps run the Ignatious bench. Canned fixtures stay as the
 *     fallback only when a step has no process tag.
 *
 * Both paths obey the same contract: the compliance verdict dispatches
 * SET_COMPLIANCE to the ONE ComplianceRibbon in the shell console (this
 * surface never mounts a second live compliance instrument), and every run
 * collapses to a receipt line on the step ("Screened · 12s ›").
 */
export function StepRunner({
  step,
  projectStep,
  dealId,
  onClose,
  onEnhance,
  canTeach,
  builderChanges,
}: {
  step: RailStep;
  projectStep: ProjectRailStep;
  dealId: string;
  /** Collapse the runner (the receipt stays on the step). */
  onClose: () => void;
  onEnhance?: (runId: string | null, teach?: boolean) => void;
  canTeach?: boolean;
  builderChanges?: number;
}) {
  const deal = useActiveDeal(dealId);
  const sandboxTeaser = useFlag('teaser_sandbox_runner');
  // Compliance record: opening the runner is running the step's skill. One
  // audit event per run invocation, scoped to the deal.
  React.useEffect(() => {
    logAudit('step', 'Ran skill', step.title, {
      deal: deal.codename,
    });
  }, [step.id, step.title, deal.codename]);

  const liveRun =
    step.id === TEASER_STEP_ID
      ? sandboxTeaser
      : step.id === MD_BRIEFING_STEP_ID || Boolean(step.live);
  if (liveRun) {
    return <LiveRun step={step} dealId={dealId} onClose={onClose} />;
  }
  if (processTagForRailStep(step.id)) {
    return (
      <SandboxOrCanned
        projectStep={projectStep}
        dealId={dealId}
        onClose={onClose}
        onEnhance={onEnhance}
        canTeach={canTeach}
        builderChanges={builderChanges}
      />
    );
  }
  return <CannedRun step={step} dealId={dealId} onClose={onClose} />;
}

// --- Live path: the in-process runners -------------------------------------

function LiveRun({
  step,
  dealId,
  onClose,
}: {
  step: RailStep;
  dealId: string;
  onClose: () => void;
}) {
  const deal = useActiveDeal(dealId);
  const [hasReceipt, setHasReceipt] = React.useState(false);
  const isMdBriefing = step.id === MD_BRIEFING_STEP_ID;
  const Runner = isMdBriefing ? MdBriefingRunner : TeaserRunner;
  return (
    <div className="space-y-[var(--space-2)]">
      <Runner
        dealId={dealId}
        onOutcome={({ verdict, seconds, tokens }) => {
          addReceipt(dealId, step.id, {
            label: isMdBriefing ? 'Brief drafted' : 'Screened',
            verdict: receiptVerdict(verdict),
            checks: isMdBriefing
              ? verdict === 'compliant'
                ? ['MD brief completed']
                : ['MD brief did not complete']
              : verdict === 'compliant'
                ? ['KYC ✓', 'FINRA ✓', 'MNPI ✓']
                : verdict === 'hold'
                  ? ['MNPI marker · routed to supervisory review']
                  : ['Promissory language · blocked pre-send'],
            seconds,
            tokens,
          });
          setHasReceipt(true);
        }}
        onSignedOff={() => {
          logAudit('step', 'Approved', step.title, {
            deal: deal.codename,
          });
          appendVersion(
            dealId,
            step.id,
            isMdBriefing ? 'MD brief' : 'Teaser draft',
            isMdBriefing
              ? 'Conductia drafted the MD brief. Banker approved the brief.'
              : 'Conductia drafted, compliance screened, MD signed off. Cleared to send.',
          );
        }}
      />
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)] underline underline-offset-4 hover:text-[var(--ink)]"
        >
          {hasReceipt ? 'Collapse to receipt' : 'Close runner'}
        </button>
      </div>
    </div>
  );
}

function SandboxOrCanned({
  projectStep,
  dealId,
  onClose,
  onEnhance,
  canTeach,
  builderChanges,
}: {
  projectStep: ProjectRailStep;
  dealId: string;
  onClose: () => void;
  onEnhance?: (runId: string | null, teach?: boolean) => void;
  canTeach?: boolean;
  builderChanges?: number;
}) {
  return (
    <div className="space-y-[var(--space-2)]">
      <SkillStepRunner projectId={dealId} step={projectStep} onEnhance={onEnhance} canTeach={canTeach} builderChanges={builderChanges} />
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)] underline underline-offset-4 hover:text-[var(--ink)]"
        >
          Close runner
        </button>
      </div>
    </div>
  );
}

// --- Canned path: the degraded schema-step flow -----------------------------

function CannedRun({
  step,
  dealId,
  onClose,
}: {
  step: RailStep;
  dealId: string;
  onClose: () => void;
}) {
  const features = stepAgentFeatures(step);
  const [feature, setFeature] = React.useState<AgentFeature | null>(
    features.length === 1 ? features[0] : null,
  );

  if (!features.length) {
    return (
      <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        A draft is not available for this step yet.
      </p>
    );
  }

  if (!feature) {
    return (
      <div className="rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-3)]">
        <p className="eyebrow mb-[var(--space-2)]">Choose a draft</p>
        <div className="flex flex-col divide-y divide-[var(--stroke)]">
          {features.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFeature(f)}
              className="py-[var(--space-2)] text-left transition-colors hover:text-[var(--accent-dark)]"
            >
              <span className="block text-[length:var(--text-sm)] font-semibold text-[var(--ink)]">
                {f.label}
              </span>
              <span className="mt-0.5 block text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                {f.description}
              </span>
            </button>
          ))}
        </div>
        <div className="mt-[var(--space-2)] flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)] underline underline-offset-4 hover:text-[var(--ink)]"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <CannedFeatureRun
      feature={feature}
      step={step}
      dealId={dealId}
      onClose={onClose}
    />
  );
}

function CannedFeatureRun({
  feature,
  step,
  dealId,
  onClose,
}: {
  feature: AgentFeature;
  step: RailStep;
  dealId: string;
  onClose: () => void;
}) {
  const deal = useActiveDeal(dealId);
  const { dispatch } = useSession();
  const [loaderStep, setLoaderStep] = React.useState(0);
  const done = loaderStep >= feature.loading.length;
  const tokens = React.useMemo(() => estimateTokens(feature), [feature]);
  const startedAt = React.useRef(0);
  React.useEffect(() => {
    startedAt.current = Date.now();
  }, []);

  // The agent's output routes through the SAME deterministic gate an outgoing
  // message passes. The verdict is dispatched to the shell's single ribbon.
  const screened =
    feature.draft ??
    feature.contacts?.map((c) => `${c.name} ${c.note}`).join('\n') ??
    feature.description;
  const check = React.useMemo<ComplianceCheckResult>(
    () => screenMessage(screened),
    [screened],
  );
  const blocked = check.verdict === 'blocked';

  // Loader ticks.
  React.useEffect(() => {
    if (done) return;
    const t = setTimeout(() => setLoaderStep((n) => n + 1), 700);
    return () => clearTimeout(t);
  }, [loaderStep, done]);

  // Ribbon lifecycle: scanning while the run is in flight, verdict when it
  // lands, idle when the runner unmounts. Never self-displayed here.
  React.useEffect(() => {
    dispatch({ type: 'SET_COMPLIANCE', status: 'scanning' });
    return () => dispatch({ type: 'SET_COMPLIANCE', status: 'idle' });
  }, [dispatch]);

  // On completion: verdict → ribbon, tokens → deal, run → receipt. Once.
  const logged = React.useRef(false);
  React.useEffect(() => {
    if (!done || logged.current) return;
    logged.current = true;
    dispatch({ type: 'SET_COMPLIANCE', status: ribbonStatus(check.verdict) });
    addDealTokens(dealId, tokens);
    addReceipt(dealId, step.id, {
      label: 'Screened',
      verdict: receiptVerdict(check.verdict),
      checks: receiptChecks(check),
      seconds: Math.max(1, Math.round((Date.now() - startedAt.current) / 1000)),
      tokens,
    });
  }, [done, check, dealId, dispatch, step.id, tokens]);

  function approve() {
    logAudit('step', 'Approved', step.title, {
      deal: deal.codename,
    });
    appendVersion(dealId, step.id, feature.title, 'Approved and logged as an output version.');
    onClose();
  }

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-3)]">
      <p className="eyebrow text-[var(--ai-deep)]">Agent run · {feature.title}</p>
      <p className="mt-1 text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
        {feature.description}
      </p>

      {!done ? (
        <ul className="mt-[var(--space-3)] space-y-[var(--space-2)]">
          {feature.loading.map((label, i) => {
            const isDone = i < loaderStep;
            const current = i === loaderStep;
            return (
              <li
                key={label}
                className={[
                  'flex items-center gap-[var(--space-2)] text-[length:var(--text-sm)]',
                  isDone || current ? 'opacity-100' : 'opacity-40',
                ].join(' ')}
              >
                {isDone ? (
                  <span className="inline-block size-2 rounded-full bg-[var(--positive)]" />
                ) : current ? (
                  <span className="size-3 animate-spin rounded-full border-2 border-[var(--ai-soft)] border-t-[var(--ai)]" />
                ) : (
                  <span className="inline-block size-2 rounded-full bg-[var(--stroke)]" />
                )}
                <span
                  className={
                    current
                      ? 'font-medium text-[var(--ai-deep)]'
                      : 'text-[var(--ink-secondary)]'
                  }
                >
                  {label}
                  {current ? '…' : ''}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="mt-[var(--space-3)] space-y-[var(--space-3)]">
          {feature.contacts?.length ? (
            <ul className="divide-y divide-[var(--stroke)]">
              {feature.contacts.map((c) => (
                <li key={c.name} className="py-[var(--space-2)]">
                  <div className="flex flex-wrap items-center gap-x-[var(--space-2)] gap-y-0.5">
                    <span className="text-[length:var(--text-sm)] font-semibold text-[var(--ink)]">
                      {c.name}
                    </span>
                    <span className="rounded-[var(--radius-pill)] bg-[var(--surface-subtle)] px-1.5 py-px text-[length:var(--text-xxs)] text-[var(--ink-secondary)]">
                      {c.role}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
                    {c.note}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}

          {feature.draft ? (
            <pre className="whitespace-pre-wrap rounded-[var(--radius-input)] border border-[var(--stroke)] bg-[var(--surface-subtle)] p-[var(--space-3)] font-mono text-[length:var(--text-xs)] leading-relaxed text-[var(--ink)]">
              {feature.draft}
            </pre>
          ) : null}

          {/* The verdict lives on the shell ribbon; here it is only a log line. */}
          <p className="font-mono text-[length:var(--text-xxs)] text-[var(--ink-tertiary)]">
            Screened · verdict routed to the compliance ribbon · logged as a
            receipt on this step
          </p>

          <div className="flex items-center justify-end gap-[var(--space-2)] border-t border-[var(--stroke)] pt-[var(--space-2)]">
            <button
              type="button"
              onClick={onClose}
              className="rounded-[var(--radius-button)] border border-[var(--stroke)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-xs)] font-medium text-[var(--ink)] transition-colors hover:border-[var(--ink-tertiary)]"
            >
              Collapse to receipt
            </button>
            <button
              type="button"
              onClick={approve}
              disabled={blocked}
              className="rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-xs)] font-semibold text-[var(--ink-on-dark)] transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {blocked ? 'Blocked · cannot approve' : 'Approve · log as version'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default StepRunner;
