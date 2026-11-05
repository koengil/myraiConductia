import { publicationNonterminal } from "@/lib/skillAuthoring/publicationState";
import { nonterminal } from "@/lib/skillAuthoring/useSkillAuthoringDraft";
import type { DraftRead } from "@/lib/skillAuthoring/types";
import type { ProjectRail } from "@/lib/rail/projectRail";
import { anchorMissing } from "./SkillBuilderPlacementFields";

export type SaveGate = { enabled: boolean; reason: string | null };

export type SaveFooterProps = {
  showSave: boolean;
  saveDisabled: boolean;
  saveReason: string | null;
};

export function saveFooterProps(
  draft: DraftRead | null,
  rail: ProjectRail,
  closing: boolean,
  readOnly: boolean,
  enhancing = false,
): SaveFooterProps {
  const gate = saveGate(draft, rail, enhancing);
  return {
    showSave: !readOnly,
    saveDisabled: closing || !gate.enabled,
    saveReason: gate.reason,
  };
}

const blocked = (reason: string): SaveGate => ({ enabled: false, reason });

export function saveGate(
  draft: DraftRead | null,
  rail: ProjectRail,
  enhancing = false,
): SaveGate {
  if (!draft || draft.status !== "active")
    return { enabled: false, reason: null };
  if (nonterminal(draft.activeAttempt))
    return blocked("Finish the current response before saving.");
  if (!draft.candidate)
    return blocked("Generate a candidate skill before saving.");
  if (!enhancing && draft.name.trim().length === 0)
    return blocked("Name the step before saving.");
  if (!enhancing && (!draft.placement || anchorMissing(rail, draft.placement)))
    return blocked("Choose a position before saving.");
  if (publicationNonterminal(draft))
    return blocked("A save is already in progress.");
  return { enabled: true, reason: null };
}
