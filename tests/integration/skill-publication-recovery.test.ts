import { afterAll, beforeAll, describe, it } from "vitest";
import {
  installShutdownGuard,
  startPublicationE2EServer,
  type RecoveryServer,
} from "./support/recoveryServer";
import * as scenarios from "./support/recoveryScenarios";

const RUN = process.env.RUN_PUBLICATION_E2E === "1";
let server: RecoveryServer | undefined;
let removeShutdownGuard: (() => void) | undefined;

async function bootServer(): Promise<void> {
  server = await startPublicationE2EServer();
  removeShutdownGuard = installShutdownGuard(server);
  process.env.IGNATIOUS_SKILL_BENCH_URL = server.baseUrl;
  process.env.IGNATIOUS_PUBLICATION_SERVICE_TOKEN = "e2e-publication-token";
}

async function stopServer(): Promise<void> {
  removeShutdownGuard?.();
  if (server !== undefined) await server.stop();
}

const CASES: [string, () => Promise<void>][] = [
  [
    "prepares, publishes, and attaches, ending published with a step id",
    scenarios.normalFlow,
  ],
  [
    "pauses on a weak active match, then returns to preparing when the set changes",
    scenarios.weakMatchThenChangedSet,
  ],
  ["blocks an exact active duplicate", scenarios.exactActiveDuplicate],
  [
    "blocks an exact removed duplicate, naming the removed step",
    scenarios.exactRemovedDuplicate,
  ],
  [
    "recovers a lost publish response through lookup with the same version",
    scenarios.lostPublishResponse,
  ],
  [
    "recovers a transient attachment failure without creating a second step",
    scenarios.transientAttachFailure,
  ],
  [
    "recovers a lost attachment response as the same step, not a new one",
    scenarios.lostAttachResponse,
  ],
  [
    "requires replacement placement after a removed anchor, then keeps the version",
    scenarios.removedAnchorThenReplacement,
  ],
  [
    "pauses on permission loss before publication, unaffected after a live receipt",
    scenarios.permissionLoss,
  ],
  [
    "pauses when the feature is disabled, before publication and after an ambiguous lookup",
    scenarios.featureDisabled,
  ],
  [
    "does not collide with, or disclose, a same-named publication in another project",
    scenarios.crossProjectNameIsolation,
  ],
];

describe.skipIf(!RUN)(
  "skill publication cross-service recovery (mode 1)",
  () => {
    beforeAll(bootServer, 45_000);
    afterAll(stopServer);

    for (const [name, scenario] of CASES) {
      it(name, scenario);
    }
  },
);
