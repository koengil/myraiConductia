import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicationProcessor } from "@/lib/skillPublication/processor";
import {
  assertMode2SupabaseUrl,
  requireMode2ServiceRoleKey,
} from "./support/mode2Url";
import { buildMode2Context, type Mode2Context } from "./support/mode2Fixtures";
import { bootMode2 } from "./support/mode2Boot";
import { recoveryDeps } from "./support/recoverySetup";
import {
  installShutdownGuard,
  startPublicationE2EServer,
  type RecoveryServer,
} from "./support/recoveryServer";

const MODE2_URL = process.env.CONDUCTIA_SUPABASE_E2E_URL;

describe.skipIf(!MODE2_URL)(
  "skill publication cross-service recovery (mode 2, real persistence)",
  () => {
    let server: RecoveryServer | undefined;
    let context: Mode2Context | undefined;
    let removeShutdownGuard: (() => void) | undefined;

    beforeAll(async () => {
      const url = assertMode2SupabaseUrl(MODE2_URL as string);
      const key = requireMode2ServiceRoleKey(process.env);
      const booted = await bootMode2(
        startPublicationE2EServer,
        (started) => {
          removeShutdownGuard = installShutdownGuard(started);
          process.env.IGNATIOUS_SKILL_BENCH_URL = started.baseUrl;
          process.env.IGNATIOUS_PUBLICATION_SERVICE_TOKEN =
            "e2e-publication-token";
        },
        () => buildMode2Context(url.toString(), key),
      );
      server = booted.server;
      context = booted.context;
    }, 45_000);

    afterAll(async () => {
      removeShutdownGuard?.();
      if (context !== undefined) await context.cleanup();
      if (server !== undefined) await server.stop();
    });

    it("prepares, publishes, and attaches through real Conductia persistence", async () => {
      if (context === undefined)
        throw new Error("mode 2 context did not initialize");
      const processor = createPublicationProcessor(
        recoveryDeps({ admin: context.admin }),
      );
      const result = await processor.drivePublication(context.operationId, 6);
      expect(result).toEqual({
        publicationId: context.operationId,
        state: "published",
        progressed: true,
      });
    });
  },
);
