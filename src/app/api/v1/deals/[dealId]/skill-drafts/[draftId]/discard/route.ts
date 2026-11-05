import { NextResponse } from "next/server";
import { isUuid, jsonError, requireApiUser } from "@/lib/api/v1/http";
import { requireFlag } from "@/lib/api/v1/requireFlag";
import { requireSkillAuthoringAccess } from "@/lib/skillAuthoring/access";
import { parseDiscardCommand } from "@/lib/skillAuthoring/parse";
import {
  callRpc,
  correlationId,
  isParsedError,
  normalizeReceipt,
  readJson,
  type RpcClient,
} from "@/lib/skillAuthoring/browserRoute";

type RouteContext = { params: Promise<{ dealId: string; draftId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const flag = await requireFlag("skill_authoring");
  if (flag) return flag;
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;
  const { dealId, draftId } = await context.params;
  const correlation = correlationId(request);
  const access = await requireSkillAuthoringAccess(
    auth.admin,
    auth.user.id,
    dealId,
    correlation,
  );
  if (!access.ok) return jsonError(access.message, access.status);
  if (!isUuid(draftId)) return jsonError("Draft not found.", 404);
  const command = parseDiscardCommand(await readJson(request));
  if (isParsedError(command)) return jsonError(command.error, 400);

  const result = await callRpc(
    auth.admin as unknown as RpcClient,
    "skill_authoring_discard_draft",
    {
      p_actor_id: auth.user.id,
      p_deal_id: access.deal.id,
      p_draft_id: draftId,
      p_expected_revision: command.expectedEditRevision,
      p_correlation_id: correlation,
    },
  );
  if ("response" in result) return result.response;
  const receipt = normalizeReceipt(result.data);
  if (!receipt)
    return jsonError("Unable to process skill authoring request.", 500);
  return NextResponse.json(receipt);
}
