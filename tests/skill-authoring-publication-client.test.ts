import { expect, it, vi } from "vitest";
import {
  createPublicationOperations,
  SkillPublicationClientError,
  type PublicationOperations,
} from "@/lib/skillAuthoring/publicationClient";

function publicationRead(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    id: "99999999-9999-4999-8999-999999999999",
    state: "preparing",
    revision: 1,
    matches: [],
    error: null,
    result: null,
    assessmentDigest: null,
    ...overrides,
  };
}

function response(status: number, body: unknown): Response {
  return {
    ok: status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

function clientWith(status: number, body: unknown) {
  const fetcher = vi.fn(() => Promise.resolve(response(status, body)));
  return { client: createPublicationOperations(fetcher), fetcher };
}

function calls(fetcher: ReturnType<typeof vi.fn>) {
  return fetcher.mock.calls.map(([url, init]) => [
    url,
    (init as RequestInit | undefined)?.method,
    (init as RequestInit | undefined)?.body
      ? JSON.parse(String((init as RequestInit).body))
      : undefined,
  ]);
}

async function invokeAll(client: PublicationOperations) {
  await client.publish("deal-1", "draft-1", {
    requestId: "req-1",
    expectedEditRevision: 4,
    candidateId: "candidate-1",
    candidateDigest: "digest-1",
  });
  await client.decideDuplicate("deal-1", "publication-1", {
    expectedRevision: 2,
    assessmentDigest: "digest-2",
    decision: "confirm",
  });
  await client.replacePlacement("deal-1", "publication-1", {
    expectedRevision: 4,
    placement: { kind: "phase_end", phaseIndex: 1 },
  });
}

function expectedCalls() {
  return [
    [
      "/api/v1/deals/deal-1/skill-drafts/draft-1/publish",
      "POST",
      {
        requestId: "req-1",
        expectedEditRevision: 4,
        candidateId: "candidate-1",
        candidateDigest: "digest-1",
      },
    ],
    [
      "/api/v1/deals/deal-1/skill-publications/publication-1/duplicate-decision",
      "POST",
      {
        expectedRevision: 2,
        assessmentDigest: "digest-2",
        decision: "confirm",
      },
    ],
    [
      "/api/v1/deals/deal-1/skill-publications/publication-1/placement",
      "POST",
      { expectedRevision: 4, placement: { kind: "phase_end", phaseIndex: 1 } },
    ],
  ];
}

it("sends the publish, duplicate-decision, and placement request bodies to their routes", async () => {
  const { client, fetcher } = clientWith(202, publicationRead());

  await invokeAll(client);

  expect(calls(fetcher)).toEqual(expectedCalls());
});

it.each([202, 200])(
  "parses a %s publication read into the safe view",
  async (status) => {
    const view = publicationRead({
      state: status === 200 ? "failed" : "preparing",
    });
    const { client } = clientWith(status, view);

    await expect(
      client.publish("deal-1", "draft-1", {
        requestId: "req-1",
        expectedEditRevision: 1,
        candidateId: "candidate-1",
        candidateDigest: "digest-1",
      }),
    ).resolves.toEqual(view);
  },
);

it("maps a 409 conflict to a typed error carrying the known conflict code", async () => {
  const { client } = clientWith(409, { error: "stale_edit_revision" });

  await expect(
    client.publish("deal-1", "draft-1", {
      requestId: "req-1",
      expectedEditRevision: 1,
      candidateId: "candidate-1",
      candidateDigest: "digest-1",
    }),
  ).rejects.toMatchObject({ kind: "conflict", code: "stale_edit_revision" });
});

it("maps an unrecognised 409 code to the unknown failure class", async () => {
  const { client } = clientWith(409, { error: "not_a_real_code" });

  await expect(
    client.publish("deal-1", "draft-1", {
      requestId: "req-1",
      expectedEditRevision: 1,
      candidateId: "candidate-1",
      candidateDigest: "digest-1",
    }),
  ).rejects.toMatchObject({ kind: "unknown", code: null });
});

it("maps a 422 to a validation error", async () => {
  const { client } = clientWith(422, { error: "Invalid." });

  await expect(
    client.replacePlacement("deal-1", "publication-1", {
      expectedRevision: 1,
      placement: { kind: "phase_start", phaseIndex: 0 },
    }),
  ).rejects.toMatchObject({ kind: "validation" });
});

it("maps a 403 to a forbidden error", async () => {
  const { client } = clientWith(403, { error: "Not permitted." });

  await expect(
    client.decideDuplicate("deal-1", "publication-1", {
      expectedRevision: 1,
      assessmentDigest: "digest-2",
      decision: "decline",
    }),
  ).rejects.toMatchObject({ kind: "forbidden" });
});

it("maps a 404 to a not-found error", async () => {
  const { client } = clientWith(404, { error: "Not found." });

  await expect(
    client.replacePlacement("deal-1", "publication-1", {
      expectedRevision: 1,
      placement: { kind: "phase_start", phaseIndex: 0 },
    }),
  ).rejects.toMatchObject({ kind: "not_found" });
});

it.each([401, 500])(
  "maps a %s response to the unknown failure class",
  async (status) => {
    const { client } = clientWith(status, { error: "Unable." });

    await expect(
      client.publish("deal-1", "draft-1", {
        requestId: "req-1",
        expectedEditRevision: 1,
        candidateId: "candidate-1",
        candidateDigest: "digest-1",
      }),
    ).rejects.toMatchObject({ kind: "unknown" });
  },
);

it("maps a fetch failure to the network failure class", async () => {
  const fetcher = vi.fn(() => Promise.reject(new TypeError("offline")));
  const client = createPublicationOperations(fetcher);

  await expect(
    client.publish("deal-1", "draft-1", {
      requestId: "req-1",
      expectedEditRevision: 1,
      candidateId: "candidate-1",
      candidateDigest: "digest-1",
    }),
  ).rejects.toMatchObject({ kind: "network" });
});

it("rejects a malformed successful publication response", async () => {
  const { client } = clientWith(200, { ...publicationRead(), matches: {} });

  const request = client.publish("deal-1", "draft-1", {
    requestId: "req-1",
    expectedEditRevision: 1,
    candidateId: "candidate-1",
    candidateDigest: "digest-1",
  });

  await expect(request).rejects.toBeInstanceOf(SkillPublicationClientError);
  await expect(request).rejects.toMatchObject({ kind: "unknown" });
});

it("rejects an available:false response as invalid for a publication command", async () => {
  const { client } = clientWith(200, { available: false });

  await expect(
    client.publish("deal-1", "draft-1", {
      requestId: "req-1",
      expectedEditRevision: 1,
      candidateId: "candidate-1",
      candidateDigest: "digest-1",
    }),
  ).rejects.toMatchObject({ kind: "unknown" });
});
