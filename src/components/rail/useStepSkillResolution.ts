'use client';

import * as React from 'react';

import { skillBindingForStep, type ProjectRailStep } from '@/lib/rail/projectRail';
import type { SkillReference } from '@/lib/skillRun/types';

/**
 * Whether a step's skill resolves, from the step's existing skill-versions
 * read, and whether it has recorded runs. The step view names a skill
 * on its draft button only when one resolves: `current` non-null, or the
 * step's own definition binds one. While the read is pending it shows no
 * button; a failed read is never presented as "no skill".
 */
export type StepSkillResolution =
  | { status: 'pending' }
  | { status: 'unavailable' }
  /** `hasRuns` null: the runs read failed, so whether runs exist is unknown. */
  | { status: 'ready'; hasSkill: boolean; hasRuns: boolean | null };

/** A step's resolved skill: the reference, none attached, or unreadable. */
export type ResolvedSkill = SkillReference | 'none' | 'unavailable';

export function runsPath(projectId: string, stepId: string): string {
  return `/api/v1/deals/${encodeURIComponent(projectId)}/steps/${encodeURIComponent(stepId)}/skill-runs`;
}

function versionsPath(projectId: string, stepId: string): string {
  return `/api/v1/deals/${encodeURIComponent(projectId)}/steps/${encodeURIComponent(stepId)}/skill-versions`;
}

/** The step's existing skill-versions read, shared by the step view and its skill runner. */
export async function fetchResolvedSkillReference(
  projectId: string,
  stepId: string,
): Promise<ResolvedSkill> {
  const response = await fetch(versionsPath(projectId, stepId), { credentials: 'include' });
  if (!response.ok) return 'unavailable';
  const body = (await response.json().catch(() => null)) as { current?: SkillReference | null } | null;
  return body?.current ?? 'none';
}

/** Whether the step has recorded runs; null when the read failed (unknown, never "none"). */
async function fetchHasRuns(projectId: string, stepId: string): Promise<boolean | null> {
  try {
    const response = await fetch(runsPath(projectId, stepId), { credentials: 'include' });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as { runs?: unknown[] } | null;
    return Array.isArray(body?.runs) ? body.runs.length > 0 : null;
  } catch {
    return null;
  }
}

export function useStepSkillResolution(
  dealId: string,
  step: ProjectRailStep,
  enabled: boolean,
): StepSkillResolution {
  const bound = skillBindingForStep(step) !== null;
  const [read, setRead] = React.useState<{ key: string; value: StepSkillResolution } | null>(null);
  const key = `${dealId}:${step.stepId}`;

  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const [resolved, hasRuns] = await Promise.all([
          fetchResolvedSkillReference(dealId, step.stepId),
          fetchHasRuns(dealId, step.stepId),
        ]);
        if (cancelled) return;
        if (resolved === 'unavailable') {
          setRead({ key, value: { status: 'unavailable' } });
          return;
        }
        setRead({
          key,
          value: { status: 'ready', hasSkill: bound || resolved !== 'none', hasRuns },
        });
      } catch {
        if (!cancelled) setRead({ key, value: { status: 'unavailable' } });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, dealId, step.stepId, key, bound]);

  if (!enabled) return { status: 'ready', hasSkill: true, hasRuns: false };
  return read?.key === key ? read.value : { status: 'pending' };
}
