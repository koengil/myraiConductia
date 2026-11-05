import { isRecord, isUuid } from "@/lib/skillPublication/parse";

import { parseTemplateSkillSource } from "./skillSource";
import type { TemplateSkillSource } from "./types";

export type PublishPlan = {
  tenantId: string;
  skills: Array<{ key: string; source: TemplateSkillSource }>;
};

export function parsePublishCheck(value: unknown): PublishPlan | null {
  if (!isRecord(value) || !isUuid(value.tenantId) || !isRecord(value.manifest)) {
    return null;
  }
  const listed = value.manifest.skills;
  if (!Array.isArray(listed)) return null;

  const skills: PublishPlan["skills"] = [];
  for (const skill of listed) {
    if (!isRecord(skill) || typeof skill.key !== "string" || skill.key === "") {
      return null;
    }
    const source = parseTemplateSkillSource(skill.source);
    if (source === null) return null;
    skills.push({ key: skill.key, source });
  }
  return { tenantId: value.tenantId, skills };
}
