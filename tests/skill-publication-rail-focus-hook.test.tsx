import { it, expect, vi, afterEach } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import {
  useRestoreExistingStep,
  usePublishedStepFocus,
} from "@/components/rail/usePublishedStepFocus";
import type { ProjectRailStep } from "@/lib/rail/projectRail";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function step(overrides: Partial<ProjectRailStep> = {}): ProjectRailStep {
  return {
    id: "step-1",
    stepId: "custom:abc",
    origin: "custom",
    phaseIndex: 0,
    displayOrder: 1,
    seq: null,
    status: "pending",
    definition: null,
    anchorStepId: null,
    removedAt: null,
    removedBy: null,
    skip: null,
    ...overrides,
  };
}

it("closes the launcher and refreshes immediately on publish", () => {
  const close = vi.fn();
  const refresh = vi.fn();
  const openStepInFocus = vi.fn();
  const { result } = renderHook(() =>
    usePublishedStepFocus({
      close,
      refresh,
      steps: [],
      loading: false,
      openStepInFocus,
    }),
  );
  act(() => result.current.handlePublished("step-9"));
  expect(close).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(openStepInFocus).not.toHaveBeenCalled();
});

it("waits until the refreshed, non-loading steps contain the step before focusing", () => {
  const openStepInFocus = vi.fn();
  const { result, rerender } = renderHook(
    (props: { steps: ProjectRailStep[]; loading: boolean }) =>
      usePublishedStepFocus({
        close: vi.fn(),
        refresh: vi.fn(),
        steps: props.steps,
        loading: props.loading,
        openStepInFocus,
      }),
    { initialProps: { steps: [] as ProjectRailStep[], loading: false } },
  );
  act(() => result.current.handlePublished("step-9"));

  rerender({ steps: [], loading: true });
  expect(openStepInFocus).not.toHaveBeenCalled();

  rerender({ steps: [step({ id: "step-9" })], loading: false });
  expect(openStepInFocus).toHaveBeenCalledTimes(1);
  expect(openStepInFocus).toHaveBeenCalledWith("step-9");
});

it("focuses the published step exactly once even after further rerenders", () => {
  const openStepInFocus = vi.fn();
  const steps = [step({ id: "step-9" })];
  const { result, rerender } = renderHook(
    (props: { steps: ProjectRailStep[]; loading: boolean }) =>
      usePublishedStepFocus({
        close: vi.fn(),
        refresh: vi.fn(),
        steps: props.steps,
        loading: props.loading,
        openStepInFocus,
      }),
    { initialProps: { steps, loading: true } },
  );
  act(() => result.current.handlePublished("step-9"));
  rerender({ steps, loading: false });
  rerender({ steps, loading: false });
  expect(openStepInFocus).toHaveBeenCalledTimes(1);
});

it("does not focus when no publish has happened", () => {
  const openStepInFocus = vi.fn();
  renderHook(() =>
    usePublishedStepFocus({
      close: vi.fn(),
      refresh: vi.fn(),
      steps: [step({ id: "step-9" })],
      loading: false,
      openStepInFocus,
    }),
  );
  expect(openStepInFocus).not.toHaveBeenCalled();
});

it("clears the pending id once a loading-to-ready cycle completes without it, so a later reappearance cannot steal focus", () => {
  const openStepInFocus = vi.fn();
  const { result, rerender } = renderHook(
    (props: { steps: ProjectRailStep[]; loading: boolean }) =>
      usePublishedStepFocus({
        close: vi.fn(),
        refresh: vi.fn(),
        steps: props.steps,
        loading: props.loading,
        openStepInFocus,
      }),
    { initialProps: { steps: [] as ProjectRailStep[], loading: false } },
  );
  act(() => result.current.handlePublished("step-9"));
  rerender({ steps: [], loading: true });
  rerender({ steps: [], loading: false });
  expect(openStepInFocus).not.toHaveBeenCalled();

  rerender({ steps: [step({ id: "step-9" })], loading: false });
  expect(openStepInFocus).not.toHaveBeenCalled();
});

it("focusExisting closes the builder before focusing the step", () => {
  const calls: string[] = [];
  const close = vi.fn(() => calls.push("close"));
  const openStepInFocus = vi.fn(() => calls.push("focus"));
  const { result } = renderHook(() =>
    usePublishedStepFocus({
      close,
      refresh: vi.fn(),
      steps: [],
      loading: false,
      openStepInFocus,
    }),
  );
  act(() => result.current.focusExisting("step-1"));
  expect(calls).toEqual(["close", "focus"]);
  expect(openStepInFocus).toHaveBeenCalledWith("step-1");
});

it("routes restore success through the publish handoff and reports success", async () => {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  })) as unknown as typeof fetch;
  const handlePublished = vi.fn();
  const { result } = renderHook(() =>
    useRestoreExistingStep("deal-1", handlePublished),
  );
  const ok = await result.current("step-9");
  expect(ok).toBe(true);
  expect(handlePublished).toHaveBeenCalledWith("step-9");
});

it("reports restore failure and never runs the handoff when the server refuses", async () => {
  global.fetch = vi.fn(async () => ({
    ok: false,
    status: 409,
    json: async () => ({ error: "no" }),
  })) as unknown as typeof fetch;
  const handlePublished = vi.fn();
  const { result } = renderHook(() =>
    useRestoreExistingStep("deal-1", handlePublished),
  );
  const ok = await result.current("step-9");
  expect(ok).toBe(false);
  expect(handlePublished).not.toHaveBeenCalled();
});

it("handles a rejected restore fetch as a failure without throwing", async () => {
  global.fetch = vi.fn(async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const handlePublished = vi.fn();
  const { result } = renderHook(() =>
    useRestoreExistingStep("deal-1", handlePublished),
  );
  await expect(result.current("step-9")).resolves.toBe(false);
  expect(handlePublished).not.toHaveBeenCalled();
});

it("sends only one restore request for a rapid double click", async () => {
  let resolveFetch: (value: unknown) => void = () => undefined;
  global.fetch = vi.fn(
    () =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
  ) as unknown as typeof fetch;
  const handlePublished = vi.fn();
  const { result } = renderHook(() =>
    useRestoreExistingStep("deal-1", handlePublished),
  );
  const first = result.current("step-9");
  const second = result.current("step-9");
  resolveFetch({ ok: true, status: 200, json: async () => ({}) });
  const [firstOk, secondOk] = await Promise.all([first, second]);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(firstOk || secondOk).toBe(true);
});
