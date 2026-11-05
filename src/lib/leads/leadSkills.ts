export const LEAD_SKILL_IDS = ['presearch', 'source-intelligence'] as const;

export type LeadSkillId = (typeof LEAD_SKILL_IDS)[number];

export type LeadSkill = {
  id: LeadSkillId;
  label: string;
  description: string;
};

export const LEAD_SKILLS: readonly LeadSkill[] = [
  {
    id: 'presearch',
    label: 'Presearch this lead',
    description: 'Research the company and write people and the memo back onto the lead.',
  },
  {
    id: 'source-intelligence',
    label: 'Source intelligence and twins',
    description:
      'Paste a debrief or transcript. Source intelligence updates the maps; the twin builder writes personas you can talk to.',
  },
];

export function leadSkillById(id: LeadSkillId): LeadSkill {
  const skill = LEAD_SKILLS.find((entry) => entry.id === id);
  if (!skill) throw new Error(`Unknown lead skill: ${id}`);
  return skill;
}
