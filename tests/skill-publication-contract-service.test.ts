import { describe, expect, it } from "vitest";
import {
  parsePreparationResponse,
  parsePublicationLookup,
  parsePublicationReceipt,
} from "@/lib/skillPublication/parseService";

const DIGEST =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const PREPARATION_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_ID = "33333333-3333-4333-8333-333333333333";
const SKILL_ID = "44444444-4444-4444-8444-444444444444";
const VERSION_ID = "55555555-5555-4555-8555-555555555555";
const PROJECT_ID = "66666666-6666-4666-8666-666666666666";

function omit<T extends Record<string, unknown>>(
  obj: T,
  key: keyof T,
): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...obj };
  delete rest[key as string];
  return rest;
}

function validCapabilityContract() {
  return {
    purpose: "Summarize deal status.",
    expectedInput: "A reporting period.",
    expectedOutput: "A concise update.",
  };
}

function validMatch() {
  return {
    targetId: TARGET_ID,
    classification: "similar" as const,
    reasonCode: "capability_similar" as const,
    confidence: 0.5,
  };
}

function validPreparationReceipt() {
  return {
    operationId: OPERATION_ID,
    preparationId: PREPARATION_ID,
    candidateDigest: DIGEST,
    capabilityContract: validCapabilityContract(),
    comparisonSetDigest: DIGEST,
    assessmentDigest: DIGEST,
    matches: [validMatch()],
  };
}

function validPublicationReceipt() {
  return {
    operationId: OPERATION_ID,
    skillId: SKILL_ID,
    versionId: VERSION_ID,
    digest: DIGEST,
    projectId: PROJECT_ID,
    publishedAt: "2026-09-10T12:00:00.000Z",
  };
}

const PREPARATION_ERROR = {
  error:
    "A preparation receipt requires operationId, preparationId, digests, a capability contract, and matches.",
};

const PREPARATION_REJECTIONS: Array<[string, Record<string, unknown>]> = [
  ["an unknown field", { ...validPreparationReceipt(), unexpected: true }],
  [
    "a non-uuid operationId",
    { ...validPreparationReceipt(), operationId: "op-1" },
  ],
  [
    "an invalid comparisonSetDigest",
    { ...validPreparationReceipt(), comparisonSetDigest: "not-a-digest" },
  ],
  [
    "an invalid capability contract",
    { ...validPreparationReceipt(), capabilityContract: { purpose: "" } },
  ],
  [
    "a match with confidence above 1",
    {
      ...validPreparationReceipt(),
      matches: [{ ...validMatch(), confidence: 1.1 }],
    },
  ],
  [
    "a match with an unknown classification",
    {
      ...validPreparationReceipt(),
      matches: [{ ...validMatch(), classification: "other" }],
    },
  ],
  [
    "a match with an unknown reasonCode",
    {
      ...validPreparationReceipt(),
      matches: [{ ...validMatch(), reasonCode: "other" }],
    },
  ],
];

const LOOKUP_ERROR = {
  error:
    "A publication lookup requires a valid not_published, prepared, or published status.",
};

const PUBLISHED_LOOKUP_MISSING_FIELDS: Array<
  [string, Record<string, unknown>]
> = [
  ["skillId", omit(validPublicationReceipt(), "skillId")],
  ["versionId", omit(validPublicationReceipt(), "versionId")],
  ["digest", omit(validPublicationReceipt(), "digest")],
];

const PUBLISHED_LOOKUP_BAD_PUBLISHED_AT: Array<[string, string]> = [
  ["a bare year", "2026"],
  ["a bare number", "1"],
  ["a natural-language date", "September 10, 2026"],
  ["a date without a time", "2026-09-10"],
  ["a date-time without a timezone", "2026-09-10T12:00:00"],
];

describe("parsePreparationResponse", () => {
  it("accepts an exact preparation receipt", () => {
    expect(parsePreparationResponse(validPreparationReceipt())).toEqual(
      validPreparationReceipt(),
    );
  });

  it.each(PREPARATION_REJECTIONS)(
    "rejects a preparation receipt with %s",
    (_reason, receipt) => {
      expect(parsePreparationResponse(receipt)).toEqual(PREPARATION_ERROR);
    },
  );
});

describe("parsePublicationLookup acceptance", () => {
  it("accepts a not_published lookup", () => {
    expect(parsePublicationLookup({ status: "not_published" })).toEqual({
      status: "not_published",
    });
  });

  it("accepts a prepared lookup", () => {
    const preparation = validPreparationReceipt();
    expect(parsePublicationLookup({ status: "prepared", preparation })).toEqual(
      { status: "prepared", preparation },
    );
  });

  it("accepts a published lookup", () => {
    const publication = validPublicationReceipt();
    expect(
      parsePublicationLookup({ status: "published", publication }),
    ).toEqual({ status: "published", publication });
  });
});

describe("parsePublicationLookup rejection", () => {
  it.each(PUBLISHED_LOOKUP_MISSING_FIELDS)(
    "rejects a published lookup missing %s",
    (_field, publication) => {
      expect(
        parsePublicationLookup({ status: "published", publication }),
      ).toEqual(LOOKUP_ERROR);
    },
  );

  it.each(PUBLISHED_LOOKUP_BAD_PUBLISHED_AT)(
    "rejects a published lookup with %s as publishedAt",
    (_reason, publishedAt) => {
      const publication = { ...validPublicationReceipt(), publishedAt };
      expect(
        parsePublicationLookup({ status: "published", publication }),
      ).toEqual(LOOKUP_ERROR);
    },
  );

  it("rejects an unknown lookup status", () => {
    expect(parsePublicationLookup({ status: "unknown" })).toEqual(LOOKUP_ERROR);
  });

  it("rejects a not_published lookup with an unknown field", () => {
    expect(
      parsePublicationLookup({ status: "not_published", unexpected: true }),
    ).toEqual(LOOKUP_ERROR);
  });
});

describe("parsePublicationReceipt", () => {
  it("accepts an exact publication receipt", () => {
    expect(parsePublicationReceipt(validPublicationReceipt())).toEqual(
      validPublicationReceipt(),
    );
  });

  it.each(PUBLISHED_LOOKUP_MISSING_FIELDS)(
    "rejects a receipt missing %s",
    (_field, receipt) => {
      expect(parsePublicationReceipt(receipt)).toBeNull();
    },
  );

  it("rejects a receipt with an unknown field", () => {
    expect(
      parsePublicationReceipt({
        ...validPublicationReceipt(),
        unexpected: true,
      }),
    ).toBeNull();
  });

  it.each(PUBLISHED_LOOKUP_BAD_PUBLISHED_AT)(
    "rejects a receipt with %s as publishedAt",
    (_reason, publishedAt) => {
      expect(
        parsePublicationReceipt({ ...validPublicationReceipt(), publishedAt }),
      ).toBeNull();
    },
  );
});
