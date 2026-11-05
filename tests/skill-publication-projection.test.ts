import { it, expect } from "vitest";
import { parseAuthoritativePublicationRead } from "@/lib/skillPublication/browserResponse";
import { parsePublicationRead } from "@/lib/skillPublication/clientResponse";
import { PUBLICATION_STATES } from "@/lib/skillPublication/types";

const PUBLICATION_ID = "11111111-1111-4111-8111-111111111111";
const DEAL_STEP_ID = "22222222-2222-4222-8222-222222222222";
const SKILL_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";
const DIGEST = "a".repeat(64);

function skillBinding(overrides: Record<string, unknown> = {}) {
  return {
    skillId: SKILL_ID,
    versionId: VERSION_ID,
    digest: DIGEST,
    ...overrides,
  };
}

function match(overrides: Record<string, unknown> = {}) {
  return {
    dealStepId: DEAL_STEP_ID,
    name: "Buyer screen",
    classification: "exact",
    reasonCode: "identity_match",
    ...overrides,
  };
}

function published(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    id: PUBLICATION_ID,
    state: "published",
    revision: 2,
    matches: [match()],
    error: null,
    result: { stepId: DEAL_STEP_ID, skillBinding: skillBinding() },
    assessmentDigest: null,
    ...overrides,
  };
}

function preparing(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    id: PUBLICATION_ID,
    state: "preparing",
    revision: 0,
    matches: [],
    error: null,
    result: null,
    assessmentDigest: null,
    ...overrides,
  };
}

function confirming(overrides: Record<string, unknown> = {}) {
  return preparing({
    state: "confirmation_required",
    assessmentDigest: "b".repeat(64),
    ...overrides,
  });
}

const NON_PUBLISHED_STATE_CASES: Array<[string, unknown, "accept" | "reject"]> =
  PUBLICATION_STATES.filter(
    (state) => state !== "published" && state !== "confirmation_required",
  ).map((state) => [
    `a ${state} state with a null result`,
    preparing({ state }),
    "accept",
  ]);

const CASES: Array<[string, unknown, "accept" | "reject"]> = [
  ["the unavailable shape", { available: false }, "accept"],
  [
    "available:false with an extra key",
    { available: false, id: PUBLICATION_ID },
    "reject",
  ],
  ["a published state with an exact success binding", published(), "accept"],
  ["an unknown state", preparing({ state: "archived" }), "reject"],
  [
    "a non-null result when the state is not published",
    preparing({
      result: { stepId: DEAL_STEP_ID, skillBinding: skillBinding() },
    }),
    "reject",
  ],
  [
    "a null result when the state is published",
    published({ result: null }),
    "reject",
  ],
  ["a top-level extra key", preparing({ providerState: "private" }), "reject"],
  [
    "a result missing versionId",
    published({
      result: {
        stepId: DEAL_STEP_ID,
        skillBinding: { skillId: SKILL_ID, digest: DIGEST },
      },
    }),
    "reject",
  ],
  [
    "a result missing digest",
    published({
      result: {
        stepId: DEAL_STEP_ID,
        skillBinding: { skillId: SKILL_ID, versionId: VERSION_ID },
      },
    }),
    "reject",
  ],
  [
    "a result with a malformed digest",
    published({
      result: {
        stepId: DEAL_STEP_ID,
        skillBinding: skillBinding({ digest: "not-a-digest" }),
      },
    }),
    "reject",
  ],
  [
    "an artifact reference on the skill binding",
    published({
      result: {
        stepId: DEAL_STEP_ID,
        skillBinding: skillBinding({ artifactReference: "private" }),
      },
    }),
    "reject",
  ],
  [
    "a provider candidate id on the result",
    published({
      result: {
        stepId: DEAL_STEP_ID,
        skillBinding: skillBinding(),
        providerCandidateId: "private",
      },
    }),
    "reject",
  ],
  ["a safe duplicate match", preparing({ matches: [match()] }), "accept"],
  [
    "a duplicate match name at the 100 character maximum",
    preparing({ matches: [match({ name: "a".repeat(100) })] }),
    "accept",
  ],
  [
    "a duplicate match name over the 100 character maximum",
    preparing({ matches: [match({ name: "a".repeat(101) })] }),
    "reject",
  ],
  [
    "a duplicate match carrying a raw targetId",
    preparing({ matches: [match({ targetId: PUBLICATION_ID })] }),
    "reject",
  ],
  [
    "a duplicate match carrying a raw confidence score",
    preparing({ matches: [match({ confidence: 0.9 })] }),
    "reject",
  ],
  [
    "a duplicate match with an unknown classification",
    preparing({ matches: [match({ classification: "invented" })] }),
    "reject",
  ],
  [
    "a duplicate match with a null dealStepId",
    preparing({ matches: [match({ dealStepId: null })] }),
    "accept",
  ],
  [
    "a failed state with a safe error",
    preparing({
      state: "failed",
      error: { code: "candidate_stale", dealStepId: null },
    }),
    "accept",
  ],
  [
    "a failed state with an unknown error code",
    preparing({
      state: "failed",
      error: { code: "not_a_real_code", dealStepId: null },
    }),
    "reject",
  ],
  [
    "a failed state with an error object carrying an extra key",
    preparing({
      state: "failed",
      error: { code: "candidate_stale", dealStepId: null, detail: "private" },
    }),
    "reject",
  ],
  ["a negative revision", preparing({ revision: -1 }), "reject"],
  ["a non-array matches", preparing({ matches: "not-an-array" }), "reject"],
  [
    "a confirmation_required state with its assessment digest",
    confirming(),
    "accept",
  ],
  [
    "a non-null assessment digest outside confirmation_required",
    preparing({ assessmentDigest: "b".repeat(64) }),
    "reject",
  ],
  [
    "a null assessment digest inside confirmation_required",
    confirming({ assessmentDigest: null }),
    "reject",
  ],
  [
    "a malformed assessment digest",
    confirming({ assessmentDigest: "not-a-digest" }),
    "reject",
  ],
  ...NON_PUBLISHED_STATE_CASES,
];

const PARSERS: Array<[string, (value: unknown) => unknown, unknown]> = [
  ["authoritative", parseAuthoritativePublicationRead, null],
  ["client", parsePublicationRead, undefined],
];

const MATRIX = PARSERS.flatMap(([parserName, parse, rejected]) =>
  CASES.map(
    ([caseName, value, expectation]) =>
      [
        `${parserName} parser rejects/accepts ${caseName}`,
        () => parse(value),
        expectation === "accept" ? value : rejected,
      ] as const,
  ),
);

it.each(MATRIX)("%s", (_label, run, expected) => {
  expect(run()).toEqual(expected);
});

it("parses a published state into the exact literal shape, not merely a shape matching the input", () => {
  const parsed = parsePublicationRead(published());
  expect(parsed).toEqual({
    available: true,
    id: "11111111-1111-4111-8111-111111111111",
    state: "published",
    revision: 2,
    matches: [
      {
        dealStepId: "22222222-2222-4222-8222-222222222222",
        name: "Buyer screen",
        classification: "exact",
        reasonCode: "identity_match",
      },
    ],
    error: null,
    result: {
      stepId: "22222222-2222-4222-8222-222222222222",
      skillBinding: {
        skillId: "33333333-3333-4333-8333-333333333333",
        versionId: "44444444-4444-4444-8444-444444444444",
        digest: "a".repeat(64),
      },
    },
    assessmentDigest: null,
  });
});

it("parses a failed state's error into the exact literal code and dealStepId", () => {
  const parsed = parsePublicationRead(
    preparing({
      state: "failed",
      error: {
        code: "candidate_stale",
        dealStepId: "22222222-2222-4222-8222-222222222222",
      },
    }),
  );
  expect(parsed).toEqual({
    available: true,
    id: "11111111-1111-4111-8111-111111111111",
    state: "failed",
    revision: 0,
    matches: [],
    error: {
      code: "candidate_stale",
      dealStepId: "22222222-2222-4222-8222-222222222222",
    },
    result: null,
    assessmentDigest: null,
  });
});

it("parses the step_removed code the enhancement rebind writes when its step was removed", () => {
  const value = preparing({
    state: "needs_placement",
    error: { code: "step_removed", dealStepId: null },
  });
  expect(parsePublicationRead(value)).toEqual(value);
  expect(parseAuthoritativePublicationRead(value)).toEqual(value);
});
