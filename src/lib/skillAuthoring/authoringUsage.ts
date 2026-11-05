import type { SupabaseClient } from "@supabase/supabase-js";

import { recordAiUsage } from "@/lib/ai/usage";
import { TABLE } from "@/lib/constants/tables";
import { bareModelId } from "@/lib/ignatious/benchMeter";
import type { TurnLine } from "./ignatiousAuthoring";

/** What one authoring or enhancement turn cost, read off its done line. */
export type AuthoringUsage = { model: string | null; costUsd: number | null };

/** The ledger task: a turn seeded from an existing skill is an enhancement. */
export type AuthoringTask = "skill_authoring" | "skill_enhancement" | "catalog_skill_authoring";

export type AuthoringUsageRecorder = (
  attemptId: string,
  task: AuthoringTask,
  usage: AuthoringUsage,
) => Promise<void>;

export function authoringUsageOf(line: Extract<TurnLine, { type: "done" }>): AuthoringUsage {
  const id =
    typeof line.modelId === "string" && line.modelId
      ? line.modelId
      : typeof line.model === "string" && line.model
        ? line.model
        : null;
  return {
    model: id ? bareModelId(id) : null,
    costUsd: typeof line.costUsd === "number" && Number.isFinite(line.costUsd) ? line.costUsd : null,
  };
}

/**
 * Put a finished turn on the AI cost ledger (source `skill_authoring`), keyed
 * by attempt id so a turn is recorded once, for the person who asked for it.
 * `dealId` is null for a firm catalog draft. Never throws, like the ledger.
 */
export function authoringUsageRecorder(
  admin: SupabaseClient,
  opts: { actorId: string; dealId: string | null },
): AuthoringUsageRecorder {
  return async (attemptId, task, usage) => {
    try {
      const { data } = await admin
        .from(TABLE.USERS)
        .select("tenant_id")
        .eq("id", opts.actorId)
        .maybeSingle();
      const tenantId = typeof data?.tenant_id === "string" ? data.tenant_id : null;
      if (!tenantId) {
        console.error("[ai-usage] authoring turn has no firm", attemptId);
        return;
      }
      await recordAiUsage(admin, {
        tenantId,
        dealId: opts.dealId,
        actorId: opts.actorId,
        source: "skill_authoring",
        task,
        externalId: attemptId,
        model: usage.model,
        costUsd: usage.costUsd,
      });
    } catch {
      console.error("[ai-usage] authoring turn not recorded", attemptId);
    }
  };
}
