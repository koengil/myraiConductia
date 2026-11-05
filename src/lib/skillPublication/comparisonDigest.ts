import { createHash } from "node:crypto";
import type { ComparisonTarget } from "./types";

export function normalizeName(name: string): string {
  const trimmed = name.replace(/^ +/, "").replace(/ +$/, "");
  return trimmed.replace(/\s+/g, " ").toLowerCase();
}

export function compareTargetId(
  a: ComparisonTarget,
  b: ComparisonTarget,
): number {
  if (a.targetId < b.targetId) return -1;
  if (a.targetId > b.targetId) return 1;
  return 0;
}

function canonicalSkillBinding(binding: ComparisonTarget["skillBinding"]) {
  if (binding === null) return null;
  return {
    skillId: binding.skillId,
    versionId: binding.versionId,
    digest: binding.digest,
  };
}

function canonicalCandidate(candidate: ComparisonTarget["candidate"]) {
  if (candidate === null) return null;
  return {
    candidateId: candidate.candidateId,
    candidateDigest: candidate.candidateDigest,
  };
}

function canonicalize(target: ComparisonTarget) {
  return {
    targetId: target.targetId,
    state: target.state,
    normalizedName: normalizeName(target.displayName),
    capabilityContract: {
      purpose: target.capabilityContract.purpose,
      expectedInput: target.capabilityContract.expectedInput,
      expectedOutput: target.capabilityContract.expectedOutput,
    },
    skillBinding: canonicalSkillBinding(target.skillBinding),
    candidate: canonicalCandidate(target.candidate),
  };
}

export function comparisonSetDigestOf(targets: ComparisonTarget[]): string {
  const canonical = [...targets].sort(compareTargetId).map(canonicalize);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
