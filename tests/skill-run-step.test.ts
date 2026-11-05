import { describe, expect, it } from "vitest";

import { parseRunRecord } from "@/lib/skillRun/parse";
import { resolveStepBinding } from "@/lib/skillRun/step";

const BINDING = {
  skillId: "2d362e20-0709-4ba0-bbd7-d21831148282",
  versionId: "0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6",
  digest: "a".repeat(64),
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b",
    step_id: "custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6",
    origin: "custom",
    removed_at: null,
    work: { primary: "Summarise the week" },
    definition: {
      schemaVersion: 1,
      type: "skill",
      title: "Weekly project update",
      description: "Prepare a concise update.",
      inputs: [
        {
          key: "primary",
          kind: "text",
          label: "Input",
          helperText: "What to emphasise.",
          required: true,
        },
      ],
      skillBinding: BINDING,
    },
    ...overrides,
  };
}

describe("resolveStepBinding", () => {
  it("resolves a step whose input has not been saved yet", () => {
    expect(resolveStepBinding(row({ work: {} }), null, null, null, null)).toEqual({
      ok: true,
      step: {
        dealStepId: "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b",
        stepId: "custom:0f1e2d3c-4b5a-4d6e-8f90-a1b2c3d4e5f6",
        title: "Weekly project update",
        binding: { kind: "publication", ...BINDING },
      },
    });
  });

  it("still refuses an absent, removed and unbound step", () => {
    expect(resolveStepBinding(null, null, null, null, null)).toEqual({
      ok: false,
      code: "not_found",
    });
    expect(
      resolveStepBinding(row({ removed_at: "2026-09-14T10:00:00Z" }), null, null, null, null),
    ).toEqual({ ok: false, code: "removed" });
    expect(resolveStepBinding(row({ origin: "catalog" }), null, null, null, null)).toEqual({
      ok: false,
      code: "not_skill_backed",
    });
  });
});

describe("parseRunRecord", () => {
  const runId = "3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11";

  it("accepts a succeeded run and keeps neither the input nor the cost", () => {
    expect(
      parseRunRecord({
        runId,
        input: "in",
        outcome: "succeeded",
        resultText: "out",
        providerRunId: "run_1",
        costUsd: 0.42,
        startedAt: "2026-09-14T10:00:00.000Z",
      }),
    ).toEqual({
      runId,
      outcome: "succeeded",
      resultText: "out",
      errorMessage: null,
      providerRunId: "run_1",
      startedAt: "2026-09-14T10:00:00.000Z",
      reference: null,
      model: null,
      clampedFrom: null,
      inputs: {},
      instructions: null,
    });
  });

  it("drops a startedAt that is not a timestamp", () => {
    expect(
      parseRunRecord({
        runId,
        outcome: "succeeded",
        resultText: "out",
        startedAt: "whenever",
      }),
    ).toMatchObject({ startedAt: null });
  });

  it("strips the control characters that break a text column", () => {
    const parsed = parseRunRecord({
      runId,
      outcome: "succeeded",
      resultText: "half\u0000an\u0000answer",
      errorMessage: "boom\u0000",
    });

    expect(parsed).toMatchObject({ resultText: "halfananswer", errorMessage: "boom" });
  });

  it("keeps the clamp the bench reported alongside the model that ran", () => {
    expect(
      parseRunRecord({
        runId,
        outcome: "succeeded",
        resultText: "out",
        model: "haiku",
        clampedFrom: "opus",
      }),
    ).toMatchObject({ model: "haiku", clampedFrom: "opus" });
  });

  it("accepts a failed run with a message and no result", () => {
    expect(
      parseRunRecord({ runId, input: "in", outcome: "failed", errorMessage: "boom" }),
    ).toMatchObject({
      outcome: "failed",
      resultText: null,
      errorMessage: "boom",
    });
  });

  it("drops result text from a failed run so the stored check holds", () => {
    expect(
      parseRunRecord({
        runId,
        input: "in",
        outcome: "failed",
        resultText: "half an answer",
        errorMessage: "boom",
      }),
    ).toMatchObject({ outcome: "failed", resultText: null });
  });

  it("refuses a succeeded run with no result text", () => {
    expect(parseRunRecord({ runId, input: "in", outcome: "succeeded" })).toEqual({
      error: "resultText is required for a succeeded run",
    });
  });

  it("refuses a run id that is not a uuid and an unknown outcome", () => {
    expect(
      parseRunRecord({ runId: "nope", input: "in", outcome: "succeeded", resultText: "r" }),
    ).toEqual({ error: "runId must be a UUID" });
    expect(parseRunRecord({ runId, input: "in", outcome: "cancelled" })).toEqual({
      error: "outcome must be succeeded or failed",
    });
  });

  it("refuses a body that is not an object", () => {
    expect(parseRunRecord(null)).toEqual({ error: "Invalid JSON body" });
  });

  it("ignores a client-supplied binding", () => {
    const parsed = parseRunRecord({
      runId,
      input: "in",
      outcome: "succeeded",
      resultText: "out",
      skill: { skillId: "spoofed", versionId: "spoofed", digest: "b".repeat(64) },
    });

    expect(parsed).not.toHaveProperty("skill");
  });

  it("keeps neither the input nor the cost the browser sent", () => {
    const parsed = parseRunRecord({
      runId,
      input: "a forged transcript",
      outcome: "succeeded",
      resultText: "out",
      costUsd: 9.99,
    });

    expect(parsed).not.toHaveProperty("input");
    expect(parsed).not.toHaveProperty("costUsd");
  });
});

const MOUNT_ARGS = ["demo", 3, "d".repeat(64)] as const;

describe("resolveStepBinding layers", () => {
  it("prefers a binding row over the step definition", () => {
    const resolved = resolveStepBinding(
      row(),
      { kind: "mount", mount_name: "demo", mount_version: 3, digest: "d".repeat(64) },
      ...MOUNT_ARGS,
    );
    expect(resolved).toMatchObject({
      ok: true,
      step: { binding: { kind: "mount", name: "demo", version: 3, digest: "d".repeat(64) } },
    });
  });

  it("falls back to the definition binding for a custom step", () => {
    const resolved = resolveStepBinding(row(), null, ...MOUNT_ARGS);
    expect(resolved).toMatchObject({
      ok: true,
      step: { binding: { kind: "publication", ...BINDING } },
    });
  });

  it("falls back to the tag-matched mount skill for a catalog step", () => {
    const resolved = resolveStepBinding(
      row({ origin: "catalog", definition: null, step_id: "p1-s17" }),
      null,
      ...MOUNT_ARGS,
    );
    expect(resolved).toMatchObject({
      ok: true,
      step: { binding: { kind: "mount", name: "demo", version: 3, digest: "d".repeat(64) } },
    });
  });

  it("refuses a catalog step with no mount skill behind it", () => {
    expect(
      resolveStepBinding(row({ origin: "catalog", definition: null }), null, null, null, null),
    ).toEqual({ ok: false, code: "not_skill_backed" });
  });
});

describe("parseRunRecord inputs", () => {
  const base = { runId: "3f0d6f9a-1f4c-4a2f-9f37-2f8f2c0f6f11", outcome: "failed", errorMessage: "x" };

  it("reads inputs and instructions", () => {
    expect(parseRunRecord({ ...base, inputs: { asOf: "2026-09-30" }, instructions: " Short " })).toMatchObject({
      inputs: { asOf: "2026-09-30" },
      instructions: "Short",
    });
  });

  it("defaults to no inputs and no instructions", () => {
    expect(parseRunRecord(base)).toMatchObject({ inputs: {}, instructions: null });
  });

  it("refuses nested input values", () => {
    expect(parseRunRecord({ ...base, inputs: { a: { b: 1 } } })).toEqual({
      error: "inputs must map names to text, numbers or booleans",
    });
  });

  it("refuses instructions over the limit", () => {
    expect(parseRunRecord({ ...base, instructions: "x".repeat(20_001) })).toEqual({
      error: "instructions are too long",
    });
  });
});
