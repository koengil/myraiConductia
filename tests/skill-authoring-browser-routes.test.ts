import { NextResponse } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";

const {
  requireFlag,
  requireApiUser,
  requireSkillAuthoringAccess,
  rpc,
  after,
  runAuthoringTurn,
  defaultTurnDeps,
} = vi.hoisted(() => ({
  requireFlag: vi.fn(),
  requireApiUser: vi.fn(),
  requireSkillAuthoringAccess: vi.fn(),
  rpc: vi.fn(),
  after: vi.fn(),
  runAuthoringTurn: vi.fn(),
  defaultTurnDeps: vi.fn(),
}));
vi.mock("@/lib/api/v1/requireFlag", () => ({ requireFlag }));
vi.mock("@/lib/api/v1/http", async (original) => ({
  ...(await original<typeof import("@/lib/api/v1/http")>()),
  requireApiUser,
}));
vi.mock("@/lib/skillAuthoring/access", () => ({ requireSkillAuthoringAccess }));
vi.mock("@/lib/skillAuthoring/runTurn", () => ({
  runAuthoringTurn,
  defaultTurnDeps,
}));
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after,
}));

import { normalizeCandidate } from "@/lib/skillAuthoring/browserRoute";
import { POST as createDraft } from "@/app/api/v1/deals/[dealId]/skill-drafts/route";
import {
  GET as restoreDraft,
  PATCH as patchDraft,
} from "@/app/api/v1/deals/[dealId]/skill-drafts/[draftId]/route";
import { POST as submitMessage } from "@/app/api/v1/deals/[dealId]/skill-drafts/[draftId]/messages/route";
import { POST as retryMessage } from "@/app/api/v1/deals/[dealId]/skill-drafts/[draftId]/messages/[messageId]/retry/route";
import { POST as discardDraft } from "@/app/api/v1/deals/[dealId]/skill-drafts/[draftId]/discard/route";

const actorId = "11111111-1111-4111-8111-111111111111";
const dealId = "22222222-2222-4222-8222-222222222222";
const draftId = "33333333-3333-4333-8333-333333333333";
const messageId = "44444444-4444-4444-8444-444444444444";
const attemptId = "66666666-6666-4666-8666-666666666666";
const requestId = "55555555-5555-4555-8555-555555555555";

const context = <T extends Record<string, string>>(params: T) => ({
  params: Promise.resolve(params),
});

function draftFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: draftId,
    deal_id: dealId,
    status: "active",
    name: "Weekly update",
    phase_index: null,
    placement_kind: null,
    anchor_deal_step_id: null,
    composer_text: "",
    edit_revision: 3,
    messages: [],
    active_attempt: null,
    candidate: null,
    publication: { available: false },
    ...overrides,
  };
}

function attemptFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: attemptId,
    message_id: messageId,
    attempt_number: 1,
    retry_request_id: null,
    status: "running",
    response_text: "",
    error_code: null,
    error_message: null,
    ...overrides,
  };
}

function sendReceipt(created: boolean) {
  return {
    draft: draftFixture(),
    message: { id: messageId, ordinal: 1, text: "Draft the update." },
    attempt: attemptFixture(),
    created,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireFlag.mockResolvedValue(null);
  requireApiUser.mockResolvedValue({
    ok: true,
    user: { id: actorId, email: "author@example.com" },
    admin: { rpc },
  });
  requireSkillAuthoringAccess.mockResolvedValue({
    ok: true,
    deal: { id: dealId, bankId: "bank-1" },
    userId: actorId,
  });
  defaultTurnDeps.mockReturnValue({});
});

function sendRequest() {
  return new Request(
    `https://conductia.test/api/v1/deals/${dealId}/skill-drafts/${draftId}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientMessageId: messageId,
        expectedEditRevision: 3,
        text: "Draft the update.",
      }),
    },
  );
}

function retryRequest() {
  return new Request(
    `https://conductia.test/api/v1/deals/${dealId}/skill-drafts/${draftId}/messages/${messageId}/retry`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ retryRequestId: requestId }),
    },
  );
}

const flaggedRoutes = [
  [
    "create",
    createDraft,
    () =>
      new Request(
        `https://conductia.test/api/v1/deals/${dealId}/skill-drafts`,
        { method: "POST" },
      ),
    context({ dealId }),
  ] as const,
  [
    "restore",
    restoreDraft,
    () =>
      new Request(
        `https://conductia.test/api/v1/deals/${dealId}/skill-drafts/${draftId}`,
      ),
    context({ dealId, draftId }),
  ] as const,
  ["send", submitMessage, sendRequest, context({ dealId, draftId })] as const,
  [
    "retry",
    retryMessage,
    retryRequest,
    context({ dealId, draftId, messageId }),
  ] as const,
  [
    "discard",
    discardDraft,
    () =>
      new Request(
        `https://conductia.test/api/v1/deals/${dealId}/skill-drafts/${draftId}/discard`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedEditRevision: 3 }),
        },
      ),
    context({ dealId, draftId }),
  ] as const,
];

it.each(flaggedRoutes)(
  "returns the flag response for %s when the flag is off",
  async (_name, handler, makeRequest, routeContext) => {
    requireFlag.mockResolvedValue(
      NextResponse.json({ error: "Not found" }, { status: 404 }),
    );
    const response = await handler(makeRequest(), routeContext as never);
    expect(response.status).toBe(404);
    expect(requireApiUser).not.toHaveBeenCalled();
  },
);

it.each(flaggedRoutes)(
  "returns 403 for %s when access is denied",
  async (_name, handler, makeRequest, routeContext) => {
    requireSkillAuthoringAccess.mockResolvedValue({
      ok: false,
      status: 403,
      message: "Not permitted.",
    });
    const response = await handler(makeRequest(), routeContext as never);
    expect(response.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  },
);

it("returns 400 for an invalid send body", async () => {
  const request = new Request(
    `https://conductia.test/api/v1/deals/${dealId}/skill-drafts/${draftId}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  const response = await submitMessage(
    request,
    context({ dealId, draftId }) as never,
  );
  expect(response.status).toBe(400);
  expect(rpc).not.toHaveBeenCalled();
});

it("returns 400 for an invalid retry body", async () => {
  const request = new Request(
    `https://conductia.test/api/v1/deals/${dealId}/skill-drafts/${draftId}/messages/${messageId}/retry`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  const response = await retryMessage(
    request,
    context({ dealId, draftId, messageId }) as never,
  );
  expect(response.status).toBe(400);
  expect(rpc).not.toHaveBeenCalled();
});

it("returns the receipt and schedules the turn for a newly created send", async () => {
  rpc.mockResolvedValue({ data: sendReceipt(true), error: null });
  const response = await submitMessage(
    sendRequest(),
    context({ dealId, draftId }) as never,
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.created).toBe(true);
  expect(body.attemptId).toBe(attemptId);
  expect(after).toHaveBeenCalledTimes(1);
  await after.mock.calls[0][0]();
  expect(runAuthoringTurn).toHaveBeenCalledWith(attemptId, expect.anything());
});

it("does not schedule a turn for a replayed send", async () => {
  rpc.mockResolvedValue({ data: sendReceipt(false), error: null });
  const response = await submitMessage(
    sendRequest(),
    context({ dealId, draftId }) as never,
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.created).toBe(false);
  expect(after).not.toHaveBeenCalled();
});

it("returns the receipt and schedules the turn for a newly created retry", async () => {
  rpc.mockResolvedValue({ data: sendReceipt(true), error: null });
  const response = await retryMessage(
    retryRequest(),
    context({ dealId, draftId, messageId }) as never,
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.created).toBe(true);
  expect(after).toHaveBeenCalledTimes(1);
  await after.mock.calls[0][0]();
  expect(runAuthoringTurn).toHaveBeenCalledWith(attemptId, expect.anything());
});

it("does not schedule a turn for a replayed retry", async () => {
  rpc.mockResolvedValue({ data: sendReceipt(false), error: null });
  const response = await retryMessage(
    retryRequest(),
    context({ dealId, draftId, messageId }) as never,
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.created).toBe(false);
  expect(after).not.toHaveBeenCalled();
});

it("returns the normalized draft with responseText for GET", async () => {
  rpc.mockResolvedValue({
    data: {
      draft: draftFixture({
        messages: [
          {
            id: messageId,
            ordinal: 1,
            text: "Draft the update.",
            attempts: [
              attemptFixture({
                status: "succeeded",
                response_text: "Here it is.",
              }),
            ],
          },
        ],
        active_attempt: null,
      }),
    },
    error: null,
  });
  const response = await restoreDraft(
    new Request(
      `https://conductia.test/api/v1/deals/${dealId}/skill-drafts/${draftId}`,
    ),
    context({ dealId, draftId }) as never,
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.draft.messages[0].attempts[0].responseText).toBe("Here it is.");
});

it("returns 404 without calling the database for a non-uuid draftId", async () => {
  const response = await restoreDraft(
    new Request(
      `https://conductia.test/api/v1/deals/${dealId}/skill-drafts/not-a-uuid`,
    ),
    context({ dealId, draftId: "not-a-uuid" }) as never,
  );
  expect(response.status).toBe(404);
  expect(rpc).not.toHaveBeenCalled();
});

it("returns 404 without calling the database for a non-uuid messageId", async () => {
  const response = await retryMessage(
    new Request(
      `https://conductia.test/api/v1/deals/${dealId}/skill-drafts/${draftId}/messages/not-a-uuid/retry`,
      {
        method: "POST",
        body: JSON.stringify({ retryRequestId: requestId }),
      },
    ),
    context({ dealId, draftId, messageId: "not-a-uuid" }) as never,
  );
  expect(response.status).toBe(404);
  expect(rpc).not.toHaveBeenCalled();
});

it("returns 409 with the server draft for a stale PATCH", async () => {
  rpc.mockResolvedValue({
    data: null,
    error: {
      code: "40001",
      message: "skill_authoring_conflict",
      details: JSON.stringify({
        draft: draftFixture({ edit_revision: 4 }),
        active_attempt: null,
      }),
    },
  });
  const request = new Request(
    `https://conductia.test/api/v1/deals/${dealId}/skill-drafts/${draftId}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedEditRevision: 3,
        name: "Weekly update",
        placement: null,
        composerText: "",
      }),
    },
  );
  const response = await patchDraft(
    request,
    context({ dealId, draftId }) as never,
  );
  expect(response.status).toBe(409);
  const body = await response.json();
  expect(body.draft.editRevision).toBe(4);
});

it("returns 200 for discard", async () => {
  rpc.mockResolvedValue({
    data: { draft: draftFixture({ status: "archived" }) },
    error: null,
  });
  const request = new Request(
    `https://conductia.test/api/v1/deals/${dealId}/skill-drafts/${draftId}/discard`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedEditRevision: 3 }),
    },
  );
  const response = await discardDraft(
    request,
    context({ dealId, draftId }) as never,
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.draft.status).toBe("archived");
});

it("carries declared input fields onto a normalized candidate preview", () => {
  const candidate = normalizeCandidate({
    id: "cand-1",
    content_digest: "a".repeat(64),
    schema_version: 1,
    preview: {
      name: "buyer-outreach-tracker",
      purpose: "Track buyer outreach",
      expected_input: "Buyer list",
      expected_output: "Outreach table",
      inputs: [{ name: "asOf", type: "date" }],
    },
  });
  expect(candidate?.inputs[0]).toMatchObject({ name: "asOf", type: "date" });
});

it("normalizes a candidate preview without declared inputs to an empty list", () => {
  const candidate = normalizeCandidate({
    id: "cand-1",
    content_digest: "a".repeat(64),
    schema_version: 1,
    preview: {
      name: "buyer-outreach-tracker",
      purpose: "Track buyer outreach",
      expected_input: "Buyer list",
      expected_output: "Outreach table",
    },
  });
  expect(candidate?.inputs).toEqual([]);
});
