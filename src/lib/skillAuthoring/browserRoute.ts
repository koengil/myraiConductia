import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { isUuid, jsonError } from "@/lib/api/v1/http";
import type { PublicationRead } from "@/lib/skillPublication/types";
import { parseSkillInputFields, type SkillInputValues } from "@/lib/skillRun/inputs";
import type { SkillReference } from "@/lib/skillRun/types";
import type { CandidatePreview, DraftRead, Placement } from "./types";
import {
  authoritativePublicationOf,
  isAuthoritativeConflict,
  isAuthoritativeDraft,
  isAuthoritativeReceipt,
  isNullableAuthoritativeAttempt,
  normalizeAttempt,
} from "./browserResponse";

type RpcError = {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  detail?: string | null;
};

type RpcResult = { data: unknown; error: RpcError | null };

export type RpcClient = {
  rpc: (
    functionName: string,
    args: Record<string, unknown>,
  ) => Promise<RpcResult>;
};

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nullableRecord(value: unknown): RecordValue | null {
  return isRecord(value) ? value : null;
}

function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizePlacement(value: RecordValue): Placement | null {
  const direct = nullableRecord(value.placement) ?? value;
  const kind = string(direct.placement_kind);
  const phaseIndex = number(direct.phase_index);
  if (kind === "phase_start") return { kind, phaseIndex };
  if (kind === "phase_end") return { kind, phaseIndex };
  if (kind === "after") {
    return {
      kind,
      phaseIndex,
      afterStepId: string(direct.anchor_deal_step_id),
    };
  }
  return null;
}

export function normalizeCandidate(value: unknown): CandidatePreview | null {
  const candidate = nullableRecord(value);
  if (!candidate) return null;
  const preview = nullableRecord(candidate.preview) ?? candidate;
  return {
    id: string(candidate.id),
    digest: string(candidate.content_digest),
    schemaVersion: 1,
    name: string(preview.name),
    purpose: string(preview.purpose),
    expectedInput: string(preview.expected_input),
    expectedOutput: string(preview.expected_output),
    inputs: parseSkillInputFields(preview.inputs),
  };
}

function normalizeMessages(value: unknown): DraftRead["messages"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const message = nullableRecord(item);
    if (!message) return [];
    const attempts = Array.isArray(message.attempts)
      ? message.attempts.flatMap((attempt) => {
          const normalized = normalizeAttempt(attempt);
          return normalized ? [normalized] : [];
        })
      : [];
    return [
      {
        id: string(message.id),
        ordinal: number(message.ordinal),
        text: string(message.text),
        attempts,
      },
    ];
  });
}

export function normalizeDraft(
  value: unknown,
  publication: { available: false } | PublicationRead,
  activeAttempt?: unknown,
): DraftRead {
  const draft = nullableRecord(value) ?? {};
  return {
    id: string(draft.id),
    dealId: string(draft.deal_id),
    status: string(draft.status) as DraftRead["status"],
    name: string(draft.name),
    placement: normalizePlacement(draft),
    composerText: string(draft.composer_text),
    editRevision: number(draft.edit_revision),
    messages: normalizeMessages(draft.messages),
    activeAttempt: normalizeAttempt(activeAttempt ?? draft.active_attempt),
    candidate: normalizeCandidate(draft.candidate),
    publication,
  };
}

export function normalizeAuthoritativeDraft(
  value: unknown,
  activeAttempt?: unknown,
): DraftRead | null {
  if (
    !isAuthoritativeDraft(value) ||
    (activeAttempt !== undefined &&
      !isNullableAuthoritativeAttempt(activeAttempt))
  ) {
    return null;
  }
  const publication = authoritativePublicationOf(value);
  return publication === null
    ? null
    : normalizeDraft(value, publication, activeAttempt);
}

function normalizeMessage(
  value: unknown,
): { id: string; ordinal: number; text: string } | null {
  const message = nullableRecord(value);
  if (!message) return null;
  return {
    id: string(message.id),
    ordinal: number(message.ordinal),
    text: string(message.text),
  };
}

export type ReceiptBasis = {
  basis: SkillReference | null;
  basisStepId: string | null;
  seedRunId: string | null;
  seedRun: { input: string; inputs: SkillInputValues; output: string } | null;
};

export function normalizeReceipt(
  value: unknown,
  basis?: ReceiptBasis,
): RecordValue | null {
  const receipt = nullableRecord(value) ?? {};
  if (!isAuthoritativeReceipt(receipt)) return null;
  const draft = nullableRecord(receipt.draft) ?? {};
  const publication = authoritativePublicationOf(draft);
  if (publication === null) return null;
  const attempt = normalizeAttempt(receipt.attempt);
  const message = normalizeMessage(receipt.message);
  return {
    draftId: string(draft.id),
    draft: normalizeDraft(draft, publication),
    ...(message ? { message } : {}),
    ...(attempt ? { attempt } : {}),
    ...(basis?.basis ? { basis: basis.basis } : {}),
    ...(basis?.basisStepId ? { basisStepId: basis.basisStepId } : {}),
    ...(basis?.seedRunId ? { seedRunId: basis.seedRunId } : {}),
    ...(basis?.seedRun ? { seedRun: basis.seedRun } : {}),
  };
}

export function normalizeSendReceipt(
  value: unknown,
): (RecordValue & { created: boolean; attemptId: string }) | null {
  const receipt = normalizeReceipt(value);
  if (!receipt) return null;
  const attempt = receipt.attempt as { id: string } | undefined;
  if (!attempt) return null;
  const raw = nullableRecord(value) ?? {};
  return { ...receipt, created: raw.created === true, attemptId: attempt.id };
}

function conflictDetail(error: RpcError): RecordValue | null {
  const detail = error.details ?? error.detail;
  if (!detail) return null;
  try {
    const parsed: unknown = JSON.parse(detail);
    return nullableRecord(parsed);
  } catch {
    return null;
  }
}

export function rpcFailure(error: RpcError): NextResponse {
  if (error.code === "40001" || error.message === "skill_authoring_conflict") {
    const detail = conflictDetail(error);
    if (!isAuthoritativeConflict(detail))
      return jsonError("Unable to process skill authoring request.", 500);
    const activeAttempt = detail.active_attempt;
    const draft = nullableRecord(detail.draft) ?? {};
    const publication = authoritativePublicationOf(draft);
    if (publication === null)
      return jsonError("Unable to process skill authoring request.", 500);
    return NextResponse.json(
      {
        error: "Draft changed. Reload and retry.",
        draft: normalizeDraft(draft, publication, activeAttempt),
        activeAttempt: normalizeAttempt(activeAttempt),
      },
      { status: 409 },
    );
  }
  if (
    error.code === "22023" ||
    error.message?.startsWith("skill_authoring_invalid_")
  ) {
    return jsonError("Invalid skill authoring request.", 422);
  }
  if (error.code === "P0002") return jsonError("Draft not found.", 404);
  if (error.code === "42501") return jsonError("Not permitted.", 403);
  return jsonError("Unable to process skill authoring request.", 500);
}

export async function callRpc(
  admin: RpcClient,
  functionName: string,
  args: Record<string, unknown>,
): Promise<{ response: NextResponse } | { data: unknown }> {
  const { data, error } = await admin.rpc(functionName, args);
  return error ? { response: rpcFailure(error) } : { data };
}

export function correlationId(request: Request): string {
  const supplied = request.headers.get("x-correlation-id");
  return supplied && isUuid(supplied) ? supplied : randomUUID();
}

export async function readJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function isParsedError(value: unknown): value is { error: string } {
  return isRecord(value) && typeof value.error === "string";
}
