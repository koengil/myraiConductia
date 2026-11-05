import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SkillAuthoringHttpError,
  type DraftFields,
  type SkillAuthoringClient,
} from "@/lib/skillAuthoring/client";
import {
  freshId,
  nonterminal,
  useSkillAuthoringDraft,
} from "@/lib/skillAuthoring/useSkillAuthoringDraft";
import type { AttemptRead, DraftRead } from "@/lib/skillAuthoring/types";

const PROJECT_ID = "deal-1";
const DRAFT_ID = "draft-1";

function makeAttempt(overrides: Partial<AttemptRead> = {}): AttemptRead {
  return {
    id: "attempt-1",
    messageId: "message-1",
    number: 1,
    status: "running",
    responseText: "",
    error: null,
    ...overrides,
  };
}

function makeDraft(overrides: Partial<DraftRead> = {}): DraftRead {
  return {
    id: DRAFT_ID,
    dealId: PROJECT_ID,
    status: "active",
    name: "",
    placement: null,
    composerText: "",
    editRevision: 0,
    messages: [],
    activeAttempt: null,
    candidate: null,
    publication: { available: false },
    ...overrides,
  };
}

function openResult(draft: DraftRead) {
  return { draft, basis: null, seedRunId: null };
}

function fakeClient(
  overrides: Partial<SkillAuthoringClient> = {},
): SkillAuthoringClient {
  return {
    open: vi.fn((_projectId: string) => Promise.resolve(openResult(makeDraft()))),
    read: vi.fn((_projectId: string, _draftId: string) =>
      Promise.resolve(makeDraft()),
    ),
    patch: vi.fn(
      (
        _projectId: string,
        _draftId: string,
        body: { expectedEditRevision: number },
      ) => Promise.resolve({ ...makeDraft(), ...body }),
    ),
    send: vi.fn((_projectId: string, _draftId: string, _body: unknown) =>
      Promise.resolve({}),
    ),
    retry: vi.fn(
      (
        _projectId: string,
        _draftId: string,
        _messageId: string,
        _body: { retryRequestId: string },
      ) => Promise.resolve({}),
    ),
    discard: vi.fn(
      (_projectId: string, _draftId: string, _expectedEditRevision: number) =>
        Promise.resolve(undefined),
    ),
    ...overrides,
  };
}

async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("nonterminal", () => {
  it("is true only while an attempt is running", () => {
    expect(nonterminal(makeAttempt({ status: "running" }))).toBe(true);
    expect(nonterminal(makeAttempt({ status: "succeeded" }))).toBe(false);
    expect(nonterminal(makeAttempt({ status: "failed" }))).toBe(false);
    expect(nonterminal(null)).toBe(false);
    expect(nonterminal(undefined)).toBe(false);
  });
});

describe("freshId", () => {
  it("produces distinct ids", () => {
    expect(freshId()).not.toBe(freshId());
  });
});

describe("useSkillAuthoringDraft — open", () => {
  it("opens the draft and reports ready", async () => {
    const opened = makeDraft({ name: "Teaser" });
    const client = fakeClient({ open: vi.fn(async () => openResult(opened)) });
    const { result } = renderHook(() =>
      useSkillAuthoringDraft(PROJECT_ID, client),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.draft).toEqual(opened);
    expect(result.current.saveState).toBe("saved");
  });

  it("reports forbidden on a 403 opening the draft", async () => {
    const client = fakeClient({
      open: vi.fn(async () => {
        throw new SkillAuthoringHttpError(403, "Not permitted.", null);
      }),
    });
    const { result } = renderHook(() =>
      useSkillAuthoringDraft(PROJECT_ID, client),
    );
    await waitFor(() => expect(result.current.status).toBe("forbidden"));
  });
});

describe("useSkillAuthoringDraft — autosave", () => {
  it("debounces rapid updateFields calls into one patch with the latest fields and current revision", async () => {
    vi.useFakeTimers();
    const opened = makeDraft({ editRevision: 3 });
    const patchSpy = vi.fn(async (_projectId, _draftId, body) => ({
      ...opened,
      ...body,
    }));
    const client = fakeClient({
      open: vi.fn(async () => openResult(opened)),
      patch: patchSpy,
    });
    const { result } = renderHook(() =>
      useSkillAuthoringDraft(PROJECT_ID, client),
    );
    await tick(0);
    expect(result.current.status).toBe("ready");

    act(() => result.current.updateFields({ name: "A" }));
    act(() => result.current.updateFields({ name: "AB" }));
    act(() => result.current.updateFields({ name: "ABC" }));

    await tick(500);

    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(patchSpy).toHaveBeenCalledWith(PROJECT_ID, opened.id, {
      expectedEditRevision: 3,
      name: "ABC",
      placement: null,
      composerText: "",
    });
    expect(result.current.saveState).toBe("saved");
  });

  it("adopts the server revision on a 409 conflict and patches once more with the local fields", async () => {
    vi.useFakeTimers();
    const opened = makeDraft({ editRevision: 1 });
    const conflictDraft = makeDraft({
      editRevision: 5,
      composerText: "other tab",
    });
    let calls = 0;
    const patchSpy = vi.fn(async (_projectId, _draftId, body) => {
      calls += 1;
      if (calls === 1)
        throw new SkillAuthoringHttpError(
          409,
          "Draft changed. Reload and retry.",
          conflictDraft,
        );
      return {
        ...conflictDraft,
        ...body,
        editRevision: body.expectedEditRevision + 1,
      };
    });
    const client = fakeClient({
      open: vi.fn(async () => openResult(opened)),
      patch: patchSpy,
    });
    const { result } = renderHook(() =>
      useSkillAuthoringDraft(PROJECT_ID, client),
    );
    await tick(0);

    act(() => result.current.updateFields({ composerText: "mine" }));
    await tick(500);

    expect(patchSpy).toHaveBeenCalledTimes(2);
    expect(patchSpy.mock.calls[1]?.[2]).toMatchObject({
      expectedEditRevision: 5,
      composerText: "mine",
    });
    expect(result.current.draft?.composerText).toBe("mine");
    expect(result.current.draft?.editRevision).toBe(6);
    expect(result.current.saveState).toBe("saved");
  });

  it("stops after a single conflict-driven retry and reports an error on a second consecutive conflict", async () => {
    vi.useFakeTimers();
    const opened = makeDraft({ editRevision: 1 });
    const conflictDraft = makeDraft({ editRevision: 5 });
    const patchSpy = vi.fn(async () => {
      throw new SkillAuthoringHttpError(
        409,
        "Draft changed. Reload and retry.",
        conflictDraft,
      );
    });
    const client = fakeClient({
      open: vi.fn(async () => openResult(opened)),
      patch: patchSpy,
    });
    const { result } = renderHook(() =>
      useSkillAuthoringDraft(PROJECT_ID, client),
    );
    await tick(0);

    act(() => result.current.updateFields({ composerText: "mine" }));
    await tick(500);

    expect(patchSpy).toHaveBeenCalledTimes(2);
    expect(result.current.saveState).toBe("error");
  });

  it("resends with the newer fields when a second edit lands while the first save is in flight", async () => {
    let resolvePatch: ((value: DraftRead) => void) | null = null;
    const opened = makeDraft({ editRevision: 0 });
    const patchSpy = vi.fn(
      (_projectId: string, _draftId: string, body: DraftFields) =>
        new Promise<DraftRead>((resolve) => {
          resolvePatch = () => resolve({ ...opened, ...body, editRevision: 1 });
        }),
    );
    const client = fakeClient({
      open: vi.fn(async () => openResult(opened)),
      patch: patchSpy,
    });
    const { result } = renderHook(() =>
      useSkillAuthoringDraft(PROJECT_ID, client),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.updateFields({ name: "First" }));

    let flushDone: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      flushDone = result.current.flush();
      await Promise.resolve();
    });

    await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(1));
    expect(patchSpy.mock.calls[0]?.[2]).toMatchObject({ name: "First" });

    act(() => result.current.updateFields({ name: "Second" }));

    await act(async () => {
      resolvePatch?.(opened);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(patchSpy).toHaveBeenCalledTimes(2));
    expect(patchSpy.mock.calls[1]?.[2]).toMatchObject({ name: "Second" });

    await act(async () => {
      resolvePatch?.(opened);
      await flushDone;
    });

    expect(result.current.draft?.name).toBe("Second");
  });
});

describe("useSkillAuthoringDraft — polling", () => {
  it("reads every 1000ms with an active attempt and every 10000ms otherwise", async () => {
    vi.useFakeTimers();
    const running = makeDraft({
      activeAttempt: makeAttempt({ status: "running" }),
    });
    const idle = makeDraft({ activeAttempt: null });
    const readSpy = vi.fn(async () => idle);
    const client = fakeClient({
      open: vi.fn(async () => openResult(running)),
      read: readSpy,
    });
    const { result } = renderHook(() =>
      useSkillAuthoringDraft(PROJECT_ID, client),
    );
    await tick(0);
    expect(result.current.draft?.activeAttempt?.status).toBe("running");

    await tick(1000);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(result.current.draft?.activeAttempt).toBeNull();

    await tick(1000);
    expect(readSpy).toHaveBeenCalledTimes(1);

    await tick(9000);
    expect(readSpy).toHaveBeenCalledTimes(2);
  });

  it("stops polling and reports forbidden after two consecutive 403s during a poll", async () => {
    vi.useFakeTimers();
    const opened = makeDraft({
      activeAttempt: makeAttempt({ status: "running" }),
    });
    const readSpy = vi.fn(async () => {
      throw new SkillAuthoringHttpError(403, "Not permitted.", null);
    });
    const client = fakeClient({
      open: vi.fn(async () => openResult(opened)),
      read: readSpy,
    });
    const { result } = renderHook(() =>
      useSkillAuthoringDraft(PROJECT_ID, client),
    );
    await tick(0);
    await tick(1000);
    expect(result.current.status).toBe("ready");
    await tick(1000);
    expect(result.current.status).toBe("forbidden");

    const callsSoFar = readSpy.mock.calls.length;
    await tick(20000);
    expect(readSpy.mock.calls.length).toBe(callsSoFar);
  });

  it("keeps polling when a single 403 is followed by a successful read", async () => {
    vi.useFakeTimers();
    const opened = makeDraft({
      activeAttempt: makeAttempt({ status: "running" }),
    });
    const readSpy = vi
      .fn(async () => opened)
      .mockRejectedValueOnce(
        new SkillAuthoringHttpError(403, "Not permitted.", null),
      )
      .mockResolvedValueOnce(opened)
      .mockRejectedValueOnce(
        new SkillAuthoringHttpError(403, "Not permitted.", null),
      );
    const client = fakeClient({
      open: vi.fn(async () => openResult(opened)),
      read: readSpy,
    });
    const { result } = renderHook(() =>
      useSkillAuthoringDraft(PROJECT_ID, client),
    );
    await tick(0);
    await tick(3000);

    expect(result.current.status).toBe("ready");
    expect(readSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

describe("useSkillAuthoringDraft — send", () => {
  it("flushes pending edits, sends with a fresh clientMessageId, clears the composer, and ignores a concurrent send", async () => {
    const opened = makeDraft({ editRevision: 2 });
    const patchSpy = vi.fn(async (_projectId, _draftId, body) => ({
      ...opened,
      ...body,
    }));
    const sendSpy = vi.fn(
      (
        _projectId: string,
        _draftId: string,
        _body: {
          clientMessageId: string;
          expectedEditRevision: number;
          text: string;
        },
      ) => Promise.resolve({}),
    );
    const readSpy = vi.fn(async () => ({ ...opened, editRevision: 3 }));
    const client = fakeClient({
      open: vi.fn(async () => openResult(opened)),
      patch: patchSpy,
      send: sendSpy,
      read: readSpy,
    });
    const { result } = renderHook(() =>
      useSkillAuthoringDraft(PROJECT_ID, client),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.updateFields({ composerText: "Draft a teaser" }));

    let first: Promise<boolean> = Promise.resolve(false);
    let second: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      first = result.current.send();
      second = result.current.send();
      await Promise.all([first, second]);
    });

    expect(await second).toBe(false);
    expect(await first).toBe(true);
    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [, , sendBody] = sendSpy.mock.calls[0];
    expect(sendBody).toMatchObject({
      text: "Draft a teaser",
      expectedEditRevision: 2,
    });
    expect(
      typeof (sendBody as { clientMessageId: string }).clientMessageId,
    ).toBe("string");
    expect(result.current.draft?.composerText).toBe("");
  });

  it("keeps keystrokes typed while the send was in flight", async () => {
    const opened = makeDraft({ editRevision: 2 });
    let releaseSend: () => void = () => undefined;
    let sendStarted: () => void = () => undefined;
    const inFlight = new Promise<void>((resolvePromise) => {
      releaseSend = resolvePromise;
    });
    const entered = new Promise<void>((resolvePromise) => {
      sendStarted = resolvePromise;
    });
    const client = fakeClient({
      open: vi.fn(async () => openResult(opened)),
      patch: vi.fn(async (_projectId, _draftId, body) => ({
        ...opened,
        ...body,
      })),
      send: vi.fn(async () => {
        sendStarted();
        await inFlight;
        return {};
      }),
      read: vi.fn(async () => ({ ...opened, editRevision: 3 })),
    });
    const { result } = renderHook(() =>
      useSkillAuthoringDraft(PROJECT_ID, client),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.updateFields({ composerText: "Draft a teaser" }));

    let sent: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      sent = result.current.send();
      await entered;
      result.current.updateFields({ composerText: "A second thought" });
      releaseSend();
      await sent;
    });

    expect(await sent).toBe(true);
    expect(result.current.draft?.composerText).toBe("A second thought");
  });

  it("keeps the composer text and clears sending when send fails", async () => {
    const opened = makeDraft({ editRevision: 0 });
    const client = fakeClient({
      open: vi.fn(async () => openResult(opened)),
      send: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    const { result } = renderHook(() =>
      useSkillAuthoringDraft(PROJECT_ID, client),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.updateFields({ composerText: "Do not lose me" }));

    let sent = true;
    await act(async () => {
      sent = await result.current.send();
    });

    expect(sent).toBe(false);
    expect(result.current.sending).toBe(false);
    expect(result.current.draft?.composerText).toBe("Do not lose me");
  });
});

describe("useSkillAuthoringDraft — onSent", () => {
  it("tells the caller once the message is admitted", async () => {
    const opened = makeDraft({ editRevision: 0 });
    const onSent = vi.fn();
    const client = fakeClient({
      open: vi.fn(async () => openResult(opened)),
      patch: vi.fn(async (_projectId, _draftId, body) => ({
        ...opened,
        ...body,
      })),
      send: vi.fn(async () => ({})),
    });
    const { result } = renderHook(() =>
      useSkillAuthoringDraft(PROJECT_ID, client, undefined, onSent),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.updateFields({ composerText: "Teach these lessons" }));
    expect(onSent).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.send();
    });

    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it("does not tell the caller when the send fails", async () => {
    const opened = makeDraft({ editRevision: 0 });
    const onSent = vi.fn();
    const client = fakeClient({
      open: vi.fn(async () => openResult(opened)),
      patch: vi.fn(async (_projectId, _draftId, body) => ({
        ...opened,
        ...body,
      })),
      send: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    const { result } = renderHook(() =>
      useSkillAuthoringDraft(PROJECT_ID, client, undefined, onSent),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.updateFields({ composerText: "Teach these lessons" }));
    await act(async () => {
      await result.current.send();
    });

    expect(onSent).not.toHaveBeenCalled();
  });
});

describe("useSkillAuthoringDraft — retry", () => {
  it("posts a fresh retryRequestId and re-reads the draft", async () => {
    const failedMessage = {
      id: "message-1",
      ordinal: 1,
      text: "Make a brief",
      attempts: [
        makeAttempt({
          status: "failed",
          error: { code: "generation_failed", message: "It broke." },
        }),
      ],
    };
    const opened = makeDraft({ messages: [failedMessage] });
    const retrySpy = vi.fn(
      (
        _projectId: string,
        _draftId: string,
        _messageId: string,
        _body: { retryRequestId: string },
      ) => Promise.resolve({}),
    );
    const refreshed = {
      ...opened,
      activeAttempt: makeAttempt({ status: "running" }),
    };
    const readSpy = vi.fn(async () => refreshed);
    const client = fakeClient({
      open: vi.fn(async () => openResult(opened)),
      retry: retrySpy,
      read: readSpy,
    });
    const { result } = renderHook(() =>
      useSkillAuthoringDraft(PROJECT_ID, client),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.retry("message-1");
    });

    expect(retrySpy).toHaveBeenCalledTimes(1);
    const [, , messageId, retryBody] = retrySpy.mock.calls[0];
    expect(messageId).toBe("message-1");
    expect(
      typeof (retryBody as { retryRequestId: string }).retryRequestId,
    ).toBe("string");
    expect(readSpy).toHaveBeenCalled();
    expect(result.current.draft?.activeAttempt?.status).toBe("running");
  });
});

describe("useSkillAuthoringDraft — unnamed first message", () => {
  it("saves an empty name, stays sendable, and sends a first message", async () => {
    const opened = makeDraft({ editRevision: 0 });
    const patchSpy = vi.fn(async (_projectId, _draftId, body) => ({
      ...opened,
      ...body,
      editRevision: body.expectedEditRevision + 1,
    }));
    const sendSpy = vi.fn(async () => ({}));
    const readSpy = vi.fn(async () => ({ ...opened, editRevision: 1 }));
    const client = fakeClient({
      open: vi.fn(async () => openResult(opened)),
      patch: patchSpy,
      send: sendSpy,
      read: readSpy,
    });
    const { result } = renderHook(() =>
      useSkillAuthoringDraft(PROJECT_ID, client),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() =>
      result.current.updateFields({ composerText: "Draft a teaser skill" }),
    );

    let sent = false;
    await act(async () => {
      sent = await result.current.send();
    });

    expect(sent).toBe(true);
    expect(patchSpy).toHaveBeenCalledWith(PROJECT_ID, opened.id, {
      expectedEditRevision: 0,
      name: "",
      placement: null,
      composerText: "Draft a teaser skill",
    });
    expect(sendSpy).toHaveBeenCalledWith(
      PROJECT_ID,
      opened.id,
      expect.objectContaining({ text: "Draft a teaser skill" }),
    );
    expect(result.current.draft?.composerText).toBe("");
  });
});

describe("useSkillAuthoringDraft — discard", () => {
  it("flushes then discards and returns true", async () => {
    const opened = makeDraft({ editRevision: 4 });
    const patchSpy = vi.fn(async (_projectId, _draftId, body) => ({
      ...opened,
      ...body,
    }));
    const discardSpy = vi.fn(async () => undefined);
    const client = fakeClient({
      open: vi.fn(async () => openResult(opened)),
      patch: patchSpy,
      discard: discardSpy,
    });
    const { result } = renderHook(() =>
      useSkillAuthoringDraft(PROJECT_ID, client),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.updateFields({ name: "Teaser" }));

    let discarded = false;
    await act(async () => {
      discarded = await result.current.discard();
    });

    expect(discarded).toBe(true);
    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(discardSpy).toHaveBeenCalledWith(
      PROJECT_ID,
      opened.id,
      opened.editRevision,
    );
  });
});

describe("useSkillAuthoringDraft — refresh and replaceDraft", () => {
  it("refresh re-reads the draft and reports forbidden on a 403", async () => {
    const opened = makeDraft({ editRevision: 0 });
    const readSpy = vi.fn(async () => {
      throw new SkillAuthoringHttpError(403, "Not permitted.", null);
    });
    const client = fakeClient({
      open: vi.fn(async () => openResult(opened)),
      read: readSpy,
    });
    const { result } = renderHook(() =>
      useSkillAuthoringDraft(PROJECT_ID, client),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.refresh();
    });

    expect(readSpy).toHaveBeenCalledWith(PROJECT_ID, opened.id);
    expect(result.current.status).toBe("forbidden");
  });

  it("replaceDraft makes an already-fetched draft current while preserving unsaved edits", async () => {
    const opened = makeDraft({ editRevision: 0, name: "Original" });
    const client = fakeClient({ open: vi.fn(async () => openResult(opened)) });
    const { result } = renderHook(() =>
      useSkillAuthoringDraft(PROJECT_ID, client),
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.updateFields({ composerText: "unsaved edit" }));
    act(() =>
      result.current.replaceDraft({
        ...opened,
        editRevision: 9,
        name: "From elsewhere",
      }),
    );

    expect(result.current.draft?.editRevision).toBe(9);
    expect(result.current.draft?.composerText).toBe("unsaved edit");
  });
});
