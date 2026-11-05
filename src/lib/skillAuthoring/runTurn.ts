import { readIgnatiousConfig } from "@/lib/ignatious/config";
import { benchReference } from "@/lib/skillRun/types";
import type { RpcClient } from "./browserRoute";
import {
  streamAuthoringTurn,
  type TurnCandidate,
  type TurnLine,
  type TurnRequest,
} from "./ignatiousAuthoring";
import { dbFailure } from '@/lib/errors/upstream';
import { authoringUsageOf, type AuthoringUsageRecorder } from "./authoringUsage";

export const PROGRESS_FLUSH_MS = 500;
export const KEEPALIVE_MS = 10_000;
export const TURN_DEADLINE_MS = 280_000;
export const GENERATION_FAILED = "generation_failed";
export const GENERATION_FAILED_MESSAGE =
  "Generation could not complete. Try again.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;

export function storableCandidate(
  candidate: TurnCandidate | null,
): TurnCandidate | null {
  if (!candidate) return null;
  const { providerCandidateId, contentDigest, schemaVersion, preview } =
    candidate;
  if (
    typeof providerCandidateId !== "string" ||
    !UUID.test(providerCandidateId)
  )
    return null;
  if (typeof contentDigest !== "string" || !DIGEST.test(contentDigest))
    return null;
  if (schemaVersion !== 1) return null;
  if (!preview || typeof preview !== "object") return null;
  return candidate;
}

export type RunTurnDeps = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<unknown>;
  stream: (
    request: TurnRequest,
    signal: AbortSignal,
  ) => AsyncIterable<TurnLine>;
  deadlineMs: number;
  projectId: string;
  now?: () => number;
  /** Puts the finished turn's cost on the AI cost ledger; never throws. */
  record?: AuthoringUsageRecorder;
};

export async function runAuthoringTurn(
  attemptId: string,
  deps: RunTurnDeps,
): Promise<void> {
  const context = (await deps.rpc("skill_authoring_run_context", {
    p_attempt_id: attemptId,
  })) as TurnRequest | null;
  if (!context) return;
  const request: TurnRequest = {
    ...context,
    basis: context.basis ? benchReference(context.basis, deps.projectId) : null,
    seedRun: context.seedRun ?? null,
  };
  const now = deps.now ?? Date.now;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), deps.deadlineMs);
  let text = "";
  let lastFlush = now();
  let flushing = false;
  let candidate: TurnCandidate | null = null;
  const flush = async () => {
    if (flushing) return;
    flushing = true;
    lastFlush = now();
    try {
      await deps.rpc("skill_authoring_record_progress", {
        p_attempt_id: attemptId,
        p_text: text,
      });
    } finally {
      flushing = false;
    }
  };
  const fail = (code: string, message: string) =>
    deps.rpc("skill_authoring_fail_attempt", {
      p_attempt_id: attemptId,
      p_code: code,
      p_message: message,
    });
  const keepalive = setInterval(
    () => void flush().catch(() => undefined),
    KEEPALIVE_MS,
  );
  try {
    for await (const line of deps.stream(request, controller.signal)) {
      if (line.type === "text") {
        text += line.text;
        if (now() - lastFlush >= PROGRESS_FLUSH_MS) await flush();
      } else if (line.type === "candidate") {
        const { type: _type, ...rest } = line;
        candidate = storableCandidate(rest);
      } else if (line.type === "done") {
        await deps.rpc("skill_authoring_complete_attempt", {
          p_attempt_id: attemptId,
          p_text: text,
          p_candidate: candidate,
        });
        await deps.record?.(
          attemptId,
          request.basis ? "skill_enhancement" : "skill_authoring",
          authoringUsageOf(line),
        );
        return;
      } else {
        await fail(line.code, line.message);
        return;
      }
    }
    await fail(GENERATION_FAILED, GENERATION_FAILED_MESSAGE);
  } catch {
    await fail(GENERATION_FAILED, GENERATION_FAILED_MESSAGE).catch(
      () => undefined,
    );
  } finally {
    clearTimeout(deadline);
    clearInterval(keepalive);
  }
}

export function defaultTurnDeps(
  admin: RpcClient,
  projectId: string,
  record?: AuthoringUsageRecorder,
): RunTurnDeps {
  const config = readIgnatiousConfig();
  return {
    record,
    rpc: async (fn, args) => {
      const { data, error } = await admin.rpc(fn, args);
      if (error) throw dbFailure("Skill authoring rpc", error);
      return data;
    },
    stream: (request, signal) => {
      if (!config) throw new Error("Ignatious is not configured");
      return streamAuthoringTurn(config, request, signal);
    },
    deadlineMs: TURN_DEADLINE_MS,
    projectId,
  };
}
