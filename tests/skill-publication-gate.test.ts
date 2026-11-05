import { it, expect } from "vitest";

import { saveGate } from "@/components/rail/skillPublicationGate";
import type {
  AttemptRead,
  DraftRead,
  Placement,
} from "@/lib/skillAuthoring/types";
import {
  baseDraft,
  rail as sharedRail,
} from "./helpers/skillBuilderDialogFixtures";

const placement: Placement = { kind: "phase_start", phaseIndex: 0 };

function candidate() {
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

function readyDraft(overrides: Partial<DraftRead> = {}): DraftRead {
  return baseDraft({
    candidate: candidate(),
    name: "Weekly update",
    placement,
    ...overrides,
  });
}

function attempt(status: "running"): AttemptRead {
  return {
    id: "a1",
    messageId: "m1",
    number: 1,
    status,
    responseText: "",
    error: null,
  };
}

it("is disabled with no reason for an inactive draft", () => {
  const gate = saveGate(readyDraft({ status: "archived" }), sharedRail);
  expect(gate).toEqual({ enabled: false, reason: null });
});

it("is disabled while an attempt is running", () => {
  const draft = readyDraft({ activeAttempt: attempt("running") });
  const gate = saveGate(draft, sharedRail);
  expect(gate).toEqual({
    enabled: false,
    reason: "Finish the current response before saving.",
  });
});

it("is disabled without a current valid candidate", () => {
  const gate = saveGate(readyDraft({ candidate: null }), sharedRail);
  expect(gate).toEqual({
    enabled: false,
    reason: "Generate a candidate skill before saving.",
  });
});

it("is disabled with a blank name", () => {
  const gate = saveGate(readyDraft({ name: "   " }), sharedRail);
  expect(gate).toEqual({
    enabled: false,
    reason: "Name the step before saving.",
  });
});

it("is disabled with an incomplete phase or position", () => {
  const gate = saveGate(readyDraft({ placement: null }), sharedRail);
  expect(gate).toEqual({
    enabled: false,
    reason: "Choose a position before saving.",
  });
});

it("is disabled when the placement anchors after a step that is no longer active", () => {
  const gate = saveGate(
    readyDraft({
      placement: { kind: "after", phaseIndex: 0, afterStepId: "missing-step" },
    }),
    sharedRail,
  );
  expect(gate).toEqual({
    enabled: false,
    reason: "Choose a position before saving.",
  });
});

it("is disabled when a publication is nonterminal", () => {
  const draft = readyDraft({
    publication: {
      available: true,
      id: "44444444-4444-4444-8444-444444444444",
      state: "publishing",
      revision: 1,
      matches: [],
      error: null,
      result: null,
      assessmentDigest: null,
    },
  });
  const gate = saveGate(draft, sharedRail);
  expect(gate).toEqual({
    enabled: false,
    reason: "A save is already in progress.",
  });
});

it("is enabled once every condition clears", () => {
  const gate = saveGate(readyDraft(), sharedRail);
  expect(gate).toEqual({ enabled: true, reason: null });
});

it("admits an enhancement whose name and placement are both empty", () => {
  const draft = baseDraft({ candidate: candidate(), name: "", placement: null });
  expect(saveGate(draft, sharedRail, true)).toEqual({
    enabled: true,
    reason: null,
  });
});

it("still requires a candidate on an enhancement", () => {
  const draft = baseDraft({ candidate: null, name: "", placement: null });
  expect(saveGate(draft, sharedRail, true)).toEqual({
    enabled: false,
    reason: "Generate a candidate skill before saving.",
  });
});
