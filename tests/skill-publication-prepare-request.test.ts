import { expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildPrepareRequest } from "@/lib/skillPublication/processorPrepareRequest";
import {
  CANDIDATE_NAME,
  DRAFT_ID,
  TENANT_ID,
  baseOperationRow,
} from "./support/skillPublicationProcessorFixtures";

function fakeAdmin(basis: unknown): SupabaseClient {
  const from = (table: string) => ({
    select: () => ({
      eq: (_column: string, value: string) => {
        if (table === "skill_authoring_candidates") {
          return Promise.resolve({ data: [{ preview: { name: CANDIDATE_NAME } }], error: null });
        }
        if (table === "deals") {
          return Promise.resolve({ data: [{ tenant_id: TENANT_ID }], error: null });
        }
        if (table === "skill_authoring_drafts") {
          return Promise.resolve({
            data: value === DRAFT_ID ? [{ basis }] : [],
            error: null,
          });
        }
        return Promise.resolve({ data: [], error: null });
      },
    }),
  });
  return { from } as unknown as SupabaseClient;
}

it("omits ancestorSkillId for a mount-kind basis", async () => {
  const admin = fakeAdmin({ kind: "mount", name: "demo", version: 3, digest: "b".repeat(64) });
  const outcome = await buildPrepareRequest(admin, baseOperationRow(), "d".repeat(64), []);

  expect(outcome.kind).toBe("ok");
  if (outcome.kind === "ok") {
    expect("ancestorSkillId" in outcome.request).toBe(false);
  }
});

it("sends ancestorSkillId for a publication-kind basis", async () => {
  const skillId = "77777777-0000-4000-8000-000000000007";
  const admin = fakeAdmin({
    kind: "publication",
    skillId,
    versionId: "88888888-0000-4000-8000-000000000008",
    digest: "e".repeat(64),
  });
  const outcome = await buildPrepareRequest(admin, baseOperationRow(), "d".repeat(64), []);

  expect(outcome.kind).toBe("ok");
  if (outcome.kind === "ok") {
    expect(outcome.request.ancestorSkillId).toBe(skillId);
  }
});

it("omits ancestorSkillId for a creation draft with no basis", async () => {
  const admin = fakeAdmin(null);
  const outcome = await buildPrepareRequest(admin, baseOperationRow(), "d".repeat(64), []);

  expect(outcome.kind).toBe("ok");
  if (outcome.kind === "ok") {
    expect("ancestorSkillId" in outcome.request).toBe(false);
    expect(JSON.stringify(outcome.request)).not.toContain("ancestorSkillId");
  }
});
