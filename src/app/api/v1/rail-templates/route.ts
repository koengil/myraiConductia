import { NextResponse } from "next/server";

import { requireApiUser } from "@/lib/api/v1/http";
import { COMPANY_PERMISSION } from "@/lib/constants/companyPermissions";
import {
  requireTemplateFlags,
  requireTemplateUse,
  templateErrorResponse,
} from "@/lib/railTemplates/access";
import { saveRailToCatalog } from "@/lib/railTemplates/saveRail";
import {
  listRailTemplates,
  listReplaceableTemplates,
  parseSaveRailCommand,
} from "@/lib/railTemplates/service";

export async function GET(request: Request) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;
  const gate = await requireTemplateFlags();
  if (gate) return gate;

  const purpose = new URL(request.url).searchParams.get("purpose");
  try {
    if (purpose === "save") {
      const scope = await requireTemplateUse(
        auth.admin,
        auth.user.id,
        COMPANY_PERMISSION.RAIL_TEMPLATES_MANAGE,
      );
      return NextResponse.json({
        templates: await listReplaceableTemplates(auth.admin, scope.companyId),
      });
    }
    const scope = await requireTemplateUse(auth.admin, auth.user.id);
    return NextResponse.json({
      templates: await listRailTemplates(auth.admin, scope.companyId),
    });
  } catch (error) {
    return templateErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;
  const gate = await requireTemplateFlags();
  if (gate) return gate;

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  let requestId: string | undefined;
  try {
    const command = parseSaveRailCommand(body);
    requestId = command.requestId;
    return NextResponse.json(
      await saveRailToCatalog(auth.admin, auth.user.id, command),
    );
  } catch (error) {
    return templateErrorResponse(error, requestId);
  }
}
