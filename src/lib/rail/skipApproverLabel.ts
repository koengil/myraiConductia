/**
 * The approver text shown for a rail-model skip. A skip logged before the
 * database verified the approver carries free text the banker typed, so the
 * rail GET marks it `approverVerified: false` and the label says so. Verified
 * and unmarked skips (local records, step records) show the name as is.
 * Wording and treatment are design to confirm.
 */
export function skipApproverLabel(skip: {
  approver: string;
  approverVerified?: boolean;
}): string {
  if (skip.approverVerified === false && skip.approver) {
    return `recorded as ${skip.approver}`;
  }
  return skip.approver;
}
