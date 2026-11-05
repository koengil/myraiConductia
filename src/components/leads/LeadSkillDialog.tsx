'use client';

import { DebriefSkills } from '@/components/leads/DebriefSkills';
import { PresearchRunner } from '@/components/leads/PresearchRunner';
import { Dialog, useRetainedWhileClosing } from '@/components/overlay';
import { leadSkillById, type LeadSkillId } from '@/lib/leads/leadSkills';

export function LeadSkillDialog({
  skillId,
  companyId,
  companyName,
  onClose,
  onApplied,
}: {
  skillId: LeadSkillId | null;
  companyId: string;
  companyName: string;
  onClose: () => void;
  onApplied?: () => void;
}) {
  // Held through the exit motion after the list clears the choice.
  const shownId = useRetainedWhileClosing(skillId);
  const skill = shownId ? leadSkillById(shownId) : null;

  return (
    <Dialog
      open={skillId != null}
      onClose={onClose}
      eyebrow="Ignatious"
      title={skill?.label ?? ''}
      description={skill?.description}
      size="xl"
      // Debriefs, attendees and answers are typed here: a stray scrim click
      // must not throw them away. Escape and Close still close.
      dismissOnScrim={false}
    >
      {shownId === 'presearch' ? (
        <PresearchRunner
          companyId={companyId}
          companyName={companyName}
          layout="dialog"
          onApplied={onApplied}
        />
      ) : shownId ? (
        <DebriefSkills
          companyId={companyId}
          companyName={companyName}
          layout="dialog"
          onApplied={onApplied}
        />
      ) : null}
    </Dialog>
  );
}
