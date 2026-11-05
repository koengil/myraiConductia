import type { ReactElement } from "react";
import { expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { DealRail } from "@/components/rail/DealRail";
import { SessionProvider } from "@/lib/session/store";
import { FlagsProvider } from "@/lib/flags/FlagsContext";
import type { FlagMap } from "@/lib/flags/resolveFlags";
import type { ProjectRail, ProjectRailStep } from "@/lib/rail/projectRail";

export const URL_PROJECT_ID = "deal-1";
export const EXISTING_STEP_ID = "44444444-4444-4444-8444-444444444444";
export const PUBLISHED_STEP_ID = "22222222-2222-4222-8222-222222222222";
export const SECOND_EXISTING_STEP_ID = "66666666-6666-4666-8666-666666666666";
export const REMOVED_STEP_ID = "77777777-7777-4777-8777-777777777777";
export const ADDED_STEP_ID = "99999999-9999-4999-8999-999999999999";

export const railBox: {
  rail: ProjectRail | null;
  status: "loading" | "ready" | "error";
} = { rail: null, status: "ready" };

export function baseRail(steps: ProjectRailStep[]): ProjectRail {
  return {
    currentStepId: EXISTING_STEP_ID,
    canEditStructure: true,
    canSaveTemplate: false,
    phases: [{ index: 0, name: "Origination", dealStatus: "active" }],
    steps,
  };
}

export function existingStep(): ProjectRailStep {
  return {
    id: EXISTING_STEP_ID,
    stepId: EXISTING_STEP_ID,
    origin: "catalog",
    phaseIndex: 0,
    displayOrder: 1,
    seq: 1,
    status: "current",
    definition: { title: "Origination brief", description: "d" },
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
  };
}

export function secondExistingStep(): ProjectRailStep {
  return {
    id: SECOND_EXISTING_STEP_ID,
    stepId: SECOND_EXISTING_STEP_ID,
    origin: "catalog",
    phaseIndex: 0,
    displayOrder: 2,
    seq: 2,
    status: "pending",
    definition: { title: "Diligence checklist", description: "d" },
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
  };
}

export function restoredStep(): ProjectRailStep {
  return {
    id: REMOVED_STEP_ID,
    stepId: REMOVED_STEP_ID,
    origin: "custom",
    phaseIndex: 0,
    displayOrder: 3,
    seq: null,
    status: "pending",
    definition: { title: "Removed step", description: "d" },
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
  };
}

export function addedStep(): ProjectRailStep {
  return {
    id: ADDED_STEP_ID,
    stepId: ADDED_STEP_ID,
    origin: "catalog",
    phaseIndex: 0,
    displayOrder: 3,
    seq: 3,
    status: "pending",
    definition: { title: "Added after launch", description: "d" },
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
  };
}

export function publishedStep(): ProjectRailStep {
  return {
    id: PUBLISHED_STEP_ID,
    stepId: "custom:new",
    origin: "custom",
    phaseIndex: 0,
    displayOrder: 3,
    seq: null,
    status: "pending",
    definition: { title: "Weekly filing summary", description: "d" },
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
  };
}

export function flags(overrides: Partial<FlagMap> = {}): FlagMap {
  return { skill_authoring: true, ...overrides } as FlagMap;
}

export function renderRail(flagMap: FlagMap) {
  return render(
    <FlagsProvider value={flagMap}>
      <SessionProvider>
        <DealRail />
      </SessionProvider>
    </FlagsProvider>,
  );
}

export function rerenderRail(
  flagMap: FlagMap,
  rerender: (node: ReactElement) => void,
) {
  rerender(
    <FlagsProvider value={flagMap}>
      <SessionProvider>
        <DealRail />
      </SessionProvider>
    </FlagsProvider>,
  );
}

export function meResponse() {
  return {
    user: {
      id: "user-storm",
      email: "storm@futureproofing.dev",
      full_name: "Storm Duncan",
      display_name: "Storm Duncan",
      firm_role: "bank_director",
      department: null,
      is_external: false,
      status: "active",
      company_id: "company-fp",
      company_role: "director",
      can_invite: true,
    },
    company: { id: "company-fp", name: "Futureproofing" },
    mandate: null,
  };
}

export function draftResponse() {
  return {
    draft: {
      id: "draft-1",
      dealId: URL_PROJECT_ID,
      status: "active",
      name: "Weekly filing summary",
      placement: { kind: "phase_start", phaseIndex: 0 },
      composerText: "",
      editRevision: 1,
      messages: [],
      activeAttempt: null,
      candidate: {
        id: "11111111-1111-4111-8111-111111111111",
        digest: "sha256:abc",
        schemaVersion: 1,
        name: "Weekly filing summary",
        purpose: "Summarize filings",
        expectedInput: "A filing",
        expectedOutput: "A summary",
        inputs: [],
      },
      eventCursor: 0,
      publication: { available: false },
    },
  };
}

export function publishResponse() {
  return {
    available: true,
    id: "33333333-3333-4333-8333-333333333333",
    state: "published",
    revision: 1,
    matches: [],
    error: null,
    result: {
      stepId: PUBLISHED_STEP_ID,
      skillBinding: {
        skillId: "11111111-1111-4111-8111-111111111111",
        versionId: "11111111-1111-4111-8111-111111111112",
        digest: "a".repeat(64),
      },
    },
    assessmentDigest: null,
  };
}

export function duplicateActiveResponse(dealStepId: string = EXISTING_STEP_ID) {
  return {
    available: true,
    id: "55555555-5555-4555-8555-555555555555",
    state: "failed",
    revision: 1,
    matches: [],
    error: { code: "duplicate_active", dealStepId },
    result: null,
    assessmentDigest: null,
  };
}

export function duplicateRemovedResponse() {
  return {
    available: true,
    id: "88888888-8888-4888-8888-888888888888",
    state: "failed",
    revision: 1,
    matches: [],
    error: { code: "duplicate_removed", dealStepId: REMOVED_STEP_ID },
    result: null,
    assessmentDigest: null,
  };
}

export function needsPlacementResponse() {
  return {
    available: true,
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    state: "needs_placement",
    revision: 1,
    matches: [],
    error: { code: "anchor_removed", dealStepId: null },
    result: null,
    assessmentDigest: null,
  };
}

type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

export function installFetch(publishJson: () => unknown = publishResponse) {
  global.fetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<FetchResponse> => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/publish"))
        return { ok: true, status: 200, json: async () => publishJson() };
      if (url.endsWith("/skill-drafts"))
        return { ok: true, status: 200, json: async () => draftResponse() };
      // Add new step writes its spot on the draft before publishing.
      if (url.endsWith("/skill-drafts/draft-1") && init?.method === "PATCH") {
        const { draft } = draftResponse();
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return { ok: true, status: 200, json: async () => ({ draft: { ...draft, ...body, editRevision: 2 } }) };
      }
      if (url.endsWith("/api/v1/me"))
        return { ok: true, status: 200, json: async () => meResponse() };
      return { ok: true, status: 200, json: async () => ({}) };
    },
  ) as unknown as typeof fetch;
}

export function fetchCallsTo(suffix: string) {
  return (
    global.fetch as unknown as ReturnType<typeof vi.fn>
  ).mock.calls.filter(([input]) => String(input).endsWith(suffix));
}

export async function waitForRailReady() {
  await waitFor(() =>
    expect(
      screen.queryByText(/Loading (the deal rail|your deal list)/i),
    ).not.toBeInTheDocument(),
  );
}
