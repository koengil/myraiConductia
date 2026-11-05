import { expect, it } from "vitest";
import {
  comparisonSetDigestOf,
  normalizeName,
} from "@/lib/skillPublication/comparisonDigest";
import type { ComparisonTarget } from "@/lib/skillPublication/types";

const NORMALIZE_NAME_CASES: Array<[string, string, string]> = [
  [
    "folds a leading tab into a leading space, since btrim strips only space characters",
    "\thello",
    " hello",
  ],
  ["folds a trailing newline into a trailing space", "hello\n", "hello "],
  [
    "collapses inner whitespace runs to a single space",
    "hello   world",
    "hello world",
  ],
  ["lowercases mixed case", "HeLLo World", "hello world"],
  ["strips plain leading and trailing spaces", "  hello  ", "hello"],
];

it.each(NORMALIZE_NAME_CASES)(
  "normalizeName %s",
  (_reason, input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  },
);

function baseTarget(targetId: string): ComparisonTarget {
  return {
    targetId,
    state: "active",
    displayName: "Alpha",
    capabilityContract: {
      purpose: "P",
      expectedInput: "I",
      expectedOutput: "O",
    },
    skillBinding: {
      skillId: "skill-1",
      versionId: "version-1",
      digest: "digest-1",
    },
    candidate: null,
  };
}

it("comparisonSetDigestOf ignores skillBinding/candidate key insertion order", () => {
  const target = baseTarget("10000000-0000-4000-8000-000000000001");
  const reversedKeys: ComparisonTarget = {
    ...target,
    skillBinding: {
      digest: target.skillBinding!.digest,
      versionId: target.skillBinding!.versionId,
      skillId: target.skillBinding!.skillId,
    },
  };

  expect(comparisonSetDigestOf([target])).toBe(
    comparisonSetDigestOf([reversedKeys]),
  );
});

it("comparisonSetDigestOf sorts input by targetId itself, independent of caller order", () => {
  const low = baseTarget("10000000-0000-4000-8000-000000000001");
  const high = baseTarget("90000000-0000-4000-8000-000000000001");

  expect(comparisonSetDigestOf([low, high])).toBe(
    comparisonSetDigestOf([high, low]),
  );
});
