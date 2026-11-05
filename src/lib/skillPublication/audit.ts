export const SKILL_PUBLICATION_AUDIT_ACTION = {
  ADMISSION_DENIED: "skill_publication.admission_denied",
} as const;

type AuditClient = {
  from: (table: "audit_log") => {
    insert: (row: Record<string, unknown>) => PromiseLike<{ error: unknown }>;
  };
};

export type SkillPublicationDenialAuditInput = {
  actorId?: string | null;
  dealId?: string | null;
  draftId?: string | null;
  publicationId?: string | null;
  service?: "conductia";
  reasonCode: string;
  correlationId: string;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REASON_CODE = /^[a-z][a-z0-9_]{0,99}$/;

function isValidInput(input: SkillPublicationDenialAuditInput): boolean {
  if (!UUID.test(input.correlationId)) return false;
  if (!REASON_CODE.test(input.reasonCode)) return false;
  for (const key of ["draftId", "publicationId", "actorId"] as const) {
    const value = input[key];
    if (value != null && !UUID.test(value)) return false;
  }
  if (input.service !== undefined && input.service !== "conductia") {
    return false;
  }
  return !(Boolean(input.actorId) && input.service !== undefined);
}

function buildDetail(
  input: SkillPublicationDenialAuditInput,
): Record<string, string> {
  const detail: Record<string, string> = {
    reasonCode: input.reasonCode,
    correlationId: input.correlationId,
  };
  if (input.actorId) detail.actorId = input.actorId;
  else detail.service = input.service ?? "conductia";
  if (input.draftId) detail.draftId = input.draftId;
  if (input.publicationId) detail.publicationId = input.publicationId;
  return detail;
}

export function buildSkillPublicationDenialAuditDetail(
  input: SkillPublicationDenialAuditInput,
): Record<string, string> {
  if (!isValidInput(input)) {
    throw new Error(
      "Skill publication denial audit identity and correlation are required.",
    );
  }
  return buildDetail(input);
}

export async function writeSkillPublicationDenialAudit(
  admin: AuditClient,
  input: SkillPublicationDenialAuditInput,
): Promise<void> {
  const detail = buildSkillPublicationDenialAuditDetail(input);
  const { error } = await admin.from("audit_log").insert({
    actor_id: input.actorId ?? null,
    service_identity: input.actorId ? null : (input.service ?? "conductia"),
    action: SKILL_PUBLICATION_AUDIT_ACTION.ADMISSION_DENIED,
    deal_id: input.dealId ?? null,
    detail,
  });
  if (error) {
    throw new Error("Unable to record skill publication access denial.");
  }
}
