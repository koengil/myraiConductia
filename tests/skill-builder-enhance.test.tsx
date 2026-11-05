import { it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";

import { SkillBuilderDialog } from "@/components/rail/SkillBuilderDialog";
import { SkillCandidatePreview } from "@/components/rail/SkillCandidatePreview";
import { SkillBuilderBasisRow } from "@/components/rail/SkillBuilderBasisRow";
import type { StepVersions } from "@/lib/skillRun/versions";
import type { SkillRunSummary } from "@/lib/skillRun/types";
import { baseDraft, fakeClient, openResult, rail, waitForDraftOpened } from "./helpers/skillBuilderDialogFixtures";
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

function ancestorFixture() {
  return {
    name: "Filing summarizer v1",
    purpose: "Summarize a filing briefly",
    expectedInput: "A filing PDF",
    expectedOutput: "A one-paragraph summary",
    inputs: [],
  };
}

function stepVersionsFixture(
  overrides: Partial<StepVersions> = {},
): StepVersions {
  return {
    current: {
      kind: "publication",
      skillId: "11111111-1111-4111-8111-111111111111",
      versionId: "22222222-2222-4222-8222-222222222222",
      digest: "b".repeat(64),
    },
    project: [
      {
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
      },
    ],
    projectUnavailableReason: null,
    catalog: [],
    ancestorContract: {
      purpose: "Summarize a filing briefly",
      expectedInput: "A filing PDF",
      expectedOutput: "A one-paragraph summary",
    },
    ...overrides,
  };
}

function stepRunsFixture(): SkillRunSummary[] {
  return [
    {
      id: "run-2",
      outcome: "failed",
      actorName: "Storm Duncan",
      input: "input text",
      inputs: {},
      resultText: null,
      errorMessage: "The skill returned an empty reply.",
      costUsd: null,
      startedAt: null,
      createdAt: "2026-09-12T12:00:00.000Z",
      binding: {
        kind: "publication",
        skillId: "11111111-1111-4111-8111-111111111111",
        versionId: "22222222-2222-4222-8222-222222222222",
        digest: "b".repeat(64),
      },
      model: null,
      clampedFrom: null,
      documents: [],
      headId: "run-2",
      headText: null,
      revisions: [],
    },
    {
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
      clampedFrom: null,
      documents: [],
      headId: "run-1",
      headText: "result text",
      revisions: [],
    },
  ];
}

function stubFetch(overrides: {
  versionsStatus?: number;
  runsStatus?: number;
  versions?: StepVersions;
} = {}) {
  const versionsStatus = overrides.versionsStatus ?? 200;
  const runsStatus = overrides.runsStatus ?? 200;
  const versions = overrides.versions ?? stepVersionsFixture();
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/skill-versions")) {
      return new Response(JSON.stringify(versions), {
        status: versionsStatus,
      });
    }
    if (url.includes("/skill-runs")) {
      return new Response(JSON.stringify({ runs: stepRunsFixture() }), {
        status: runsStatus,
      });
    }
    return new Response("not found", { status: 404 });
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openEnhanceDialog(
  fetchOverrides: Parameters<typeof stubFetch>[0] = {},
  draftOverrides: Parameters<typeof baseDraft>[0] = {},
  { seedRunId = "run-1" }: { seedRunId?: string | null } = {},
) {
  const resolvedSeedRunId = seedRunId === null ? undefined : seedRunId;
  vi.stubGlobal("fetch", stubFetch(fetchOverrides));
  const onClose = vi.fn();
  const draft = baseDraft({ candidate: candidateFixture(), ...draftOverrides });
  const versions = fetchOverrides.versions ?? stepVersionsFixture();
  const client = fakeClient({
    open: vi.fn(async (_projectId: string, basis?: { seedRunId?: string }) => ({
      draft,
      basis: versions.current,
      seedRunId: basis?.seedRunId ?? null,
    })),
  });
  render(
    <SkillBuilderDialog
      open
      dealId="deal-1"
      rail={rail}
      onClose={onClose}
      client={client}
      publicationClient={publicationClientStub()}
      basisStepId="p2-s36"
      seedRunId={resolvedSeedRunId}
    />,
  );
  await screen.findByRole("dialog");
  await waitForDraftOpened(client);
  // Opened, not edited: no save status yet.
  expect(screen.queryByTestId("draft-status")).toBeNull();
  return { onClose, client };
}

async function openCreationDialog(overrides: Parameters<typeof baseDraft>[0] = {}) {
  vi.stubGlobal("fetch", stubFetch());
  const onClose = vi.fn();
  const draft = baseDraft({ candidate: candidateFixture(), ...overrides });
  const client = fakeClient({ open: vi.fn(async () => openResult(draft)) });
  render(
    <SkillBuilderDialog
      open
      dealId="deal-1"
      rail={rail}
      onClose={onClose}
      client={client}
      publicationClient={publicationClientStub()}
    />,
  );
  await screen.findByRole("dialog");
  await waitForDraftOpened(client);
  // Opened, not edited: no save status yet.
  expect(screen.queryByTestId("draft-status")).toBeNull();
  return { onClose, client };
}

it("shows the enhance header, hides placement controls, and shows the basis row", async () => {
  await openEnhanceDialog();

  expect(screen.getByText("Enhance skill")).toBeInTheDocument();
  expect(screen.queryByText("Skill builder")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Step name")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Phase")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Position")).not.toBeInTheDocument();

  await waitFor(() =>
    expect(screen.getByText(/Published 10 Sep 2026/)).toBeInTheDocument(),
  );
  expect(
    screen.getByText(/Published 10 Sep 2026/).textContent,
  ).toContain("Priya Shah");

  const seedRunSection = screen.getByText("Seed run").closest("div") as HTMLElement;
  await waitFor(() =>
    expect(within(seedRunSection).getByText(/succeeded$/)).toBeInTheDocument(),
  );
  expect(within(seedRunSection).getByText(/succeeded$/).textContent).toMatch(
    /^Priya Shah · /,
  );
});

it("reads Ready to publish and Publish and use on this step in enhance mode", async () => {
  await openEnhanceDialog();
  expect(screen.getByText("Ready to publish")).toBeInTheDocument();
  expect(screen.queryByText("Ready to save")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Publish and use on this step" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Save skill and add step" }),
  ).not.toBeInTheDocument();
});

it("keeps Close and Discard draft unchanged in enhance mode", async () => {
  await openEnhanceDialog();
  expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Discard draft" }),
  ).toBeInTheDocument();
});

it("shows no seed run attached when the dialog opened without one", async () => {
  await openEnhanceDialog({}, {}, { seedRunId: null });
  expect(screen.getByText("No seed run attached.")).toBeInTheDocument();
});

it("shows neutral copy, distinct from no-version-resolved, when the version fetch fails", async () => {
  await openEnhanceDialog({ versionsStatus: 500 });
  await waitFor(() =>
    expect(
      screen.getByText("Version details are unavailable right now."),
    ).toBeInTheDocument(),
  );
  expect(
    screen.queryByText("No version resolved for this step."),
  ).not.toBeInTheDocument();
});

it("populates the ancestor comparison from the resolved publication's capability contract", async () => {
  await openEnhanceDialog();
  const ancestor = ancestorFixture();
  await waitFor(() =>
    expect(
      screen.getByText(`Was: ${ancestor.purpose}`),
    ).toBeInTheDocument(),
  );
  expect(
    screen.getByText(`Was: ${ancestor.expectedInput}`),
  ).toBeInTheDocument();
  expect(
    screen.getByText(`Was: ${ancestor.expectedOutput}`),
  ).toBeInTheDocument();
});

it("shows no ancestor comparison for a mount basis, which has no stored capability contract", async () => {
  await openEnhanceDialog({
    versions: stepVersionsFixture({
      current: { kind: "mount", name: "md-briefing", version: 3, digest: "c".repeat(64) },
      project: [],
      ancestorContract: null,
    }),
  });
  await waitFor(() =>
    expect(screen.getByText("Filing summarizer")).toBeInTheDocument(),
  );
  expect(screen.queryByText(/^Was: /)).not.toBeInTheDocument();
});

it("reverts to creation copy and controls when there is no basis", async () => {
  await openCreationDialog();

  expect(screen.getByText("Skill builder")).toBeInTheDocument();
  expect(screen.queryByText("Enhance skill")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Step name")).toBeInTheDocument();
  expect(screen.getByLabelText("Phase")).toBeInTheDocument();
  expect(screen.getByLabelText("Position")).toBeInTheDocument();
  expect(screen.queryByText("No seed run attached.")).not.toBeInTheDocument();

  expect(screen.getByText("Ready to save")).toBeInTheDocument();
  expect(screen.queryByText("Ready to publish")).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Save skill and add step" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Publish and use on this step" }),
  ).not.toBeInTheDocument();
});

it("renders the ancestor value beside the candidate value for each of the four fields", () => {
  render(
    <SkillCandidatePreview
      candidate={candidateFixture()}
      ancestor={ancestorFixture()}
      enhancing
    />,
  );
  const ancestor = ancestorFixture();
  const candidate = candidateFixture();

  expect(screen.getByText(`Was: ${ancestor.name}`)).toBeInTheDocument();
  expect(screen.getByText(candidate.name)).toBeInTheDocument();
  expect(screen.getByText(`Was: ${ancestor.purpose}`)).toBeInTheDocument();
  expect(screen.getByText(candidate.purpose)).toBeInTheDocument();
  expect(
    screen.getByText(`Was: ${ancestor.expectedInput}`),
  ).toBeInTheDocument();
  expect(screen.getByText(candidate.expectedInput)).toBeInTheDocument();
  expect(
    screen.getByText(`Was: ${ancestor.expectedOutput}`),
  ).toBeInTheDocument();
  expect(screen.getByText(candidate.expectedOutput)).toBeInTheDocument();
  expect(screen.getByText("Ready to publish")).toBeInTheDocument();
});

it("does not render ancestor comparisons when there is no ancestor", () => {
  render(<SkillCandidatePreview candidate={candidateFixture()} />);
  expect(screen.queryByText(/^Was: /)).not.toBeInTheDocument();
  expect(screen.getByText("Ready to save")).toBeInTheDocument();
});

it("lists the candidate's declared inputs", () => {
  render(
    <SkillCandidatePreview
      candidate={{
        ...candidateFixture(),
        inputs: [
          {
            name: "asOf",
            label: "As of",
            description: null,
            type: "date",
            values: [],
            required: true,
            default: null,
          },
          {
            name: "audience",
            label: "Audience",
            description: null,
            type: "enum",
            values: ["Board", "Buyer"],
            required: false,
            default: null,
          },
        ],
      }}
    />,
  );

  expect(screen.getByText("Inputs")).toBeInTheDocument();
  expect(screen.getByText("As of")).toBeInTheDocument();
  expect(screen.getByText("Date")).toBeInTheDocument();
  expect(screen.getByText("Required")).toBeInTheDocument();
  expect(screen.getByText("Audience")).toBeInTheDocument();
  expect(screen.getByText("Choice")).toBeInTheDocument();
  expect(screen.getByText("Board, Buyer")).toBeInTheDocument();
});

it("shows a placeholder when the candidate has no declared inputs", () => {
  render(<SkillCandidatePreview candidate={candidateFixture()} />);

  expect(screen.getByText("Inputs")).toBeInTheDocument();
  expect(
    screen.getByText("No inputs. Runs on deal context and instructions."),
  ).toBeInTheDocument();
});

it("basis row names the step, the version, and the attached seed run", () => {
  render(
    <SkillBuilderBasisRow
      stepTitle="Buyer outreach"
      version={{
        label: "Published 10 Sep 2026",
        authorName: "Priya Shah",
        createdAt: "2026-09-10T12:00:00.000Z",
      }}
      versionError={false}
      seedRunAttached
      seedRun={{ id: "run-1", label: "Priya Shah run" }}
      runsError={false}
    />,
  );

  expect(screen.getByText("Buyer outreach")).toBeInTheDocument();
  expect(
    screen.getByText(/Published 10 Sep 2026/).textContent,
  ).toContain("Priya Shah");
  expect(screen.getByText("Priya Shah run")).toBeInTheDocument();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
});

it("basis row shows neutral run-details copy, distinct from no-seed-run, on a runs fetch failure", () => {
  render(
    <SkillBuilderBasisRow
      stepTitle="Buyer outreach"
      version={null}
      versionError={false}
      seedRunAttached
      seedRun={null}
      runsError
    />,
  );

  expect(
    screen.getByText("Seed run attached. Run details are unavailable right now."),
  ).toBeInTheDocument();
  expect(screen.queryByText("No seed run attached.")).not.toBeInTheDocument();
});

it("sends the basis step and the seed run in the draft-open POST body", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const versions = stepVersionsFixture();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/skill-versions")) {
        return new Response(JSON.stringify(versions), { status: 200 });
      }
      if (url.endsWith("/skill-drafts")) {
        return new Response(
          JSON.stringify({
            draftId: "draft-1",
            draft: baseDraft({ candidate: candidateFixture() }),
            basis: versions.current,
            basisStepId: "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b",
            seedRunId: "run-1",
          }),
          { status: 200 },
        );
      }
      if (url.includes("/skill-runs")) {
        return new Response(JSON.stringify({ runs: stepRunsFixture() }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }),
  );

  render(
    <SkillBuilderDialog
      open
      dealId="deal-1"
      rail={rail}
      onClose={vi.fn()}
      publicationClient={publicationClientStub()}
      basisStepId="p2-s36"
      seedRunId="run-1"
    />,
  );
  await screen.findByRole("dialog");

  await waitFor(() =>
    expect(calls.some((call) => call.url.endsWith("/skill-drafts"))).toBe(true),
  );
  const opened = calls.find((call) => call.url.endsWith("/skill-drafts"));
  expect(opened?.init?.method).toBe("POST");
  expect(JSON.parse(String(opened?.init?.body))).toEqual({
    basisStepId: "p2-s36",
    seedRunId: "run-1",
  });
});

it("shows the seed run the resumed draft stores, not the one the launcher asked for", async () => {
  vi.stubGlobal("fetch", stubFetch());
  const draft = baseDraft({ candidate: candidateFixture() });
  const versions = stepVersionsFixture();
  const client = fakeClient({
    open: vi.fn(async () => ({
      draft,
      basis: versions.current,
      seedRunId: "run-2",
    })),
  });
  render(
    <SkillBuilderDialog
      open
      dealId="deal-1"
      rail={rail}
      onClose={vi.fn()}
      client={client}
      publicationClient={publicationClientStub()}
      basisStepId="p2-s36"
      seedRunId="run-1"
    />,
  );
  await screen.findByRole("dialog");

  const seedRunSection = screen.getByText("Seed run").closest("div") as HTMLElement;
  await waitFor(() =>
    expect(within(seedRunSection).getByText(/failed$/)).toBeInTheDocument(),
  );
  expect(within(seedRunSection).getByText(/failed$/).textContent).toMatch(
    /^Storm Duncan · /,
  );
});
