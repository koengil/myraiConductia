import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PUBLICATION_CONFLICT_CODES,
  PUBLICATION_ERROR_CODES,
  PUBLICATION_STATES,
} from "@/lib/skillPublication/types";

function readSkillPublicationApi() {
  return JSON.parse(readFileSync("openapi/skill-publication.json", "utf8"));
}

const BROWSER_COMMAND_PATHS = [
  "/deals/{dealId}/skill-drafts/{draftId}/publish",
  "/deals/{dealId}/skill-publications/{publicationId}/duplicate-decision",
  "/deals/{dealId}/skill-publications/{publicationId}/placement",
];

const IGNATIOUS_OPERATION_PATHS = [
  "/conductia/skill-publications/{operationId}/prepare",
  "/conductia/skill-publications/{operationId}/publish",
  "/conductia/skill-publications/{operationId}",
];

it("pins the contract version and publication state enum", () => {
  const api = readSkillPublicationApi();
  expect(api.openapi).toBe("3.1.0");
  expect(api.components.schemas.PublicationState.enum).toEqual(
    PUBLICATION_STATES,
  );
});

it("pins the publication error code enum to the codes the client parses", () => {
  expect(
    readSkillPublicationApi().components.schemas.PublicationErrorCode.enum,
  ).toEqual(PUBLICATION_ERROR_CODES);
});

it("requires skillId, versionId, and digest together on every binding and receipt", () => {
  const schemas = readSkillPublicationApi().components.schemas;
  expect(schemas.SkillBinding.required).toEqual([
    "skillId",
    "versionId",
    "digest",
  ]);
  expect(schemas.SkillBinding.additionalProperties).toBe(false);
  expect(schemas.PublicationReceipt.required).toEqual(
    expect.arrayContaining(["skillId", "versionId", "digest"]),
  );
  expect(schemas.PublicationReceipt.additionalProperties).toBe(false);
  expect(schemas.SkillStepDefinitionV1.required).toContain("skillBinding");
  expect(schemas.SkillStepDefinitionV1.additionalProperties).toBe(false);
});

it("requires assessmentDigest on the browser publication read", () => {
  const schema = readSkillPublicationApi().components.schemas.PublicationRead;
  expect(schema.required).toContain("assessmentDigest");
  expect(schema.properties.assessmentDigest).toEqual({
    description:
      "The stored assessment digest, present only while state is confirmation_required; null in every other state.",
    anyOf: [{ type: "string", pattern: "^[0-9a-f]{64}$" }, { type: "null" }],
  });
});

it("requires every preparation receipt field", () => {
  expect(
    readSkillPublicationApi().components.schemas.PreparationReceipt.required,
  ).toEqual(
    expect.arrayContaining([
      "operationId",
      "preparationId",
      "candidateDigest",
      "capabilityContract",
      "comparisonSetDigest",
      "assessmentDigest",
      "matches",
    ]),
  );
});

it("requires candidateName on the prepare request, distinct from displayName", () => {
  const schema = readSkillPublicationApi().components.schemas.PrepareRequest;
  expect(schema.required).toEqual(
    expect.arrayContaining(["candidateName", "displayName"]),
  );
  expect(schema.properties.candidateName).toEqual({
    type: "string",
    minLength: 1,
    maxLength: 100,
    description:
      "The Ignatious candidate preview name, used for fingerprint verification. Distinct from displayName, which is the editable draft name.",
  });
  expect(schema.additionalProperties).toBe(false);
});

it("exposes every browser and Ignatious path", () => {
  const paths = Object.keys(readSkillPublicationApi().paths);
  expect(paths).toEqual(
    expect.arrayContaining([
      ...BROWSER_COMMAND_PATHS,
      ...IGNATIOUS_OPERATION_PATHS,
    ]),
  );
});

it("prefixes every browser command path with /api/v1", () => {
  const paths = readSkillPublicationApi().paths;
  for (const path of BROWSER_COMMAND_PATHS) {
    expect(paths[path].servers).toEqual([{ url: "/api/v1" }]);
  }
});

it("prefixes every Ignatious operation path with /v1", () => {
  const paths = readSkillPublicationApi().paths;
  for (const path of IGNATIOUS_OPERATION_PATHS) {
    expect(paths[path].servers).toEqual([{ url: "/v1" }]);
  }
});

describe("publication conflict codes", () => {
  it("pins the closed conflict code enum against the OpenAPI schema", () => {
    const schemas = readSkillPublicationApi().components.schemas;
    expect(schemas.PublicationConflictCode.enum).toEqual(
      PUBLICATION_CONFLICT_CODES,
    );
  });

  it("requires the three browser commands to use the closed conflict response", () => {
    const paths = readSkillPublicationApi().paths;
    for (const path of BROWSER_COMMAND_PATHS) {
      expect(paths[path].post.responses["409"]).toEqual({
        $ref: "#/components/responses/PublicationCommandConflict",
      });
    }
  });
});

it("declares the exact response code set for each browser command", () => {
  const paths = readSkillPublicationApi().paths;
  for (const path of BROWSER_COMMAND_PATHS) {
    expect(Object.keys(paths[path].post.responses).sort()).toEqual(
      ["200", "202", "401", "403", "404", "409", "422", "500"].sort(),
    );
  }
});

function operationOf(pathItem: { post?: unknown; get?: unknown }) {
  return (pathItem.post ?? pathItem.get) as {
    responses: Record<string, unknown>;
  };
}

it("authenticates browser commands without touching the Ignatious service auth response", () => {
  const paths = readSkillPublicationApi().paths;
  const responses = readSkillPublicationApi().components.responses;
  for (const path of BROWSER_COMMAND_PATHS) {
    expect(operationOf(paths[path]).responses["401"]).toEqual({
      $ref: "#/components/responses/NotAuthenticated",
    });
  }
  expect(responses.NotAuthenticated.description).toBe("Not authenticated");
  for (const path of IGNATIOUS_OPERATION_PATHS) {
    expect(operationOf(paths[path]).responses["401"]).toEqual({
      $ref: "#/components/responses/Unauthorized",
    });
  }
  expect(responses.Unauthorized.description).toBe(
    "Not authenticated or not authorized",
  );
});

it("never leaks internal candidate fields into operation or schema definitions", () => {
  const api = readSkillPublicationApi();
  const forbidden = ["artifactReference", "providerCandidateId"];
  const haystacks = [
    ...Object.values(api.paths).flatMap((path) =>
      Object.values(path as object),
    ),
    api.components.schemas,
  ];
  for (const haystack of haystacks) {
    for (const field of forbidden) {
      expect(JSON.stringify(haystack)).not.toContain(field);
    }
  }
});
