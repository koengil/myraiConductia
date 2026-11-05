import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseSkillStepDefinitionV1 } from "@/lib/skillPublication/parse";
import { resolveStepBinding } from "@/lib/skillRun/step";
import { createProvisionedUser } from "@/lib/auth/provisioning";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

function requireAdmin(): SupabaseClient {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    throw new Error(
      "RUN_DB_TESTS=1 needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (local `supabase start` stack).",
    );
  }
  return createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function assertOk(table: string, error: { message: string } | null): void {
  if (error) throw new Error(`seed failed (${table}): ${error.message}`);
}

const userIds: string[] = [];
const companyIds: string[] = [];
const dealIds: string[] = [];

async function seedActor(admin: SupabaseClient, tenantId: string): Promise<string> {
  const user = await createProvisionedUser(admin, {
    email: `${randomUUID()}@attach.integration.test`,
    email_confirm: true,
    profile: { tenant_id: tenantId, full_name: "Attach Test Actor" },
  });
  userIds.push(user.id);
  return user.id;
}

async function seedBank(admin: SupabaseClient, tenantId: string): Promise<string> {
  const id = randomUUID();
  const { error } = await admin
    .from("companies")
    .insert({ id, tenant_id: tenantId, name: `Attach Bank ${id}`, type: "bank" });
  assertOk("companies", error);
  companyIds.push(id);
  return id;
}

async function seedDeal(
  admin: SupabaseClient,
  tenantId: string,
  bankId: string,
): Promise<string> {
  const id = randomUUID();
  const { error } = await admin.from("deals").insert({
    id,
    tenant_id: tenantId,
    code: `ATT-${id.slice(0, 8)}`,
    codename: `Attach deal ${id}`,
    bank_id: bankId,
  });
  assertOk("deals", error);
  dealIds.push(id);
  return id;
}

async function seedStep(
  admin: SupabaseClient,
  dealId: string,
  options: { removed?: boolean } = {},
): Promise<string> {
  const { data, error } = await admin
    .from("deal_steps")
    .insert({
      deal_id: dealId,
      step_id: `custom:${randomUUID()}`,
      status: "pending",
      origin: "custom",
      definition: {},
      removed_at: options.removed ? new Date().toISOString() : null,
    })
    .select("id")
    .single();
  assertOk("deal_steps", error);
  return (data as { id: string }).id;
}

type DraftBasis = {
  basisDealStepId: string | null;
  basis: Record<string, unknown> | null;
};

async function seedDraftChain(
  admin: SupabaseClient,
  dealId: string,
  actorId: string,
  basis: DraftBasis,
): Promise<{ draftId: string; candidateId: string }> {
  const draftId = randomUUID();
  const draftInsert = await admin.from("skill_authoring_drafts").insert({
    id: draftId,
    deal_id: dealId,
    author_id: actorId,
    basis_deal_step_id: basis.basisDealStepId,
    basis: basis.basis,
    phase_index: basis.basisDealStepId ? null : 0,
    placement_kind: basis.basisDealStepId ? null : "phase_end",
  });
  assertOk("skill_authoring_drafts", draftInsert.error);

  const messageId = randomUUID();
  const messageInsert = await admin.from("skill_authoring_messages").insert({
    id: messageId,
    draft_id: draftId,
    author_id: actorId,
    ordinal: 1,
    text: "improve this skill",
    client_message_id: randomUUID(),
    admitted_edit_revision: 0,
  });
  assertOk("skill_authoring_messages", messageInsert.error);

  const attemptId = randomUUID();
  const attemptInsert = await admin.from("skill_authoring_attempts").insert({
    id: attemptId,
    draft_id: draftId,
    message_id: messageId,
    attempt_number: 1,
    status: "succeeded",
  });
  assertOk("skill_authoring_attempts", attemptInsert.error);

  const candidateId = randomUUID();
  const providerCandidateId = randomUUID();
  const candidateInsert = await admin.from("skill_authoring_candidates").insert({
    id: candidateId,
    draft_id: draftId,
    attempt_id: attemptId,
    provider_candidate_id: providerCandidateId,
    content_digest: DIGEST_A,
    schema_version: 1,
    preview: {
      name: "attach-test-skill",
      purpose: "test",
      expectedInput: "in",
      expectedOutput: "out",
    },
  });
  assertOk("skill_authoring_candidates", candidateInsert.error);

  const linkUpdate = await admin
    .from("skill_authoring_drafts")
    .update({ current_candidate_id: candidateId })
    .eq("id", draftId);
  assertOk("skill_authoring_drafts", linkUpdate.error);

  return { draftId, candidateId };
}

async function seedOperation(
  admin: SupabaseClient,
  args: {
    dealId: string;
    draftId: string;
    actorId: string;
    candidateId: string;
    reservedSkillId: string;
    publishedVersionId: string;
  },
): Promise<string> {
  const { data: candidate, error: candidateError } = await admin
    .from("skill_authoring_candidates")
    .select("provider_candidate_id, content_digest")
    .eq("id", args.candidateId)
    .single();
  assertOk("skill_authoring_candidates", candidateError);
  const c = candidate as { provider_candidate_id: string; content_digest: string };

  const operationId = randomUUID();
  const { error } = await admin.from("skill_publication_operations").insert({
    id: operationId,
    deal_id: args.dealId,
    draft_id: args.draftId,
    actor_id: args.actorId,
    client_request_id: randomUUID(),
    state: "attaching",
    candidate_id: args.candidateId,
    provider_candidate_id: c.provider_candidate_id,
    candidate_digest: c.content_digest,
    draft_edit_revision: 0,
    name: "Attach test skill",
    phase_index: 0,
    placement_kind: "phase_end",
    reserved_skill_id: args.reservedSkillId,
    reserved_step_key: `custom:${randomUUID()}`,
    capability_contract: { purpose: "test", expectedInput: "in", expectedOutput: "out" },
    published_skill_id: args.reservedSkillId,
    published_version_id: args.publishedVersionId,
    published_digest: c.content_digest,
  });
  assertOk("skill_publication_operations", error);
  return operationId;
}

async function seedBinding(
  admin: SupabaseClient,
  args: {
    dealStepId: string;
    dealId: string;
    actorId: string;
    skillId: string;
    versionId: string;
    digest: string;
    source: "publication" | "selection";
  },
): Promise<void> {
  const { error } = await admin.from("deal_step_skill_bindings").insert({
    deal_step_id: args.dealStepId,
    deal_id: args.dealId,
    kind: "publication",
    skill_id: args.skillId,
    version_id: args.versionId,
    digest: args.digest,
    bound_by: args.actorId,
    source: args.source,
  });
  assertOk("deal_step_skill_bindings", error);
}

type AttachOutcome = {
  view: Record<string, unknown>;
  operation: Record<string, unknown>;
  stepCount: number;
  binding: Record<string, unknown> | null;
  auditActions: string[];
  resultingStep: Record<string, unknown> | null;
};

async function callAttach(
  admin: SupabaseClient,
  dealId: string,
  operationId: string,
  basisDealStepId: string | null,
): Promise<AttachOutcome> {
  const { data, error } = await admin.rpc("skill_publication_attach", {
    p_publication_id: operationId,
  });
  if (error) throw new Error(`skill_publication_attach failed: ${error.message}`);

  const { data: operation } = await admin
    .from("skill_publication_operations")
    .select("*")
    .eq("id", operationId)
    .single();
  const { data: steps } = await admin
    .from("deal_steps")
    .select("id")
    .eq("deal_id", dealId);
  const { data: binding } = basisDealStepId
    ? await admin
        .from("deal_step_skill_bindings")
        .select("*")
        .eq("deal_step_id", basisDealStepId)
        .maybeSingle()
    : { data: null };
  const { data: audit } = await admin
    .from("audit_log")
    .select("action")
    .eq("deal_id", dealId);

  const op = operation as Record<string, unknown>;
  const resultingStepId = op.resulting_deal_step_id as string | null;
  const { data: resultingStep } = resultingStepId
    ? await admin.from("deal_steps").select("*").eq("id", resultingStepId).maybeSingle()
    : { data: null };

  return {
    view: data as Record<string, unknown>,
    operation: op,
    stepCount: (steps ?? []).length,
    binding: binding as Record<string, unknown> | null,
    auditActions: (audit ?? []).map((row) => (row as { action: string }).action),
    resultingStep: resultingStep as Record<string, unknown> | null,
  };
}

afterAll(async () => {
  if (!RUN_DB_TESTS) return;
  const admin = requireAdmin();
  for (const dealId of dealIds) {
    await admin.from("audit_log").delete().eq("deal_id", dealId);
    await admin.from("skill_publication_operations").delete().eq("deal_id", dealId);
    await admin.from("deal_step_skill_bindings").delete().eq("deal_id", dealId);
    await admin
      .from("skill_authoring_candidates")
      .delete()
      .in(
        "draft_id",
        (
          await admin.from("skill_authoring_drafts").select("id").eq("deal_id", dealId)
        ).data?.map((row) => (row as { id: string }).id) ?? [],
      );
    await admin
      .from("skill_authoring_attempts")
      .delete()
      .in(
        "draft_id",
        (
          await admin.from("skill_authoring_drafts").select("id").eq("deal_id", dealId)
        ).data?.map((row) => (row as { id: string }).id) ?? [],
      );
    await admin
      .from("skill_authoring_messages")
      .delete()
      .in(
        "draft_id",
        (
          await admin.from("skill_authoring_drafts").select("id").eq("deal_id", dealId)
        ).data?.map((row) => (row as { id: string }).id) ?? [],
      );
    await admin.from("skill_authoring_drafts").delete().eq("deal_id", dealId);
    await admin.from("deal_steps").delete().eq("deal_id", dealId);
    await admin.from("deals").delete().eq("id", dealId);
  }
  for (const companyId of companyIds) {
    await admin.from("companies").delete().eq("id", companyId);
  }
  for (const userId of userIds) {
    await admin.auth.admin.deleteUser(userId);
  }
});

describe.skipIf(!RUN_DB_TESTS)("skill_publication_attach basis rebind", () => {
  it("rebinds the basis step instead of inserting a new one", async () => {
    const admin = requireAdmin();
    const tenantId = randomUUID();
    const actorId = await seedActor(admin, tenantId);
    const bankId = await seedBank(admin, tenantId);
    const dealId = await seedDeal(admin, tenantId, bankId);
    const stepId = await seedStep(admin, dealId);

    const reservedSkillId = randomUUID();
    const versionId = randomUUID();
    const { draftId, candidateId } = await seedDraftChain(admin, dealId, actorId, {
      basisDealStepId: stepId,
      basis: { kind: "publication", skillId: reservedSkillId, versionId: randomUUID(), digest: DIGEST_B },
    });
    const operationId = await seedOperation(admin, {
      dealId,
      draftId,
      actorId,
      candidateId,
      reservedSkillId,
      publishedVersionId: versionId,
    });

    const result = await callAttach(admin, dealId, operationId, stepId);

    expect(result.view.state).toBe("published");
    expect(result.operation.resulting_deal_step_id).toBe(stepId);
    expect(result.stepCount).toBe(1);
    expect(result.binding).toMatchObject({
      kind: "publication",
      skill_id: reservedSkillId,
      version_id: versionId,
      source: "publication",
    });
    expect(result.auditActions).toContain("rail.step_rebound");

    const resolved = resolveStepBinding(
      { id: stepId, step_id: (result.resultingStep as { step_id: string }).step_id, removed_at: null, origin: "custom", definition: null },
      result.binding,
      null,
      null,
      null,
    );
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.step.binding).toEqual({
        kind: "publication",
        skillId: reservedSkillId,
        versionId,
        digest: DIGEST_A,
      });
    }
  });

  it("still inserts a step for a creation draft", async () => {
    const admin = requireAdmin();
    const tenantId = randomUUID();
    const actorId = await seedActor(admin, tenantId);
    const bankId = await seedBank(admin, tenantId);
    const dealId = await seedDeal(admin, tenantId, bankId);

    const reservedSkillId = randomUUID();
    const versionId = randomUUID();
    const { draftId, candidateId } = await seedDraftChain(admin, dealId, actorId, {
      basisDealStepId: null,
      basis: null,
    });
    const operationId = await seedOperation(admin, {
      dealId,
      draftId,
      actorId,
      candidateId,
      reservedSkillId,
      publishedVersionId: versionId,
    });

    const result = await callAttach(admin, dealId, operationId, null);

    expect(result.view.state).toBe("published");
    expect(result.stepCount).toBe(1);
    expect(result.operation.resulting_deal_step_id).toBeTruthy();

    const parsed = parseSkillStepDefinitionV1(
      (result.resultingStep as { definition: unknown }).definition,
    );
    expect("error" in parsed).toBe(false);
    if (!("error" in parsed)) {
      expect(Object.keys(parsed.skillBinding).sort()).toEqual([
        "digest",
        "skillId",
        "versionId",
      ]);
      expect(parsed.skillBinding).toEqual({
        skillId: reservedSkillId,
        versionId,
        digest: DIGEST_A,
      });
    }
  });

  it("reconciles when the basis step was rebound by someone else first", async () => {
    const admin = requireAdmin();
    const tenantId = randomUUID();
    const actorId = await seedActor(admin, tenantId);
    const bankId = await seedBank(admin, tenantId);
    const dealId = await seedDeal(admin, tenantId, bankId);
    const stepId = await seedStep(admin, dealId);

    const ancestorSkillId = randomUUID();
    const ancestorVersionId = randomUUID();
    const otherVersionId = randomUUID();

    await seedBinding(admin, {
      dealStepId: stepId,
      dealId,
      actorId,
      skillId: ancestorSkillId,
      versionId: otherVersionId,
      digest: DIGEST_C,
      source: "selection",
    });

    const { draftId, candidateId } = await seedDraftChain(admin, dealId, actorId, {
      basisDealStepId: stepId,
      basis: {
        kind: "publication",
        skillId: ancestorSkillId,
        versionId: ancestorVersionId,
        digest: DIGEST_B,
      },
    });
    const newVersionId = randomUUID();
    const operationId = await seedOperation(admin, {
      dealId,
      draftId,
      actorId,
      candidateId,
      reservedSkillId: ancestorSkillId,
      publishedVersionId: newVersionId,
    });

    const result = await callAttach(admin, dealId, operationId, stepId);

    expect(result.view.state).toBe("reconciling");
    expect(result.view.error).toMatchObject({ code: "receipt_conflict" });
    expect(result.binding).toMatchObject({ version_id: otherVersionId, source: "selection" });
  });

  it("needs placement when the basis step was removed underneath the draft", async () => {
    const admin = requireAdmin();
    const tenantId = randomUUID();
    const actorId = await seedActor(admin, tenantId);
    const bankId = await seedBank(admin, tenantId);
    const dealId = await seedDeal(admin, tenantId, bankId);
    const stepId = await seedStep(admin, dealId, { removed: true });

    const reservedSkillId = randomUUID();
    const versionId = randomUUID();
    const { draftId, candidateId } = await seedDraftChain(admin, dealId, actorId, {
      basisDealStepId: stepId,
      basis: { kind: "publication", skillId: reservedSkillId, versionId: randomUUID(), digest: DIGEST_B },
    });
    const operationId = await seedOperation(admin, {
      dealId,
      draftId,
      actorId,
      candidateId,
      reservedSkillId,
      publishedVersionId: versionId,
    });

    const result = await callAttach(admin, dealId, operationId, stepId);

    expect(result.view.state).toBe("needs_placement");
    expect(result.view.error).toMatchObject({ code: "step_removed" });
  });
});
