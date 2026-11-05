import {
  DEAL_RAIL,
  MVP_DEAL_RAIL,
  orderedSteps,
  type RailStep,
} from "@/lib/rail/dealRail";

import type {
  TemplateAddedChange,
  TemplateChangeSet,
  TemplateRemovedChange,
} from "./changeReview";

type StoredAddedChange = Omit<TemplateAddedChange, "title" | "summary"> & {
  title: string | null;
  summary: string | null;
};

type StoredRemovedChange = Omit<TemplateRemovedChange, "title"> & { title: string | null };

export type StoredTemplateChangeSet = Omit<TemplateChangeSet, "changes"> & {
  changes: (StoredAddedChange | StoredRemovedChange)[];
};

const CATALOGUE = new Map<string, RailStep>(
  [...orderedSteps(DEAL_RAIL), ...orderedSteps(MVP_DEAL_RAIL)].map((step) => [step.id, step]),
);

function stepKey(changeId: string): string {
  return changeId.slice(changeId.indexOf(":") + 1);
}

export function withCatalogueTitles(stored: StoredTemplateChangeSet): TemplateChangeSet {
  return {
    ...stored,
    changes: stored.changes.map((change) => {
      if (change.kind === "removed") {
        return {
          ...change,
          title: change.title ?? CATALOGUE.get(change.stepId)?.title ?? change.stepId,
        };
      }
      const key = stepKey(change.id);
      const entry = CATALOGUE.get(key);
      return {
        ...change,
        title: change.title ?? entry?.title ?? key,
        summary: change.summary ?? entry?.description ?? "",
      };
    }),
  };
}

export function changeSetBody(data: unknown): { changeSet: TemplateChangeSet | null } {
  return {
    changeSet: data ? withCatalogueTitles(data as StoredTemplateChangeSet) : null,
  };
}
