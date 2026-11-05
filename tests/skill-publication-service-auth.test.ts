import { timingSafeEqual } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createSkillPublicationServiceAuth } from "@/lib/skillPublication/serviceAuth";

function authWith(
  overrides: Parameters<typeof createSkillPublicationServiceAuth>[0] = {},
) {
  return createSkillPublicationServiceAuth({
    limiter: new Map(),
    now: () => 0,
    writeDenialAudit: async () => undefined,
    tokens: () => ["current-token", "previous-token"],
    ...overrides,
  });
}

function request(token: string, headers: Record<string, string> = {}) {
  return new Request("https://conductia.test/internal", {
    headers: { authorization: `Bearer ${token}`, ...headers },
  });
}

it.each(["current-token", "previous-token"])(
  "compares the presented digest against every configured token before accepting %s",
  async (token) => {
    const compare = vi.fn(timingSafeEqual);
    const auth = authWith({ compare });
    await expect(auth(request(token))).resolves.toEqual({ ok: true });
    expect(compare).toHaveBeenCalledTimes(2);
  },
);

it("compares against every configured token when none match", async () => {
  const compare = vi.fn(timingSafeEqual);
  const auth = authWith({ compare });
  await auth(request("wrong-token"));
  expect(compare).toHaveBeenCalledTimes(2);
});

it("denies a bearer header with no token without invoking the token comparison", async () => {
  const compare = vi.fn(timingSafeEqual);
  const auth = authWith({ compare });

  const request = new Request("https://conductia.test/internal", {
    headers: { authorization: "Bearer " },
  });
  expect(request.headers.get("authorization")).toBe("Bearer");

  const result = await auth(request);

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.response.status).toBe(401);
    await expect(result.response.json()).resolves.toEqual({
      error: "Unauthorized",
    });
  }
  expect(compare).not.toHaveBeenCalled();
});

it("reserves the failure before writing the denial audit, then returns 429 once exhausted", async () => {
  const limiter = new Map();
  const writeDenialAudit = vi.fn().mockResolvedValue(undefined);
  const auth = authWith({ limiter, writeDenialAudit });
  const attempt = () =>
    auth(
      new Request("https://conductia.test/internal", {
        headers: {
          authorization: "Bearer wrong-token",
          "x-vercel-forwarded-for": "203.0.113.9",
        },
      }),
    );

  for (let count = 0; count < 10; count += 1) {
    const denied = await attempt();
    expect(denied.ok).toBe(false);
  }
  writeDenialAudit.mockClear();

  const limited = await attempt();

  expect(limited.ok).toBe(false);
  if (!limited.ok) {
    expect(limited.response.status).toBe(429);
    await expect(limited.response.json()).resolves.toEqual({
      error: "Too many authentication failures.",
    });
  }
  expect(writeDenialAudit).not.toHaveBeenCalled();
});

it("returns the uniform 401 and logs a safe fixed code when the denial audit write fails", async () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const auth = authWith({
    writeDenialAudit: vi.fn().mockRejectedValue(new Error("db down")),
  });

  const result = await auth(request("wrong-token"));

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.response.status).toBe(401);
    await expect(result.response.json()).resolves.toEqual({
      error: "Unauthorized",
    });
  }
  expect(spy).toHaveBeenCalledTimes(1);
  const [logName, logPayload] = spy.mock.calls[0] as [string, unknown];
  expect(logName).toBe("[skill_publication_audit]");
  expect(Object.keys(logPayload as object).sort()).toEqual(
    ["code", "correlationId"].sort(),
  );
  expect((logPayload as { code: string }).code).toBe(
    "SKILL_PUBLICATION_DENIAL_AUDIT_FAILED",
  );
  spy.mockRestore();
});
