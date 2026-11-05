import {
  prepare,
  publish,
  lookup,
} from "@/lib/skillPublication/ignatiousClient";
import type { IgnatiousClientFunctions } from "@/lib/skillPublication/processorTypes";

type FaultKind = "prepare" | "publish" | "lookup";

export type FaultPlan = {
  dropReplyOnce?: Set<FaultKind>;
  neverArriveOnce?: Set<FaultKind>;
  forbid?: Set<FaultKind>;
};

function faultyFetch(
  plan: FaultPlan,
  kind: FaultKind,
  dropped: Set<FaultKind>,
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    if (plan.neverArriveOnce?.has(kind) && !dropped.has(kind)) {
      dropped.add(kind);
      throw new Error("simulated request that never reached the server");
    }
    const response = await fetch(input, init);
    if (plan.dropReplyOnce?.has(kind) && !dropped.has(kind)) {
      dropped.add(kind);
      await response.text().catch(() => undefined);
      throw new Error("simulated dropped reply");
    }
    return response;
  };
}

function forbidden(kind: FaultKind): Promise<never> {
  return Promise.reject(new Error(`unexpected ${kind} call during recovery`));
}

export function createFaultInjectingIgnatious(
  plan: FaultPlan,
): IgnatiousClientFunctions {
  const dropped = new Set<FaultKind>();
  return {
    prepare: (operationId, body, context) =>
      plan.forbid?.has("prepare")
        ? forbidden("prepare")
        : prepare(operationId, body, {
            correlationId: context.correlationId,
            fetchImpl: faultyFetch(plan, "prepare", dropped),
          }),
    publish: (operationId, body, context) =>
      plan.forbid?.has("publish")
        ? forbidden("publish")
        : publish(operationId, body, {
            correlationId: context.correlationId,
            fetchImpl: faultyFetch(plan, "publish", dropped),
          }),
    lookup: (operationId, context) =>
      plan.forbid?.has("lookup")
        ? forbidden("lookup")
        : lookup(operationId, {
            correlationId: context.correlationId,
            fetchImpl: faultyFetch(plan, "lookup", dropped),
          }),
  };
}
