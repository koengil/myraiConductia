import { NextResponse } from "next/server";

import { jsonError, requireApiUser } from "@/lib/api/v1/http";
import {
  requireTemplateFlags,
  requireTemplateUse,
  templateErrorResponse,
} from "@/lib/railTemplates/access";
import { previewRailTemplate } from "@/lib/railTemplates/service";

type RouteContext = { params: Promise<{ templateId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;
  const gate = await requireTemplateFlags();
  if (gate) return gate;

  const { templateId } = await context.params;
  try {
    const scope = await requireTemplateUse(auth.admin, auth.user.id);
    const preview = await previewRailTemplate(
      auth.admin,
      scope.companyId,
      templateId,
    );
    return preview === null
      ? jsonError("That saved rail is not available.", 404)
      : NextResponse.json(preview);
  } catch (error) {
    return templateErrorResponse(error);
  }
}
