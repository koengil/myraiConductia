import { createPublicationProcessor } from "@/lib/skillPublication/processor";
import type { RecoveryAdmin } from "./recoveryAdmin";
import type { AdvancingClock } from "./recoveryClock";
import {
  createFaultInjectingIgnatious,
  type FaultPlan,
} from "./recoveryFaultyFetch";
import { recoveryDeps } from "./recoverySetup";

export function clockedDeps(
  admin: RecoveryAdmin,
  clock: AdvancingClock,
  options: {
    faultPlan?: FaultPlan;
    isFlagEnabled?: () => Promise<boolean>;
  } = {},
) {
  return recoveryDeps({
    admin: admin.admin,
    now: clock.now,
    ignatious: options.faultPlan
      ? createFaultInjectingIgnatious(options.faultPlan)
      : undefined,
    isFlagEnabled: options.isFlagEnabled,
  });
}

export function clockedProcessor(
  admin: RecoveryAdmin,
  clock: AdvancingClock,
  options: {
    faultPlan?: FaultPlan;
    isFlagEnabled?: () => Promise<boolean>;
  } = {},
) {
  return createPublicationProcessor(clockedDeps(admin, clock, options));
}
