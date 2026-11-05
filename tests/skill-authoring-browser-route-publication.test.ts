import { describe, expect, it } from "vitest";
import { normalizeAuthoritativeDraft } from "@/lib/skillAuthoring/browserRoute";

const draftId = "33333333-3333-4333-8333-333333333333";
const dealId = "22222222-2222-4222-8222-222222222222";
const publicationId = "55555555-5555-4555-8555-555555555555";
const dealStepId = "66666666-6666-4666-8666-666666666666";
const skillId = "77777777-7777-4777-8777-777777777777";
const versionId = "88888888-8888-4888-8888-888888888888";
const digest = "a".repeat(64);

function publishedPublication() {
  return {
    available: true,
    id: publicationId,
    state: "published",
    revision: 3,
    matches: [],
    error: null,
    result: {
      stepId: dealStepId,
      skillBinding: { skillId, versionId, digest },
    },
    assessmentDigest: null,
  };
}

function rawDraft(overrides: Record<string, unknown> = {}) {
  return {
    id: draftId,
    deal_id: dealId,
    status: "active",
    name: "Weekly update",
    placement_kind: null,
    phase_index: null,
    anchor_deal_step_id: null,
    composer_text: "",
    edit_revision: 0,
    messages: [],
    active_attempt: null,
    candidate: null,
    event_cursor: 0,
    publication: publishedPublication(),
    ...overrides,
  };
}

describe("browser route publication normalization", () => {
  it("carries a real published PublicationRead through unchanged", () => {
    const result = normalizeAuthoritativeDraft(rawDraft());
    expect(result?.publication).toEqual(publishedPublication());
  });

  it("rejects a draft whose publication carries an extra key", () => {
    const result = normalizeAuthoritativeDraft(
      rawDraft({
        publication: { ...publishedPublication(), providerState: "private" },
      }),
    );
    expect(result).toBeNull();
  });
});
