import {
  hasExactKeys,
  isDigest,
  isRecord,
  isUuid,
} from "@/lib/skillPublication/parse";
import { parseSkillReference } from "@/lib/skillRun/versions";

import type { TemplateSkillSource } from "./types";

export function parseTemplateSkillSource(
  value: unknown,
): TemplateSkillSource | null {
  const reference = parseSkillReference(value);
  if (reference !== null) return reference;
  if (
    !isRecord(value) ||
    value.kind !== "candidate" ||
    !hasExactKeys(value, ["kind", "candidateId", "digest"]) ||
    !isUuid(value.candidateId) ||
    !isDigest(value.digest)
  ) {
    return null;
  }
  return {
    kind: "candidate",
    candidateId: value.candidateId,
    digest: value.digest,
  };
}
