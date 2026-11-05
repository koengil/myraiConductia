import { after, NextResponse } from "next/server";
import { isUuid, jsonError, requireApiUser } from "@/lib/api/v1/http";
import { requireFlag } from "@/lib/api/v1/requireFlag";
import { requireSkillAuthoringAccess } from "@/lib/skillAuthoring/access";
import { parseMessageCommand } from "@/lib/skillAuthoring/parse";
import {
  defaultTurnDeps,
  runAuthoringTurn,
} from "@/lib/skillAuthoring/runTurn";
import { authoringUsageRecorder } from "@/lib/skillAuthoring/authoringUsage";
import {
  callRpc,
  correlationId,
  isParsedError,
  normalizeSendReceipt,
  readJson,
  type RpcClient,
} from "@/lib/skillAuthoring/browserRoute";

export const maxDuration = 300;

type RouteContext = { params: Promise<{ dealId: string; draftId: string }> };

function authorAccess(
  auth: {
    admin: Parameters<typeof requireSkillAuthoringAccess>[0];
    user: { id: string };
  },
  dealId: string,
  correlation: string,
) {
  return requireSkillAuthoringAccess(
    auth.admin,
    auth.user.id,
    dealId,
    correlation,
  );
}

export async function POST(request: Request, context: RouteContext) {
  const flag = await requireFlag("skill_authoring");
  if (flag) return flag;
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;
  const { dealId, draftId } = await context.params;
  const correlation = correlationId(request);
  const access = await authorAccess(auth, dealId, correlation);
  if (!access.ok) return jsonError(access.message, access.status);
  if (!isUuid(draftId)) return jsonError("Draft not found.", 404);
  const command = parseMessageCommand(await readJson(request));
  if (isParsedError(command)) return jsonError(command.error, 400);

  const result = await callRpc(
    auth.admin as unknown as RpcClient,
    "skill_authoring_submit_message",
    {
      p_actor_id: auth.user.id,
      p_deal_id: access.deal.id,
      p_draft_id: draftId,
      p_expected_revision: command.expectedEditRevision,
      p_client_message_id: command.clientMessageId,
      p_text: command.text,
      p_correlation_id: correlation,
    },
  );
  if ("response" in result) return result.response;

  const receipt = normalizeSendReceipt(result.data);
  if (!receipt)
    return jsonError("Unable to process skill authoring request.", 500);
  if (receipt.created) {
    const deps = defaultTurnDeps(
      auth.admin as unknown as RpcClient,
      access.deal.id,
      authoringUsageRecorder(auth.admin, { actorId: auth.user.id, dealId: access.deal.id }),
    );
    after(() => runAuthoringTurn(receipt.attemptId, deps));
  }
  return NextResponse.json(receipt);
}
