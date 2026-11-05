import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  within,
  fireEvent,
} from "@testing-library/react";

import { DealRail } from "../src/components/rail/DealRail";
import { SessionProvider } from "../src/lib/session/store";
import { FlagsProvider } from "../src/lib/flags/FlagsContext";
import type { FlagMap } from "../src/lib/flags/resolveFlags";
import type { ProjectRail } from "../src/lib/rail/projectRail";
import { waitForDraftLoaded } from "./helpers/skillBuilderDialogFixtures";

const URL_PROJECT_ID = "SUM-2026-014";

const replaceSpy = vi.fn();
let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: replaceSpy,
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useParams: () => ({ projectId: URL_PROJECT_ID }),
  usePathname: () => `/projects/${URL_PROJECT_ID}/rail`,
  useSearchParams: () => new URLSearchParams(search),
}));

let railState: {
  rail: ProjectRail | null;
  status: "loading" | "ready" | "error";
};
const refreshSpy = vi.fn();

vi.mock("@/lib/rail/projectRail", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/rail/projectRail")>();
  return {
    ...actual,
    useProjectRail: () => ({
      rail: railState.rail,
      status: railState.status,
      refresh: refreshSpy,
      skipStep: vi.fn(async () => ({})),
      stepRecords: [],
    }),
  };
});

function baseRail(overrides: Partial<ProjectRail> = {}): ProjectRail {
  return {
    currentStepId: "p2-s29",
    canEditStructure: true,
    canSaveTemplate: false,
    phases: [{ index: 2, name: "Diligence", dealStatus: "active" }],
    steps: [
      {
        id: "p2-s29",
        stepId: "p2-s29",
        origin: "catalog",
        phaseIndex: 2,
        displayOrder: 1,
        seq: 29,
        status: "current",
        definition: null,
        anchorStepId: null,
        removedAt: null,
        removedBy: null,
        skip: null,
      },
    ],
    ...overrides,
  };
}

function flags(overrides: Partial<FlagMap> = {}): FlagMap {
  return { skill_authoring: false, ...overrides } as FlagMap;
}

function renderRail(flagMap: FlagMap) {
  return render(
    <FlagsProvider value={flagMap}>
      <SessionProvider>
        <DealRail />
      </SessionProvider>
    </FlagsProvider>,
  );
}

function draftResponse(overrides: Record<string, unknown> = {}) {
  return {
    draft: {
      id: "draft-1",
      dealId: URL_PROJECT_ID,
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
    },
  };
}

function meResponse() {
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

type FetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

/** Echo a draft PATCH as a saved draft (the placement tests); otherwise it answers with no draft, as before. */
let echoDraftPatch = false;

function installFetch(skillDraftsResponse: () => FetchResponse) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/skill-drafts")) return skillDraftsResponse();
    if (url.endsWith("/skill-drafts/draft-1") && init?.method === "PATCH" && echoDraftPatch) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () =>
          draftResponse({
            name: body.name,
            placement: body.placement,
            composerText: body.composerText,
            editRevision: 2,
          }),
      };
    }
    if (url.endsWith("/api/v1/me")) {
      return { ok: true, status: 200, json: async () => meResponse() };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

function fetchCallsTo(suffix: string) {
  return (
    global.fetch as unknown as ReturnType<typeof vi.fn>
  ).mock.calls.filter(([input]) => String(input).endsWith(suffix));
}

async function waitForRailReady() {
  await waitFor(() =>
    expect(
      screen.queryByText(/Loading (the deal rail|your deal list)/i),
    ).not.toBeInTheDocument(),
  );
}

async function openBuilder() {
  await waitForRailReady();
  fireEvent.click(screen.getAllByRole("button", { name: "Add new step" })[0]);
  await screen.findByRole("dialog");
}

afterEach(() => {
  cleanup();
  echoDraftPatch = false;
  search = "";
  vi.restoreAllMocks();
  railState = { rail: baseRail(), status: "ready" };
});

beforeEach(() => {
  railState = { rail: baseRail(), status: "ready" };
  refreshSpy.mockClear();
  installFetch(() => ({
    ok: true,
    status: 200,
    json: async () => draftResponse(),
  }));
});

describe("skill authoring rail entry — gating, off/without authority", () => {
  it("shows no Add step affordance when the flag is off", async () => {
    railState = { rail: baseRail({ canEditStructure: true }), status: "ready" };
    renderRail(flags({ skill_authoring: false }));
    await waitForRailReady();
    expect(
      screen.queryByRole("button", { name: "Add new step" }),
    ).not.toBeInTheDocument();
  });

  it("shows no Add step affordance without structural authority", async () => {
    railState = {
      rail: baseRail({ canEditStructure: false }),
      status: "ready",
    };
    renderRail(flags({ skill_authoring: true }));
    await waitForRailReady();
    expect(
      screen.queryByRole("button", { name: "Add new step" }),
    ).not.toBeInTheDocument();
  });
});

describe("skill authoring rail entry — gating, view and placement", () => {
  it("shows no Add step affordance on a zoomed-in step", async () => {
    railState = { rail: baseRail({ canEditStructure: true }), status: "ready" };
    renderRail(flags({ skill_authoring: true }));
    await waitForRailReady();
    fireEvent.click(screen.getByRole("button", { name: "Open current step" }));
    expect(
      screen.queryByRole("button", { name: "Add new step" }),
    ).not.toBeInTheDocument();
  });

  it("shows Add new step in the column and Edit rail in the header when both gates pass", async () => {
    railState = { rail: baseRail({ canEditStructure: true }), status: "ready" };
    renderRail(flags({ skill_authoring: true }));
    await waitForRailReady();
    expect(screen.getByRole("region", { name: "Rail overview" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("banner")).getByRole("button", { name: "Edit rail" }),
    ).toBeInTheDocument();
  });
});

describe("skill authoring rail entry — opens and restores", () => {
  it("opens the builder against the URL project id", async () => {
    railState = { rail: baseRail({ canEditStructure: true }), status: "ready" };
    renderRail(flags({ skill_authoring: true }));
    await openBuilder();
    await waitFor(() => expect(fetchCallsTo("/skill-drafts")).toHaveLength(1));
    const [url] = fetchCallsTo("/skill-drafts")[0];
    expect(url).toBe(`/api/v1/deals/${URL_PROJECT_ID}/skill-drafts`);
  });
});

describe("skill authoring rail entry — closes without changing the rail", () => {
  it("closes without changing the rail", async () => {
    railState = { rail: baseRail({ canEditStructure: true }), status: "ready" };
    renderRail(flags({ skill_authoring: true }));
    await openBuilder();
    await waitForDraftLoaded();
    // Opened, not edited: no save status yet.
    expect(screen.queryByTestId("draft-status")).toBeNull();
    // One way out by name: Close, not also a Dismiss cross.
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(
      screen.getAllByRole("button", { name: "Add new step" })[0],
    ).toBeInTheDocument();
  });
});

describe("skill authoring rail entry — autosave failure", () => {
  it("shows something other than Saved after a failing autosave", async () => {
    railState = { rail: baseRail({ canEditStructure: true }), status: "ready" };
    renderRail(flags({ skill_authoring: true }));
    await openBuilder();
    await waitForDraftLoaded();
    // Opened, not edited: no save status yet.
    expect(screen.queryByTestId("draft-status")).toBeNull();

    fireEvent.change(screen.getByLabelText("Step name"), {
      target: { value: "Teaser" },
    });

    await waitFor(
      () => {
        const status = screen.queryByTestId("draft-status");
        expect(status?.textContent).toBe("Saving");
      },
      { timeout: 3000 },
    );

    await waitFor(
      () => {
        const status = screen.queryByTestId("draft-status");
        expect(status?.textContent).not.toBe("Saving");
      },
      { timeout: 3000 },
    );

    const settled = screen.queryByTestId("draft-status");
    expect(settled?.textContent ?? "").not.toBe("Saved");
  });
});

describe("skill authoring rail entry — mount rule", () => {
  it("keeps an open dialog mounted while the rail re-enters loading", async () => {
    railState = { rail: baseRail({ canEditStructure: true }), status: "ready" };
    const { rerender } = renderRail(flags({ skill_authoring: true }));
    await openBuilder();
    await waitForDraftLoaded();
    // Opened, not edited: no save status yet.
    expect(screen.queryByTestId("draft-status")).toBeNull();

    railState = { rail: null, status: "loading" };
    rerender(
      <FlagsProvider value={flags({ skill_authoring: true })}>
        <SessionProvider>
          <DealRail />
        </SessionProvider>
      </FlagsProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText(/Loading the deal rail/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

const ENHANCE_STEP_UUID = "6b1e6f2a-9c3d-4a7b-8e5f-1a2b3c4d5e6f";
const ENHANCE_STEP_KEY = "custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6";

function skillBackedRail(overrides: Partial<ProjectRail> = {}): ProjectRail {
  return {
    currentStepId: ENHANCE_STEP_UUID,
    canEditStructure: true,
    canSaveTemplate: false,
    phases: [{ index: 2, name: "Diligence", dealStatus: "active" }],
    ...overrides,
    steps: [
      {
        id: ENHANCE_STEP_UUID,
        stepId: ENHANCE_STEP_KEY,
        origin: "custom",
        phaseIndex: 2,
        displayOrder: 1,
        seq: null,
        status: "current",
        definition: {
          schemaVersion: 1,
          type: "skill",
          title: "Weekly project update",
          description: "Prepare a concise update.",
          inputs: [
            {
              key: "primary",
              kind: "text",
              label: "Input",
              helperText: "What to emphasise.",
              required: true,
            },
          ],
          skillBinding: {
            skillId: "2d362e20-0709-4ba0-bbd7-d21831148282",
            versionId: "0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6",
            digest: "a".repeat(64),
          },
        },
        anchorStepId: null,
        removedAt: null,
        removedBy: null,
        skip: null,
      },
    ],
  };
}

function installEnhanceFetch(
  runs: unknown[] | (() => unknown[]) = [],
  routes: Record<string, () => FetchResponse | Promise<FetchResponse>> = {},
) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const route = Object.keys(routes).find((suffix) => url.endsWith(suffix));
    if (route) return routes[route]();
    if (url.endsWith("/skill-versions")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ current: null, project: [], catalog: [] }),
      };
    }
    if (url.endsWith("/skill-runs")) {
      return { ok: true, status: 200, json: async () => ({ runs: typeof runs === "function" ? runs() : runs }) };
    }
    if (url.endsWith("/api/v1/me")) {
      return { ok: true, status: 200, json: async () => meResponse() };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

const RUN_ID = "3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11";

function taughtRun(sent: boolean) {
  return [
    {
      id: RUN_ID,
      outcome: "succeeded",
      actorName: "Storm Duncan",
      input: null,
      inputs: {},
      resultText: "Revenue fell.",
      errorMessage: null,
      costUsd: null,
      startedAt: null,
      createdAt: "2026-10-13T09:00:00.000Z",
      binding: null,
      model: "sonnet",
      clampedFrom: null,
      documents: [],
      headId: "rev-2",
      headText: "Revenue rose.",
      revisions: [
        {
          id: "rev-2",
          parentId: RUN_ID,
          kind: "edits",
          outcome: "succeeded",
          errorMessage: null,
          actorName: "Storm Duncan",
          createdAt: "2026-10-13T10:00:00.000Z",
          version: 2,
          edits: [
            {
              id: "e1",
              kind: "comment",
              start: 0,
              end: 13,
              comment: "It rose.",
              status: "applied",
              reason: null,
              teach: true,
              sent,
              resultStart: 0,
              resultEnd: 13,
              before: "Revenue fell.",
            },
          ],
          restoredFrom: null,
          skillMounted: true,
        },
      ],
    },
  ];
}

function installTaughtRunFetch(
  sentAfter?: () => boolean,
  routes?: Record<string, () => FetchResponse | Promise<FetchResponse>>,
) {
  installEnhanceFetch(() => taughtRun(sentAfter?.() ?? false), routes);
}

describe("skill authoring rail entry - improve this skill", () => {
  it("opens the builder in enhancement mode, seeded with no run, from the control", async () => {
    railState = { rail: skillBackedRail(), status: "ready" };
    installEnhanceFetch();
    renderRail(flags({ skill_authoring: true }));
    await waitForRailReady();
    fireEvent.click(screen.getByRole("button", { name: "Open current step" }));

    const callsBeforeClick = (
      global.fetch as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.length;

    fireEvent.click(
      await screen.findByRole("button", { name: "Improve this skill" }),
    );

    expect(
      await screen.findByRole("dialog", { name: "Enhance skill" }),
    ).toBeInTheDocument();

    await waitFor(() => {
      const basisUrls = (
        global.fetch as unknown as ReturnType<typeof vi.fn>
      ).mock.calls
        .slice(callsBeforeClick)
        .map(([input]) => String(input));
      expect(
        basisUrls.some((url) =>
          url.includes(encodeURIComponent(ENHANCE_STEP_KEY)),
        ),
      ).toBe(true);
    });

    const basisUrls = (
      global.fetch as unknown as ReturnType<typeof vi.fn>
    ).mock.calls
      .slice(callsBeforeClick)
      .map(([input]) => String(input));
    expect(basisUrls.some((url) => url.includes(ENHANCE_STEP_UUID))).toBe(
      false,
    );
  });

  it("opens the builder to teach from the step's Teach the skill button", async () => {
    railState = {
      rail: skillBackedRail({ canEditStructure: true }),
      status: "ready",
    };
    installTaughtRunFetch();
    renderRail(flags({ skill_authoring: true, skill_output_revisions: true }));
    await waitForRailReady();
    fireEvent.click(screen.getByRole("button", { name: "Open current step" }));

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Teach the skill · 1 comment",
      }),
    );

    expect(
      await screen.findByRole("dialog", { name: "Enhance skill" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(fetchCallsTo("/skill-drafts")).toHaveLength(1));
    const [, init] = fetchCallsTo("/skill-drafts")[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      basisStepId: ENHANCE_STEP_KEY,
      seedRunId: RUN_ID,
      teach: true,
    });
  });

  it("reloads the step's runs when the builder closes and drops Teach the skill once the comment is sent", async () => {
    railState = {
      rail: skillBackedRail({ canEditStructure: true }),
      status: "ready",
    };
    let sent = false;
    installTaughtRunFetch(() => sent);
    renderRail(flags({ skill_authoring: true, skill_output_revisions: true }));
    await waitForRailReady();
    fireEvent.click(screen.getByRole("button", { name: "Open current step" }));

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Teach the skill · 1 comment",
      }),
    );
    await screen.findByRole("dialog", { name: "Enhance skill" });
    const runsBeforeClose = fetchCallsTo("/skill-runs").length;
    sent = true;

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Enhance skill" }), {
      key: "Escape",
    });

    await waitFor(() =>
      expect(fetchCallsTo("/skill-runs").length).toBeGreaterThan(runsBeforeClose),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Teach the skill/ }),
      ).not.toBeInTheDocument(),
    );
  });

  it("drops Teach the skill once the builder sends the taught comments, while the builder is still open", async () => {
    railState = {
      rail: skillBackedRail({ canEditStructure: true }),
      status: "ready",
    };
    const prompt = "Update this skill with lessons from reviews of its output.";
    let sent = false;
    installTaughtRunFetch(() => sent, {
      "/skill-drafts": () => ({
        ok: true,
        status: 200,
        json: async () => draftResponse({ composerText: prompt }),
      }),
      "/messages": () => {
        sent = true;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    renderRail(flags({ skill_authoring: true, skill_output_revisions: true }));
    await waitForRailReady();
    fireEvent.click(screen.getByRole("button", { name: "Open current step" }));

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Teach the skill · 1 comment",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Enhance skill" });
    await waitFor(() =>
      expect(within(dialog).getByRole("textbox", { name: "Message" })).toHaveValue(prompt),
    );
    expect(
      screen.getByRole("button", { name: "Teach the skill · 1 comment", hidden: true }),
    ).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Teach the skill/, hidden: true }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("dialog", { name: "Enhance skill" })).toBeInTheDocument();
  });

  it("drops Teach the skill when the builder is closed while the send is still in flight", async () => {
    railState = {
      rail: skillBackedRail({ canEditStructure: true }),
      status: "ready",
    };
    const prompt = "Update this skill with lessons from reviews of its output.";
    let sent = false;
    let admit: () => void = () => undefined;
    const admitted = new Promise<void>((resolvePromise) => {
      admit = resolvePromise;
    });
    installTaughtRunFetch(() => sent, {
      "/skill-drafts": () => ({
        ok: true,
        status: 200,
        json: async () => draftResponse({ composerText: prompt }),
      }),
      "/messages": async () => {
        await admitted;
        sent = true;
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });
    renderRail(flags({ skill_authoring: true, skill_output_revisions: true }));
    await waitForRailReady();
    fireEvent.click(screen.getByRole("button", { name: "Open current step" }));

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Teach the skill · 1 comment",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Enhance skill" });
    await waitFor(() =>
      expect(within(dialog).getByRole("textbox", { name: "Message" })).toHaveValue(prompt),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fetchCallsTo("/messages")).toHaveLength(1));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Enhance skill" })).not.toBeInTheDocument(),
    );
    const runsAfterClose = fetchCallsTo("/skill-runs").length;
    await waitFor(() =>
      expect(fetchCallsTo("/skill-runs").length).toBe(runsAfterClose),
    );
    expect(
      screen.getByRole("button", { name: "Teach the skill · 1 comment" }),
    ).toBeInTheDocument();

    admit();

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Teach the skill/ }),
      ).not.toBeInTheDocument(),
    );
  });

  it("hides Teach the skill from someone who may not improve the skill", async () => {
    railState = {
      rail: skillBackedRail({ canEditStructure: false }),
      status: "ready",
    };
    installTaughtRunFetch();
    renderRail(flags({ skill_authoring: true, skill_output_revisions: true }));
    await waitForRailReady();
    fireEvent.click(screen.getByRole("button", { name: "Open current step" }));

    await screen.findByRole("button", { name: "Review output" });

    expect(
      screen.queryByRole("button", { name: /Teach the skill/ }),
    ).not.toBeInTheDocument();
  });
});

describe("skill authoring rail entry — where the new step goes", () => {
  function draftPatches() {
    return (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([input, init]) => String(input).endsWith("/skill-drafts/draft-1") && (init as RequestInit | undefined)?.method === "PATCH")
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
  }

  it("opens from the header placed after the deal's current step, saving it with the first edit", async () => {
    echoDraftPatch = true;
    railState = { rail: baseRail({ canEditStructure: true }), status: "ready" };
    renderRail(flags({ skill_authoring: true }));
    await openBuilder();
    await waitFor(() =>
      expect(screen.getByTestId("placement-summary")).toHaveTextContent(/^Adds after: /),
    );
    // Opening saves nothing.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(draftPatches()).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Step name"), { target: { value: "Buyer memo" } });
    await waitFor(() => expect(draftPatches()).toHaveLength(1));
    expect(draftPatches()[0]).toMatchObject({
      name: "Buyer memo",
      placement: { kind: "after", phaseIndex: 2, afterStepId: "p2-s29" },
    });
  });

  it("opens from the plus on a card's dashed track, placed after that step", async () => {
    echoDraftPatch = true;
    const rail = baseRail({ canEditStructure: true });
    rail.steps.push({
      ...rail.steps[0],
      id: "p2-s30",
      stepId: "p2-s30",
      displayOrder: 2,
      seq: 30,
      status: "pending",
    });
    // The plus sits between cards: the column's last one has the footer instead.
    rail.steps.push({
      ...rail.steps[0],
      id: "p2-s31",
      stepId: "p2-s31",
      displayOrder: 3,
      seq: 31,
      status: "pending",
    });
    railState = { rail, status: "ready" };
    renderRail(flags({ skill_authoring: true }));
    await waitForRailReady();

    const card = await screen.findByTestId("step-p2-s30");
    fireEvent.click(within(card.closest("li")!).getByRole("button", { name: /^Add a step after / }));
    await screen.findByRole("dialog", { name: "Skill builder" });
    await waitFor(() =>
      expect(screen.getByTestId("placement-summary")).toHaveTextContent(/^Adds after: /),
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(draftPatches()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Step name"), { target: { value: "Buyer memo" } });
    await waitFor(() => expect(draftPatches()).toHaveLength(1));
    expect(draftPatches()[0].placement).toEqual({
      kind: "after",
      phaseIndex: 2,
      afterStepId: "p2-s30",
    });
  });
});
