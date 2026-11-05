import { describe, expect, it } from "vitest";
import {
  DIGEST_PATTERN,
  parseDuplicateDecisionCommand,
  parsePlacementCommand,
  parsePublishCommand,
  parseSkillStepDefinitionV1,
} from "@/lib/skillPublication/parse";
import { PUBLICATION_STATES } from "@/lib/skillPublication/types";

const DIGEST =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const CANDIDATE_ID = "22222222-2222-4222-8222-222222222222";
const SKILL_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";

function validPublishCommand() {
  return {
    requestId: REQUEST_ID,
    expectedEditRevision: 0,
    candidateId: CANDIDATE_ID,
    candidateDigest: DIGEST,
  };
}

function validSkillStepDefinition() {
  return {
    schemaVersion: 1,
    type: "skill",
    title: "Weekly project update",
    description:
      "Prepare a concise project update from current deal information.",
    inputs: [
      {
        key: "primary",
        kind: "text",
        label: "Input",
        helperText:
          "Describe the reporting period and any points to emphasize.",
        required: true,
      },
    ],
    skillBinding: { skillId: SKILL_ID, versionId: VERSION_ID, digest: DIGEST },
  };
}

const PUBLISH_COMMAND_ERROR = {
  error:
    "A publish command requires a UUID requestId, nonnegative expectedEditRevision, UUID candidateId, and a SHA-256 candidateDigest.",
};

const PUBLISH_COMMAND_REJECTIONS: Array<[string, Record<string, unknown>]> = [
  ["a non-UUID requestId", { ...validPublishCommand(), requestId: "req-1" }],
  [
    "a malformed candidateId",
    { ...validPublishCommand(), candidateId: "not-a-uuid" },
  ],
  [
    "a negative expectedEditRevision",
    { ...validPublishCommand(), expectedEditRevision: -1 },
  ],
  [
    "a short candidateDigest",
    { ...validPublishCommand(), candidateDigest: "a".repeat(63) },
  ],
  [
    "an uppercase candidateDigest",
    { ...validPublishCommand(), candidateDigest: DIGEST.toUpperCase() },
  ],
  ["an unknown field", { ...validPublishCommand(), unexpected: true }],
];

const DUPLICATE_DECISION_ERROR = {
  error:
    "A duplicate decision requires a nonnegative expectedRevision, a SHA-256 assessmentDigest, and a confirm or decline decision.",
};

const DUPLICATE_DECISION_REJECTIONS: Array<[string, Record<string, unknown>]> =
  [
    [
      "an unknown decision",
      { expectedRevision: 2, assessmentDigest: DIGEST, decision: "maybe" },
    ],
    [
      "a negative revision",
      { expectedRevision: -1, assessmentDigest: DIGEST, decision: "decline" },
    ],
    [
      "an invalid digest",
      {
        expectedRevision: 2,
        assessmentDigest: "not-a-digest",
        decision: "decline",
      },
    ],
    [
      "an unknown field",
      {
        expectedRevision: 2,
        assessmentDigest: DIGEST,
        decision: "decline",
        unexpected: true,
      },
    ],
  ];

const PLACEMENT_COMMAND_ERROR = {
  error:
    "A placement command requires a nonnegative expectedRevision and a valid placement.",
};

const PLACEMENT_COMMAND_REJECTIONS: Array<[string, Record<string, unknown>]> = [
  [
    "a negative expectedRevision",
    { expectedRevision: -1, placement: { kind: "phase_start", phaseIndex: 0 } },
  ],
  ["a null placement", { expectedRevision: 0, placement: null }],
  [
    "an invalid placement kind",
    { expectedRevision: 0, placement: { kind: "unknown", phaseIndex: 0 } },
  ],
  [
    "an unknown field",
    {
      expectedRevision: 0,
      placement: { kind: "phase_start", phaseIndex: 0 },
      unexpected: true,
    },
  ],
];

const SKILL_STEP_DEFINITION_ERROR = {
  error:
    "A skill step definition requires schemaVersion 1, title, description, exactly one primary input, and a skill binding.",
};

const SKILL_STEP_DEFINITION_REJECTIONS: Array<
  [string, Record<string, unknown>]
> = [
  ["schemaVersion 2", { ...validSkillStepDefinition(), schemaVersion: 2 }],
  ["a non-skill type", { ...validSkillStepDefinition(), type: "custom" }],
  ["a blank title", { ...validSkillStepDefinition(), title: " " }],
  [
    "a required false input",
    {
      ...validSkillStepDefinition(),
      inputs: [
        {
          key: "primary",
          kind: "text",
          label: "Input",
          helperText: "x",
          required: false,
        },
      ],
    },
  ],
  [
    "a non-uuid skillId",
    {
      ...validSkillStepDefinition(),
      skillBinding: {
        skillId: "not-a-uuid",
        versionId: VERSION_ID,
        digest: DIGEST,
      },
    },
  ],
  [
    "an invalid digest",
    {
      ...validSkillStepDefinition(),
      skillBinding: {
        skillId: SKILL_ID,
        versionId: VERSION_ID,
        digest: "not-a-digest",
      },
    },
  ],
];

describe("skill publication contract primitives", () => {
  it("matches DIGEST_PATTERN against a lowercase SHA-256 digest", () => {
    expect(DIGEST_PATTERN.test(DIGEST)).toBe(true);
    expect(DIGEST_PATTERN.test(DIGEST.toUpperCase())).toBe(false);
    expect(DIGEST_PATTERN.test("a".repeat(63))).toBe(false);
  });

  it("lists every publication state", () => {
    expect(PUBLICATION_STATES).toEqual([
      "preparing",
      "confirmation_required",
      "publishing",
      "attaching",
      "reconciling",
      "needs_placement",
      "published",
      "failed",
    ]);
  });
});

describe("parsePublishCommand", () => {
  it("accepts an exact publish command", () => {
    expect(parsePublishCommand(validPublishCommand())).toEqual(
      validPublishCommand(),
    );
  });

  it("accepts case-insensitive UUIDs", () => {
    const command = {
      ...validPublishCommand(),
      candidateId: CANDIDATE_ID.toUpperCase(),
    };
    expect(parsePublishCommand(command)).toEqual(command);
  });

  it.each(PUBLISH_COMMAND_REJECTIONS)(
    "rejects a publish command with %s",
    (_reason, command) => {
      expect(parsePublishCommand(command)).toEqual(PUBLISH_COMMAND_ERROR);
    },
  );
});

describe("parseDuplicateDecisionCommand", () => {
  it("accepts an exact duplicate decision command", () => {
    const command = {
      expectedRevision: 2,
      assessmentDigest: DIGEST,
      decision: "confirm" as const,
    };
    expect(parseDuplicateDecisionCommand(command)).toEqual(command);
  });

  it.each(DUPLICATE_DECISION_REJECTIONS)(
    "rejects a duplicate decision command with %s",
    (_reason, command) => {
      expect(parseDuplicateDecisionCommand(command)).toEqual(
        DUPLICATE_DECISION_ERROR,
      );
    },
  );
});

describe("parsePlacementCommand", () => {
  it("accepts an exact placement command", () => {
    const command = {
      expectedRevision: 4,
      placement: {
        kind: "after" as const,
        phaseIndex: 2,
        afterStepId: "4e4bac4f-dcbf-411c-bf4b-3ddc6cdb5861",
      },
    };
    expect(parsePlacementCommand(command)).toEqual(command);
  });

  it.each(PLACEMENT_COMMAND_REJECTIONS)(
    "rejects a placement command with %s",
    (_reason, command) => {
      expect(parsePlacementCommand(command)).toEqual(PLACEMENT_COMMAND_ERROR);
    },
  );
});

describe("parseSkillStepDefinitionV1", () => {
  it("accepts a schema version 1 skill step definition with exactly one primary input", () => {
    expect(parseSkillStepDefinitionV1(validSkillStepDefinition())).toEqual(
      validSkillStepDefinition(),
    );
  });

  it("rejects an extra input in schema version 1", () => {
    const definition = validSkillStepDefinition();
    definition.inputs.push({
      key: "primary",
      kind: "text",
      label: "Input",
      helperText: "A second input.",
      required: true,
    });
    expect(parseSkillStepDefinitionV1(definition)).toEqual(
      SKILL_STEP_DEFINITION_ERROR,
    );
  });

  it.each(SKILL_STEP_DEFINITION_REJECTIONS)(
    "rejects a skill step definition with %s",
    (_reason, definition) => {
      expect(parseSkillStepDefinitionV1(definition)).toEqual(
        SKILL_STEP_DEFINITION_ERROR,
      );
    },
  );
});
