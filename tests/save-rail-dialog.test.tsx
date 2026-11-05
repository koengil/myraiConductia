import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

import { FlagsProvider } from "@/lib/flags/FlagsContext";
import type { FlagMap } from "@/lib/flags/resolveFlags";
import { SessionProvider } from "@/lib/session/store";
import type { ProjectRail, ProjectRailStep } from "@/lib/rail/projectRail";
import type { TemplateSummary } from "@/lib/railTemplates/types";

const PROJECT_ID = "SUM-2026-014";

const SKILL_BINDING = {
  skillId: "11111111-1111-4111-8111-111111111111",
  versionId: "22222222-2222-4222-8222-222222222222",
  digest: "a".repeat(64),
};

let railState: {
  rail: ProjectRail | null;
  status: "loading" | "ready" | "error";
};

vi.mock("@/lib/rail/projectRail", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/rail/projectRail")>();
  return {
    ...actual,
    useProjectRail: () => ({
      rail: railState.rail,
      status: railState.status,
      refresh: vi.fn(),
      skipStep: vi.fn(async () => ({})),
      stepRecords: [],
    }),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useParams: () => ({ projectId: PROJECT_ID }),
  usePathname: () => `/projects/${PROJECT_ID}/rail`,
  useSearchParams: () => new URLSearchParams(),
}));

function step(overrides: Partial<ProjectRailStep> = {}): ProjectRailStep {
  return {
    id: "step-1",
    stepId: "p1-s01",
    origin: "catalog",
    phaseIndex: 1,
    displayOrder: 1,
    seq: 1,
    status: "current",
    definition: null,
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
    ...overrides,
  };
}

function baseRail(overrides: Partial<ProjectRail> = {}): ProjectRail {
  return {
    currentStepId: "step-1",
    canEditStructure: true,
    canSaveTemplate: true,
    phases: [{ index: 1, name: "Mandate", dealStatus: "active" }],
    steps: [
      step(),
      step({ id: "step-2", stepId: "p1-s02", displayOrder: 2, seq: 2, status: "pending" }),
      step({
        id: "step-3",
        stepId: "custom:brief",
        origin: "custom",
        displayOrder: 3,
        seq: null,
        status: "pending",
        definition: {
          schemaVersion: 1,
          type: "skill",
          title: "Buyer brief",
          description: "Drafts the buyer brief.",
          inputs: [
            {
              key: "primary",
              kind: "text",
              label: "Input",
              helperText: "Paste the buyer notes.",
              required: true,
            },
          ],
          skillBinding: SKILL_BINDING,
        },
      }),
      step({
        id: "step-4",
        stepId: "p1-s04",
        displayOrder: 4,
        seq: 4,
        status: "pending",
        removedAt: "2026-09-01T00:00:00.000Z",
      }),
    ],
    ...overrides,
  };
}

function summary(overrides: Partial<TemplateSummary> = {}): TemplateSummary {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    revisionId: "44444444-4444-4444-8444-444444444444",
    name: "Technology sell-side",
    description: "Standard technology process.",
    stepCount: 3,
    skillCount: 1,
    updatedAt: "2026-09-20T12:00:00.000Z",
    ...overrides,
  };
}

const ME = {
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

const API_DEAL = {
  id: "deal-uuid",
  code: PROJECT_ID,
  codename: "Project Summit",
  status: "active",
  createdAt: "2026-09-01T00:00:00.000Z",
  entryStepSeq: 1,
  currentStepSeq: 1,
  targetName: "Summit",
  dealRole: "Lead",
  conflictsApprovedBy: null,
  conflictsApprovedOn: null,
};

type Reply = {
  status: number;
  body: unknown;
  gate?: Promise<void>;
  network?: true;
};

type Route = "me" | "deals" | "list" | "save" | "other";

const replies: Record<string, Reply[]> = {};
let calls: Array<{ method: string; url: string; body: unknown }> = [];
let templates: TemplateSummary[] = [];

function queue(route: Route, ...items: Reply[]) {
  replies[route] = [...(replies[route] ?? []), ...items];
}

function held(reply: Reply): { reply: Reply; release: () => void } {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reply: { ...reply, gate }, release };
}

function routeOf(method: string, url: string): Route {
  if (url.startsWith("/api/v1/me")) return "me";
  if (url.startsWith("/api/v1/deals?") || url === "/api/v1/deals") return "deals";
  if (url.startsWith("/api/v1/rail-templates")) {
    return method === "POST" ? "save" : "list";
  }
  return "other";
}

function defaultReply(route: Route): Reply {
  if (route === "me") return { status: 200, body: ME };
  if (route === "deals") return { status: 200, body: { deals: [API_DEAL] } };
  if (route === "list") return { status: 200, body: { templates } };
  if (route === "other") return { status: 200, body: {} };
  throw new Error(`No queued rail template reply for ${route}`);
}

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, url, body });
    const route = routeOf(method, url);
    const reply = replies[route]?.shift() ?? defaultReply(route);
    if (reply.gate) await reply.gate;
    if (reply.network) throw new TypeError("Failed to fetch");
    return {
      ok: reply.status < 400,
      status: reply.status,
      json: async () => reply.body,
    } as Response;
  }) as unknown as typeof fetch;
}

function callsTo(route: Route) {
  return calls.filter((call) => routeOf(call.method, call.url) === route);
}

async function renderDialog(props: {
  onClose?: () => void;
  onSaved?: (value: TemplateSummary) => void;
} = {}) {
  const onClose = props.onClose ?? vi.fn();
  const onSaved = props.onSaved ?? vi.fn();
  const { SaveRailDialog } = await import(
    "@/components/rail/SaveRailDialog"
  );
  render(
    <SaveRailDialog
      dealId={PROJECT_ID}
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  // The shared Dialog fades in; wait for the enter motion to settle so
  // visibility assertions see the finished panel.
  await waitFor(() => expect(screen.getByRole("dialog")).toBeVisible());
  return { onClose, onSaved };
}

function flags(overrides: Partial<FlagMap> = {}): FlagMap {
  return {
    rail_templates: true,
    project_rail_model: true,
    gate0_api_create: true,
    ...overrides,
  } as FlagMap;
}

async function renderRail(flagMap: FlagMap) {
  const { DealRail } = await import("@/components/rail/DealRail");
  render(
    <FlagsProvider value={flagMap}>
      <SessionProvider>
        <DealRail />
      </SessionProvider>
    </FlagsProvider>,
  );
  await waitFor(() =>
    expect(
      screen.queryByText(/Loading (the deal rail|your deal list)/i),
    ).not.toBeInTheDocument(),
  );
}

beforeEach(() => {
  railState = { rail: baseRail(), status: "ready" };
  templates = [summary()];
  calls = [];
  for (const key of Object.keys(replies)) delete replies[key];
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SaveRailDialog", () => {
  it("explains what a replacement does to deals built from the rail", async () => {
    await renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: "Replace existing" }));
    expect(
      await screen.findByText(
        "Deals built from this rail are told about the changes and choose what to take.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Replace rail" }),
    ).toBeDisabled();
  });

  it("discloses what is shared and that only published steps are included", async () => {
    await renderDialog();
    expect(
      screen.getByText(
        "Shares step descriptions and selected skill instructions with your company. People, deal work and results are not copied.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText("Only published steps are included."),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Removed standard steps stay removed on new deals, where they can be restored.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(
        "Deals built from this rail are told about the changes and choose what to take.",
      ),
    ).not.toBeInTheDocument();
  });

  it("previews the active steps and states the skill count as a floor", async () => {
    await renderDialog();
    expect(screen.getByText("3 active steps.")).toBeVisible();
    expect(
      screen.getByText(
        "At least 1 step carries a skill. The saved rail may include more.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText("3 active steps, including 1 skill-backed step."),
    ).not.toBeInTheDocument();
  });

  it("shows the description that replacing a saved rail would overwrite", async () => {
    await renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: "Replace existing" }));
    const selector = await screen.findByLabelText("Saved rail");
    fireEvent.change(selector, {
      target: { value: "33333333-3333-4333-8333-333333333333" },
    });
    expect(screen.getByLabelText("Description")).toHaveValue(
      "Standard technology process.",
    );
  });

  it("keeps a description the banker typed when reselecting a saved rail", async () => {
    await renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: "Replace existing" }));
    const selector = await screen.findByLabelText("Saved rail");
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Refreshed after diligence." },
    });
    fireEvent.change(selector, {
      target: { value: "33333333-3333-4333-8333-333333333333" },
    });
    expect(screen.getByLabelText("Description")).toHaveValue(
      "Refreshed after diligence.",
    );
  });

  it("requires a name and collapses its whitespace before saving", async () => {
    queue("save", { status: 200, body: summary({ name: "Diligence Rail" }) });
    await renderDialog();
    const save = screen.getByRole("button", { name: "Save rail" });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "   " },
    });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "  Diligence   Rail  " },
    });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(callsTo("save")).toHaveLength(1));
    expect(callsTo("save")[0].body).toMatchObject({
      sourceDealId: PROJECT_ID,
      target: { kind: "new", name: "Diligence Rail" },
    });
  });

  it("sends the current revision of the saved rail chosen for replacement", async () => {
    templates = [
      summary(),
      summary({
        id: "55555555-5555-4555-8555-555555555555",
        revisionId: "66666666-6666-4666-8666-666666666666",
        name: "Healthcare carve-out",
      }),
    ];
    queue("save", { status: 200, body: summary() });
    await renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: "Replace existing" }));
    const selector = await screen.findByLabelText("Saved rail");
    fireEvent.change(selector, {
      target: { value: "55555555-5555-4555-8555-555555555555" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Refreshed after diligence." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace rail" }));

    await waitFor(() => expect(callsTo("save")).toHaveLength(1));
    expect(callsTo("save")[0].body).toMatchObject({
      description: "Refreshed after diligence.",
      target: {
        kind: "replace",
        templateId: "55555555-5555-4555-8555-555555555555",
        expectedRevisionId: "66666666-6666-4666-8666-666666666666",
      },
    });
    expect(callsTo("list")[0].url).toContain("purpose=save");
  });

  it("disables the submit while the save is in flight and announces it", async () => {
    const { reply, release } = held({ status: 200, body: summary() });
    queue("save", reply);
    await renderDialog();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Technology sell-side" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save rail" })).toBeDisabled(),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Saving this rail to your company.",
    );
    release();
  });

  it("keeps the entered values and shows the server's refusal inline", async () => {
    queue("save", {
      status: 403,
      body: {
        error: "This company rail is not available to you.",
        code: "forbidden",
        retryable: false,
      },
    });
    await renderDialog();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Technology sell-side" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Used on every technology mandate." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This company rail is not available to you.",
    );
    expect(screen.getByLabelText("Name")).toHaveValue("Technology sell-side");
    expect(screen.getByLabelText("Description")).toHaveValue(
      "Used on every technology mandate.",
    );
  });

  it("keeps the name in place when the company already uses it", async () => {
    queue("save", {
      status: 409,
      body: {
        error: "Another saved rail in your company already uses that name.",
        code: "name_taken",
        retryable: false,
      },
    });
    queue("save", { status: 200, body: summary({ name: "Technology II" }) });
    const onSaved = vi.fn();
    await renderDialog({ onSaved });
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Technology sell-side" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Another saved rail in your company already uses that name.",
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Technology II" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));

    const requestIds = callsTo("save").map(
      (call) => (call.body as { requestId: string }).requestId,
    );
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).not.toEqual(requestIds[1]);
  });

  it("saves when the banker presses Enter in the name field", async () => {
    queue("save", { status: 200, body: summary({ name: "Technology III" }) });
    const onSaved = vi.fn();
    await renderDialog({ onSaved });
    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "Technology III" } });
    fireEvent.submit(name.closest("form")!);

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(callsTo("save")).toHaveLength(1);
  });

  it("marks the name invalid, describes it by the refusal, and puts focus back on it", async () => {
    queue("save", {
      status: 409,
      body: {
        error: "Another saved rail in your company already uses that name.",
        code: "name_taken",
        retryable: false,
      },
    });
    await renderDialog();
    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "Technology sell-side" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));

    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(name).toHaveAttribute("aria-invalid", "true"));
    expect(name).toHaveAttribute("aria-describedby", alert.id);
    expect(alert.id).not.toEqual("");
    expect(document.activeElement).toBe(name);
  });

  it("returns to edit mode with refreshed choices and the entered description when the saved rail changed", async () => {
    queue("save", {
      status: 409,
      body: {
        error: "That saved rail changed while you were working.",
        code: "stale_template",
        retryable: false,
      },
    });
    queue(
      "list",
      { status: 200, body: { templates: [summary()] } },
      {
        status: 200,
        body: {
          templates: [
            summary({
              revisionId: "77777777-7777-4777-8777-777777777777",
            }),
          ],
        },
      },
    );
    queue("save", { status: 200, body: summary() });
    await renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: "Replace existing" }));
    const selector = await screen.findByLabelText("Saved rail");
    fireEvent.change(selector, {
      target: { value: "33333333-3333-4333-8333-333333333333" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Refreshed after diligence." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace rail" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That saved rail changed while you were working.",
    );
    await waitFor(() => expect(callsTo("list")).toHaveLength(2));
    expect(screen.getByLabelText("Description")).toHaveValue(
      "Refreshed after diligence.",
    );
    expect(screen.getByLabelText("Saved rail")).toHaveValue("");

    fireEvent.change(screen.getByLabelText("Saved rail"), {
      target: { value: "33333333-3333-4333-8333-333333333333" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace rail" }));
    await waitFor(() => expect(callsTo("save")).toHaveLength(2));
    expect(callsTo("save")[1].body).toMatchObject({
      description: "Refreshed after diligence.",
      target: {
        kind: "replace",
        expectedRevisionId: "77777777-7777-4777-8777-777777777777",
      },
    });
  });

  it("reports a source rail that changed while it was being saved", async () => {
    queue("save", {
      status: 409,
      body: {
        error: "This rail changed while it was being saved.",
        code: "source_changed",
        retryable: false,
      },
    });
    await renderDialog();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Technology sell-side" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This rail changed while it was being saved.",
    );
    expect(screen.getByRole("button", { name: "Save rail" })).toBeEnabled();
  });

  it("closes with the server's summary when the save succeeds", async () => {
    const receipt = summary({ name: "Technology sell-side" });
    queue("save", { status: 200, body: receipt });
    const { onClose, onSaved } = await renderDialog();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Technology sell-side" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(receipt));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("tells the banker the deal will follow the saved rail", async () => {
    await renderDialog();
    expect(
      screen.getByText("This deal will follow the saved rail from now on."),
    ).toBeVisible();
  });

  it("limits a name to 80 characters", async () => {
    await renderDialog();
    expect(screen.getByLabelText("Name")).toHaveAttribute("maxlength", "80");
  });

  it("resends the same request when the banker saves again after a transport failure", async () => {
    queue("save", { status: 0, body: null, network: true });
    queue("save", { status: 200, body: summary() });
    const { onSaved } = await renderDialog();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Technology sell-side" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));

    await screen.findByRole("alert");
    expect(screen.getByLabelText("Name")).toHaveValue("Technology sell-side");
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const sent = callsTo("save").map((call) => (call.body as { requestId: string }).requestId);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
  });

  it("resends the same request after a server error that carries no code", async () => {
    queue("save", { status: 500, body: { error: "Unable to process this request." } });
    queue("save", { status: 200, body: summary() });
    const { onSaved } = await renderDialog();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Technology sell-side" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));

    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const sent = callsTo("save").map((call) => (call.body as { requestId: string }).requestId);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
  });

  it("resends the same request when a successful answer cannot be read", async () => {
    queue("save", { status: 200, body: null });
    queue("save", { status: 200, body: summary() });
    const { onSaved } = await renderDialog();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Technology sell-side" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));

    await screen.findByRole("alert");
    expect(screen.getByLabelText("Name")).toHaveValue("Technology sell-side");
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const sent = callsTo("save").map((call) => (call.body as { requestId: string }).requestId);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
  });

  it("starts a new request when the banker changes the name after a failure", async () => {
    queue("save", { status: 0, body: null, network: true });
    queue("save", { status: 200, body: summary() });
    const { onSaved } = await renderDialog();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Technology sell-side" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));

    await screen.findByRole("alert");
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Technology carve-out" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const sent = callsTo("save").map((call) => (call.body as { requestId: string }).requestId);
    expect(sent[1]).not.toBe(sent[0]);
  });

  it.each([
    [
      "unpublished_changes",
      "This template has changes that are not published. Publish or undo them on Rail templates first.",
    ],
    [
      "order_differs",
      "This rail orders its steps differently from that template. Save it as a new template instead.",
    ],
    ["nothing_to_publish", "This template already matches this rail."],
  ])("shows the server's words for %s and keeps what was entered", async (code, copy) => {
    queue("save", { status: 409, body: { error: copy, code, retryable: false } });
    await renderDialog();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Technology sell-side" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(copy);
    expect(screen.getByLabelText("Name")).toHaveValue("Technology sell-side");
  });

  it("puts focus on the name when it opens", async () => {
    await renderDialog();
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
  });

  it("dismisses on Escape without saving", async () => {
    const { onClose } = await renderDialog();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(callsTo("save")).toHaveLength(0);
  });
});

describe("DealRail save rail action", () => {
  it("offers Save rail on a real structured deal to someone who can configure templates", async () => {
    await renderRail(flags());
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("radio", { name: "Create new" }),
    ).toBeChecked();
  });

  it("says which version a save published", async () => {
    queue("save", {
      status: 200,
      body: summary({ name: "Technology sell-side", version: 3 }),
    });
    await renderRail(flags());
    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Technology sell-side" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save rail" }));

    expect(
      await screen.findByText(
        "Saved as Technology sell-side, version 3. New mandates in your company can start from it.",
      ),
    ).toBeVisible();
  });

  it("asks for the deal's template changes again after a save", async () => {
    queue("save", { status: 200, body: summary({ name: "Technology sell-side", version: 3 }) });
    await renderRail(flags({ template_change_review: true }));
    const changeReads = () =>
      calls.filter((call) => call.url.endsWith("/rail/template-changes")).length;
    const before = changeReads();
    expect(before).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Save rail" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Technology sell-side" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save rail" }));
    await screen.findByText(/Saved as Technology sell-side/);

    await waitFor(() => expect(changeReads()).toBe(before + 1));
  });

  it("places Save rail beside Edit rail", async () => {
    await renderRail(flags({ skill_authoring: true }));
    const save = screen.getByRole("button", { name: "Save rail" });
    const add = screen.getByRole("button", { name: "Edit rail" });
    expect(save.parentElement).toBe(add.parentElement);
  });

  it("hides Save rail when the rail templates flag is off", async () => {
    await renderRail(flags({ rail_templates: false }));
    expect(
      screen.queryByRole("button", { name: "Save rail" }),
    ).not.toBeInTheDocument();
  });

  it("hides Save rail from someone who cannot configure templates", async () => {
    railState = {
      rail: baseRail({ canSaveTemplate: false }),
      status: "ready",
    };
    await renderRail(flags());
    expect(
      screen.queryByRole("button", { name: "Save rail" }),
    ).not.toBeInTheDocument();
  });

  it("offers Save rail to a template manager who cannot change this rail", async () => {
    railState = {
      rail: baseRail({ canEditStructure: false, canSaveTemplate: true }),
      status: "ready",
    };
    await renderRail(flags());
    expect(screen.getByRole("button", { name: "Save rail" })).toBeInTheDocument();
  });
});
