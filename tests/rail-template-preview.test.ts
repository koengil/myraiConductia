import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { TABLE } from "@/lib/constants/tables";
import { GATE0_NOTIFY_STEP_ID } from "@/lib/rail/gate0";
import { listRailTemplates, previewRailTemplate } from "@/lib/railTemplates/service";
import type { RailManifest, TemplateStep } from "@/lib/railTemplates/types";

import { queryStub } from "./support/railTemplateFixtures";

const COMPANY = "cccccccc-0000-4000-8000-000000000001";
const TEMPLATE = "77777777-0000-4000-8000-000000000001";
const REVISION = "88888888-0000-4000-8000-000000000001";

function catalogStep(catalogStepId: string, displayOrder: number): TemplateStep {
  return {
    key: `s${displayOrder}`,
    templateStepKey: catalogStepId,
    catalogStepId,
    seq: displayOrder,
    phaseIndex: 1,
    displayOrder,
    definition: null,
    skillKey: null,
  };
}

function manifestWith(steps: TemplateStep[]): RailManifest {
  return {
    schemaVersion: 2,
    censusVersion: "hv-5x65-2026-07-08",
    steps,
    skills: [],
  };
}

function adminFor(manifest: RailManifest): SupabaseClient {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    [TABLE.RAIL_TEMPLATES]: [
      {
        id: TEMPLATE,
        company_id: COMPANY,
        name: "Technology sell-side",
        normalized_name: "technology sell-side",
        current_revision_id: REVISION,
      },
    ],
    [TABLE.RAIL_TEMPLATE_REVISIONS]: [
      {
        id: REVISION,
        description: "",
        manifest,
        created_at: "2026-09-22T00:00:00.000Z",
      },
    ],
  };
  return {
    from: (table: string) => queryStub(tables[table] ?? []),
  } as unknown as SupabaseClient;
}

describe("previewRailTemplate step titles", () => {
  it("names the Gate 0 notify step rather than printing its id", async () => {
    const admin = adminFor(
      manifestWith([
        catalogStep("p1-s7", 1),
        catalogStep("p1-s6", 2),
        catalogStep(GATE0_NOTIFY_STEP_ID, 3),
        catalogStep("p1-s8", 4),
      ]),
    );

    const preview = await previewRailTemplate(admin, COMPANY, TEMPLATE);

    const titles = (preview?.steps ?? []).map((step) => step.title);
    expect(titles).not.toContain(GATE0_NOTIFY_STEP_ID);
    expect(titles[2]).toBe("Notify Compliance");
  });

  it("names every step a deal rail can carry", async () => {
    const admin = adminFor(
      manifestWith([
        catalogStep("p1-s7", 1),
        catalogStep(GATE0_NOTIFY_STEP_ID, 2),
        catalogStep("p1-s8", 3),
        catalogStep("p2-s26", 4),
      ]),
    );

    const preview = await previewRailTemplate(admin, COMPANY, TEMPLATE);

    for (const step of preview?.steps ?? []) {
      expect(step.title).not.toMatch(/^(g0-|p\d+-s\d+$)/);
    }
  });
});

function publishedStep(
  templateStepKey: string,
  catalogStepId: string | null,
  displayOrder: number,
): TemplateStep {
  return {
    key: `t${displayOrder - 1}`,
    templateStepKey,
    catalogStepId,
    seq: catalogStepId === null ? null : displayOrder,
    phaseIndex: 1,
    displayOrder,
    definition:
      catalogStepId === null
        ? { title: "Fairness opinion", description: "Independent opinion before signing." }
        : null,
    skillKey: null,
  };
}

function publishedManifest(steps: TemplateStep[]): RailManifest {
  return {
    schemaVersion: 2,
    censusVersion: "hv-5x65-2026-07-08",
    steps,
    skills: [],
  };
}

const PUBLISHED_STEPS = [
  publishedStep("p1-s7", "p1-s7", 1),
  publishedStep("p1-s6", "p1-s6", 2),
  publishedStep(GATE0_NOTIFY_STEP_ID, GATE0_NOTIFY_STEP_ID, 3),
  publishedStep("custom-0f7c2b9e-3a41-4c55-9d1e-6b2a7f0c8d13", null, 4),
];

describe("a published catalog template in the Gate 0 picker", () => {
  it("lists a schema 2 revision with its step and skill counts", async () => {
    const admin = adminFor(publishedManifest(PUBLISHED_STEPS));

    const templates = await listRailTemplates(admin, COMPANY);

    expect(templates).toEqual([
      {
        id: TEMPLATE,
        revisionId: REVISION,
        name: "Technology sell-side",
        description: "",
        stepCount: 4,
        skillCount: 0,
        updatedAt: "2026-09-22T00:00:00.000Z",
      },
    ]);
  });

  it("previews a schema 2 custom step by its title", async () => {
    const admin = adminFor(publishedManifest(PUBLISHED_STEPS));

    const preview = await previewRailTemplate(admin, COMPANY, TEMPLATE);

    expect(preview?.steps.map((step) => step.title)[3]).toBe("Fairness opinion");
  });

  it("refuses a schema 2 revision whose step has no template step key", async () => {
    const admin = adminFor(
      publishedManifest([{ ...publishedStep("p1-s7", "p1-s7", 1), templateStepKey: "" }]),
    );

    await expect(listRailTemplates(admin, COMPANY)).rejects.toMatchObject({
      code: "invalid_command",
    });
  });

  it("refuses a revision written before the catalog", async () => {
    const admin = adminFor({
      ...publishedManifest(PUBLISHED_STEPS),
      schemaVersion: 1,
    } as unknown as RailManifest);

    await expect(listRailTemplates(admin, COMPANY)).rejects.toMatchObject({
      code: "invalid_command",
    });
  });
});
