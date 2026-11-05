import { NextResponse } from "next/server";
import { jsonError } from "@/lib/api/v1/http";
import {
  PUBLICATION_CONFLICT_CODES,
  type PublicationConflictCode,
} from "./types";

export type PublicationRpcError = {
  code?: string | null;
  message?: string | null;
};

export type PublicationRpcOutcome =
  | { kind: "conflict"; code: PublicationConflictCode }
  | { kind: "invalid" }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "server_error" };

function isPublicationConflictCode(
  value: unknown,
): value is PublicationConflictCode {
  return (
    typeof value === "string" &&
    PUBLICATION_CONFLICT_CODES.includes(value as never)
  );
}

export function classifyPublicationRpcError(
  error: PublicationRpcError,
): PublicationRpcOutcome {
  if (error.code === "40001" && isPublicationConflictCode(error.message)) {
    return { kind: "conflict", code: error.message };
  }
  if (error.code === "23505") return { kind: "conflict", code: "publication_exists" };
  if (error.code === "22023") return { kind: "invalid" };
  if (error.code === "P0002") return { kind: "not_found" };
  if (error.code === "42501") return { kind: "forbidden" };
  return { kind: "server_error" };
}

export function publicationRpcOutcomeResponse(
  outcome: PublicationRpcOutcome,
): NextResponse {
  switch (outcome.kind) {
    case "conflict":
      return NextResponse.json({ error: outcome.code }, { status: 409 });
    case "invalid":
      return jsonError("Invalid skill save request.", 422);
    case "not_found":
      return jsonError("Not found.", 404);
    case "forbidden":
      return jsonError("Not permitted.", 403);
    default:
      return jsonError("Unable to process the skill save request.", 500);
  }
}
