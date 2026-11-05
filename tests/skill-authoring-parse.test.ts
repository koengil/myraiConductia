import { describe, expect, it } from "vitest";
import {
  parseDraftPatch,
  parseDiscardCommand,
  parseMessageCommand,
  parseRetryCommand,
} from "@/lib/skillAuthoring/parse";

function validDraftPatch() {
  return {
    expectedEditRevision: 0,
    name: "Weekly update",
    placement: null,
    composerText: "Prepare a weekly update.",
  };
}

describe("skill authoring parse", () => {
  it("accepts an exact message command", () => {
    expect(
      parseMessageCommand({
        clientMessageId: "11111111-1111-4111-8111-111111111111",
        expectedEditRevision: 3,
        text: "Draft a weekly update.",
      }),
    ).toEqual({
      clientMessageId: "11111111-1111-4111-8111-111111111111",
      expectedEditRevision: 3,
      text: "Draft a weekly update.",
    });
  });

  it("rejects empty messages and negative revisions", () => {
    expect(parseMessageCommand({ text: "", expectedEditRevision: -1 })).toEqual(
      {
        error:
          "Message text, clientMessageId, and a nonnegative expectedEditRevision are required.",
      },
    );
  });

  it("accepts a draft patch at name and composer limits", () => {
    const patch = {
      expectedEditRevision: 0,
      name: "n".repeat(100),
      placement: { kind: "after", phaseIndex: 1, afterStepId: "step-1" },
      composerText: "c".repeat(20_000),
    };

    expect(parseDraftPatch(patch)).toEqual(patch);
  });

  it.each([
    ["a blank name", { ...validDraftPatch(), name: " " }],
    [
      "a name longer than 100 characters",
      { ...validDraftPatch(), name: "n".repeat(101) },
    ],
    [
      "a composer longer than 20000 characters",
      { ...validDraftPatch(), composerText: "c".repeat(20_001) },
    ],
    ["an unknown field", { ...validDraftPatch(), unexpected: true }],
  ])("rejects a draft patch with %s", (_reason, patch) => {
    expect(parseDraftPatch(patch)).toEqual({
      error:
        "A draft patch requires a valid name, placement, composerText, and nonnegative expectedEditRevision.",
    });
  });

  it("accepts a draft patch with an empty name so a first message can autosave before naming the step", () => {
    const patch = { ...validDraftPatch(), name: "" };

    expect(parseDraftPatch(patch)).toEqual(patch);
  });

  it("rejects a draft patch with an invalid after placement", () => {
    expect(
      parseDraftPatch({
        expectedEditRevision: 0,
        name: "Weekly update",
        placement: { kind: "after", phaseIndex: 1, afterStepId: "" },
        composerText: "Prepare a weekly update.",
      }),
    ).toEqual({
      error:
        "A draft patch requires a valid name, placement, composerText, and nonnegative expectedEditRevision.",
    });
  });

  it("accepts a UUID retry request id", () => {
    expect(
      parseRetryCommand({
        retryRequestId: "22222222-2222-4222-8222-222222222222",
      }),
    ).toEqual({ retryRequestId: "22222222-2222-4222-8222-222222222222" });
  });

  it.each([
    ["a non-UUID request id", { retryRequestId: "retry-1" }],
    [
      "an unknown field",
      {
        retryRequestId: "22222222-2222-4222-8222-222222222222",
        unexpected: true,
      },
    ],
  ])("rejects a retry command with %s", (_reason, command) => {
    expect(parseRetryCommand(command)).toEqual({
      error: "A UUID retryRequestId is required.",
    });
  });

  it("accepts a nonnegative discard revision", () => {
    expect(parseDiscardCommand({ expectedEditRevision: 0 })).toEqual({
      expectedEditRevision: 0,
    });
  });

  it("rejects a negative discard revision", () => {
    expect(parseDiscardCommand({ expectedEditRevision: -1 })).toEqual({
      error: "A nonnegative expectedEditRevision is required.",
    });
  });
});
