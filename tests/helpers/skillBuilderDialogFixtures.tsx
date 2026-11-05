import { expect, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";

import { SkillBuilderDialog } from "@/components/rail/SkillBuilderDialog";
import type { SkillAuthoringClient } from "@/lib/skillAuthoring/client";
import type { AttemptRead, DraftRead } from "@/lib/skillAuthoring/types";
import type { PublicationOperations } from "@/lib/skillAuthoring/publicationClient";
import type { PublicationRead } from "@/lib/skillPublication/types";
import type { ProjectRail } from "@/lib/rail/projectRail";
import { publicationClientStub } from "./publicationClientStub";

export const rail: ProjectRail = {
  currentStepId: "step-1",
  canEditStructure: true,
  canSaveTemplate: false,
  phases: [
    { index: 0, name: "Origination", dealStatus: "active" },
    { index: 1, name: "Diligence", dealStatus: "active" },
  ],
  steps: [
    {
      id: "step-1",
      stepId: "cat-1",
      origin: "catalog",
      phaseIndex: 0,
      displayOrder: 1,
      seq: 1,
      status: "current",
      definition: null,
      anchorStepId: null,
      removedAt: null,
      removedBy: null,
      skip: null,
    },
    {
      id: "step-2",
      stepId: "cat-2",
      origin: "catalog",
      phaseIndex: 0,
      displayOrder: 2,
      seq: 2,
      status: "pending",
      definition: null,
      anchorStepId: null,
      removedAt: null,
      removedBy: null,
      skip: null,
    },
  ],
};

export function baseDraft(overrides: Partial<DraftRead> = {}): DraftRead {
  return {
    id: "draft-1",
    dealId: "deal-1",
    status: "active",
    name: "",
    placement: null,
    composerText: "",
    editRevision: 1,
    messages: [],
    activeAttempt: null,
    candidate: null,
    publication: { available: false },
    ...overrides,
  };
}

export function attempt(overrides: Partial<AttemptRead> = {}): AttemptRead {
  return {
    id: "attempt-1",
    messageId: "message-1",
    number: 1,
    status: "succeeded",
    responseText: "",
    error: null,
    ...overrides,
  };
}

export function openResult(draft: DraftRead) {
  return { draft, basis: null, seedRunId: null };
}

export function fakeClient(
  overrides: Partial<SkillAuthoringClient> = {},
): SkillAuthoringClient {
  return {
    open: vi.fn(async () => openResult(baseDraft())),
    read: vi.fn(async () => baseDraft()),
    patch: vi.fn(async (dealId, draftId, command) => baseDraft({ ...command })),
    send: vi.fn(async () => baseDraft()),
    retry: vi.fn(async () => baseDraft()),
    discard: vi.fn(async () => undefined),
    ...overrides,
  };
}

export function publication(
  overrides: Partial<PublicationRead> = {},
): PublicationRead {
  return {
    available: true,
    id: "publication-1",
    state: "preparing",
    revision: 1,
    matches: [],
    error: null,
    result: null,
    assessmentDigest: null,
    ...overrides,
  };
}

/**
 * The builder is ready once the draft open call has resolved (or refused)
 * and its result is on screen: the named "Message" field (both create and
 * enhance mode), or the "Not permitted" dialog. Never the save status: nothing shows there before the
 * first edit.
 */
export async function waitForDraftOpened(client: SkillAuthoringClient) {
  await waitFor(() => expect(client.open).toHaveBeenCalled());
  const opened = vi.mocked(client.open).mock.results.at(-1)?.value as Promise<unknown> | undefined;
  await act(async () => {
    await Promise.resolve(opened).catch(() => undefined);
  });
  await waitFor(() => {
    const named = screen.queryByLabelText("Message");
    const notPermitted = screen.queryByText("Not permitted");
    expect(named !== null || notPermitted !== null).toBe(true);
  });
}

/**
 * For a builder opened through the real client (the rail): ready once the
 * draft is read, which enables "Discard draft" (it waits for a draft).
 */
export async function waitForDraftLoaded() {
  await waitFor(() => expect(screen.getByRole("button", { name: "Discard draft" })).toBeEnabled());
}

export type OpenDialogOptions = {
  publicationClient?: PublicationOperations;
  onPublished?: (stepId: string) => void;
  onFocusStep?: (dealStepId: string) => void;
  onRestoreStep?: (dealStepId: string) => Promise<boolean>;
};

export async function openDialog(
  client: SkillAuthoringClient,
  rawRail: ProjectRail = rail,
  options: OpenDialogOptions = {},
) {
  const onClose = vi.fn();
  const publicationClient =
    options.publicationClient ?? publicationClientStub();
  render(
    <SkillBuilderDialog
      open
      dealId="deal-1"
      rail={rawRail}
      onClose={onClose}
      client={client}
      publicationClient={publicationClient}
      onPublished={options.onPublished}
      onFocusStep={options.onFocusStep}
      onRestoreStep={options.onRestoreStep}
    />,
  );
  await screen.findByRole("dialog");
  await waitForDraftOpened(client);
  return { onClose, publicationClient };
}
