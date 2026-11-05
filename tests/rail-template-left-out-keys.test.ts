import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { TABLE } from "@/lib/constants/tables";
import { seedLeftOutSteps } from "@/lib/railTemplates/creationRepository";
import type { CreationAdmission, RailManifest } from "@/lib/railTemplates/types";

import { queryStub } from "./support/railTemplateFixtures";

const DEAL = "dddddddd-0000-4000-8000-000000000001";
const KEPT = "22222222-2222-4222-8222-222222222222";

function manifest(): RailManifest {
  return {
    schemaVersion: 2,
    censusVersion: "hv-5x65-2026-07-08",
    skills: [],
    steps: [
      {
        key: "t0",
        templateStepKey: "p1-s10",
        catalogStepId: "p1-s10",
        seq: 10,
        phaseIndex: 1,
        displayOrder: 1,
        definition: null,
        skillKey: null,
      },
    ],
  };
}

function admission(rail: RailManifest): CreationAdmission {
  return {
    requestId: "aaaaaaaa-0000-4000-8000-000000000001",
    actorId: "bbbbbbbb-0000-4000-8000-000000000001",
    companyId: "cccccccc-0000-4000-8000-000000000001",
    dealId: DEAL,
    revisionId: "88888888-0000-4000-8000-000000000001",
    manifest: rail,
    input: {} as CreationAdmission["input"],
    stepIds: { t0: KEPT },
    targets: [],
    state: "ready",
    receipt: null,
  };
}

function capture(): { admin: SupabaseClient; rows: Array<Record<string, unknown>> } {
  const rows: Array<Record<string, unknown>> = [];
  const admin = {
    from: (table: string) => {
      expect(table).toBe(TABLE.DEAL_STEPS);
      return queryStub(rows);
    },
  } as unknown as SupabaseClient;
  return { admin, rows };
}

describe("seedLeftOutSteps", () => {
  it("keys each left-out house step by its step id", async () => {
    const { admin, rows } = capture();

    await seedLeftOutSteps(admin, admission(manifest()));

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.step_id === "p1-s10")).toBe(false);
    for (const row of rows) expect(row.template_step_key).toBe(row.step_id);
  });
});
