import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  coerceFieldValue,
  collectRunInputs,
  missingRequired,
  parseInputProblems,
  parseInputValues,
  parseSkillInputFields,
  sameInputValues,
  type SkillInputField,
} from "@/lib/skillRun/inputs";

const AS_OF: SkillInputField = {
  name: "asOf", label: "As of", description: null, type: "date", values: [], required: true, default: null,
};
const COUNT: SkillInputField = {
  name: "count", label: "count", description: null, type: "number", values: [], required: false, default: null,
};
const AUDIENCE: SkillInputField = {
  name: "audience", label: "Audience", description: null, type: "enum", values: ["Board", "Exec"], required: true, default: "Board",
};

describe("parseSkillInputFields", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("normalizes a bench list and defaults the label to the name", () => {
    expect(parseSkillInputFields([{ name: "count", type: "number" }, { name: "asOf", type: "date", label: "As of", required: true }]))
      .toEqual([COUNT, AS_OF]);
  });
  it("reads a missing or invalid list as no fields", () => {
    expect(parseSkillInputFields(undefined)).toEqual([]);
    expect(parseSkillInputFields([{ name: "x", type: "enum" }])).toEqual([]);
    expect(parseSkillInputFields([{ name: "x", type: "file" }])).toEqual([]);
  });

  describe("logging", () => {
    it("warns once when the value is present but invalid", () => {
      expect(parseSkillInputFields([{ name: "x", type: "file" }])).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("does not warn when the value is missing", () => {
      expect(parseSkillInputFields(undefined)).toEqual([]);
      expect(parseSkillInputFields(null)).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});

describe("coerceFieldValue", () => {
  it("drops an empty or non-finite number instead of sending NaN", () => {
    expect(coerceFieldValue(COUNT, "")).toBeUndefined();
    expect(coerceFieldValue(COUNT, "-")).toBeUndefined();
    expect(coerceFieldValue(COUNT, "1e3")).toBe(1000);
  });
  it("drops a blank string", () => {
    expect(coerceFieldValue(AS_OF, "   ")).toBeUndefined();
  });
});

describe("collectRunInputs", () => {
  it("sends only declared, non-empty values", () => {
    expect(collectRunInputs([AS_OF], { asOf: "2026-09-30", stale: "x", })).toEqual({ asOf: "2026-09-30" });
  });

  it("includes a field's default when no value was entered", () => {
    expect(collectRunInputs([AUDIENCE], {})).toEqual({ audience: "Board" });
    expect(collectRunInputs([AUDIENCE], { audience: "" })).toEqual({ audience: "Board" });
    expect(collectRunInputs([AUDIENCE], { audience: "Exec" })).toEqual({ audience: "Exec" });
  });
});

describe("missingRequired", () => {
  it("names the first required field without a value", () => {
    expect(missingRequired([COUNT, AS_OF], {})).toEqual(AS_OF);
    expect(missingRequired([COUNT, AS_OF], { asOf: "2026-09-30" })).toBeNull();
  });
});

describe("parseInputValues", () => {
  it("accepts scalars and refuses anything else", () => {
    expect(parseInputValues({ a: "x", b: 2, c: true })).toEqual({ a: "x", b: 2, c: true });
    expect(parseInputValues({ a: { nested: 1 } })).toBeNull();
    expect(parseInputValues("x")).toBeNull();
  });
});

describe("sameInputValues", () => {
  it("ignores key order", () => {
    expect(sameInputValues({ a: 1, b: "x" }, { b: "x", a: 1 })).toBe(true);
    expect(sameInputValues({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe("parseInputProblems", () => {
  it("reads problems from a bench 422 envelope", () => {
    expect(parseInputProblems({ error: { code: "validation", detail: { problems: [{ name: "asOf", message: "required" }, { name: null, message: "x" }] } } }))
      .toEqual([{ name: "asOf", message: "required" }, { name: null, message: "x" }]);
    expect(parseInputProblems({ error: { code: "validation", detail: {} } })).toBeNull();
  });
});
