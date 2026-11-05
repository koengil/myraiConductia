import { jsonError } from "@/lib/api/v1/http";
import { readJson } from "@/lib/skillAuthoring/browserRoute";
import {
  finalizeCommand,
  guardPublicationCommand,
  respondToRpcFailure,
} from "@/lib/skillPublication/browserCommandRoute";
import { parsePlacementCommand } from "@/lib/skillPublication/parse";

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

  const command = parsePlacementCommand(await readJson(request));
  if ("error" in command) return jsonError(command.error, 422);

  const placement = command.placement;
  const { data, error } = await guard.admin.rpc(
    "skill_publication_replace_placement",
    {
      p_actor_id: guard.userId,
      p_deal_id: guard.dealId,
      p_publication_id: publicationId,
      p_expected_revision: command.expectedRevision,
      p_phase_index: placement.phaseIndex,
      p_placement_kind: placement.kind,
      p_anchor_deal_step_id:
        placement.kind === "after" ? placement.afterStepId : null,
      p_correlation_id: guard.correlation,
    },
  );
  if (error) return respondToRpcFailure(guard, error, { publicationId });

  return finalizeCommand(guard, publicationId, {
    advance: true,
    commandView: data,
  });
}
