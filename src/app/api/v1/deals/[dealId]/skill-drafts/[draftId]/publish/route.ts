import { jsonError } from "@/lib/api/v1/http";
import { readJson } from "@/lib/skillAuthoring/browserRoute";
import {
  finalizeCommand,
  guardPublicationCommand,
  respondToRpcFailure,
} from "@/lib/skillPublication/browserCommandRoute";
import { parsePublishCommand } from "@/lib/skillPublication/parse";

type RouteContext = {
  params: Promise<{ dealId: string; draftId: string }>;
};

function publicationIdFromView(data: unknown): string | null {
  if (
    data &&
    typeof data === "object" &&
    typeof (data as { id?: unknown }).id === "string"
  ) {
    return (data as { id: string }).id;
  }
  return null;
}

export async function POST(request: Request, context: RouteContext) {
  const { dealId, draftId } = await context.params;
  const guard = await guardPublicationCommand(request, dealId, {
    key: "draftId",
    value: draftId,
  });
  if (!guard.ok) return guard.response;

  const command = parsePublishCommand(await readJson(request));
  if ("error" in command) return jsonError(command.error, 422);

  const { data, error } = await guard.admin.rpc("skill_publication_admit", {
    p_actor_id: guard.userId,
    p_deal_id: guard.dealId,
    p_draft_id: draftId,
    p_client_request_id: command.requestId,
    p_expected_edit_revision: command.expectedEditRevision,
    p_candidate_id: command.candidateId,
    p_candidate_digest: command.candidateDigest,
    p_correlation_id: guard.correlation,
  });
  if (error) return respondToRpcFailure(guard, error, { draftId });

  const publicationId = publicationIdFromView(data);
  if (!publicationId) {
    return jsonError("Unable to process the skill save request.", 500);
  }
  return finalizeCommand(guard, publicationId, {
    advance: true,
    commandView: data,
  });
}
