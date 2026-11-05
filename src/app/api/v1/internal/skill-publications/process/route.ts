import { NextResponse } from "next/server";
import { jsonError } from "@/lib/api/v1/http";
import { processDuePublications } from "@/lib/skillPublication/processor";
import { requireSkillPublicationService } from "@/lib/skillPublication/serviceAuth";

const BATCH_LIMIT = 25;

async function sweep() {
  const results = await processDuePublications(BATCH_LIMIT);
  const counts: Record<string, number> = {};
  for (const result of results) {
    counts[result.state] = (counts[result.state] ?? 0) + 1;
  }
  return NextResponse.json({ counts });
}

export async function GET(request: Request) {
  const service = await requireSkillPublicationService(request);
  if (!service.ok) return service.response;
  return sweep();
}

export async function POST(request: Request) {
  const service = await requireSkillPublicationService(request);
  if (!service.ok) return service.response;

  const body = await request.text();
  if (body.length > 0) {
    return jsonError("Invalid skill save worker request.", 422);
  }

  return sweep();
}
