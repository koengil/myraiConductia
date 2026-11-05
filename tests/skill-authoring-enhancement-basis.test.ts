import { afterEach, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import {
  ancestorFromContract,
  matchesReference,
  runOutcomeLabel,
  stepRunsPath,
  stepVersionsPath,
  toRunSummary,
  useEnhancementBasis,
} from "@/lib/skillAuthoring/useEnhancementBasis";
import type { StepVersions, VersionOption } from "@/lib/skillRun/versions";
import type { SkillRunSummary } from "@/lib/skillRun/types";
import { rail } from "./helpers/skillBuilderDialogFixtures";

afterEach(() => {
  vi.unstubAllGlobals();
});

function publicationOption(overrides: Partial<VersionOption> = {}): VersionOption {
  return {
    reference: {
      kind: "publication",
      skillId: "11111111-1111-4111-8111-111111111111",
      versionId: "22222222-2222-4222-8222-222222222222",
      digest: "b".repeat(64),
    },
    label: "Published 10 Sep 2026",
    authorName: "Priya Shah",
    createdAt: "2026-09-10T12:00:00.000Z",
    available: true,
    unavailableReason: null,
    inputs: [],
    ...overrides,
  };
}

function runSummary(overrides: Partial<SkillRunSummary> = {}): SkillRunSummary {
  return {
    clampedFrom: null,
    id: "run-1",
    outcome: "succeeded",
    actorName: "Priya Shah",
    input: "input text",
    inputs: {},
    resultText: "result text",
    errorMessage: null,
    costUsd: null,
    startedAt: null,
    createdAt: "2026-09-11T12:00:00.000Z",
    binding: {
      kind: "publication",
      skillId: "11111111-1111-4111-8111-111111111111",
      versionId: "22222222-2222-4222-8222-222222222222",
      digest: "b".repeat(64),
    },
    model: null,
    documents: [],
    headId: "run-1",
    headText: "result text",
    revisions: [],
    ...overrides,
  };
}

function stepVersions(overrides: Partial<StepVersions> = {}): StepVersions {
  return {
    current: {
      kind: "publication",
      skillId: "11111111-1111-4111-8111-111111111111",
      versionId: "22222222-2222-4222-8222-222222222222",
      digest: "b".repeat(64),
    },
    project: [publicationOption()],
    projectUnavailableReason: null,
    catalog: [],
    ancestorContract: {
      purpose: "Summarise weekly filings",
      expectedInput: "A filing PDF",
      expectedOutput: "A one-paragraph summary",
    },
    ...overrides,
  };
}

it("matches a publication option to a publication reference by versionId, not skillId or digest", () => {
  const option = publicationOption();
  expect(
    matchesReference(option, {
      kind: "publication",
      skillId: "different-skill",
      versionId: "22222222-2222-4222-8222-222222222222",
      digest: "different-digest",
    }),
  ).toBe(true);
  expect(
    matchesReference(option, {
      kind: "publication",
      skillId: "11111111-1111-4111-8111-111111111111",
      versionId: "not-the-same-version",
      digest: "b".repeat(64),
    }),
  ).toBe(false);
});

it("matches a mount option to a mount reference by name and version", () => {
  const option: VersionOption = {
    reference: { kind: "mount", name: "md-briefing", version: 3, digest: "f".repeat(64) },
    label: "v3",
    authorName: "ops@example.test",
    createdAt: "2026-09-10T00:00:00Z",
    available: true,
    unavailableReason: null,
    inputs: [],
  };
  expect(
    matchesReference(option, { kind: "mount", name: "md-briefing", version: 3, digest: "different" }),
  ).toBe(true);
  expect(
    matchesReference(option, { kind: "mount", name: "md-briefing", version: 4, digest: "f".repeat(64) }),
  ).toBe(false);
});

it("never matches a publication option against a mount reference", () => {
  const option = publicationOption();
  expect(
    matchesReference(option, { kind: "mount", name: "md-briefing", version: 3, digest: "f".repeat(64) }),
  ).toBe(false);
});

it("labels a failed outcome as failed and anything else as succeeded", () => {
  expect(runOutcomeLabel("succeeded")).toBe("succeeded");
  expect(runOutcomeLabel("failed")).toBe("failed");
});

it("formats a run summary with the actor, date and outcome", () => {
  const summary = toRunSummary(runSummary());
  expect(summary.id).toBe("run-1");
  expect(summary.label.startsWith("Priya Shah · ")).toBe(true);
  expect(summary.label.endsWith(" · succeeded")).toBe(true);
});

it("builds an ancestor preview from a capability contract, leaving the name blank", () => {
  const ancestor = ancestorFromContract({
    purpose: "Summarise weekly filings",
    expectedInput: "A filing PDF",
    expectedOutput: "A one-paragraph summary",
  });
  expect(ancestor).toEqual({
    name: "",
    purpose: "Summarise weekly filings",
    expectedInput: "A filing PDF",
    expectedOutput: "A one-paragraph summary",
    inputs: [],
  });
});

it("returns a null ancestor for a missing capability contract", () => {
  expect(ancestorFromContract(null)).toBeNull();
  expect(ancestorFromContract(undefined)).toBeNull();
});

it("builds the skill-versions and skill-runs paths from the deal and step ids", () => {
  expect(stepVersionsPath("deal 1", "p2-s36")).toBe(
    "/api/v1/deals/deal%201/steps/p2-s36/skill-versions",
  );
  expect(stepRunsPath("deal 1", "p2-s36")).toBe(
    "/api/v1/deals/deal%201/steps/p2-s36/skill-runs",
  );
});

function stubFetch(handlers: {
  versions?: () => Response;
  runs?: () => Response;
}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/skill-versions")) {
      return handlers.versions
        ? handlers.versions()
        : new Response("not found", { status: 404 });
    }
    if (url.includes("/skill-runs")) {
      return handlers.runs
        ? handlers.runs()
        : new Response("not found", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  });
}

it("resolves the step title, version, seed run and ancestor for a publication basis", async () => {
  vi.stubGlobal(
    "fetch",
    stubFetch({
      versions: () => new Response(JSON.stringify(stepVersions()), { status: 200 }),
      runs: () =>
        new Response(JSON.stringify({ runs: [runSummary()] }), { status: 200 }),
    }),
  );

  const { result } = renderHook(() =>
    useEnhancementBasis("deal-1", rail, "cat-1", "run-1"),
  );

  await waitFor(() => expect(result.current.version).not.toBeNull());
  expect(result.current.stepTitle).toBe("cat-1");
  expect(result.current.version).toEqual({
    label: "Published 10 Sep 2026",
    authorName: "Priya Shah",
    createdAt: "2026-09-10T12:00:00.000Z",
  });
  expect(result.current.versionError).toBe(false);
  expect(result.current.seedRunAttached).toBe(true);
  await waitFor(() => expect(result.current.seedRun).not.toBeNull());
  expect(result.current.seedRun?.id).toBe("run-1");
  expect(result.current.runsError).toBe(false);
  expect(result.current.ancestor).toEqual({
    name: "",
    purpose: "Summarise weekly filings",
    expectedInput: "A filing PDF",
    expectedOutput: "A one-paragraph summary",
    inputs: [],
  });
});

it("sets versionError, and no ancestor, when the skill-versions fetch fails", async () => {
  vi.stubGlobal(
    "fetch",
    stubFetch({
      versions: () => new Response("boom", { status: 500 }),
      runs: () => new Response(JSON.stringify({ runs: [] }), { status: 200 }),
    }),
  );

  const { result } = renderHook(() =>
    useEnhancementBasis("deal-1", rail, "p2-s36", undefined),
  );

  await waitFor(() => expect(result.current.versionError).toBe(true));
  expect(result.current.version).toBeNull();
  expect(result.current.ancestor).toBeNull();
});

it("sets runsError, and leaves seedRun null, when the skill-runs fetch fails", async () => {
  vi.stubGlobal(
    "fetch",
    stubFetch({
      versions: () => new Response(JSON.stringify(stepVersions()), { status: 200 }),
      runs: () => new Response("boom", { status: 500 }),
    }),
  );

  const { result } = renderHook(() =>
    useEnhancementBasis("deal-1", rail, "p2-s36", "run-1"),
  );

  await waitFor(() => expect(result.current.runsError).toBe(true));
  expect(result.current.seedRun).toBeNull();
  expect(result.current.seedRunAttached).toBe(true);
});

it("makes no request and reports no basis data when there is no basisStepId", () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);

  const { result } = renderHook(() =>
    useEnhancementBasis("deal-1", rail, undefined, undefined),
  );

  expect(fetchSpy).not.toHaveBeenCalled();
  expect(result.current.stepTitle).toBe("");
  expect(result.current.version).toBeNull();
  expect(result.current.seedRunAttached).toBe(false);
  expect(result.current.ancestor).toBeNull();
});
