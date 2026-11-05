import type { SupabaseClient } from "@supabase/supabase-js";
import { classifyInternalUser, userCanAccessDeal } from "@/lib/api/v1/access";
import { hasCompanyPermissionChecked } from "@/lib/api/v1/companyAccess";
import { COMPANY_PERMISSION } from "@/lib/constants/companyPermissions";
import { loadDealByIdOrCode } from "@/lib/dataroom/steps";

export type SkillAuthoringAccess =
  | { ok: true; deal: { id: string; bankId: string }; userId: string }
  | { ok: false; status: 403 | 404; message: string; hidden?: true };

/**
 * `hidden`: the caller has no seat on the deal and no oversight of it. They
 * get the missing-deal answer, never a 403 that would confirm the deal exists
 * (decision-log D65), but the refusal is still audited as a denial.
 */
type AuthorDecision = "allowed" | "denied" | "hidden" | "undecided";

const denied = (): SkillAuthoringAccess => ({
  ok: false,
  status: 403,
  message: "Not permitted.",
});

const DEAL_NOT_FOUND = "Deal not found.";

export async function requireSkillAuthoringAccess(
  admin: SupabaseClient,
  userId: string,
  dealId: string,
  correlationId: string,
): Promise<SkillAuthoringAccess> {
  const deal = await resolvedDeal(admin, dealId);
  if (!deal) return { ok: false, status: 404, message: DEAL_NOT_FOUND };
  const bankId = await dealBankId(admin, deal.id);
  if (!bankId) return denied();
  const decision = await canAuthor(admin, userId, deal.id, bankId);
  if (decision === "allowed") {
    return { ok: true, deal: { id: deal.id, bankId }, userId };
  }
  if (decision === "denied" || decision === "hidden") {
    await writeDenialAudit(admin, userId, deal.id, correlationId);
  }
  if (decision === "hidden") {
    return { ok: false, status: 404, message: DEAL_NOT_FOUND, hidden: true };
  }
  return denied();
}

async function resolvedDeal(
  admin: SupabaseClient,
  dealId: string,
): Promise<{ id: string } | null> {
  try {
    return await loadDealByIdOrCode(admin, dealId);
  } catch {
    return null;
  }
}

async function dealBankId(
  admin: SupabaseClient,
  dealId: string,
): Promise<string | null> {
  try {
    const { data: deal, error: dealError } = await admin
      .from("deals")
      .select("bank_id")
      .eq("id", dealId)
      .maybeSingle();
    return dealError || !deal?.bank_id ? null : (deal.bank_id as string);
  } catch {
    return null;
  }
}

async function canAuthor(
  admin: SupabaseClient,
  userId: string,
  dealId: string,
  bankId: string,
): Promise<AuthorDecision> {
  let hasDealAccess: boolean;
  try {
    hasDealAccess = await userCanAccessDeal(admin, userId, dealId);
  } catch {
    return "undecided";
  }
  if (!hasDealAccess) return "hidden";

  let classification: Awaited<ReturnType<typeof classifyInternalUser>>;
  try {
    classification = await classifyInternalUser(admin, userId);
  } catch {
    return "undecided";
  }
  if (classification === "error") return "undecided";
  if (classification !== "internal") return "denied";

  let permission: Awaited<ReturnType<typeof hasCompanyPermissionChecked>>;
  try {
    permission = await hasCompanyPermissionChecked(
      admin,
      userId,
      bankId,
      COMPANY_PERMISSION.DEAL_STEPS_STRUCTURE,
    );
  } catch {
    return "undecided";
  }
  if (permission === "unreadable") return "undecided";
  return permission ? "allowed" : "denied";
}

async function writeDenialAudit(
  admin: SupabaseClient,
  actorId: string,
  dealId: string,
  correlationId: string,
): Promise<void> {
  try {
    await admin.rpc("skill_authoring_write_audit", {
      p_actor_id: actorId,
      p_action: "skill_authoring.access_denied",
      p_deal_id: dealId,
      p_detail: { actorId, correlationId },
    });
  } catch {
    return;
  }
}
