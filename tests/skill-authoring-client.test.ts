import { afterEach, expect, it, vi } from "vitest";
import {
  createSkillAuthoringClient,
  SkillAuthoringHttpError,
} from "@/lib/skillAuthoring/client";
import type { DraftRead } from "@/lib/skillAuthoring/types";

const draft: DraftRead = {
  id: "draft-1",
  dealId: "deal-1",
  status: "active",
  name: "",
  placement: null,
  composerText: "",
  editRevision: 2,
  messages: [],
  activeAttempt: null,
  candidate: null,
  publication: { available: false },
};

function response(status: number, body: unknown): Response {
  return {
    ok: status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function clientWith(body: unknown, status = 200) {
  const fetcher = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(response(status, body)),
  );
  return { client: createSkillAuthoringClient(fetcher), fetcher };
}

async function invokeAll(
  client: ReturnType<typeof createSkillAuthoringClient>,
) {
  await client.open("deal-1");
  await client.read("deal-1", "draft-1");
  await client.patch("deal-1", "draft-1", {
    expectedEditRevision: 2,
    name: "",
    placement: null,
    composerText: "",
  });
  await client.send("deal-1", "draft-1", {
    text: "Make a brief.",
    clientMessageId: "message-1",
    expectedEditRevision: 2,
  });
  await client.retry("deal-1", "draft-1", "message-1", {
    retryRequestId: "retry-1",
  });
  await client.discard("deal-1", "draft-1", 2);
}

afterEach(() => vi.restoreAllMocks());

it("uses only same-origin versioned Conductia routes", async () => {
  const { client, fetcher } = clientWith({ draft });

  await invokeAll(client);

  for (const [url] of fetcher.mock.calls) {
    expect(String(url)).toMatch(/^\/api\/v1\/deals\//);
    expect(String(url)).not.toContain("ignatious");
  }
});

it("maps routes and mutating commands to their durable endpoints", async () => {
  const { client, fetcher } = clientWith({ draft });

  await invokeAll(client);

  expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
    ["/api/v1/deals/deal-1/skill-drafts", "POST"],
    ["/api/v1/deals/deal-1/skill-drafts/draft-1", "GET"],
    ["/api/v1/deals/deal-1/skill-drafts/draft-1", "PATCH"],
    ["/api/v1/deals/deal-1/skill-drafts/draft-1/messages", "POST"],
    [
      "/api/v1/deals/deal-1/skill-drafts/draft-1/messages/message-1/retry",
      "POST",
    ],
    ["/api/v1/deals/deal-1/skill-drafts/draft-1/discard", "POST"],
  ]);
});

it("sends the body it was given verbatim", async () => {
  const { client, fetcher } = clientWith({ draft });

  await client.patch("deal-1", "draft-1", {
    expectedEditRevision: 5,
    name: "Teaser",
    placement: { kind: "phase_start", phaseIndex: 1 },
    composerText: "hello",
  });

  const [, init] = fetcher.mock.calls[0];
  expect(JSON.parse(String(init?.body))).toEqual({
    expectedEditRevision: 5,
    name: "Teaser",
    placement: { kind: "phase_start", phaseIndex: 1 },
    composerText: "hello",
  });
});

it("returns the draft from a mutation receipt without validating its shape", async () => {
  const { client } = clientWith({ draft });

  await expect(
    client.patch("deal-1", "draft-1", {
      expectedEditRevision: 2,
      name: "",
      placement: null,
      composerText: "",
    }),
  ).resolves.toEqual(draft);
});

it("returns the send and retry response bodies unvalidated", async () => {
  const receipt = { draft, message: { id: "m1" }, created: true };
  const { client } = clientWith(receipt);

  await expect(
    client.send("deal-1", "draft-1", {
      text: "hi",
      clientMessageId: "message-1",
      expectedEditRevision: 2,
    }),
  ).resolves.toEqual(receipt);
});

it("throws a SkillAuthoringHttpError with the response status on failure", async () => {
  const { client } = clientWith({ error: "Draft not found." }, 404);

  await expect(client.read("deal-1", "draft-1")).rejects.toMatchObject({
    status: 404,
    message: "Draft not found.",
    draft: null,
  } satisfies Partial<SkillAuthoringHttpError>);
});

it("surfaces the conflict draft from a stale mutation", async () => {
  const saved = { ...draft, editRevision: 3, composerText: "Saved elsewhere" };
  const { client } = clientWith(
    { error: "Draft changed. Reload and retry.", draft: saved },
    409,
  );

  await expect(
    client.patch("deal-1", "draft-1", {
      expectedEditRevision: 2,
      name: "",
      placement: null,
      composerText: "Mine",
    }),
  ).rejects.toMatchObject({
    status: 409,
    draft: saved,
  } satisfies Partial<SkillAuthoringHttpError>);
});

it("throws a 500 when a draft-returning response has no draft", async () => {
  const { client } = clientWith({ notADraft: true });

  await expect(client.read("deal-1", "draft-1")).rejects.toMatchObject({
    status: 500,
  } satisfies Partial<SkillAuthoringHttpError>);
});

it("posts the basis step and the seed run when opening an enhancement draft", async () => {
  const { client, fetcher } = clientWith({ draft });

  await client.open("deal-1", { basisStepId: "p2-s36", seedRunId: "run-1" });

  const [url, init] = fetcher.mock.calls[0];
  expect(String(url)).toBe("/api/v1/deals/deal-1/skill-drafts");
  expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual({
    basisStepId: "p2-s36",
    seedRunId: "run-1",
  });
});

it("posts teach when opening a teaching draft", async () => {
  const { client, fetcher } = clientWith({ draft });

  await client.open("deal-1", { basisStepId: "p2-s36", seedRunId: "run-1", teach: true });

  const [, init] = fetcher.mock.calls[0];
  expect(JSON.parse(String(init?.body))).toEqual({
    basisStepId: "p2-s36",
    seedRunId: "run-1",
    teach: true,
  });
});

it("returns the basis and seed run the open receipt echoes", async () => {
  const basis = {
    kind: "publication" as const,
    skillId: "11111111-1111-4111-8111-111111111111",
    versionId: "22222222-2222-4222-8222-222222222222",
    digest: "b".repeat(64),
  };
  const { client } = clientWith({ draft, basis, seedRunId: "run-9" });

  await expect(client.open("deal-1", { basisStepId: "p2-s36" })).resolves.toEqual({
    draft,
    basis,
    seedRunId: "run-9",
  });
});
