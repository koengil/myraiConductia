import { afterEach, expect, it, vi } from "vitest";
import {
  lookup,
  prepare,
  publish,
} from "@/lib/skillPublication/ignatiousClient";
import { SKILL_PUBLICATION_REQUEST_TIMEOUT_MS } from "@/lib/skillPublication/config";
import {
  OPERATION_ID,
  erroringBodyResponse,
  jsonResponse,
  validPrepareRequest,
  validPreparationReceipt,
  validPublicationReceipt,
  validPublishRequest,
} from "./support/skillPublicationServiceFixtures";

const CORRELATION_ID = "correlation-1";
const BENCH_URL = "http://localhost:4212";
const TOKEN = "pub-token";

const ORIGINAL_ENV = { ...process.env };

function setConfigEnv(overrides: Record<string, string | undefined> = {}) {
  process.env.IGNATIOUS_SKILL_BENCH_URL = BENCH_URL;
  process.env.IGNATIOUS_PUBLICATION_SERVICE_TOKEN = TOKEN;
  process.env.IGNATIOUS_API_KEY = "api-key";
  process.env.IGNATIOUS_AUTHORING_SERVICE_TOKEN = "authoring-token";
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

it("prepare returns unconfigured, without calling fetch, when the service config is missing", async () => {
  setConfigEnv({ IGNATIOUS_SKILL_BENCH_URL: undefined });
  const fetchImpl = vi.fn();

  const result = await prepare(OPERATION_ID, validPrepareRequest(), {
    correlationId: CORRELATION_ID,
    fetchImpl,
  });

  expect(result).toEqual({ outcome: "unconfigured" });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("prepare sends bearer auth, the correlation id, and content-type on POST", async () => {
  setConfigEnv();
  const fetchImpl = vi
    .fn()
    .mockResolvedValue(jsonResponse(200, validPreparationReceipt()));

  await prepare(OPERATION_ID, validPrepareRequest(), {
    correlationId: CORRELATION_ID,
    fetchImpl,
  });

  const [url, init] = fetchImpl.mock.calls[0];
  expect(url).toBe(
    `${BENCH_URL}/v1/conductia/skill-publications/${OPERATION_ID}/prepare`,
  );
  expect(init.method).toBe("POST");
  const headers = new Headers(init.headers);
  expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  expect(headers.get("x-correlation-id")).toBe(CORRELATION_ID);
  expect(headers.get("content-type")).toBe("application/json");
  expect(JSON.parse(init.body)).toEqual(validPrepareRequest());
});

it("prepare encodes the operation id in the URL", async () => {
  setConfigEnv();
  const fetchImpl = vi
    .fn()
    .mockResolvedValue(jsonResponse(200, validPreparationReceipt()));

  await prepare("not/safe id", validPrepareRequest(), {
    correlationId: CORRELATION_ID,
    fetchImpl,
  });

  const [url] = fetchImpl.mock.calls[0];
  expect(url).toBe(
    `${BENCH_URL}/v1/conductia/skill-publications/${encodeURIComponent("not/safe id")}/prepare`,
  );
});

it("prepare aborts the request with the exact signal AbortSignal.timeout returns", async () => {
  setConfigEnv();
  const timeoutSignal = new AbortController().signal;
  const timeoutSpy = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(timeoutSignal);
  const fetchImpl = vi
    .fn()
    .mockResolvedValue(jsonResponse(200, validPreparationReceipt()));

  await prepare(OPERATION_ID, validPrepareRequest(), {
    correlationId: CORRELATION_ID,
    fetchImpl,
  });

  expect(timeoutSpy).toHaveBeenCalledWith(SKILL_PUBLICATION_REQUEST_TIMEOUT_MS);
  const [, init] = fetchImpl.mock.calls[0];
  expect(init.signal).toBe(timeoutSignal);
});

it("prepare returns timeout_or_network when the body stream errors", async () => {
  setConfigEnv();
  const fetchImpl = vi.fn().mockResolvedValue(erroringBodyResponse());

  const result = await prepare(OPERATION_ID, validPrepareRequest(), {
    correlationId: CORRELATION_ID,
    fetchImpl,
  });

  expect(result).toEqual({ outcome: "timeout_or_network" });
});

type OutcomeCase = [string, () => Response, unknown];

const PREPARE_OUTCOME_CASES: OutcomeCase[] = [
  [
    "success with the strictly parsed preparation receipt",
    () => jsonResponse(200, validPreparationReceipt()),
    { outcome: "success", body: validPreparationReceipt() },
  ],
  [
    "invalid_response when the receipt fails strict parsing",
    () => jsonResponse(200, { ...validPreparationReceipt(), matches: "x" }),
    { outcome: "invalid_response" },
  ],
  [
    "invalid_response when the body is not valid JSON",
    () => new Response("not json", { status: 200 }),
    { outcome: "invalid_response" },
  ],
  [
    "an http_error with status and envelope code on 409",
    () => jsonResponse(409, { error: "version_conflict" }),
    { outcome: "http_error", status: 409, code: "version_conflict" },
  ],
  [
    "an http_error with a null code when the error body is not an envelope",
    () => new Response("", { status: 500 }),
    { outcome: "http_error", status: 500, code: null },
  ],
];

it.each(PREPARE_OUTCOME_CASES)(
  "prepare returns %s",
  async (_name, makeResponse, expected) => {
    setConfigEnv();
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse());

    const result = await prepare(OPERATION_ID, validPrepareRequest(), {
      correlationId: CORRELATION_ID,
      fetchImpl,
    });

    expect(result).toEqual(expected);
  },
);

it("prepare returns timeout_or_network, never not_published, when fetch rejects", async () => {
  setConfigEnv();
  const fetchImpl = vi
    .fn()
    .mockRejectedValue(new DOMException("Timeout", "TimeoutError"));

  const result = await prepare(OPERATION_ID, validPrepareRequest(), {
    correlationId: CORRELATION_ID,
    fetchImpl,
  });

  expect(result).toEqual({ outcome: "timeout_or_network" });
});

it("publish posts to the publish endpoint and returns the strictly parsed receipt", async () => {
  setConfigEnv();
  const fetchImpl = vi
    .fn()
    .mockResolvedValue(jsonResponse(200, validPublicationReceipt()));

  const result = await publish(OPERATION_ID, validPublishRequest(), {
    correlationId: CORRELATION_ID,
    fetchImpl,
  });

  const [url, init] = fetchImpl.mock.calls[0];
  expect(url).toBe(
    `${BENCH_URL}/v1/conductia/skill-publications/${OPERATION_ID}/publish`,
  );
  expect(init.method).toBe("POST");
  expect(result).toEqual({
    outcome: "success",
    body: validPublicationReceipt(),
  });
});

it("publish returns invalid_response when a binding field is missing", async () => {
  setConfigEnv();
  const receipt = validPublicationReceipt() as Record<string, unknown>;
  delete receipt.versionId;
  const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, receipt));

  const result = await publish(OPERATION_ID, validPublishRequest(), {
    correlationId: CORRELATION_ID,
    fetchImpl,
  });

  expect(result).toEqual({ outcome: "invalid_response" });
});

it("publish returns unconfigured, without calling fetch, when the service config is missing", async () => {
  setConfigEnv({ IGNATIOUS_SKILL_BENCH_URL: undefined });
  const fetchImpl = vi.fn();

  const result = await publish(OPERATION_ID, validPublishRequest(), {
    correlationId: CORRELATION_ID,
    fetchImpl,
  });

  expect(result).toEqual({ outcome: "unconfigured" });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("publish returns timeout_or_network when fetch rejects", async () => {
  setConfigEnv();
  const fetchImpl = vi
    .fn()
    .mockRejectedValue(new DOMException("Timeout", "TimeoutError"));

  const result = await publish(OPERATION_ID, validPublishRequest(), {
    correlationId: CORRELATION_ID,
    fetchImpl,
  });

  expect(result).toEqual({ outcome: "timeout_or_network" });
});

it("publish returns timeout_or_network, never a receipt, when the body stream errors", async () => {
  setConfigEnv();
  const fetchImpl = vi.fn().mockResolvedValue(erroringBodyResponse());

  const result = await publish(OPERATION_ID, validPublishRequest(), {
    correlationId: CORRELATION_ID,
    fetchImpl,
  });

  expect(result).toEqual({ outcome: "timeout_or_network" });
});

it("lookup issues a GET without a request body", async () => {
  setConfigEnv();
  const fetchImpl = vi
    .fn()
    .mockResolvedValue(jsonResponse(200, { status: "not_published" }));

  const result = await lookup(OPERATION_ID, {
    correlationId: CORRELATION_ID,
    fetchImpl,
  });

  const [url, init] = fetchImpl.mock.calls[0];
  expect(url).toBe(
    `${BENCH_URL}/v1/conductia/skill-publications/${OPERATION_ID}`,
  );
  expect(init.method).toBe("GET");
  expect(init.body).toBeUndefined();
  expect(result).toEqual({
    outcome: "success",
    body: { status: "not_published" },
  });
});

it("lookup returns the published status with the strictly parsed publication", async () => {
  setConfigEnv();
  const fetchImpl = vi.fn().mockResolvedValue(
    jsonResponse(200, {
      status: "published",
      publication: validPublicationReceipt(),
    }),
  );

  const result = await lookup(OPERATION_ID, {
    correlationId: CORRELATION_ID,
    fetchImpl,
  });

  expect(result).toEqual({
    outcome: "success",
    body: { status: "published", publication: validPublicationReceipt() },
  });
});

it("lookup returns a 404 http_error with the not_found code", async () => {
  setConfigEnv();
  const fetchImpl = vi
    .fn()
    .mockResolvedValue(jsonResponse(404, { error: "not_found" }));

  const result = await lookup(OPERATION_ID, {
    correlationId: CORRELATION_ID,
    fetchImpl,
  });

  expect(result).toEqual({
    outcome: "http_error",
    status: 404,
    code: "not_found",
  });
});
