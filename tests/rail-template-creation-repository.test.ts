import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { finalizeCreation } from "@/lib/railTemplates/creationRepository";

import { manifestFixture } from "./support/railTemplateFixtures";

const ACTOR = "cccccccc-0000-4000-8000-000000000001";
const BANK = "aaaaaaaa-0000-4000-8000-000000000001";
const DEAL = "dddddddd-0000-4000-8000-000000000001";
const TEMPLATE = "eeeeeeee-0000-4000-8000-000000000001";
const REVISION = "ffffffff-0000-4000-8000-000000000001";
const REQUEST = "99999999-0000-4000-8000-000000000001";

const manifest = manifestFixture();

const creationRow = {
  request_id: REQUEST,
  actor_id: ACTOR,
  company_id: BANK,
  revision_id: REVISION,
  reserved_deal_id: DEAL,
  input: { codename: "Project Gale" },
  step_ids: Object.fromEntries(
    manifest.steps.map((step, index) => [
      step.key,
      `11111111-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    ]),
  ),
  targets: [],
  state: "preparing",
  receipt: null,
};

const revisionRow = { id: REVISION, template_id: TEMPLATE, manifest };

function adminFailingFinalizeWith(error: { code: string; message: string }) {
  const rows: Record<string, unknown> = {
    rail_template_creations: creationRow,
    rail_template_revisions: revisionRow,
  };
  return {
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: rows[table] ?? null, error: null }),
      };
      return query;
    },
    rpc: async () => ({ data: null, error }),
  } as unknown as SupabaseClient;
}

const imports = { requestId: REQUEST, projectId: DEAL, skills: [] };

describe("finalizing a deal created from a saved rail", () => {
  it("names a code name already on a live deal instead of failing opaquely", async () => {
    const admin = adminFailingFinalizeWith({
      code: "23505",
      message:
        'duplicate key value violates unique constraint "deals_codename_unique_active"',
    });

    await expect(
      finalizeCreation(admin, ACTOR, REQUEST, imports),
    ).rejects.toThrow("codename_taken");
  });

  it("maps any other finalize failure to a code-only database error", async () => {
    const admin = adminFailingFinalizeWith({
      code: "23505",
      message: 'duplicate key value violates unique constraint "deal_steps_pkey"',
    });

    await expect(
      finalizeCreation(admin, ACTOR, REQUEST, imports),
    ).rejects.toMatchObject({ name: "DbError", code: "23505" });
    await expect(
      finalizeCreation(admin, ACTOR, REQUEST, imports),
    ).rejects.not.toThrow(/deal_steps_pkey/);
  });
});
