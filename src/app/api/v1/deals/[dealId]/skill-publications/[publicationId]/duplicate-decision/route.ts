import { jsonError } from "@/lib/api/v1/http";
import { readJson } from "@/lib/skillAuthoring/browserRoute";
import {
  finalizeCommand,
  guardPublicationCommand,
  respondToRpcFailure,
} from "@/lib/skillPublication/browserCommandRoute";
import { parseDuplicateDecisionCommand } from "@/lib/skillPublication/parse";

type RouteContext = {
  params: Promise<{ dealId: string; publicationId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { dealId, publicationId } = await context.params;
  const guard = await guardPublicationCommand(request, dealId, {
    key: "publicationId",
    value: publicationId,
  });
  if (!guard.ok) return guard.response;

  const command = parseDuplicateDecisionCommand(await readJson(request));
  if ("error" in command) return jsonError(command.error, 422);

  const { data, error } = await guard.admin.rpc(
    "skill_publication_decide_duplicate",
    {
      p_actor_id: guard.userId,
      p_deal_id: guard.dealId,
      p_publication_id: publicationId,
      p_expected_revision: command.expectedRevision,
      p_assessment_digest: command.assessmentDigest,
      p_decision: command.decision,
      p_correlation_id: guard.correlation,
    },
  );
  if (error) return respondToRpcFailure(guard, error, { publicationId });

  return finalizeCommand(guard, publicationId, {
    advance: command.decision === "confirm",
    commandView: data,
  });
}
