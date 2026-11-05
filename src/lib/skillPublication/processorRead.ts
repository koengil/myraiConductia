import type { SupabaseClient } from "@supabase/supabase-js";
import { TABLE } from "@/lib/constants/tables";
import type { SkillReference } from "@/lib/skillRun/types";
import type { OperationRow } from "./processorTypes";
import { dbFailure } from '@/lib/errors/upstream';

const OPERATION_COLUMNS = [
  "id",
  "deal_id",
  "draft_id",
  "actor_id",
  "state",
  "candidate_id",
  "provider_candidate_id",
  "candidate_digest",
  "name",
  "capability_contract",
  "comparison_set_digest",
  "preparation_id",
  "assessment_digest",
  "reserved_skill_id",
  "status_code",
  "next_retry_at",
  "attempt_count",
].join(", ");

async function fetchFirstRow(
  admin: SupabaseClient,
  table: string,
  columns: string,
  column: string,
  value: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await admin
    .from(table)
    .select(columns)
    .eq(column, value);
  if (error) throw dbFailure('Skill publication read', error);
  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  return rows[0] ?? null;
}

export async function fetchOperation(
  admin: SupabaseClient,
  publicationId: string,
): Promise<OperationRow> {
  const row = await fetchFirstRow(
    admin,
    TABLE.SKILL_PUBLICATION_OPERATIONS,
    OPERATION_COLUMNS,
    "id",
    publicationId,
  );
  if (row === null) {
    throw new Error("skill_publication_operation_not_found");
  }
  return row as unknown as OperationRow;
}

export async function fetchDealTenantId(
  admin: SupabaseClient,
  dealId: string,
): Promise<string> {
  const row = await fetchFirstRow(
    admin,
    TABLE.DEALS,
    "tenant_id",
    "id",
    dealId,
  );
  if (row === null) {
    throw new Error("deal_not_found");
  }
  return row.tenant_id as string;
}

export async function fetchCandidateName(
  admin: SupabaseClient,
  candidateId: string,
): Promise<string> {
  const row = await fetchFirstRow(
    admin,
    TABLE.SKILL_AUTHORING_CANDIDATES,
    "preview",
    "id",
    candidateId,
  );
  if (row === null) {
    throw new Error("skill_authoring_candidate_not_found");
  }
  const preview = row.preview as Record<string, unknown> | null;
  return typeof preview?.name === "string" ? preview.name : "";
}

export async function fetchDraftBasis(
  admin: SupabaseClient,
  draftId: string,
): Promise<SkillReference | null> {
  const row = await fetchFirstRow(
    admin,
    TABLE.SKILL_AUTHORING_DRAFTS,
    "basis",
    "id",
    draftId,
  );
  return (row?.basis as SkillReference | null | undefined) ?? null;
}

export async function fetchDraftBasisStepId(
  admin: SupabaseClient,
  draftId: string,
): Promise<string | null> {
  const row = await fetchFirstRow(
    admin,
    TABLE.SKILL_AUTHORING_DRAFTS,
    "basis_deal_step_id",
    "id",
    draftId,
  );
  return (row?.basis_deal_step_id as string | null | undefined) ?? null;
}
