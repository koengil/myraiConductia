import { describe, expect, it } from "vitest";
import { parseSkillBinding } from "@/lib/skillPublication/parse";

const DIGEST =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SKILL_ID = "33333333-3333-4333-8333-333333333333";
const VERSION_ID = "44444444-4444-4444-8444-444444444444";

function omit<T extends Record<string, unknown>>(
  obj: T,
  key: keyof T,
): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...obj };
  delete rest[key as string];
  return rest;
}

const VALID_SKILL_BINDING = {
  skillId: SKILL_ID,
  versionId: VERSION_ID,
  digest: DIGEST,
};

const SKILL_BINDING_REJECTIONS: Array<[string, Record<string, unknown>]> = [
  ["a missing skillId", omit(VALID_SKILL_BINDING, "skillId")],
  ["a missing versionId", omit(VALID_SKILL_BINDING, "versionId")],
  ["a missing digest", omit(VALID_SKILL_BINDING, "digest")],
  ["a non-uuid skillId", { ...VALID_SKILL_BINDING, skillId: "not-a-uuid" }],
  ["a non-uuid versionId", { ...VALID_SKILL_BINDING, versionId: "not-a-uuid" }],
  ["an invalid digest", { ...VALID_SKILL_BINDING, digest: "not-a-digest" }],
  ["an unknown field", { ...VALID_SKILL_BINDING, unexpected: true }],
];

describe("parseSkillBinding", () => {
  it("accepts an exact skill binding", () => {
    expect(parseSkillBinding(VALID_SKILL_BINDING)).toEqual(VALID_SKILL_BINDING);
  });

  it.each(SKILL_BINDING_REJECTIONS)(
    "rejects a skill binding with %s",
    (_reason, binding) => {
      expect(parseSkillBinding(binding)).toBeNull();
    },
  );
});
