import { it, expect, afterEach, vi } from "vitest";
import {
  act,
  render,
  renderHook,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";

import {
  SkillBuilderDialog,
  useGatedFlush,
} from "@/components/rail/SkillBuilderDialog";
import { SkillAuthoringConversation } from "@/components/rail/SkillAuthoringConversation";
import { SkillAuthoringHttpError } from "@/lib/skillAuthoring/client";
import { SkillPublicationClientError } from "@/lib/skillAuthoring/publicationClient";
import type { PublicationFreeze } from "@/lib/skillAuthoring/publicationState";
import type { DraftRead } from "@/lib/skillAuthoring/types";
import {
  attempt,
  baseDraft,
  fakeClient,
  openDialog,
  openResult,
  publication,
  rail,
} from "./helpers/skillBuilderDialogFixtures";
import { publicationClientStub } from "./helpers/publicationClientStub";

function candidateFixture() {
  return {
    id: "cand-1",
    digest: "sha256:abc",
    schemaVersion: 1 as const,
    name: "Filing summarizer",
    purpose: "Summarize filings",
    expectedInput: "A filing",
    expectedOutput: "A summary",
    inputs: [],
  };
}

function skillBindingFixture() {
  return {
    skillId: "11111111-1111-4111-8111-111111111111",
    versionId: "22222222-2222-4222-8222-222222222222",
    digest: "b".repeat(64),
  };
}

function frozenFreeze(): PublicationFreeze {
  return {
    patchDisabled: true,
    sendDisabled: true,
    retryDisabled: true,
    discardDisabled: true,
    duplicateDecisionOnly: false,
    placementReplacementOnly: false,
    readOnly: false,
  };
}

function openFreeze(): PublicationFreeze {
  return {
    patchDisabled: false,
    sendDisabled: false,
    retryDisabled: false,
    discardDisabled: false,
    duplicateDecisionOnly: false,
    placementReplacementOnly: false,
    readOnly: false,
  };
}

afterEach(() => {
  cleanup();
});

it("renders nothing when closed", () => {
  render(
    <SkillBuilderDialog
      open={false}
      dealId="deal-1"
      rail={rail}
      onClose={vi.fn()}
    />,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("restores the draft name, placement and messages", async () => {
  const draft = baseDraft({
    name: "Buyer outreach",
    placement: { kind: "phase_start", phaseIndex: 0 },
    messages: [
      {
        id: "message-1",
        ordinal: 1,
        text: "Summarize this filing",
        attempts: [attempt({ responseText: "Here is the summary" })],
      },
    ],
  });
  await openDialog(fakeClient({ open: vi.fn(async () => openResult(draft)) }));
  await waitFor(() =>
    expect(screen.getByLabelText("Step name")).toHaveValue("Buyer outreach"),
  );
  // A saved spot reads as one line; Change opens the choices on it.
  expect(screen.getByTestId("placement-summary")).toHaveTextContent(
    "Adds at the start of Origination",
  );
  expect(screen.queryByLabelText("Position")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Change where this step goes" }));
  expect(screen.getByLabelText("Position")).toHaveValue("phase_start");
  expect(screen.getByText("Summarize this filing")).toBeInTheDocument();
  expect(screen.getByText("Here is the summary")).toBeInTheDocument();
});

const RAW_API_MESSAGE =
  "A draft patch requires a valid name, placement, composerText, and nonnegative expectedEditRevision.";
const NAME_FIELD_ERROR_TEXT =
  "Enter a step name, or leave it empty; a name cannot be only spaces.";

function namePatchMock(goodName: string) {
  return vi
    .fn()
    .mockRejectedValueOnce(
      new SkillAuthoringHttpError(400, RAW_API_MESSAGE, null),
    )
    .mockResolvedValueOnce(baseDraft({ name: goodName, editRevision: 2 }));
}

it("shows the name field error for a spaces-only name, never the raw API message, and clears it once a valid name saves", async () => {
  const patch = namePatchMock("Good name");
  await openDialog(fakeClient({ patch }));

  const nameInput = screen.getByLabelText("Step name");
  fireEvent.change(nameInput, { target: { value: "   " } });
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));

  await waitFor(() =>
    expect(nameInput).toHaveAttribute("aria-invalid", "true"),
  );
  expect(nameInput).toHaveAttribute(
    "aria-describedby",
    "skill-authoring-name-error",
  );
  const alert = screen.getByText(NAME_FIELD_ERROR_TEXT);
  expect(alert.id).toBe("skill-authoring-name-error");
  expect(alert).toHaveAttribute("role", "alert");
  expect(screen.queryByText(RAW_API_MESSAGE)).not.toBeInTheDocument();
  expect(
    screen.queryByText("This draft changed in another tab."),
  ).not.toBeInTheDocument();

  fireEvent.change(nameInput, { target: { value: "Good name" } });
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
  expect(patch.mock.calls[1]?.[2]).toMatchObject({ name: "Good name" });
  await waitFor(() => expect(nameInput).not.toHaveAttribute("aria-invalid"));
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
  );
});

it("shows length-specific copy for a name over the 100-character limit", async () => {
  await openDialog(fakeClient());
  const nameInput = screen.getByLabelText("Step name");
  fireEvent.change(nameInput, { target: { value: "n".repeat(101) } });
  await waitFor(() =>
    expect(nameInput).toHaveAttribute("aria-invalid", "true"),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Step names can be at most 100 characters.",
  );
});

it("explains that only phase start and end are available when a phase has no active steps", async () => {
  await openDialog(fakeClient());
  const phase = screen.getByLabelText("Phase") as HTMLSelectElement;
  fireEvent.change(phase, { target: { value: "1" } });

  const position = screen.getByLabelText("Position") as HTMLSelectElement;
  expect(
    Array.from(position.querySelectorAll("option")).some((option) =>
      option.textContent?.startsWith("After: "),
    ),
  ).toBe(false);
  expect(
    screen.getByText(
      "This phase has no active steps, so only phase start and end are available.",
    ),
  ).toBeInTheDocument();
});

it("shows the responseText of an active attempt", async () => {
  const draft = baseDraft({
    activeAttempt: attempt({
      status: "running",
      responseText: "Partial answer so far",
    }),
    messages: [
      {
        id: "message-1",
        ordinal: 1,
        text: "q",
        attempts: [
          attempt({ status: "running", responseText: "Partial answer so far" }),
        ],
      },
    ],
  });
  await openDialog(fakeClient({ open: vi.fn(async () => openResult(draft)) }));
  expect(screen.getByText("Partial answer so far")).toBeInTheDocument();
  expect(screen.getByText("Generating")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});

function failedMessage(
  id: string,
  ordinal: number,
  text: string,
  errorMessage: string,
) {
  return {
    id,
    ordinal,
    text,
    attempts: [
      attempt({
        id: `${id}-attempt`,
        messageId: id,
        status: "failed" as const,
        error: { code: "x", message: errorMessage },
      }),
    ],
  };
}

it("shows Retry only on the newest failed message", async () => {
  const draft = baseDraft({
    messages: [
      failedMessage("message-1", 1, "first", "Older failure"),
      failedMessage("message-2", 2, "second", "Newer failure"),
    ],
  });
  await openDialog(fakeClient({ open: vi.fn(async () => openResult(draft)) }));
  expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
  expect(screen.getByText("Older failure")).toBeInTheDocument();
  expect(screen.getByText("Newer failure")).toBeInTheDocument();
});

it("clicking Retry calls retry for that message", async () => {
  const draft = baseDraft({
    messages: [failedMessage("message-1", 1, "first", "Older failure")],
  });
  const retry = vi.fn(
    async (
      _dealId: string,
      _draftId: string,
      _messageId: string,
      _body: { retryRequestId: string },
    ) => draft,
  );
  await openDialog(fakeClient({ open: vi.fn(async () => openResult(draft)), retry }));
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(retry).toHaveBeenCalled());
  expect(retry.mock.calls[0]?.[2]).toBe("message-1");
});

it("disables Send and the composer as soon as Send is clicked, before the send response arrives", async () => {
  let resolveSend: (draft: DraftRead) => void = () => undefined;
  const client = fakeClient({
    send: vi.fn(
      () =>
        new Promise<DraftRead>((resolve) => {
          resolveSend = resolve;
        }),
    ),
  });
  await openDialog(client);

  const composer = screen.getByLabelText("Message");
  fireEvent.change(composer, { target: { value: "Build a skill" } });
  await waitFor(() => expect(client.patch).toHaveBeenCalled());

  const sendButton = screen.getByRole("button", { name: "Send" });
  await waitFor(() => expect(sendButton).not.toBeDisabled());
  fireEvent.click(sendButton);

  await waitFor(() => expect(client.send).toHaveBeenCalled());
  expect(sendButton).toBeDisabled();
  expect(composer).toBeDisabled();

  resolveSend(baseDraft({ composerText: "", editRevision: 2 }));
});

it("shows Ready to save and a disabled Save for a candidate", async () => {
  const draft = baseDraft({
    candidate: {
      id: "cand-1",
      digest: "sha256:abc",
      schemaVersion: 1,
      name: "Filing summarizer",
      purpose: "Summarize filings",
      expectedInput: "A filing document",
      expectedOutput: "A short summary",
      inputs: [],
    },
  });
  await openDialog(fakeClient({ open: vi.fn(async () => openResult(draft)) }));
  expect(screen.getByText("Filing summarizer")).toBeInTheDocument();
  expect(screen.getByText("Ready to save")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Save skill and add step" }),
  ).toBeDisabled();
});

it("shows Ready to save only for a valid candidate", async () => {
  await openDialog(fakeClient());
  expect(screen.queryByText("Ready to save")).toBeNull();
  expect(screen.getByText("No candidate skill yet.")).toBeInTheDocument();
});

it("saves then closes on Close", async () => {
  const { onClose } = await openDialog(fakeClient());
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

it("saves then closes on Escape", async () => {
  const { onClose } = await openDialog(fakeClient());
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

it("keeps the dialog open and shows the save error message on a failed Close", async () => {
  const patch = vi.fn(async () => {
    throw { status: 500 };
  });
  const { onClose } = await openDialog(fakeClient({ patch }));
  fireEvent.change(screen.getByLabelText("Step name"), {
    target: { value: "name" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await screen.findByText(
    "The latest text is not durable yet. Try closing again.",
  );
  await waitFor(() =>
    expect(screen.getByTestId("draft-status")).toHaveTextContent("Not saved"),
  );
  expect(onClose).not.toHaveBeenCalled();
});

it("asks for confirmation before discarding, then discards", async () => {
  const draft = baseDraft({
    messages: [
      {
        id: "message-1",
        ordinal: 1,
        text: "kept until server confirms",
        attempts: [],
      },
    ],
  });
  const { onClose } = await openDialog(
    fakeClient({ open: vi.fn(async () => openResult(draft)) }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  expect(screen.getByText("Discard this draft?")).toBeInTheDocument();
  expect(screen.getByText("kept until server confirms")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Yes, discard" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

it("shows a not-permitted state with only Close, and closes on Close", async () => {
  const open = vi.fn(async () => {
    throw new SkillAuthoringHttpError(403, "Not permitted.", null);
  });
  const { onClose } = await openDialog(fakeClient({ open }));
  await screen.findByText("Not permitted");
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getAllByRole("button")).toHaveLength(1);
  expect(
    within(dialog).getByRole("button", { name: "Close" }),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("Message")).toBeNull();
  expect(screen.queryByText("Skill preview")).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

it("orders the footer as Discard draft, Close, Save skill and add step", async () => {
  await openDialog(fakeClient());
  const footer = screen.getByTestId("skill-builder-footer");
  const names = within(footer)
    .getAllByRole("button")
    .map((button) => button.textContent);
  expect(names).toEqual(["Discard draft", "Close", "Save skill and add step"]);
});

it("keeps the footer actions in place while the discard confirmation is open", async () => {
  await openDialog(fakeClient());
  const actions = screen.getByTestId("skill-builder-footer-actions");
  const actionNames = () =>
    within(actions)
      .getAllByRole("button")
      .map((button) => button.textContent);
  expect(actionNames()).toEqual(["Close", "Save skill and add step"]);
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  expect(screen.getByText("Discard this draft?")).toBeInTheDocument();
  expect(actionNames()).toEqual(["Close", "Save skill and add step"]);
  expect(
    within(actions).queryByRole("button", { name: "Yes, discard" }),
  ).toBeNull();
  const confirmation = screen.getByRole("group", { name: "Discard draft" });
  expect(confirmation.className).toContain("absolute");
});

it("closes the discard confirmation on Escape without closing the dialog", async () => {
  const { onClose } = await openDialog(fakeClient());
  fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
  fireEvent.keyDown(screen.getByRole("button", { name: "Discard draft" }), {
    key: "Escape",
  });
  expect(screen.queryByText("Discard this draft?")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});

it("shows no save status right after opening, before any edit", async () => {
  await openDialog(fakeClient());
  expect(screen.queryByTestId("draft-status")).toBeNull();
  expect(screen.queryByText("Saved")).toBeNull();
  // The first edit brings the status in.
  fireEvent.change(screen.getByLabelText("Step name"), { target: { value: "New name" } });
  expect(screen.getByTestId("draft-status")).toHaveTextContent("Saving");
});

it("shows Saving while a patch is in flight and Saved once it settles", async () => {
  let resolvePatch: (draft: DraftRead) => void = () => undefined;
  const patch = vi.fn(
    () =>
      new Promise<DraftRead>((resolve) => {
        resolvePatch = resolve;
      }),
  );
  await openDialog(fakeClient({ patch }));
  fireEvent.change(screen.getByLabelText("Step name"), {
    target: { value: "New name" },
  });
  expect(screen.getByTestId("draft-status")).toHaveTextContent("Saving");
  await waitFor(() => expect(patch).toHaveBeenCalled());
  resolvePatch(baseDraft({ name: "New name", editRevision: 2 }));
  await waitFor(() =>
    expect(screen.getByTestId("draft-status")).toHaveTextContent("Saved"),
  );
});

it("disables Send while a publication is nonterminal, composed with other reasons", async () => {
  const draft = baseDraft({
    composerText: "Ready to send",
    publication: publication({ state: "publishing" }),
  });
  await openDialog(fakeClient({ open: vi.fn(async () => openResult(draft)) }));
  expect(screen.getByLabelText("Message")).toHaveValue("Ready to send");
  // Nothing has been edited, so no save status shows.
  expect(screen.queryByTestId("draft-status")).toBeNull();
  expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
});

it("does not fire onPublished for a publication already published on open", async () => {
  const draft = baseDraft({
    publication: publication({
      state: "published",
      result: {
        stepId: "step-9",
        skillBinding: {
          skillId: "11111111-1111-4111-8111-111111111111",
          versionId: "22222222-2222-4222-8222-222222222222",
          digest: "b".repeat(64),
        },
      },
    }),
  });
  const onPublished = vi.fn();
  await openDialog(fakeClient({ open: vi.fn(async () => openResult(draft)) }), rail, {
    onPublished,
  });
  expect(onPublished).not.toHaveBeenCalled();
});

it("fires onPublished when a publish command resolves published directly", async () => {
  const draft = baseDraft({
    candidate: candidateFixture(),
    name: "Weekly update",
    placement: { kind: "phase_start", phaseIndex: 0 },
  });
  const publish = vi.fn(async () =>
    publication({
      state: "published",
      result: {
        stepId: "step-9",
        skillBinding: {
          skillId: "11111111-1111-4111-8111-111111111111",
          versionId: "22222222-2222-4222-8222-222222222222",
          digest: "b".repeat(64),
        },
      },
    }),
  );
  const onPublished = vi.fn();
  await openDialog(fakeClient({ open: vi.fn(async () => openResult(draft)) }), rail, {
    onPublished,
    publicationClient: { ...publicationClientStub(), publish },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save skill and add step" }),
  );
  await waitFor(() => expect(onPublished).toHaveBeenCalledWith("step-9"));
  expect(onPublished).toHaveBeenCalledTimes(1);
});

it("re-reads the draft while a publication is nonterminal", async () => {
  const nonterminalDraft = baseDraft({
    publication: publication({ state: "attaching" }),
  });
  const read = vi.fn(async () => nonterminalDraft);
  await openDialog(
    fakeClient({ open: vi.fn(async () => openResult(nonterminalDraft)), read }),
  );
  await waitFor(() => expect(read).toHaveBeenCalled(), { timeout: 3000 });
});

it("shows the duplicate confirmation prompt and saves anyway with the current assessment digest", async () => {
  const draft = baseDraft({
    candidate: candidateFixture(),
    publication: publication({
      state: "confirmation_required",
      revision: 3,
      assessmentDigest: "digest-xyz",
      matches: [
        {
          dealStepId: "step-2",
          name: "Existing step",
          classification: "similar",
          reasonCode: "name_match",
        },
      ],
    }),
  });
  const decideDuplicate = vi.fn(async () =>
    publication({ state: "preparing", revision: 4 }),
  );
  await openDialog(fakeClient({ open: vi.fn(async () => openResult(draft)) }), rail, {
    publicationClient: { ...publicationClientStub(), decideDuplicate },
  });
  expect(
    screen.getByText(
      "These existing steps look similar. Confirm to save anyway, or decline to revise the draft.",
    ),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save anyway" }));
  await waitFor(() =>
    expect(decideDuplicate).toHaveBeenCalledWith("deal-1", "publication-1", {
      expectedRevision: 3,
      assessmentDigest: "digest-xyz",
      decision: "confirm",
    }),
  );
});

it("sends only one decide-duplicate confirm request for a rapid double click on Save anyway", async () => {
  const draft = baseDraft({
    candidate: candidateFixture(),
    publication: publication({
      state: "confirmation_required",
      revision: 3,
      assessmentDigest: "digest-xyz",
      matches: [
        {
          dealStepId: "step-2",
          name: "Existing step",
          classification: "similar",
          reasonCode: "name_match",
        },
      ],
    }),
  });
  let resolveDecide: (value: ReturnType<typeof publication>) => void = () =>
    undefined;
  const decideDuplicate = vi.fn(
    () =>
      new Promise<ReturnType<typeof publication>>((resolve) => {
        resolveDecide = resolve;
      }),
  );
  await openDialog(fakeClient({ open: vi.fn(async () => openResult(draft)) }), rail, {
    publicationClient: { ...publicationClientStub(), decideDuplicate },
  });
  const button = screen.getByRole("button", { name: "Save anyway" });
  fireEvent.click(button);
  fireEvent.click(button);
  resolveDecide(publication({ state: "preparing", revision: 4 }));
  await waitFor(() => expect(decideDuplicate).toHaveBeenCalledTimes(1));
});

it("sends only one decide-duplicate decline request for a rapid double click on Decline and revise", async () => {
  const draft = baseDraft({
    candidate: candidateFixture(),
    publication: publication({
      state: "confirmation_required",
      revision: 3,
      assessmentDigest: "digest-xyz",
      matches: [
        {
          dealStepId: "step-2",
          name: "Existing step",
          classification: "similar",
          reasonCode: "name_match",
        },
      ],
    }),
  });
  let resolveDecide: (value: ReturnType<typeof publication>) => void = () =>
    undefined;
  const decideDuplicate = vi.fn(
    () =>
      new Promise<ReturnType<typeof publication>>((resolve) => {
        resolveDecide = resolve;
      }),
  );
  await openDialog(fakeClient({ open: vi.fn(async () => openResult(draft)) }), rail, {
    publicationClient: { ...publicationClientStub(), decideDuplicate },
  });
  const button = screen.getByRole("button", { name: "Decline and revise" });
  fireEvent.click(button);
  fireEvent.click(button);
  resolveDecide(publication({ state: "confirmation_required", revision: 4 }));
  await waitFor(() => expect(decideDuplicate).toHaveBeenCalledTimes(1));
});

it("builds needs_placement options from the live rail, excludes the frozen anchor, and shows the placement validation copy", async () => {
  const draft = baseDraft({
    placement: { kind: "after", phaseIndex: 0, afterStepId: "step-1" },
    publication: publication({ state: "needs_placement", revision: 2 }),
  });
  const replacePlacement = vi.fn(async () => {
    throw new SkillPublicationClientError("validation", "Invalid.");
  });
  await openDialog(fakeClient({ open: vi.fn(async () => openResult(draft)) }), rail, {
    publicationClient: { ...publicationClientStub(), replacePlacement },
  });

  fireEvent.change(screen.getByLabelText("New phase"), {
    target: { value: "0" },
  });
  const position = screen.getByLabelText("New position") as HTMLSelectElement;
  const optionTexts = Array.from(position.querySelectorAll("option")).map(
    (option) => option.textContent,
  );
  expect(optionTexts).not.toContain("After: cat-1");
  expect(optionTexts).toContain("After: cat-2");

  fireEvent.change(position, { target: { value: "phase_end" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm position" }));

  await waitFor(() =>
    expect(
      screen.getByText(
        "That position is no longer available. Choose another position.",
      ),
    ).toBeInTheDocument(),
  );
  expect(replacePlacement).toHaveBeenCalledWith("deal-1", "publication-1", {
    expectedRevision: 2,
    placement: { kind: "phase_end", phaseIndex: 0 },
  });
});

it("shows the no-steps help text and wires aria-describedby when R90 excludes the only anchor in the phase", async () => {
  const singleStepRail = {
    ...rail,
    steps: [rail.steps[0]],
  };
  const draft = baseDraft({
    placement: { kind: "after", phaseIndex: 0, afterStepId: "step-1" },
    publication: publication({ state: "needs_placement", revision: 2 }),
  });
  await openDialog(
    fakeClient({ open: vi.fn(async () => openResult(draft)) }),
    singleStepRail,
    {
      publicationClient: publicationClientStub(),
    },
  );

  fireEvent.change(screen.getByLabelText("New phase"), {
    target: { value: "0" },
  });

  const helpText = await screen.findByText(
    "This phase has no active steps, so only phase start and end are available.",
  );
  const position = screen.getByLabelText("New position");
  expect(position).toHaveAttribute("aria-describedby", helpText.id);
});

it("sends only one replace-placement request for a rapid double click on Confirm position", async () => {
  const draft = baseDraft({
    placement: { kind: "after", phaseIndex: 0, afterStepId: "step-1" },
    publication: publication({ state: "needs_placement", revision: 2 }),
  });
  let resolveReplace: (value: ReturnType<typeof publication>) => void = () =>
    undefined;
  const replacePlacement = vi.fn(
    () =>
      new Promise<ReturnType<typeof publication>>((resolve) => {
        resolveReplace = resolve;
      }),
  );
  await openDialog(fakeClient({ open: vi.fn(async () => openResult(draft)) }), rail, {
    publicationClient: { ...publicationClientStub(), replacePlacement },
  });

  fireEvent.change(screen.getByLabelText("New phase"), {
    target: { value: "0" },
  });
  const position = screen.getByLabelText("New position") as HTMLSelectElement;
  fireEvent.change(position, { target: { value: "phase_end" } });

  const button = screen.getByRole("button", { name: "Confirm position" });
  fireEvent.click(button);
  fireEvent.click(button);
  resolveReplace(publication({ state: "preparing", revision: 3 }));
  await waitFor(() => expect(replacePlacement).toHaveBeenCalledTimes(1));
});

it("freezes the name field, hides Retry, and disables Discard while a publication is nonterminal", async () => {
  const draft = baseDraft({
    messages: [failedMessage("message-1", 1, "first", "Older failure")],
    publication: publication({ state: "publishing" }),
  });
  await openDialog(fakeClient({ open: vi.fn(async () => openResult(draft)) }));
  expect(screen.getByLabelText("Step name")).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(screen.getByRole("button", { name: "Discard draft" })).toBeDisabled();
});

it("hides Save once the draft's publication has published", async () => {
  const draft = baseDraft({
    publication: publication({ state: "published" }),
  });
  await openDialog(fakeClient({ open: vi.fn(async () => openResult(draft)) }));
  expect(
    screen.queryByRole("button", { name: "Save skill and add step" }),
  ).toBeNull();
});

it("gates flush to a no-op while the publication is nonterminal, and passes it through once it clears", async () => {
  const flush = vi.fn(async () => false);
  const { result, rerender } = renderHook(
    ({ freeze }: { freeze: PublicationFreeze }) => useGatedFlush(flush, freeze),
    { initialProps: { freeze: frozenFreeze() } },
  );

  await expect(result.current()).resolves.toBe(true);
  expect(flush).not.toHaveBeenCalled();

  rerender({ freeze: openFreeze() });
  await expect(result.current()).resolves.toBe(false);
  expect(flush).toHaveBeenCalledTimes(1);
});

function duplicateActiveDraft(overrides: Partial<DraftRead> = {}): DraftRead {
  return baseDraft({
    publication: publication({
      state: "failed",
      error: { code: "duplicate_active", dealStepId: "step-9" },
    }),
    ...overrides,
  });
}

it("flushes a dirty field before focusing an existing step, and shows the flush-failure copy without navigating when the flush fails", async () => {
  const draft = duplicateActiveDraft();
  const patch = vi.fn(async () => {
    throw { status: 500 };
  });
  const onFocusStep = vi.fn();
  await openDialog(
    fakeClient({ open: vi.fn(async () => openResult(draft)), patch }),
    rail,
    { onFocusStep },
  );
  fireEvent.change(screen.getByLabelText("Step name"), {
    target: { value: "Renamed while failed" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Focus existing step" }));
  await waitFor(() => expect(patch).toHaveBeenCalled());
  await screen.findByText("The latest text is not durable yet. Try again.");
  expect(
    screen.queryByText(
      "The latest text is not durable yet. Try closing again.",
    ),
  ).toBeNull();
  expect(onFocusStep).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

it("clears a stale close-failure alert once a flush attempt for Focus existing step begins, never showing both alerts together", async () => {
  const draft = duplicateActiveDraft();
  const patch = vi.fn(async () => {
    throw { status: 500 };
  });
  const onFocusStep = vi.fn();
  await openDialog(
    fakeClient({ open: vi.fn(async () => openResult(draft)), patch }),
    rail,
    { onFocusStep },
  );
  fireEvent.change(screen.getByLabelText("Step name"), {
    target: { value: "Renamed while failed" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await screen.findByText(
    "The latest text is not durable yet. Try closing again.",
  );

  fireEvent.click(screen.getByRole("button", { name: "Focus existing step" }));
  await waitFor(() =>
    expect(
      screen.getByText("The latest text is not durable yet. Try again."),
    ).toBeInTheDocument(),
  );
  expect(
    screen.queryByText(
      "The latest text is not durable yet. Try closing again.",
    ),
  ).toBeNull();
});

it("focuses the existing step only after a pending flush resolves", async () => {
  const draft = duplicateActiveDraft();
  let resolvePatch: (value: DraftRead) => void = () => undefined;
  const patch = vi.fn(
    () =>
      new Promise<DraftRead>((resolve) => {
        resolvePatch = resolve;
      }),
  );
  const onFocusStep = vi.fn();
  await openDialog(
    fakeClient({ open: vi.fn(async () => openResult(draft)), patch }),
    rail,
    { onFocusStep },
  );
  fireEvent.change(screen.getByLabelText("Step name"), {
    target: { value: "Renamed while failed" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Focus existing step" }));
  await waitFor(() => expect(patch).toHaveBeenCalled());
  expect(onFocusStep).not.toHaveBeenCalled();
  resolvePatch(
    baseDraft({
      ...draft,
      name: "Renamed while failed",
      editRevision: draft.editRevision + 1,
    }),
  );
  await waitFor(() => expect(onFocusStep).toHaveBeenCalledWith("step-9"));
});

it("sends only one restore request for a rapid double click", async () => {
  const draft = baseDraft({
    publication: publication({
      state: "failed",
      error: { code: "duplicate_removed", dealStepId: "step-9" },
    }),
  });
  let resolveRestore: (value: boolean) => void = () => undefined;
  const onRestoreStep = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        resolveRestore = resolve;
      }),
  );
  await openDialog(fakeClient({ open: vi.fn(async () => openResult(draft)) }), rail, {
    onRestoreStep,
  });
  const button = screen.getByRole("button", {
    name: "Restore existing step",
  });
  fireEvent.click(button);
  fireEvent.click(button);
  resolveRestore(true);
  await waitFor(() => expect(onRestoreStep).toHaveBeenCalledTimes(1));
});

it("fires onPublished once when a poll and a late command both observe the same published id", async () => {
  vi.useFakeTimers();
  try {
    const draft = baseDraft({
      candidate: candidateFixture(),
      publication: publication({
        id: "pub-1",
        state: "confirmation_required",
        revision: 1,
        assessmentDigest: "a".repeat(64),
      }),
    });
    const publishedRead = baseDraft({
      candidate: candidateFixture(),
      publication: publication({
        id: "pub-1",
        state: "published",
        revision: 2,
        result: { stepId: "step-9", skillBinding: skillBindingFixture() },
      }),
    });
    let resolveDecide: (value: ReturnType<typeof publication>) => void = () =>
      undefined;
    const heldDecide = new Promise<ReturnType<typeof publication>>(
      (resolve) => {
        resolveDecide = resolve;
      },
    );
    const read = vi.fn(async () => publishedRead);
    const decideDuplicate = vi.fn(() => heldDecide);
    const onPublished = vi.fn();

    await act(async () => {
      render(
        <SkillBuilderDialog
          open
          dealId="deal-1"
          rail={rail}
          onClose={vi.fn()}
          client={fakeClient({ open: vi.fn(async () => openResult(draft)), read })}
          onPublished={onPublished}
          publicationClient={{ ...publicationClientStub(), decideDuplicate }}
        />,
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Save anyway" }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(onPublished).toHaveBeenCalledTimes(1);
    expect(onPublished).toHaveBeenCalledWith("step-9");

    await act(async () => {
      resolveDecide(
        publication({
          id: "pub-1",
          state: "published",
          revision: 2,
          result: { stepId: "step-9", skillBinding: skillBindingFixture() },
        }),
      );
      await heldDecide;
    });

    expect(onPublished).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

function savableDraft(): DraftRead {
  return baseDraft({
    candidate: candidateFixture(),
    name: "Weekly update",
    placement: { kind: "phase_start", phaseIndex: 0 },
  });
}

async function saveAndFail(publish: () => Promise<never>) {
  const draft = savableDraft();
  await openDialog(fakeClient({ open: vi.fn(async () => openResult(draft)) }), rail, {
    publicationClient: { ...publicationClientStub(), publish: vi.fn(publish) },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Save skill and add step" }),
  );
}

it.each([
  [
    "network",
    () =>
      Promise.reject(
        new SkillPublicationClientError("network", "Network error."),
      ),
    "The request did not reach Conductia. Check your connection and try again.",
  ],
  [
    "conflict",
    () =>
      Promise.reject(
        new SkillPublicationClientError(
          "conflict",
          "Skill save conflict.",
          "stale_edit_revision",
        ),
      ),
    "The draft changed since this action started. Reopen the draft.",
  ],
  [
    "forbidden",
    () =>
      Promise.reject(
        new SkillPublicationClientError("forbidden", "Not permitted."),
      ),
    "You no longer have permission to publish this skill.",
  ],
  [
    "validation outside needs_placement",
    () =>
      Promise.reject(
        new SkillPublicationClientError(
          "validation",
          "Invalid skill save request.",
        ),
      ),
    "This request was not valid. Correct the draft and try again.",
  ],
] as const)(
  "shows the safe copy for a %s command failure",
  async (_label, publish, expectedText) => {
    await saveAndFail(publish);
    await screen.findByText(expectedText);
    expect(
      screen.queryByText(
        "That position is no longer available. Choose another position.",
      ),
    ).toBeNull();
  },
);

it("refreshes once after an indefinite Save failure and starts the poll when the refreshed draft is nonterminal", async () => {
  const draft = savableDraft();
  const nonterminalDraft = baseDraft({
    ...draft,
    publication: publication({ state: "preparing" }),
  });
  const read = vi.fn(async () => nonterminalDraft);
  const publish = vi.fn(() =>
    Promise.reject(
      new SkillPublicationClientError("network", "Network error."),
    ),
  );
  const client = fakeClient({ open: vi.fn(async () => openResult(draft)), read });

  render(
    <SkillBuilderDialog
      open
      dealId="deal-1"
      rail={rail}
      onClose={vi.fn()}
      client={client}
      publicationClient={{ ...publicationClientStub(), publish }}
    />,
  );
  await waitFor(() => expect(client.open).toHaveBeenCalled());

  fireEvent.click(
    screen.getByRole("button", { name: "Save skill and add step" }),
  );

  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2), {
    timeout: 3000,
  });
});

it("keeps re-reading through frequent re-renders while a publication is nonterminal", async () => {
  const nonterminalDraft = baseDraft({
    publication: publication({ state: "attaching" }),
  });
  const read = vi.fn(async () => nonterminalDraft);
  const client = fakeClient({
    open: vi.fn(async () => openResult(nonterminalDraft)),
    read,
  });
  const stub = publicationClientStub();
  const { rerender } = render(
    <SkillBuilderDialog
      open
      dealId="deal-1"
      rail={rail}
      onClose={vi.fn()}
      client={client}
      publicationClient={stub}
    />,
  );
  await screen.findByRole("dialog");
  await waitFor(() => expect(client.open).toHaveBeenCalled());

  const rerenderInterval = setInterval(() => {
    rerender(
      <SkillBuilderDialog
        open
        dealId="deal-1"
        rail={rail}
        onClose={vi.fn()}
        client={client}
        publicationClient={stub}
      />,
    );
  }, 100);

  try {
    await waitFor(() => expect(read).toHaveBeenCalled(), { timeout: 3000 });
  } finally {
    clearInterval(rerenderInterval);
  }
});

function transcriptMessage(ordinal: number) {
  return {
    id: `message-${ordinal}`,
    ordinal,
    text: `Question ${ordinal}. `.repeat(20),
    attempts: [
      attempt({
        id: `attempt-${ordinal}`,
        messageId: `message-${ordinal}`,
        responseText: `Answer ${ordinal}. `.repeat(60),
      }),
    ],
  };
}

it("keeps the transcript as the scroll region and the composer pinned beside it", async () => {
  const draft = baseDraft({
    messages: Array.from({ length: 12 }, (_, index) =>
      transcriptMessage(index + 1),
    ),
  });
  await openDialog(fakeClient({ open: vi.fn(async () => openResult(draft)) }));
  const transcript = screen.getByRole("region", { name: "Conversation" });
  expect(transcript.className).toContain("overflow-y-auto");
  expect(transcript.className).toContain("min-h-0");
  expect(transcript.className).toContain("flex-1");
  const composer = screen.getByLabelText("Message");
  expect(transcript.contains(composer)).toBe(false);
  expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  expect(screen.getByTestId("skill-builder-footer")).toBeInTheDocument();
  expect(screen.getByText("Skill preview")).toBeInTheDocument();
});

it("floors the stacked transcript and makes the preview pane yield first", async () => {
  await openDialog(fakeClient());
  const transcript = screen.getByRole("region", { name: "Conversation" });
  const conversationPane = transcript.parentElement;
  expect(conversationPane).not.toBeNull();
  expect(conversationPane?.className).toContain("min-h-64");
  expect(conversationPane?.className).toContain("md:min-h-0");
  expect(conversationPane?.className).not.toContain("shrink-0");
  const previewPane = screen.getByText("Skill preview").parentElement;
  expect(previewPane).not.toBeNull();
  expect(previewPane?.className).toContain("min-h-14");
  expect(previewPane?.className).toContain("md:min-h-0");
  expect(previewPane?.className).not.toContain("shrink-0");
  expect(
    screen.getByLabelText("Message").parentElement?.parentElement?.className,
  ).toContain("shrink-0");
  const panes = conversationPane?.parentElement;
  expect(panes?.className).toContain("min-h-[22rem]");
  expect(panes?.className).toContain("md:min-h-0");
});

function conversationElement(
  messages: ReturnType<typeof transcriptMessage>[],
) {
  return (
    <SkillAuthoringConversation
      messages={messages}
      composerValue=""
      onComposerChange={() => undefined}
      composerDisabled={false}
      onSend={() => undefined}
      sendDisabled={false}
      onRetry={() => undefined}
    />
  );
}

function stubScrollMetrics(node: HTMLElement, scrollTop: number) {
  Object.defineProperty(node, "scrollHeight", {
    value: 900,
    configurable: true,
  });
  Object.defineProperty(node, "clientHeight", {
    value: 300,
    configurable: true,
  });
  Object.defineProperty(node, "scrollTop", {
    value: scrollTop,
    writable: true,
    configurable: true,
  });
  const scrollTo = vi.fn();
  Object.defineProperty(node, "scrollTo", {
    value: scrollTo,
    configurable: true,
  });
  return scrollTo;
}

it("scrolls the transcript to the newest text while the reader sits at the bottom", () => {
  const { rerender } = render(conversationElement([transcriptMessage(1)]));
  const transcript = screen.getByRole("region", { name: "Conversation" });
  const scrollTo = stubScrollMetrics(transcript, 600);
  rerender(conversationElement([transcriptMessage(1), transcriptMessage(2)]));
  expect(scrollTo).toHaveBeenCalledWith({ top: 900, behavior: "smooth" });
});

it("holds the transcript position when the reader has scrolled up", () => {
  const { rerender } = render(conversationElement([transcriptMessage(1)]));
  const transcript = screen.getByRole("region", { name: "Conversation" });
  const scrollTo = stubScrollMetrics(transcript, 120);
  fireEvent.scroll(transcript);
  rerender(conversationElement([transcriptMessage(1), transcriptMessage(2)]));
  expect(scrollTo).not.toHaveBeenCalled();
  expect(transcript.scrollTop).toBe(120);
});

function conversationWithComposer(composerValue: string) {
  return (
    <SkillAuthoringConversation
      messages={[]}
      composerValue={composerValue}
      onComposerChange={() => undefined}
      composerDisabled={false}
      onSend={() => undefined}
      sendDisabled={false}
      onRetry={() => undefined}
    />
  );
}

function lines(count: number) {
  return Array.from({ length: count }, (_, index) => `Line ${String(index + 1)}`).join("\n");
}

it("fits the composer to its text, so a filled-in prompt can be read before it is sent, and resets it once emptied", () => {
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      return this.value.split("\n").length * 18 + 16;
    },
  });
  try {
    const { rerender } = render(conversationWithComposer("One line"));
    expect(screen.getByRole("textbox", { name: "Message" }).style.height).toBe("34px");

    rerender(conversationWithComposer(lines(20)));
    expect(screen.getByRole("textbox", { name: "Message" }).style.height).toBe("376px");

    rerender(conversationWithComposer(""));
    expect(screen.getByRole("textbox", { name: "Message" }).style.height).toBe("");
  } finally {
    Reflect.deleteProperty(HTMLTextAreaElement.prototype, "scrollHeight");
  }
});
