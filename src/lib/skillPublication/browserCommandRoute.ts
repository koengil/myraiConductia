import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse, after } from "next/server";
import { isUuid, jsonError, requireApiUser } from "@/lib/api/v1/http";
import { requireFlag } from "@/lib/api/v1/requireFlag";
import { requireSkillAuthoringAccess } from "@/lib/skillAuthoring/access";
import { correlationId } from "@/lib/skillAuthoring/browserRoute";
import {
  writeSkillPublicationDenialAudit,
  type SkillPublicationDenialAuditInput,
} from "./audit";
import {
  classifyPublicationRpcError,
  publicationRpcOutcomeResponse,
  type PublicationRpcError,
} from "./conflictResponse";
import { parsePublicationRead } from "./parsePublicationRead";
import { advancePublication, drivePublication } from "./processor";
import type { PublicationRead } from "./types";

export type PublicationCommandContext = {
  admin: SupabaseClient;
  userId: string;
  dealId: string;
  correlation: string;
};

export type PublicationGuardResult =
  | ({ ok: true } & PublicationCommandContext)
  | { ok: false; response: NextResponse };

export type PublicationResource = {
  key: "draftId" | "publicationId";
  value: string;
};

async function safeAuditDenial(
  admin: SupabaseClient,
  input: SkillPublicationDenialAuditInput,
): Promise<void> {
  try {
    await writeSkillPublicationDenialAudit(admin, input);
  } catch {
    console.error("[skill_publication_audit]", {
      code: "SKILL_PUBLICATION_DENIAL_AUDIT_FAILED",
      correlationId: input.correlationId,
    });
  }
}

function logPublicationRouteEvent(
  publicationId: string,
  correlation: string,
  reasonCode: string,
): void {
  console.error("[skill_publication_route]", {
    publicationId,
    correlationId: correlation,
    reasonCode,
  });
}

function resolvedDenialDealId(
  access: { status: 403 | 404 | 500; message: string; hidden?: true },
  dealIdParam: string,
): string | null {
  const resolved =
    "deal" in access
      ? (access as { deal?: { id?: unknown } }).deal?.id
      : undefined;
  if (typeof resolved === "string") return resolved;
  return isUuid(dealIdParam) ? dealIdParam : null;
}

async function auditAccessDenial(
  admin: SupabaseClient,
  userId: string,
  dealId: string | null,
  resource: PublicationResource,
  correlation: string,
): Promise<void> {
  await safeAuditDenial(admin, {
    actorId: userId,
    dealId,
    draftId: resource.key === "draftId" ? resource.value : undefined,
    publicationId:
      resource.key === "publicationId" ? resource.value : undefined,
    correlationId: correlation,
    reasonCode: "access_denied",
  });
}

type AuthenticatedCommand = {
  admin: SupabaseClient;
  user: { id: string };
};

async function authenticateCommand(
  request: Request,
  resource: PublicationResource,
): Promise<
  | { auth: AuthenticatedCommand; correlation: string }
  | { response: NextResponse }
> {
  const flag = await requireFlag("skill_authoring");
  if (flag) return { response: flag };
  const auth = await requireApiUser();
  if (!auth.ok) return { response: auth.response };
  const correlation = correlationId(request);
  if (!isUuid(resource.value)) {
    return { response: jsonError("Not found", 404) };
  }
  return { auth, correlation };
}

async function denyAccess(
  auth: AuthenticatedCommand,
  dealIdParam: string,
  resource: PublicationResource,
  correlation: string,
  access: { status: 403 | 404 | 500; message: string; hidden?: true },
): Promise<PublicationGuardResult> {
  // A hidden deal answers 404 like a missing one, but it is still a refusal.
  if (access.status === 403 || access.hidden) {
    await auditAccessDenial(
      auth.admin,
      auth.user.id,
      resolvedDenialDealId(access, dealIdParam),
      resource,
      correlation,
    );
  }
  return { ok: false, response: jsonError(access.message, access.status) };
}

export async function guardPublicationCommand(
  request: Request,
  dealIdParam: string,
  resource: PublicationResource,
): Promise<PublicationGuardResult> {
  const authenticated = await authenticateCommand(request, resource);
  if ("response" in authenticated) {
    return { ok: false, response: authenticated.response };
  }
  const { auth, correlation } = authenticated;
  const access = await requireSkillAuthoringAccess(
    auth.admin,
    auth.user.id,
    dealIdParam,
    correlation,
  );
  if (!access.ok) {
    return denyAccess(auth, dealIdParam, resource, correlation, access);
  }
  return {
    ok: true,
    admin: auth.admin,
    userId: auth.user.id,
    dealId: access.deal.id,
    correlation,
  };
}

export async function respondToRpcFailure(
  context: PublicationCommandContext,
  error: PublicationRpcError,
  ids: { draftId?: string; publicationId?: string },
): Promise<NextResponse> {
  const outcome = classifyPublicationRpcError(error);
  if (outcome.kind === "forbidden") {
    await safeAuditDenial(context.admin, {
      actorId: context.userId,
      dealId: context.dealId,
      draftId: ids.draftId,
      publicationId: ids.publicationId,
      correlationId: context.correlation,
      reasonCode: "access_lost",
    });
  }
  return publicationRpcOutcomeResponse(outcome);
}

async function readPublicationView(
  context: PublicationCommandContext,
  publicationId: string,
): Promise<{ view: PublicationRead } | { response: NextResponse }> {
  const { data, error } = await context.admin.rpc("skill_publication_read", {
    p_actor_id: context.userId,
    p_deal_id: context.dealId,
    p_publication_id: publicationId,
    p_correlation_id: context.correlation,
  });
  if (error) {
    return {
      response: await respondToRpcFailure(context, error, { publicationId }),
    };
  }
  const view = parsePublicationRead(data);
  if (!view || view.available === false) {
    return {
      response: jsonError("Unable to process the skill save request.", 500),
    };
  }
  return { view };
}

async function driveAfterAdmission(
  publicationId: string,
  correlation: string,
): Promise<void> {
  try {
    await drivePublication(publicationId, 4);
  } catch {
    logPublicationRouteEvent(publicationId, correlation, "processor_error");
  }
}

function publicationViewStatus(view: PublicationRead): 200 | 202 {
  return view.state === "published" || view.state === "failed" ? 200 : 202;
}

function commandResultView(commandData: unknown): PublicationRead | null {
  const parsed = parsePublicationRead(commandData);
  return parsed && parsed.available !== false ? parsed : null;
}

export async function finalizeCommand(
  context: PublicationCommandContext,
  publicationId: string,
  options: { advance: boolean; commandView?: unknown },
): Promise<NextResponse> {
  if (options.advance) {
    try {
      await advancePublication(publicationId);
    } catch {
      logPublicationRouteEvent(
        publicationId,
        context.correlation,
        "processor_error",
      );
    }
    after(() => driveAfterAdmission(publicationId, context.correlation));
  }
  const result = await readPublicationView(context, publicationId);
  if ("response" in result) {
    const fallback = commandResultView(options.commandView);
    if (fallback) {
      return NextResponse.json(fallback, {
        status: publicationViewStatus(fallback),
      });
    }
    return result.response;
  }
  return NextResponse.json(result.view, {
    status: publicationViewStatus(result.view),
  });
}
