import { vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { SkillBuilderDialog } from "@/components/rail/SkillBuilderDialog";
import type { SkillAuthoringClient } from "@/lib/skillAuthoring/client";
import type { CandidatePreview, DraftRead } from "@/lib/skillAuthoring/types";
import type { PublicationRead } from "@/lib/skillPublication/types";
import { baseDraft, rail, waitForDraftOpened } from "./skillBuilderDialogFixtures";

export { baseDraft, fakeClient, rail } from "./skillBuilderDialogFixtures";

export const candidate: CandidatePreview = {
  id: "cand-1",
  digest: "sha256:abc",
  schemaVersion: 1,
  name: "Filing summarizer",
  purpose: "Summarize filings",
  expectedInput: "A filing document",
  expectedOutput: "A short summary",
  inputs: [],
};

export function publication(
  overrides: Partial<PublicationRead> = {},
): PublicationRead {
  return {
    available: true,
    id: "pub-1",
    state: "preparing",
    revision: 1,
    matches: [],
    error: null,
    result: null,
    assessmentDigest: null,
    ...overrides,
  };
}

export function stateDraft(
  state: PublicationRead["state"],
  overrides: Partial<PublicationRead> = {},
): DraftRead {
  return baseDraft({
    candidate,
    publication: publication({ state, ...overrides }),
  });
}

export type OpenWithHandlers = {
  onPublished?: (stepId: string) => void;
  onFocusStep?: (dealStepId: string) => void;
  onRestoreStep?: (dealStepId: string) => Promise<boolean>;
  onClose?: () => void;
};

export async function openWith(
  client: SkillAuthoringClient,
  handlers: OpenWithHandlers = {},
) {
  const { onClose: providedOnClose, ...forwardedHandlers } = handlers;
  const onClose = providedOnClose ?? vi.fn();
  render(
    <SkillBuilderDialog
      open
      dealId="deal-1"
      rail={rail}
      onClose={onClose}
      client={client}
      {...forwardedHandlers}
    />,
  );
  await screen.findByRole("dialog");
  await waitForDraftOpened(client);
  return { onClose };
}
