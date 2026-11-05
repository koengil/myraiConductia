import type { ReactElement } from "react";
import { it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  screen,
  cleanup,
  waitFor,
  fireEvent,
  within,
} from "@testing-library/react";

import {
  ADDED_STEP_ID,
  EXISTING_STEP_ID,
  PUBLISHED_STEP_ID,
  SECOND_EXISTING_STEP_ID,
  addedStep,
  baseRail,
  duplicateActiveResponse,
  duplicateRemovedResponse,
  existingStep,
  flags,
  installFetch,
  needsPlacementResponse,
  publishedStep,
  railBox,
  renderRail,
  rerenderRail,
  restoredStep,
  secondExistingStep,
  waitForRailReady,
} from "./helpers/dealRailPublicationHarness";
import { waitForDraftLoaded } from "./helpers/skillBuilderDialogFixtures";

const replaceSpy = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: replaceSpy,
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useParams: () => ({ projectId: "deal-1" }),
  usePathname: () => "/projects/deal-1/rail",
  useSearchParams: () => new URLSearchParams(),
}));

const refreshSpy = vi.fn();
vi.mock("@/lib/rail/projectRail", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/rail/projectRail")>();
  return {
    ...actual,
    useProjectRail: () => ({
      rail: railBox.rail,
      status: railBox.status,
      refresh: refreshSpy,
      skipStep: vi.fn(async () => ({})),
      stepRecords: [],
    }),
  };
});

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  railBox.rail = baseRail([existingStep(), secondExistingStep()]);
  railBox.status = "ready";
  refreshSpy.mockClear();
  installFetch();
});

async function openDialogAndSave() {
  fireEvent.click(screen.getAllByRole("button", { name: "Add new step" })[0]);
  await screen.findByRole("dialog");
  await waitForDraftLoaded();
  fireEvent.click(
    screen.getByRole("button", { name: "Save skill and add step" }),
  );
}

async function cycleRailThroughLoading(
  nextRail: ReturnType<typeof baseRail>,
  rerender: (node: ReactElement) => void,
) {
  railBox.rail = null;
  railBox.status = "loading";
  rerenderRail(flags(), rerender);
  await waitFor(() =>
    expect(screen.getByText(/Loading the deal rail/i)).toBeInTheDocument(),
  );
  railBox.rail = nextRail;
  railBox.status = "ready";
  rerenderRail(flags(), rerender);
}

it("closes the dialog, refreshes, then lands on the board with the new step highlighted, focused and draggable", async () => {
  const { rerender } = renderRail(flags());
  await waitForRailReady();

  await openDialogAndSave();
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));
  await cycleRailThroughLoading(
    baseRail([existingStep(), secondExistingStep(), publishedStep()]),
    rerender,
  );

  // Lands on the board, not the zoomed step, so the new card stays visible and draggable.
  const region = await screen.findByRole("region", { name: "Rail overview" });
  expect(screen.queryByRole("region", { name: "Step detail" })).not.toBeInTheDocument();
  const added = within(region).getByTestId(`step-${PUBLISHED_STEP_ID}`);
  const addedButton = within(added).getByRole("button", { name: /^Step .*Weekly filing summary/ });

  // Someone with rail editing rights is asked about the change's scope, over
  // the new card; answering hands focus back to it.
  const prompt = await screen.findByRole("dialog", { name: /Weekly filing summary added/ });
  expect(within(prompt).getByText("This changes the rail for everyone on this deal.")).toBeInTheDocument();
  await waitFor(() => expect(prompt.contains(document.activeElement)).toBe(true));
  fireEvent.click(within(prompt).getByRole("button", { name: "Apply to this deal" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  await waitFor(() => expect(addedButton).toHaveFocus());

  // Highlighted with the New pill and no hint about how to move it; no other card is.
  expect(added).toHaveAttribute("data-highlight", "new");
  expect(added).toHaveAttribute("data-status", "pending");
  expect(within(added).getByText("New")).toBeInTheDocument();
  expect(within(added).queryByText("Drag it into place.")).not.toBeInTheDocument();
  expect(region.querySelectorAll('[data-highlight="new"]')).toHaveLength(1);
  // The current marker did not move.
  const originationStep = within(region).getByTestId(`step-${EXISTING_STEP_ID}`);
  expect(originationStep).toHaveAttribute("data-status", "current");
});

it("keeps the open dialog mounted while a refresh cycles the rail through loading", async () => {
  const { rerender } = renderRail(flags());
  await waitForRailReady();
  fireEvent.click(screen.getAllByRole("button", { name: "Add new step" })[0]);
  const dialogBefore = await screen.findByRole("dialog");
  await waitForDraftLoaded();

  railBox.rail = null;
  railBox.status = "loading";
  rerenderRail(flags(), rerender);
  await waitFor(() =>
    expect(screen.getByText(/Loading the deal rail/i)).toBeInTheDocument(),
  );
  expect(screen.getByRole("dialog")).toBe(dialogBefore);

  railBox.rail = baseRail([existingStep(), secondExistingStep()]);
  railBox.status = "ready";
  rerenderRail(flags(), rerender);
  await waitForRailReady();
  expect(screen.getByRole("dialog")).toBe(dialogBefore);
});

it("closes the builder before focusing the step on an exact active duplicate", async () => {
  installFetch(() => duplicateActiveResponse(SECOND_EXISTING_STEP_ID));
  renderRail(flags());
  await waitForRailReady();
  await openDialogAndSave();

  await screen.findByRole("button", { name: "Focus existing step" });
  fireEvent.click(screen.getByRole("button", { name: "Focus existing step" }));

  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Skill builder" })).not.toBeInTheDocument(),
  );
  const zoomed = await screen.findByRole("region", { name: "Step detail" });
  // An exact duplicate opens the existing step zoomed in, not the board (a new
  // step lands on the board): the builder and its "Add new step" trigger are gone,
  // so focus moves into the zoomed step.
  await waitFor(() => expect(zoomed).toHaveFocus());
  expect(within(zoomed).getByRole("heading", { name: /Diligence checklist/ })).toBeInTheDocument();
});

it("restores an existing step through the real wiring: success closes, refreshes and focuses", async () => {
  railBox.rail = baseRail([existingStep(), secondExistingStep()]);
  installFetch(duplicateRemovedResponse);
  const { rerender } = renderRail(flags());
  await waitForRailReady();
  await openDialogAndSave();

  await screen.findByRole("button", { name: "Restore existing step" });
  fireEvent.click(
    screen.getByRole("button", { name: "Restore existing step" }),
  );

  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await waitFor(() => expect(refreshSpy).toHaveBeenCalledTimes(1));

  await cycleRailThroughLoading(
    baseRail([existingStep(), secondExistingStep(), restoredStep()]),
    rerender,
  );

  const zoomed = await screen.findByRole("region", { name: "Step detail" });
  // A restore opens the restored step zoomed in, not the board (a new step
  // lands on the board): the builder and its "Add new step" trigger are gone, so
  // focus moves into the zoomed step.
  await waitFor(() => expect(zoomed).toHaveFocus());
  expect(within(zoomed).getByRole("heading", { name: /Removed step/ })).toBeInTheDocument();
});

async function reachNeedsPlacement() {
  installFetch(needsPlacementResponse);
  const { rerender } = renderRail(flags());
  await waitForRailReady();
  await openDialogAndSave();
  await screen.findByLabelText("New phase");
  return rerender;
}

function positionOptionValues() {
  fireEvent.change(screen.getByLabelText("New phase"), {
    target: { value: "0" },
  });
  const position = screen.getByLabelText("New position");
  return Array.from(position.querySelectorAll("option")).map((option) =>
    option.getAttribute("value"),
  );
}

it("excludes a step removed from the live rail after launch", async () => {
  railBox.rail = baseRail([existingStep(), secondExistingStep()]);
  const rerender = await reachNeedsPlacement();

  railBox.rail = baseRail([existingStep()]);
  rerenderRail(flags(), rerender);

  const optionValues = positionOptionValues();
  expect(optionValues).not.toContain(`after:${SECOND_EXISTING_STEP_ID}`);
  expect(optionValues).toContain(`after:${EXISTING_STEP_ID}`);
});

it("offers a step added to the live rail after launch", async () => {
  railBox.rail = baseRail([existingStep()]);
  const rerender = await reachNeedsPlacement();

  railBox.rail = baseRail([existingStep(), addedStep()]);
  rerenderRail(flags(), rerender);

  const optionValues = positionOptionValues();
  expect(optionValues).toContain(`after:${ADDED_STEP_ID}`);
});
