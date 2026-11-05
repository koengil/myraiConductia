import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SkillAuthoringClient } from "@/lib/skillAuthoring/client";
import type { PublicationOperations } from "@/lib/skillAuthoring/publicationClient";
import type { CandidatePreview, DraftRead } from "@/lib/skillAuthoring/types";
import { useSkillAuthoringDraft } from "@/lib/skillAuthoring/useSkillAuthoringDraft";
import { useSkillAuthoringPublication } from "@/lib/skillAuthoring/useSkillAuthoringPublication";
import type {
  PublicationRead,
  PublishCommand,
} from "@/lib/skillPublication/types";

const DEAL_ID = "deal-1";
const DRAFT_ID = "draft-1";
const OPENED_REVISION = 4;

function candidate(): CandidatePreview {
  return {
    id: "candidate-1",
    digest: "sha256:abc",
    schemaVersion: 1,
    name: "Filing summarizer",
    purpose: "Summarize filings",
    expectedInput: "A filing",
    expectedOutput: "A summary",
    inputs: [],
  };
}

function makeDraft(overrides: Partial<DraftRead> = {}): DraftRead {
  return {
    id: DRAFT_ID,
    dealId: DEAL_ID,
    status: "active",
    name: "",
    placement: { kind: "phase_start", phaseIndex: 0 },
    composerText: "",
    editRevision: OPENED_REVISION,
    messages: [],
    activeAttempt: null,
    candidate: candidate(),
    publication: { available: false },
    ...overrides,
  };
}

function makePublication(
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

function bumpingClient(): SkillAuthoringClient {
  return {
    open: vi.fn(async () => ({
      draft: makeDraft(),
      basis: null,
      seedRunId: null,
    })),
    read: vi.fn(async () => makeDraft()),
    patch: vi.fn(async (_projectId, _draftId, command) =>
      makeDraft({
        name: command.name,
        placement: command.placement,
        composerText: command.composerText,
        editRevision: command.expectedEditRevision + 1,
      }),
    ),
    send: vi.fn(async () => ({})),
    retry: vi.fn(async () => ({})),
    discard: vi.fn(async () => undefined),
  };
}

function recordingPublicationClient(): {
  client: PublicationOperations;
  commands: PublishCommand[];
} {
  const commands: PublishCommand[] = [];
  const client: PublicationOperations = {
    publish: vi.fn(async (_dealId, _draftId, command: PublishCommand) => {
      commands.push(command);
      return makePublication();
    }),
    decideDuplicate: vi.fn(async () => makePublication()),
    replacePlacement: vi.fn(async () => makePublication()),
  };
  return { client, commands };
}

function renderAuthoring(
  client: SkillAuthoringClient,
  publicationClient: PublicationOperations,
) {
  return renderHook(() => {
    const authoring = useSkillAuthoringDraft(DEAL_ID, client);
    const publication = useSkillAuthoringPublication(
      DEAL_ID,
      authoring,
      undefined,
      publicationClient,
    );
    return { authoring, publication };
  });
}

describe("publishing straight after an edit", () => {
  it("sends the post-flush edit revision", async () => {
    const client = bumpingClient();
    const { client: publicationClient, commands } =
      recordingPublicationClient();
    const { result } = renderAuthoring(client, publicationClient);
    await waitFor(() => expect(result.current.authoring.status).toBe("ready"));

    act(() => {
      result.current.authoring.updateFields({ name: "Teaser review" });
    });
    await act(async () => {
      await result.current.publication.publish();
    });

    expect(client.patch).toHaveBeenCalledTimes(1);
    expect(commands).toHaveLength(1);
    expect(commands[0].expectedEditRevision).toBe(OPENED_REVISION + 1);
  });

  it("keeps the post-flush edit revision after the publication merges", async () => {
    const client = bumpingClient();
    const { client: publicationClient } = recordingPublicationClient();
    const { result } = renderAuthoring(client, publicationClient);
    await waitFor(() => expect(result.current.authoring.status).toBe("ready"));

    act(() => {
      result.current.authoring.updateFields({ name: "Teaser review" });
    });
    await act(async () => {
      await result.current.publication.publish();
    });

    await waitFor(() =>
      expect(result.current.authoring.draft?.publication.available).toBe(true),
    );
    expect(result.current.authoring.draft?.editRevision).toBe(
      OPENED_REVISION + 1,
    );
  });
});
