import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildComparisonSet } from "@/lib/skillPublication/comparisonSet";
import type {
  IgnatiousClientFunctions,
  IsFlagEnabledFn,
  ProcessorDeps,
} from "@/lib/skillPublication/processorTypes";
import { createFaultInjectingIgnatious } from "./recoveryFaultyFetch";

export function recoveryDeps(options: {
  admin: SupabaseClient;
  ignatious?: IgnatiousClientFunctions;
  isFlagEnabled?: IsFlagEnabledFn;
  now?: () => Date;
}): ProcessorDeps {
  return {
    admin: options.admin,
    ignatious: options.ignatious ?? createFaultInjectingIgnatious({}),
    buildComparisonSet,
    isFlagEnabled: options.isFlagEnabled ?? (async () => true),
    now: options.now ?? (() => new Date()),
    correlationId: () => randomUUID(),
  };
}
