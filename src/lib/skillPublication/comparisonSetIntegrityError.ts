export const COMPARISON_SET_INTEGRITY_REASONS = [
  "unparseable_capability_contract",
  "missing_or_invalid_binding",
] as const;
export type ComparisonSetIntegrityReason =
  (typeof COMPARISON_SET_INTEGRITY_REASONS)[number];

export class ComparisonSetIntegrityError extends Error {
  readonly targetId: string;
  readonly reason: ComparisonSetIntegrityReason;

  constructor(targetId: string, reason: ComparisonSetIntegrityReason) {
    super(
      `Comparison set target ${targetId} failed integrity check: ${reason}`,
    );
    this.name = "ComparisonSetIntegrityError";
    this.targetId = targetId;
    this.reason = reason;
  }
}
