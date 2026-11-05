import { normalizeName } from "./comparisonDigest";
import type {
  ComparisonTarget,
  ComparisonTargetState,
  DuplicateMatch,
  PublicationErrorCode,
  SafeDuplicateMatch,
} from "./types";

const BLOCK_PRIORITY: Record<ComparisonTargetState, number> = {
  active: 0,
  admitted: 1,
  removed: 2,
};

function compareTargetId(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export type DuplicateBlock = {
  code: Extract<PublicationErrorCode, "duplicate_active" | "duplicate_removed">;
  dealStepId: string | null;
};

export type DuplicateDecision =
  | { kind: "block"; block: DuplicateBlock }
  | { kind: "confirm"; matches: SafeDuplicateMatch[] }
  | { kind: "clear" };

function targetsById(
  targets: ComparisonTarget[],
): Map<string, ComparisonTarget> {
  const map = new Map<string, ComparisonTarget>();
  for (const target of targets) map.set(target.targetId, target);
  return map;
}

function blockFor(target: ComparisonTarget): DuplicateBlock | null {
  if (target.state === "active") {
    return { code: "duplicate_active", dealStepId: target.targetId };
  }
  if (target.state === "removed") {
    return { code: "duplicate_removed", dealStepId: target.targetId };
  }
  if (target.state === "admitted") {
    return { code: "duplicate_active", dealStepId: null };
  }
  return null;
}

type RankedBlock = {
  block: DuplicateBlock;
  priority: number;
  targetId: string;
};

function rankedBlockFor(target: ComparisonTarget): RankedBlock | null {
  const block = blockFor(target);
  if (!block) return null;
  return {
    block,
    priority: BLOCK_PRIORITY[target.state],
    targetId: target.targetId,
  };
}

function pickHighestRanked(candidates: RankedBlock[]): DuplicateBlock | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return compareTargetId(a.targetId, b.targetId);
  });
  return sorted[0].block;
}

function findHardBlock(
  matches: DuplicateMatch[],
  byId: Map<string, ComparisonTarget>,
): DuplicateBlock | null {
  const candidates: RankedBlock[] = [];
  for (const match of matches) {
    const target = byId.get(match.targetId);
    if (!target) continue;
    if (
      match.classification === "exact" ||
      match.classification === "equivalent"
    ) {
      const ranked = rankedBlockFor(target);
      if (ranked) candidates.push(ranked);
    }
  }
  return pickHighestRanked(candidates);
}

function collectConfirmMatches(
  matches: DuplicateMatch[],
  byId: Map<string, ComparisonTarget>,
): SafeDuplicateMatch[] {
  const confirmMatches: SafeDuplicateMatch[] = [];
  for (const match of matches) {
    const target = byId.get(match.targetId);
    if (!target) continue;
    if (match.classification === "similar" && target.state === "active") {
      confirmMatches.push({
        dealStepId: target.targetId,
        name: target.displayName,
        classification: match.classification,
        reasonCode: match.reasonCode,
      });
    }
  }
  return confirmMatches;
}

export function decideDuplicates(
  matches: DuplicateMatch[],
  targets: ComparisonTarget[],
): DuplicateDecision {
  const byId = targetsById(targets);
  const block = findHardBlock(matches, byId);
  if (block) return { kind: "block", block };
  const confirmMatches = collectConfirmMatches(matches, byId);
  if (confirmMatches.length > 0) {
    return { kind: "confirm", matches: confirmMatches };
  }
  return { kind: "clear" };
}

export function normalizedNameCollision(
  name: string,
  targets: ComparisonTarget[],
): DuplicateBlock | null {
  const normalized = normalizeName(name);
  const candidates: RankedBlock[] = [];
  for (const target of targets) {
    if (normalizeName(target.displayName) !== normalized) continue;
    const ranked = rankedBlockFor(target);
    if (ranked) candidates.push(ranked);
  }
  return pickHighestRanked(candidates);
}
