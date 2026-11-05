import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { classifyInternalUser, userCanAccessDeal } from "@/lib/api/v1/access";
import { hasCompanyPermissionChecked } from "@/lib/api/v1/companyAccess";
import {
  COMPANY_PERMISSION,
  type CompanyPermission,
} from "@/lib/constants/companyPermissions";
import { TABLE } from "@/lib/constants/tables";
import { loadDealByIdOrCode } from "@/lib/dataroom/steps";
import { requireFlag } from "@/lib/flags/requireFlag";
import type { FlagKey } from "@/lib/flags/keys";
import { isRecord, isUuid } from "@/lib/skillPublication/parse";

import { TemplateError } from "./types";

export type TemplateScope = { companyId: string; tenantId: string };

export type TemplateSourceScope = TemplateScope & { dealId: string };

const TEMPLATE_FLAGS: readonly FlagKey[] = [
  "rail_templates",
  "project_rail_model",
  "gate0_api_create",
];

const DENIED = "This company rail is not available to you.";
const DEAL_NOT_AVAILABLE = "That deal is not available.";

export async function requireTemplateFlags(): Promise<NextResponse | null> {
  for (const key of TEMPLATE_FLAGS) {
    const gate = await requireFlag(key);
    if (gate) return gate;
  }
  return null;
}

export function templateErrorResponse(
  error: unknown,
  requestId?: string,
): NextResponse {
  if (!(error instanceof TemplateError)) {
    return NextResponse.json(
      { error: "Unable to process this request." },
      { status: 500 },
    );
  }
  return NextResponse.json(
    {
      error: error.message,
      code: error.code,
      retryable: error.retryable,
      ...(requestId === undefined ? {} : { requestId }),
    },
    { status: error.status },
  );
}

export async function requireTemplateUse(
  admin: SupabaseClient,
  actorId: string,
  permission: CompanyPermission = COMPANY_PERMISSION.DEALS_CREATE,
): Promise<TemplateScope> {
  const scope = await internalScope(admin, actorId);
  await requirePermission(admin, actorId, scope.companyId, permission);
  return scope;
}

export async function requireTemplateSave(
  admin: SupabaseClient,
  actorId: string,
  sourceDealId: string,
): Promise<TemplateSourceScope> {
  const ref = await loadDealByIdOrCode(admin, sourceDealId).catch(() => null);
  if (!ref) {
    throw new TemplateError("not_found", DEAL_NOT_AVAILABLE);
  }
  // A caller with no seat and no oversight gets the missing-deal answer, so a
  // guessed code cannot tell a real deal from a made-up one (D65, #245). This
  // runs before the scope read, so that read's 'forbidden' reaches seated
  // callers only. Seated callers keep the 'forbidden' refusals below.
  if (!(await userCanAccessDeal(admin, actorId, ref.id))) {
    throw new TemplateError("not_found", DEAL_NOT_AVAILABLE);
  }
  const deal = await sourceScope(admin, ref.id);
  if ((await classifyInternalUser(admin, actorId)) !== "internal") {
    throw new TemplateError("forbidden", DENIED);
  }
  await requirePermission(
    admin,
    actorId,
    deal.companyId,
    COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE,
  );
  return deal;
}

async function sourceScope(
  admin: SupabaseClient,
  dealId: string,
): Promise<TemplateSourceScope> {
  const { data, error } = await admin
    .from(TABLE.DEALS)
    .select("bank_id, tenant_id")
    .eq("id", dealId)
    .maybeSingle();
  if (error || !isRecord(data) || !isUuid(data.bank_id)) {
    throw new TemplateError("forbidden", DENIED);
  }
  return {
    dealId,
    companyId: data.bank_id,
    tenantId: typeof data.tenant_id === "string" ? data.tenant_id : "",
  };
}

async function internalScope(
  admin: SupabaseClient,
  actorId: string,
): Promise<TemplateScope> {
  if ((await classifyInternalUser(admin, actorId)) !== "internal") {
    throw new TemplateError("forbidden", DENIED);
  }
  const { data, error } = await admin
    .from(TABLE.USERS)
    .select("company_id, tenant_id")
    .eq("id", actorId)
    .maybeSingle();
  if (error || !isRecord(data) || !isUuid(data.company_id)) {
    throw new TemplateError("forbidden", DENIED);
  }
  return {
    companyId: data.company_id,
    tenantId: typeof data.tenant_id === "string" ? data.tenant_id : "",
  };
}

async function requirePermission(
  admin: SupabaseClient,
  actorId: string,
  companyId: string,
  permission: CompanyPermission,
): Promise<void> {
  const allowed = await hasCompanyPermissionChecked(
    admin,
    actorId,
    companyId,
    permission,
  );
  if (allowed !== true) {
    throw new TemplateError("forbidden", DENIED);
  }
}
