import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { jsonError, requireApiUser } from "@/lib/api/v1/http";
import { requireFlag } from "@/lib/api/v1/requireFlag";
import { SKILL_RUN_SOURCE } from "@/lib/constants/dealSteps";
import { TABLE } from "@/lib/constants/tables";
import { IgnatiousRequestError } from "@/lib/ignatious/control-plane";
import { ignatiousErrorResponse } from "@/lib/ignatious/routeContext";
import type { TurnSeedRun } from "@/lib/skillAuthoring/ignatiousAuthoring";
import { requireSkillAuthoringAccess } from "@/lib/skillAuthoring/access";
import {
  callRpc,
  correlationId,
  normalizeReceipt,
  type ReceiptBasis,
  type RpcClient,
} from "@/lib/skillAuthoring/browserRoute";
import { parseInputValues } from "@/lib/skillRun/inputs";
import { prepareTeachingOffer } from "@/lib/skillRun/teachingStore";
import { resolveStepBinding } from "@/lib/skillRun/step";
import { parseSkillReference, readStep, resolveMountTripleForStep } from "@/lib/skillRun/versions";

type RouteContext = { params: Promise<{ dealId: string }> };

const BINDING_COLUMNS = "kind, skill_id, version_id, mount_name, mount_version, digest";

async function readBinding(
  admin: SupabaseClient,
  dealStepId: string,
): Promise<Record<string, unknown> | null> {
  const { data } = await admin
    .from(TABLE.DEAL_STEP_SKILL_BINDINGS)
    .select(BINDING_COLUMNS)
    .eq("deal_step_id", dealStepId)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

async function readSeedRun(
  admin: SupabaseClient,
  seedRunId: string,
  dealId: string,
  dealStepId: string | null,
): Promise<TurnSeedRun | null> {
  let query = admin
    .from(TABLE.DEAL_STEP_SKILL_RUNS)
    .select("input, inputs, result_text, error_message")
    .eq("id", seedRunId)
    .eq("deal_id", dealId)
    .neq("source", SKILL_RUN_SOURCE.REVISION);
  if (dealStepId) query = query.eq("deal_step_id", dealStepId);
  const { data } = await query.maybeSingle();
  if (!data) return null;
  const row = data as Record<string, unknown>;
  const text =
    typeof row.result_text === "string"
      ? row.result_text
      : typeof row.error_message === "string"
        ? row.error_message
        : "";
  return {
    input: typeof row.input === "string" ? row.input : "",
    inputs: parseInputValues(row.inputs) ?? {},
    output: text,
  };
}

async function readStoredBasis(
  admin: SupabaseClient,
  draftId: string,
): Promise<Record<string, unknown> | null> {
  const { data } = await admin
    .from(TABLE.SKILL_AUTHORING_DRAFTS)
    .select("basis, basis_deal_step_id, seed_run_id")
    .eq("id", draftId)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

function draftIdOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const draft = (value as { draft?: unknown }).draft;
  if (!draft || typeof draft !== "object") return null;
  const id = (draft as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

export async function POST(request: Request, context: RouteContext) {
  const flag = await requireFlag("skill_authoring");
  if (flag) return flag;
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;
  const { dealId } = await context.params;
  const correlation = correlationId(request);
  const access = await requireSkillAuthoringAccess(
    auth.admin,
    auth.user.id,
    dealId,
    correlation,
  );
  if (!access.ok) return jsonError(access.message, access.status);

  let raw: unknown = null;
  try {
    raw = await request.json();
  } catch {
    raw = null;
  }
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const basisStepId = typeof body.basisStepId === "string" ? body.basisStepId : null;
  const seedRunId = typeof body.seedRunId === "string" ? body.seedRunId : null;
  const teach = body.teach === true;

  if (teach) {
    const revisionsFlag = await requireFlag("skill_output_revisions");
    if (revisionsFlag) return revisionsFlag;
  }

  const receiptBasis: ReceiptBasis = {
    basis: null,
    basisStepId: null,
    seedRunId: null,
    seedRun: null,
  };

  if (basisStepId) {
    const row = await readStep(auth.admin, access.deal.id, basisStepId);
    const binding =
      row && typeof row.id === "string" ? await readBinding(auth.admin, row.id) : null;

    let mount: { name: string; version: number; digest: string } | null;
    try {
      mount = await resolveMountTripleForStep(basisStepId);
    } catch (error) {
      if (error instanceof IgnatiousRequestError) return ignatiousErrorResponse(error);
      throw error;
    }

    const resolved = resolveStepBinding(
      row,
      binding,
      mount?.name ?? null,
      mount?.version ?? null,
      mount?.digest ?? null,
    );
    if (!resolved.ok) {
      return resolved.code === "not_found"
        ? jsonError("Unknown step", 404)
        : jsonError("This step has no skill attached", 409);
    }

    receiptBasis.basis = resolved.step.binding;
    receiptBasis.basisStepId = resolved.step.dealStepId;
  }

  let resolvedSeedRunId: string | null = null;
  if (seedRunId) {
    const seedRun = await readSeedRun(
      auth.admin,
      seedRunId,
      access.deal.id,
      receiptBasis.basisStepId,
    );
    if (seedRun) {
      receiptBasis.seedRun = seedRun;
      receiptBasis.seedRunId = seedRunId;
      resolvedSeedRunId = seedRunId;
    }
  }

  if (teach && (!receiptBasis.basisStepId || !resolvedSeedRunId)) {
    return jsonError("Teaching the skill needs the step and the run it reviewed.", 422);
  }

  const openDraft = () =>
    callRpc(auth.admin as unknown as RpcClient, "skill_authoring_get_or_create_draft", {
      p_actor_id: auth.user.id,
      p_deal_id: access.deal.id,
      p_correlation_id: correlation,
      p_basis_deal_step_id: receiptBasis.basisStepId,
      p_basis: receiptBasis.basis,
      p_seed_run_id: resolvedSeedRunId,
    });

  let result = await openDraft();
  if ("response" in result) return result.response;

  const draftId = draftIdOf(result.data);

  if (teach && draftId && receiptBasis.basisStepId && resolvedSeedRunId) {
    const offer = await prepareTeachingOffer(auth.admin, {
      dealStepId: receiptBasis.basisStepId,
      seedRunId: resolvedSeedRunId,
      draftId,
    });
    if (offer === "unreadable") return jsonError("The comments could not be read.", 500);
    let offered: Awaited<ReturnType<typeof callRpc>> | null = null;
    if (offer) {
      offered = await callRpc(
        auth.admin as unknown as RpcClient,
        "skill_teaching_offer",
        {
          p_actor_id: auth.user.id,
          p_deal_id: access.deal.id,
          p_draft_id: draftId,
          p_edits: offer.edits,
          p_prompt: offer.prompt,
          p_correlation_id: correlation,
        },
      );
      if ("response" in offered && offered.response.status !== 409) return offered.response;
    }
    if (offered && "data" in offered) {
      result = offered;
    } else {
      const fresh = await openDraft();
      if ("response" in fresh) return fresh.response;
      result = fresh;
    }
  }

  const echoed = draftId
    ? await storedBasisOf(auth.admin, draftId, access.deal.id, receiptBasis)
    : receiptBasis;

  const receipt = normalizeReceipt(result.data, echoed);
  if (!receipt)
    return jsonError("Unable to process skill authoring request.", 500);
  return NextResponse.json(receipt);
}

async function storedBasisOf(
  admin: SupabaseClient,
  draftId: string,
  dealId: string,
  fallback: ReceiptBasis,
): Promise<ReceiptBasis> {
  const stored = await readStoredBasis(admin, draftId);
  if (!stored) return fallback;

  const basis = parseSkillReference(stored.basis);
  const basisStepId =
    typeof stored.basis_deal_step_id === "string" ? stored.basis_deal_step_id : null;
  if (!basis || !basisStepId) {
    return { basis: null, basisStepId: null, seedRunId: null, seedRun: null };
  }

  const storedSeedRunId =
    typeof stored.seed_run_id === "string" ? stored.seed_run_id : null;
  if (storedSeedRunId === null) {
    return { basis, basisStepId, seedRunId: null, seedRun: null };
  }
  if (storedSeedRunId === fallback.seedRunId) {
    return { basis, basisStepId, seedRunId: storedSeedRunId, seedRun: fallback.seedRun };
  }
  const seedRun = await readSeedRun(admin, storedSeedRunId, dealId, basisStepId);
  return { basis, basisStepId, seedRunId: storedSeedRunId, seedRun };
}
