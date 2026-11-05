import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  RECOVERY_CANDIDATE_NAME,
  RECOVERY_PROVIDER_CANDIDATE_ID,
  RECOVERY_CANDIDATE_DIGEST,
  recoveryCapabilityContract,
} from "./recoveryFixtures";
import { createProvisionedUser } from "@/lib/auth/provisioning";

export type Mode2Context = {
  admin: SupabaseClient;
  operationId: string;
  cleanup(): Promise<void>;
};

type SupabaseError = { message: string } | null;

function assertNoError(table: string, error: SupabaseError): void {
  if (error) throw new Error(`mode2_fixture_write_failed: ${table}`);
}

export function createMode2Client(
  url: string,
  serviceRoleKey: string,
): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function readMirroredUser(
  admin: SupabaseClient,
  userId: string,
): Promise<void> {
  const { data, error } = await admin
    .from("users")
    .select("id")
    .eq("id", userId)
    .maybeSingle();
  assertNoError("users", error);
  if (data === null) {
    throw new Error("mode2_fixture_mirror_missing: users");
  }
}

async function createActor(
  admin: SupabaseClient,
  tenantId: string,
): Promise<string> {
  const email = `mode2-${randomUUID()}@example.test`;
  let userId: string;
  try {
    const user = await createProvisionedUser(admin, {
      email,
      email_confirm: true,
      profile: { tenant_id: tenantId, full_name: "Mode 2 Smoke Actor" },
    });
    userId = user.id;
  } catch {
    throw new Error("mode2_fixture_write_failed: auth.users");
  }
  await readMirroredUser(admin, userId);
  return userId;
}

async function grantDealStepsStructurePermission(
  admin: SupabaseClient,
  companyId: string,
  actorId: string,
): Promise<void> {
  const userUpdate = await admin
    .from("users")
    .update({ company_id: companyId, status: "active" })
    .eq("id", actorId);
  assertNoError("users", userUpdate.error);
  const memberAccess = await admin
    .from("company_member_access")
    .insert({ company_id: companyId, user_id: actorId });
  assertNoError("company_member_access", memberAccess.error);
  const memberPermission = await admin
    .from("company_member_permissions")
    .insert({
      company_id: companyId,
      user_id: actorId,
      permission_key: "company:deals:steps:structure",
      granted_by: actorId,
    });
  assertNoError("company_member_permissions", memberPermission.error);
}

async function grantDealMembership(
  admin: SupabaseClient,
  dealId: string,
  actorId: string,
): Promise<void> {
  const mdRole = await admin
    .from("roles")
    .select("id")
    .eq("slug", "md")
    .single();
  assertNoError("roles", mdRole.error);
  const membership = await admin.from("deal_memberships").insert({
    deal_id: dealId,
    user_id: actorId,
    role_id: (mdRole.data as { id: string }).id,
    deal_role: "md",
  });
  assertNoError("deal_memberships", membership.error);
}

async function createDealChain(
  admin: SupabaseClient,
  tenantId: string,
  actorId: string,
) {
  const companyId = randomUUID();
  const dealId = randomUUID();
  const companyInsert = await admin.from("companies").insert({
    id: companyId,
    tenant_id: tenantId,
    name: `Mode 2 bank ${dealId}`,
    type: "bank",
  });
  assertNoError("companies", companyInsert.error);
  const dealInsert = await admin.from("deals").insert({
    id: dealId,
    tenant_id: tenantId,
    code: `M2-${dealId.slice(0, 8)}`,
    codename: "Mode 2 smoke deal",
    bank_id: companyId,
    mandate_owner_id: actorId,
  });
  assertNoError("deals", dealInsert.error);
  await grantDealStepsStructurePermission(admin, companyId, actorId);
  await grantDealMembership(admin, dealId, actorId);
  return { companyId, dealId };
}

async function createDraft(
  admin: SupabaseClient,
  dealId: string,
  actorId: string,
): Promise<string> {
  const draftId = randomUUID();
  const { error } = await admin.from("skill_authoring_drafts").insert({
    id: draftId,
    deal_id: dealId,
    author_id: actorId,
    phase_index: 0,
    placement_kind: "phase_end",
  });
  assertNoError("skill_authoring_drafts", error);
  return draftId;
}

async function createMessageAndAttempt(
  admin: SupabaseClient,
  draftId: string,
  actorId: string,
): Promise<string> {
  const messageId = randomUUID();
  const messageInsert = await admin.from("skill_authoring_messages").insert({
    id: messageId,
    draft_id: draftId,
    author_id: actorId,
    ordinal: 1,
    text: "mode 2 smoke message",
    client_message_id: randomUUID(),
    admitted_edit_revision: 0,
  });
  assertNoError("skill_authoring_messages", messageInsert.error);
  const attemptId = randomUUID();
  const attemptInsert = await admin.from("skill_authoring_attempts").insert({
    id: attemptId,
    draft_id: draftId,
    message_id: messageId,
    attempt_number: 1,
  });
  assertNoError("skill_authoring_attempts", attemptInsert.error);
  return attemptId;
}

async function createCandidateRow(
  admin: SupabaseClient,
  draftId: string,
  attemptId: string,
): Promise<string> {
  const candidateId = randomUUID();
  const { error } = await admin.from("skill_authoring_candidates").insert({
    id: candidateId,
    draft_id: draftId,
    attempt_id: attemptId,
    provider_candidate_id: RECOVERY_PROVIDER_CANDIDATE_ID,
    content_digest: RECOVERY_CANDIDATE_DIGEST,
    schema_version: 1,
    preview: { name: RECOVERY_CANDIDATE_NAME },
  });
  assertNoError("skill_authoring_candidates", error);
  return candidateId;
}

async function createDraftChain(
  admin: SupabaseClient,
  dealId: string,
  actorId: string,
) {
  const draftId = await createDraft(admin, dealId, actorId);
  const attemptId = await createMessageAndAttempt(admin, draftId, actorId);
  const candidateId = await createCandidateRow(admin, draftId, attemptId);
  return { draftId, candidateId };
}

async function createOperation(
  admin: SupabaseClient,
  dealId: string,
  draftId: string,
  actorId: string,
  candidateId: string,
): Promise<string> {
  const operationId = randomUUID();
  const { error } = await admin.from("skill_publication_operations").insert({
    id: operationId,
    deal_id: dealId,
    draft_id: draftId,
    actor_id: actorId,
    client_request_id: randomUUID(),
    candidate_id: candidateId,
    provider_candidate_id: RECOVERY_PROVIDER_CANDIDATE_ID,
    candidate_digest: RECOVERY_CANDIDATE_DIGEST,
    draft_edit_revision: 0,
    name: "Mode 2 smoke skill",
    phase_index: 0,
    placement_kind: "phase_end",
    reserved_skill_id: randomUUID(),
    reserved_step_key: `custom:${randomUUID()}`,
    capability_contract: recoveryCapabilityContract(),
  });
  assertNoError("skill_publication_operations", error);
  return operationId;
}

type CleanupIds = {
  operationId: string;
  draftId: string;
  dealId: string;
  companyId: string;
  actorId: string;
};

async function cleanupDraftChain(
  admin: SupabaseClient,
  draftId: string,
): Promise<void> {
  const candidates = await admin
    .from("skill_authoring_candidates")
    .delete()
    .eq("draft_id", draftId);
  assertNoError("skill_authoring_candidates", candidates.error);
  const attempts = await admin
    .from("skill_authoring_attempts")
    .delete()
    .eq("draft_id", draftId);
  assertNoError("skill_authoring_attempts", attempts.error);
  const messages = await admin
    .from("skill_authoring_messages")
    .delete()
    .eq("draft_id", draftId);
  assertNoError("skill_authoring_messages", messages.error);
  const drafts = await admin
    .from("skill_authoring_drafts")
    .delete()
    .eq("id", draftId);
  assertNoError("skill_authoring_drafts", drafts.error);
}

function buildCleanup(
  admin: SupabaseClient,
  ids: CleanupIds,
): () => Promise<void> {
  return async () => {
    const operations = await admin
      .from("skill_publication_operations")
      .delete()
      .eq("id", ids.operationId);
    assertNoError("skill_publication_operations", operations.error);
    await cleanupDraftChain(admin, ids.draftId);
    const auditLog = await admin
      .from("audit_log")
      .delete()
      .or(`actor_id.eq.${ids.actorId},deal_id.eq.${ids.dealId}`);
    assertNoError("audit_log", auditLog.error);
    const deals = await admin.from("deals").delete().eq("id", ids.dealId);
    assertNoError("deals", deals.error);
    const clearCompanyId = await admin
      .from("users")
      .update({ company_id: null })
      .eq("id", ids.actorId);
    assertNoError("users", clearCompanyId.error);
    const companies = await admin
      .from("companies")
      .delete()
      .eq("id", ids.companyId);
    assertNoError("companies", companies.error);
    const { error } = await admin.auth.admin.deleteUser(ids.actorId);
    assertNoError("auth.users", error);
  };
}

export async function buildMode2Context(
  url: string,
  serviceRoleKey: string,
): Promise<Mode2Context> {
  const admin = createMode2Client(url, serviceRoleKey);
  const tenantId = randomUUID();
  const actorId = await createActor(admin, tenantId);
  const { companyId, dealId } = await createDealChain(admin, tenantId, actorId);
  const { draftId, candidateId } = await createDraftChain(
    admin,
    dealId,
    actorId,
  );
  const operationId = await createOperation(
    admin,
    dealId,
    draftId,
    actorId,
    candidateId,
  );
  return {
    admin,
    operationId,
    cleanup: buildCleanup(admin, {
      operationId,
      draftId,
      dealId,
      companyId,
      actorId,
    }),
  };
}
