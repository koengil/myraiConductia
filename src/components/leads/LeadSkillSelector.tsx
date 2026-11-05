'use client';

import { ChevronDown } from 'lucide-react';

import { Menu } from '@/components/overlay';
import { LEAD_SKILLS, type LeadSkillId } from '@/lib/leads/leadSkills';

/**
 * "Run a skill" on a lead: the shared Menu, one item per lead skill with
 * what it does on a second line. Choosing one opens its dialog.
 */
export function LeadSkillSelector({
  leadName,
  onSelect,
}: {
  leadName: string;
  onSelect: (skillId: LeadSkillId) => void;
}) {
  return (
    <div className="shrink-0">
      <Menu
        label={`Skills for ${leadName}`}
        trigger={
          <>
            Run a skill
            <ChevronDown className="size-3.5" aria-hidden />
          </>
        }
        items={LEAD_SKILLS.map((skill) => ({
          id: skill.id,
          label: skill.label,
          description: skill.description,
          onSelect: () => onSelect(skill.id),
        }))}
      />
    </div>
  );
}
