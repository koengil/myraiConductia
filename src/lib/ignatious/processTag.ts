/**
 * Intellibank rail ids (`p1-s9`) ↔ Ignatious process tags (`phase-1` / `seq-9`).
 *
 * Ignatious tags bench skills to the sell-side taxonomy, not to our rail
 * strings. The mapping is mechanical: phase digit and sequence number are
 * the same ids on both sides.
 */

export const BENCH_MODEL_ALIASES = ['opus', 'sonnet', 'haiku'] as const;
export type BenchModelAlias = (typeof BENCH_MODEL_ALIASES)[number];

export const BENCH_EFFORT_LEVELS = ['low', 'medium', 'high'] as const;
export type BenchEffortLevel = (typeof BENCH_EFFORT_LEVELS)[number];

export type BenchTestStatus = 'untested' | 'testing' | 'passed' | 'failed' | 'blocked';

export type ProcessTag = {
  stageId: string;
  applicationId: string | null;
};

const MODEL_RANK: Record<BenchModelAlias, number> = { haiku: 0, sonnet: 1, opus: 2 };

export function isBenchModelAlias(value: unknown): value is BenchModelAlias {
  return (
    typeof value === 'string' &&
    (BENCH_MODEL_ALIASES as readonly string[]).includes(value)
  );
}

export function isBenchEffortLevel(value: unknown): value is BenchEffortLevel {
  return (
    typeof value === 'string' &&
    (BENCH_EFFORT_LEVELS as readonly string[]).includes(value)
  );
}

export function isBenchTestStatus(value: unknown): value is BenchTestStatus {
  return (
    value === 'untested' ||
    value === 'testing' ||
    value === 'passed' ||
    value === 'failed' ||
    value === 'blocked'
  );
}

/** Models at or below a skill's routing ceiling. Null ceiling means any alias. */
export function modelsWithinCeiling(maxModel: BenchModelAlias | null): readonly BenchModelAlias[] {
  if (!maxModel) return BENCH_MODEL_ALIASES;
  const cap = MODEL_RANK[maxModel];
  return BENCH_MODEL_ALIASES.filter((alias) => MODEL_RANK[alias] <= cap);
}

/** Map a rail step (`p2-s36`) onto the Ignatious process tag for that seq. */
export function processTagForRailStep(stepId: string): ProcessTag | null {
  const match = /^p([1-5])-s(\d+)$/.exec(stepId);
  if (!match) return null;
  return {
    stageId: `phase-${match[1]}`,
    applicationId: `seq-${match[2]}`,
  };
}

export function describeProcessTag(tag: ProcessTag | null | undefined): string {
  if (!tag) return 'all skills';
  if (tag.stageId === 'always') return 'always';
  return tag.applicationId ? `${tag.stageId} · ${tag.applicationId}` : tag.stageId;
}

export function skillMatchesProcessTag(
  skillTag: ProcessTag | null | undefined,
  selection: ProcessTag,
): boolean {
  if (!skillTag) return false;
  if (skillTag.stageId === 'always') return true;
  return (
    skillTag.stageId === selection.stageId &&
    (skillTag.applicationId ?? null) === (selection.applicationId ?? null)
  );
}
