import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  importTemplateSkills,
  retainTemplateSkills,
} from "@/lib/railTemplates/providerClient";
import { TEMPLATE_ERROR_MESSAGE } from "@/lib/railTemplates/types";
import type {
  ImportReceipt,
  ImportRequest,
  RetainReceipt,
  RetainRequest,
} from "@/lib/railTemplates/types";

const BENCH_URL = "http://localhost:4212";
const TOKEN = "pub-token";
const ORIGINAL_ENV = { ...process.env };

type Fixture = { name: string; schema: string; value: unknown };

// Byte-identical copy of the provider's contract/fixtures.json; both suites must parse the same bytes.
const fixtures = JSON.parse(
  readFileSync("tests/fixtures/rail-template-provider.json", "utf8"),
) as { valid: Fixture[]; invalid: Fixture[] };

function only(pool: Fixture[], schema: string): Fixture[] {
  return pool.filter((entry) => entry.schema === schema);
}

function firstValid<T>(schema: string): T {
  return only(fixtures.valid, schema)[0].value as T;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) =>
    handler(url, init),
  );
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
}

beforeEach(() => {
  process.env.IGNATIOUS_SKILL_BENCH_URL = BENCH_URL;
  process.env.IGNATIOUS_PUBLICATION_SERVICE_TOKEN = TOKEN;
  process.env.IGNATIOUS_API_KEY = "api-key";
  process.env.IGNATIOUS_AUTHORING_SERVICE_TOKEN = "authoring-token";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("rail template provider client", () => {
  it("posts a retain request to the revision path with the publication token", async () => {
    const request = firstValid<RetainRequest>("RetainRequest");
    const receipt = firstValid<RetainReceipt>("RetainReceipt");
    const fetchImpl = stubFetch(() => jsonResponse(receipt));

    expect(await retainTemplateSkills(receipt.revisionId, request)).toEqual(
      receipt,
    );
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      `${BENCH_URL}/v1/conductia/rail-templates/revisions/${receipt.revisionId}/retain`,
    );
    expect(JSON.parse(init.body as string)).toEqual(request);
    expect(
      (init.headers as Record<string, string>).Authorization,
    ).toBe(`Bearer ${TOKEN}`);
  });

  it("accepts every valid retain receipt the provider pins", async () => {
    const cases = only(fixtures.valid, "RetainReceipt");
    expect(cases.length).toBeGreaterThan(0);
    for (const fixture of cases) {
      const receipt = fixture.value as RetainReceipt;
      stubFetch(() => jsonResponse(receipt));
      expect(
        await retainTemplateSkills(receipt.revisionId, {
          companyId: firstValid<RetainRequest>("RetainRequest").companyId,
          sourceProjectId:
            firstValid<RetainRequest>("RetainRequest").sourceProjectId,
          skills: [],
        }),
      ).toEqual(receipt);
    }
  });

  it("posts an import request to the request path", async () => {
    const request = firstValid<ImportRequest>("ImportRequest");
    const receipt = firstValid<ImportReceipt>("ImportReceipt");
    const fetchImpl = stubFetch(() => jsonResponse(receipt));

    expect(await importTemplateSkills(receipt.requestId, request)).toEqual(
      receipt,
    );
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `${BENCH_URL}/v1/conductia/rail-templates/imports/${receipt.requestId}`,
    );
  });

  it("refuses every request shape the provider pins as invalid", async () => {
    const retainCases = only(fixtures.invalid, "RetainRequest");
    const importCases = only(fixtures.invalid, "ImportRequest");
    expect(retainCases.length).toBeGreaterThan(0);
    expect(importCases.length).toBeGreaterThan(0);
    for (const fixture of retainCases) {
      const fetchImpl = stubFetch(() => jsonResponse({}));
      await expect(
        retainTemplateSkills(
          firstValid<RetainReceipt>("RetainReceipt").revisionId,
          fixture.value as RetainRequest,
        ),
      ).rejects.toMatchObject({ code: "invalid_command" });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
    for (const fixture of importCases) {
      const fetchImpl = stubFetch(() => jsonResponse({}));
      await expect(
        importTemplateSkills(
          firstValid<ImportReceipt>("ImportReceipt").requestId,
          fixture.value as ImportRequest,
        ),
      ).rejects.toMatchObject({ code: "invalid_command" });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("refuses every receipt shape the provider pins as invalid", async () => {
    const request = firstValid<ImportRequest>("ImportRequest");
    const cases = only(fixtures.invalid, "ImportReceipt");
    expect(cases.length).toBeGreaterThan(0);
    for (const fixture of cases) {
      stubFetch(() => jsonResponse(fixture.value));
      await expect(
        importTemplateSkills(
          (fixture.value as ImportReceipt).requestId,
          request,
        ),
      ).rejects.toMatchObject({ code: "provider_unavailable", status: 502 });
    }
  });

  it("refuses a retain receipt that names another revision", async () => {
    const request = firstValid<RetainRequest>("RetainRequest");
    const receipt = firstValid<RetainReceipt>("RetainReceipt");
    stubFetch(() => jsonResponse(receipt));

    await expect(
      retainTemplateSkills(
        "12345678-1234-4123-8123-123456789012",
        request,
      ),
    ).rejects.toMatchObject({ code: "provider_unavailable", status: 502 });
  });

  it("refuses a retain receipt whose assets repeat a key", async () => {
    const request = firstValid<RetainRequest>("RetainRequest");
    const receipt = firstValid<RetainReceipt>("RetainReceipt");
    stubFetch(() =>
      jsonResponse({
        ...receipt,
        assets: [receipt.assets[0], receipt.assets[0]],
      }),
    );

    await expect(
      retainTemplateSkills(receipt.revisionId, request),
    ).rejects.toMatchObject({ code: "provider_unavailable", status: 502 });
  });

  it("keeps the provider's code but answers in Conductia's own words", async () => {
    const request = firstValid<RetainRequest>("RetainRequest");
    const receipt = firstValid<RetainReceipt>("RetainReceipt");
    stubFetch(() =>
      jsonResponse(
        {
          error: "no published version matches that skill, version and digest",
          code: "skill_unavailable",
          retryable: false,
        },
        409,
      ),
    );

    await expect(
      retainTemplateSkills(receipt.revisionId, request),
    ).rejects.toMatchObject({
      code: "skill_unavailable",
      status: 409,
      message: TEMPLATE_ERROR_MESSAGE.skill_unavailable,
    });
  });

  it("tolerates the shared auth guard's nested error envelope", async () => {
    const request = firstValid<RetainRequest>("RetainRequest");
    const receipt = firstValid<RetainReceipt>("RetainReceipt");
    stubFetch(() =>
      jsonResponse(
        { apiError: { message: "unauthorized", status: 401 } },
        401,
      ),
    );

    await expect(
      retainTemplateSkills(receipt.revisionId, request),
    ).rejects.toMatchObject({
      code: "provider_unavailable",
      status: 503,
      retryable: true,
    });
  });

  it("reports a lost connection as retryable without a receipt", async () => {
    const request = firstValid<RetainRequest>("RetainRequest");
    const receipt = firstValid<RetainReceipt>("RetainReceipt");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    );

    await expect(
      retainTemplateSkills(receipt.revisionId, request),
    ).rejects.toMatchObject({
      code: "provider_unavailable",
      status: 503,
      retryable: true,
    });
  });

  it("reports an unconfigured service without calling it", async () => {
    delete process.env.IGNATIOUS_SKILL_BENCH_URL;
    const fetchImpl = stubFetch(() => jsonResponse({}));
    const request = firstValid<RetainRequest>("RetainRequest");
    const receipt = firstValid<RetainReceipt>("RetainReceipt");

    await expect(
      retainTemplateSkills(receipt.revisionId, request),
    ).rejects.toMatchObject({ code: "provider_unavailable", status: 503 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts every valid retain request the provider pins, with or without a source project", async () => {
    const cases = only(fixtures.valid, "RetainRequest");
    expect(cases).toHaveLength(4);
    const revisionId = firstValid<RetainReceipt>("RetainReceipt").revisionId;
    for (const fixture of cases) {
      const request = fixture.value as RetainRequest;
      const fetchImpl = stubFetch(() =>
        jsonResponse({
          revisionId,
          assets: request.skills.map((skill) => ({
            key: skill.key,
            packageDigest: skill.source.digest,
          })),
        }),
      );

      await retainTemplateSkills(revisionId, request);

      expect(JSON.parse(fetchImpl.mock.calls[0][1].body as string)).toEqual(
        request,
      );
    }
  });

  it("sends a candidate source with no source project", async () => {
    const request = fixtures.valid.find(
      (entry) =>
        entry.name === "retain a builder candidate with no source project",
    )?.value as RetainRequest;
    const revisionId = firstValid<RetainReceipt>("RetainReceipt").revisionId;
    const fetchImpl = stubFetch(() =>
      jsonResponse({
        revisionId,
        assets: [{ key: "s0", packageDigest: request.skills[0].source.digest }],
      }),
    );

    await retainTemplateSkills(revisionId, request);

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string) as {
      skills: Array<{ source: { kind: string } }>;
    };
    expect(body).not.toHaveProperty("sourceProjectId");
    expect(body.skills[0].source.kind).toBe("candidate");
  });

  it("refuses a retain request whose source project is present but undefined", async () => {
    const request = {
      ...firstValid<RetainRequest>("RetainRequest"),
      sourceProjectId: undefined,
    };
    const fetchImpl = stubFetch(() => jsonResponse({}));

    await expect(
      retainTemplateSkills(
        firstValid<RetainReceipt>("RetainReceipt").revisionId,
        request,
      ),
    ).rejects.toMatchObject({ code: "invalid_command" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("imports one of a revision's assets", async () => {
    const request = fixtures.valid.find(
      (entry) => entry.name === "import one of two retained assets",
    )?.value as ImportRequest;
    const requestId = firstValid<ImportReceipt>("ImportReceipt").requestId;
    const target = request.targets[0];
    stubFetch(() =>
      jsonResponse({
        requestId,
        projectId: request.projectId,
        skills: [
          {
            key: target.key,
            binding: {
              skillId: target.skillId,
              versionId: target.versionId,
              digest: "1b4f0e9851971998e732078544c96b36c3d01cedf7caa332359d6f1d83567014",
            },
          },
        ],
      }),
    );

    const receipt = await importTemplateSkills(requestId, request);

    expect(receipt.skills.map((skill) => skill.key)).toEqual(["s1"]);
  });
});
