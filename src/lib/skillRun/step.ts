import { parseSkillStepDefinitionV1 } from "@/lib/skillPublication/parse";

import type { BindingResolution, SkillReference } from "./types";

type StepRow = {
  id?: unknown;
  step_id?: unknown;
  origin?: unknown;
  removed_at?: unknown;
  work?: unknown;
  definition?: unknown;
};

export function resolveStepBinding(
  row: unknown,
  binding: unknown,
  mountName: string | null,
  mountVersion: number | null,
  mountDigest: string | null,
): BindingResolution {
  if (!row || typeof row !== "object") return { ok: false, code: "not_found" };
  const step = row as StepRow;
  if (typeof step.id !== "string" || typeof step.step_id !== "string") {
    return { ok: false, code: "not_found" };
  }
  if (step.removed_at !== null && step.removed_at !== undefined) {
    return { ok: false, code: "removed" };
  }

  const parsed = parseSkillStepDefinitionV1(step.definition);
  const title = "error" in parsed ? String(step.step_id) : parsed.title;

  const fromRow = referenceFromRow(binding);
  if (fromRow) {
    return {
      ok: true,
      step: { dealStepId: step.id, stepId: step.step_id, title, binding: fromRow },
    };
  }

  if (step.origin === "custom") {
    if ("error" in parsed) return { ok: false, code: "not_skill_backed" };
    return {
      ok: true,
      step: {
        dealStepId: step.id,
        stepId: step.step_id,
        title: parsed.title,
        binding: { kind: "publication", ...parsed.skillBinding },
      },
    };
  }

  if (mountName === null || mountVersion === null || mountDigest === null) {
    return { ok: false, code: "not_skill_backed" };
  }
  return {
    ok: true,
    step: {
      dealStepId: step.id,
      stepId: step.step_id,
      title,
      binding: { kind: "mount", name: mountName, version: mountVersion, digest: mountDigest },
    },
  };
}

function referenceFromRow(binding: unknown): SkillReference | null {
  if (!binding || typeof binding !== "object") return null;
  const row = binding as Record<string, unknown>;
  const digest = typeof row.digest === "string" ? row.digest : null;
  if (digest === null) return null;
  if (row.kind === "publication" && typeof row.skill_id === "string" && typeof row.version_id === "string") {
    return { kind: "publication", skillId: row.skill_id, versionId: row.version_id, digest };
  }
  if (row.kind === "mount" && typeof row.mount_name === "string" && typeof row.mount_version === "number") {
    return { kind: "mount", name: row.mount_name, version: row.mount_version, digest };
  }
  return null;
}
