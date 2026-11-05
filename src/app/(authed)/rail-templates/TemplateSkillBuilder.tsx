'use client';

import * as React from 'react';

import { SkillBuilderDialog } from '@/components/rail/SkillBuilderDialog';
import { STEP_STATUS } from '@/lib/constants/dealSteps';
import type { ProjectRail } from '@/lib/rail/projectRail';
import type { TemplateStepView } from '@/lib/rail/railTemplateModel';
import { createTemplateSkillAuthoringClient } from '@/lib/rail/templateSkillAuthoringClient';
import type { Placement } from '@/lib/skillAuthoring/types';

/** The template as a rail, so rail components (skill builder, reorder Preview) can take it. */
export function railFromSteps(
  phases: { index: number; name: string }[],
  steps: readonly TemplateStepView[],
): ProjectRail {
  return {
    currentStepId: null,
    canEditStructure: true,
    canSaveTemplate: false,
    phases: phases.map((phase) => ({ index: phase.index, name: phase.name, dealStatus: '' })),
    steps: steps.flatMap((step) => {
      if (!step.id) return [];
      return [
        {
          id: step.id,
          stepId: step.stepId,
          origin: step.origin,
          phaseIndex: step.phaseIndex,
          displayOrder: step.displayOrder,
          seq: step.seq,
          status: STEP_STATUS.PENDING,
          definition: { title: step.title, description: step.description },
          anchorStepId: null,
          removedAt: null,
          removedBy: null,
          skip: null,
        },
      ];
    }),
  };
}

/**
 * The skill builder on a template. `open` comes from the parent's state, so
 * closing sets it false while this stays mounted and the shared dialog plays
 * its exit motion.
 */
export function TemplateSkillBuilder({
  open,
  templateId,
  phases,
  steps,
  placement,
  onClose,
  onAdded,
}: {
  open: boolean;
  templateId: string;
  phases: { index: number; name: string }[];
  steps: readonly TemplateStepView[];
  placement: Placement;
  onClose: () => void;
  onAdded: () => void;
}) {
  const rail = React.useMemo(() => railFromSteps(phases, steps), [phases, steps]);
  const authoring = React.useMemo(
    () => createTemplateSkillAuthoringClient(templateId, placement),
    [templateId, placement],
  );

  return (
    <SkillBuilderDialog
      open={open}
      dealId={templateId}
      rail={rail}
      client={authoring.drafts}
      publicationClient={authoring.publication}
      onClose={onClose}
      onPublished={() => {
        onClose();
        onAdded();
      }}
    />
  );
}
