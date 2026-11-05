import { canonicalizeText } from "@/lib/conductia/documents";
import { isUuid } from "@/lib/skillPublication/parse";

import { MAX_INSTRUCTIONS, parseInputValues } from "./inputs";
import { parseSkillReference } from "./versions";
import type { RunRecordBody } from "./types";

const MAX_TEXT = 200_000;
const MAX_MESSAGE = 2_000;

function cleanText(value: unknown): string {
  return typeof value === "string" ? canonicalizeText(value) : "";
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function parseRunRecord(body: unknown): RunRecordBody | { error: string } {
  if (!body || typeof body !== "object") return { error: "Invalid JSON body" };
  const rec = body as Record<string, unknown>;

  const runId = typeof rec.runId === "string" ? rec.runId.trim() : "";
  if (!isUuid(runId)) return { error: "runId must be a UUID" };

  if (rec.outcome !== "succeeded" && rec.outcome !== "failed") {
    return { error: "outcome must be succeeded or failed" };
  }

  const cleanedResult = cleanText(rec.resultText);
  const resultText = cleanedResult.trim() === "" ? null : cleanedResult;
  if (rec.outcome === "succeeded" && resultText === null) {
    return { error: "resultText is required for a succeeded run" };
  }
  if (resultText !== null && resultText.length > MAX_TEXT) {
    return { error: "resultText is too long" };
  }

  const cleanedMessage = cleanText(rec.errorMessage);
  const errorMessage =
    cleanedMessage.trim() === "" ? null : cleanedMessage.slice(0, MAX_MESSAGE);
  const providerRunId =
    typeof rec.providerRunId === "string" && rec.providerRunId.trim() !== ""
      ? rec.providerRunId.trim()
      : null;

  let reference = null;
  if (rec.reference !== undefined && rec.reference !== null) {
    reference = parseSkillReference(rec.reference);
    if (reference === null) return { error: "That version reference is not valid" };
  }

  const model =
    typeof rec.model === "string" && rec.model.trim() !== "" ? rec.model.trim() : null;
  const clampedFrom =
    typeof rec.clampedFrom === "string" && rec.clampedFrom.trim() !== ""
      ? rec.clampedFrom.trim()
      : null;

  const inputs = rec.inputs === undefined || rec.inputs === null ? {} : parseInputValues(rec.inputs);
  if (inputs === null) return { error: "inputs must map names to text, numbers or booleans" };
  const rawInstructions = typeof rec.instructions === "string" ? rec.instructions.trim() : "";
  if (rawInstructions.length > MAX_INSTRUCTIONS) return { error: "instructions are too long" };
  const instructions = rawInstructions === "" ? null : rawInstructions;

  return {
    runId,
    outcome: rec.outcome,
    resultText: rec.outcome === "succeeded" ? resultText : null,
    errorMessage,
    providerRunId,
    startedAt: isTimestamp(rec.startedAt) ? rec.startedAt : null,
    reference,
    model,
    clampedFrom,
    inputs,
    instructions,
  };
}
