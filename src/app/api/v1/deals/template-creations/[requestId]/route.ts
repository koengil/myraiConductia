import { NextResponse } from "next/server";

import { jsonError, requireApiUser } from "@/lib/api/v1/http";
import { provisionDealDataroomOnCreate } from "@/lib/dataroom/steps";
import { errorCodeOf } from "@/lib/errors/upstream";
import {
  requireTemplateFlags,
  templateErrorResponse,
} from "@/lib/railTemplates/access";
import {
  readDealCreation,
  resumeDealCreation,
} from "@/lib/railTemplates/createDeal";

type RouteContext = { params: Promise<{ requestId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;
  const gate = await requireTemplateFlags();
  if (gate) return gate;

  const { requestId } = await context.params;
  try {
    const creation = await readDealCreation(auth.admin, auth.user.id, requestId);
    return creation === null
      ? jsonError("That mandate is no longer pending.", 404)
      : NextResponse.json(creation);
  } catch (error) {
    return templateErrorResponse(error, requestId);
  }
}

export async function POST(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;
  const gate = await requireTemplateFlags();
  if (gate) return gate;

  const { requestId } = await context.params;
  try {
    const receipt = await resumeDealCreation(auth.admin, auth.user.id, requestId);
    try {
      await provisionDealDataroomOnCreate(
        auth.admin,
        receipt.deal.id,
        receipt.deal.code,
      );
    } catch (err) {
      console.error("dataroom provision failed at deal create", {
        dealId: receipt.deal.id,
        code: errorCodeOf(err),
      });
    }
    return NextResponse.json(receipt);
  } catch (error) {
    return templateErrorResponse(error, requestId);
  }
}
