export type TemplateRevisionRef = { id: string; label: string; savedAt: string };

export type TemplateChangeAnchor = { position: "after" | "before"; stepId: string };

export const SKILL_STEP_NOT_ADDED = "skill_step_not_added";

export type TemplateChangeDecision = "accepted" | "discarded";

export type TemplateAddedChange = {
  id: string;
  kind: "added";
  title: string;
  summary: string;
  phaseIndex: number;
  anchor: TemplateChangeAnchor | null;
  decision: TemplateChangeDecision | null;
};

export type TemplateRemovedChange = {
  id: string;
  kind: "removed";
  stepId: string;
  title: string;
  phaseIndex: number;
  decision: TemplateChangeDecision | null;
};

export type TemplateChange = TemplateAddedChange | TemplateRemovedChange;

export type TemplateChangeSet = {
  template: { id: string; name: string };
  baseRevision: TemplateRevisionRef;
  currentRevision: TemplateRevisionRef & { savedBy: { id: string; name: string } };
  changes: TemplateChange[];
};

export function pendingChanges(changeSet: TemplateChangeSet): TemplateChange[] {
  return changeSet.changes.filter((change) => change.decision === null);
}
