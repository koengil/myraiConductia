import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { processDuePublications, writeSkillPublicationDenialAudit } = vi.hoisted(
  () => ({
    processDuePublications: vi.fn(),
    writeSkillPublicationDenialAudit: vi.fn(),
  }),
);

vi.mock("@/lib/skillPublication/processor", () => ({
  processDuePublications,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseAdminClient: vi.fn(() => ({})),
}));
vi.mock("@/lib/skillPublication/audit", () => ({
  writeSkillPublicationDenialAudit,
  SKILL_PUBLICATION_AUDIT_ACTION: {
    ADMISSION_DENIED: "skill_publication.admission_denied",
  },
}));

import { GET, POST } from "@/app/api/v1/internal/skill-publications/process/route";

const ORIGINAL_ENV = { ...process.env };

function request(body?: string, authorization = "Bearer current-token") {
  return new Request(
    "https://conductia.test/api/v1/internal/skill-publications/process",
    {
      method: "POST",
      headers: { authorization },
      body,
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SKILL_PUBLICATION_PROCESSOR_TOKEN = "current-token";
  process.env.SKILL_PUBLICATION_PROCESSOR_TOKEN_PREVIOUS = "previous-token";
  process.env.CRON_SECRET = "cron-secret";
  writeSkillPublicationDenialAudit.mockResolvedValue(undefined);
  processDuePublications.mockResolvedValue([]);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

it("rejects a missing bearer token with 401 and audits the denial", async () => {
  const response = await POST(request(undefined, ""));
  expect(response.status).toBe(401);
  expect(processDuePublications).not.toHaveBeenCalled();
  expect(writeSkillPublicationDenialAudit).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ service: "conductia" }),
  );
});

it("rejects a wrong bearer token with a uniform 401", async () => {
  const response = await POST(request(undefined, "Bearer wrong-token"));
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "Unauthorized" });
});

it("accepts the current token", async () => {
  const response = await POST(request(undefined, "Bearer current-token"));
  expect(response.status).toBe(200);
});

it("accepts the previous token", async () => {
  const response = await POST(request(undefined, "Bearer previous-token"));
  expect(response.status).toBe(200);
});

it("denies everything when no processor tokens are configured", async () => {
  delete process.env.SKILL_PUBLICATION_PROCESSOR_TOKEN;
  delete process.env.SKILL_PUBLICATION_PROCESSOR_TOKEN_PREVIOUS;
  delete process.env.CRON_SECRET;
  const response = await POST(request(undefined, "Bearer current-token"));
  expect(response.status).toBe(401);
});

it("returns 429 once the failure limiter is exhausted for a source", async () => {
  const failing = () =>
    POST(
      new Request(
        "https://conductia.test/api/v1/internal/skill-publications/process",
        {
          method: "POST",
          headers: {
            authorization: "Bearer wrong-token",
            "x-vercel-forwarded-for": "203.0.113.5",
          },
        },
      ),
    );
  for (let count = 0; count < 10; count += 1) {
    const response = await failing();
    expect(response.status).toBe(401);
  }
  writeSkillPublicationDenialAudit.mockClear();
  const limited = await failing();
  expect(limited.status).toBe(429);
  expect(writeSkillPublicationDenialAudit).not.toHaveBeenCalled();
});

it("rejects a non-empty request body with 422", async () => {
  const response = await POST(request(JSON.stringify({ limit: 25 })));
  expect(response.status).toBe(422);
  expect(processDuePublications).not.toHaveBeenCalled();
});

it("accepts an empty request body", async () => {
  const response = await POST(request(""));
  expect(response.status).toBe(200);
});

it("runs a batch of at most 25 due publications", async () => {
  await POST(request());
  expect(processDuePublications).toHaveBeenCalledWith(25);
});

it("returns counts grouped by resulting state with no ids, names, or content", async () => {
  processDuePublications.mockResolvedValue([
    { publicationId: "a", state: "published", progressed: true },
    { publicationId: "b", state: "published", progressed: true },
    { publicationId: "c", state: "failed", progressed: false },
    { publicationId: "d", state: "preparing", progressed: false },
  ]);
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    counts: { published: 2, failed: 1, preparing: 1 },
  });
});

function cronRequest(authorization = "Bearer cron-secret") {
  return new Request(
    "https://conductia.test/api/v1/internal/skill-publications/process",
    { method: "GET", headers: { authorization } },
  );
}

it("runs the sweep for a Vercel cron GET carrying the cron secret", async () => {
  const response = await GET(cronRequest());
  expect(response.status).toBe(200);
  expect(processDuePublications).toHaveBeenCalledWith(25);
});

it("accepts the cron secret on POST too", async () => {
  const response = await POST(request(undefined, "Bearer cron-secret"));
  expect(response.status).toBe(200);
});

it("rejects a cron GET without a valid bearer token", async () => {
  const response = await GET(cronRequest("Bearer wrong-token"));
  expect(response.status).toBe(401);
  expect(processDuePublications).not.toHaveBeenCalled();
});

it("returns the same state counts on GET as on POST", async () => {
  processDuePublications.mockResolvedValue([
    { publicationId: "a", state: "published", progressed: true },
    { publicationId: "b", state: "failed", progressed: false },
  ]);
  const response = await GET(cronRequest());
  expect(await response.json()).toEqual({
    counts: { published: 1, failed: 1 },
  });
});
