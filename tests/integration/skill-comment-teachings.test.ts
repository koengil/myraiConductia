import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { createProvisionedUser } from "@/lib/auth/provisioning";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) {
  throw new Error(
    "Integration suite needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY " +
      "(local `supabase start` stack).",
  );
}
const admin = createClient(url, secret, { auth: { persistSession: false } });

const RUN = Date.now().toString(36);
const TENANT = randomUUID();
const COMMENT = "End every bullet with a period.";

const dealIds: string[] = [];
const userIds: string[] = [];
const companyIds: string[] = [];

type Seed = {
  dealId: string;
  stepId: string;
  actorId: string;
  executionRunId: string;
  revisionId: string;
  taughtEditId: string;
  plainEditId: string;
  draftId: string;
};

function expectNoError(label: string, error: { message: string } | null): void {
  if (error) throw new Error(`${label}: ${error.message}`);
}

function edit(id: string, teach: boolean) {
  return {
    id,
    kind: "comment",
    start: 0,
    end: 5,
    comment: COMMENT,
    status: "applied",
    resultStart: 0,
    resultEnd: 6,
    ...(teach ? { teach: true } : {}),
  };
}

async function openDraft(
  seed: Pick<Seed, "dealId" | "actorId" | "stepId" | "executionRunId">,
) {
  const { data, error } = await admin.rpc(
    "skill_authoring_get_or_create_draft",
    {
      p_actor_id: seed.actorId,
      p_deal_id: seed.dealId,
      p_correlation_id: randomUUID(),
      p_basis_deal_step_id: seed.stepId,
      p_basis: {
        kind: "publication",
        skillId: randomUUID(),
        versionId: randomUUID(),
        digest: "b".repeat(64),
      },
      p_seed_run_id: seed.executionRunId,
    },
  );
  expectNoError("get_or_create_draft", error);
  return (data as { draft: { id: string; edit_revision: number } }).draft;
}

async function seed(): Promise<Seed> {
  const companyId = randomUUID();
  expectNoError(
    "companies",
    (
      await admin
        .from("companies")
        .insert({
          id: companyId,
          tenant_id: TENANT,
          name: `Teach Bank ${companyId}`,
          type: "bank",
        })
    ).error,
  );
  companyIds.push(companyId);

  const { id: actorId } = await createProvisionedUser(admin, {
    email: `${randomUUID()}-${RUN}@integration.conductia.dev`,
    password: `Integration-${RUN}-x9!`,
    email_confirm: true,
    profile: { tenant_id: TENANT },
  });
  userIds.push(actorId);
  expectNoError(
    "users",
    (
      await admin
        .from("users")
        .update({
          tenant_id: TENANT,
          company_id: companyId,
          company_role: "director",
          status: "active",
          is_external: false,
        })
        .eq("id", actorId)
    ).error,
  );

  const dealId = randomUUID();
  expectNoError(
    "deals",
    (
      await admin.from("deals").insert({
        id: dealId,
        tenant_id: TENANT,
        code: `TCH-${dealId.slice(0, 8)}`,
        codename: `Teach deal ${dealId.slice(0, 8)}`,
        bank_id: companyId,
      })
    ).error,
  );
  dealIds.push(dealId);

  const role = await admin.from("roles").select("id").eq("slug", "md").single();
  expectNoError("roles", role.error);
  expectNoError(
    "deal_memberships",
    (
      await admin.from("deal_memberships").insert({
        deal_id: dealId,
        user_id: actorId,
        role_id: (role.data as { id: string }).id,
        deal_role: "md",
      })
    ).error,
  );

  const step = await admin
    .from("deal_steps")
    .insert({
      deal_id: dealId,
      step_id: `custom:${randomUUID()}`,
      status: "pending",
      origin: "custom",
      phase_index: 1,
      definition: { schemaVersion: 1, type: "skill", title: "Buyer screen" },
    })
    .select("id")
    .single();
  expectNoError("deal_steps", step.error);
  const stepId = (step.data as { id: string }).id;

  const skillId = randomUUID();
  const versionId = randomUUID();
  const executionRunId = randomUUID();
  expectNoError(
    "execution run",
    (
      await admin.from("deal_step_skill_runs").insert({
        id: executionRunId,
        deal_id: dealId,
        deal_step_id: stepId,
        actor_id: actorId,
        skill_id: skillId,
        version_id: versionId,
        digest: "a".repeat(64),
        source: "execution",
        input: "Summarise",
        outcome: "succeeded",
        result_text: "First output.",
      })
    ).error,
  );

  const taughtEditId = randomUUID();
  const plainEditId = randomUUID();
  const revisionId = randomUUID();
  expectNoError(
    "record_skill_run_revision",
    (
      await admin.rpc("record_skill_run_revision", {
        p_run: {
          id: revisionId,
          deal_id: dealId,
          deal_step_id: stepId,
          actor_id: actorId,
          source: "revision",
          parent_run_id: executionRunId,
          root_run_id: executionRunId,
          skill_id: skillId,
          version_id: versionId,
          digest: "a".repeat(64),
          inputs: {
            kind: "edits",
            edits: [edit(taughtEditId, true), edit(plainEditId, false)],
          },
          outcome: "succeeded",
          result_text: "Revised output.",
        },
        p_audit: { kind: "test" },
      })
    ).error,
  );

  const draft = await openDraft({ dealId, actorId, stepId, executionRunId });
  return {
    dealId,
    stepId,
    actorId,
    executionRunId,
    revisionId,
    taughtEditId,
    plainEditId,
    draftId: draft.id,
  };
}

async function offer(
  s: Seed,
  editIds: string[],
  prompt: string,
  draftId = s.draftId,
) {
  return admin.rpc("skill_teaching_offer", {
    p_actor_id: s.actorId,
    p_deal_id: s.dealId,
    p_draft_id: draftId,
    p_edits: editIds.map((editId) => ({ runId: s.revisionId, editId })),
    p_prompt: prompt,
    p_correlation_id: randomUUID(),
  });
}

async function draftRow(draftId: string) {
  const { data, error } = await admin
    .from("skill_authoring_drafts")
    .select("composer_text, edit_revision")
    .eq("id", draftId)
    .single();
  expectNoError("draft read", error);
  return data as { composer_text: string; edit_revision: number };
}

async function setComposer(s: Seed, text: string) {
  const { error } = await admin
    .from("skill_authoring_drafts")
    .update({ composer_text: text })
    .eq("id", s.draftId);
  expectNoError("composer", error);
}

async function rows(editId: string) {
  const { data, error } = await admin
    .from("skill_comment_teachings")
    .select("*")
    .eq("edit_id", editId);
  expectNoError("teachings read", error);
  return data as {
    kind: string;
    message_id: string | null;
    draft_id: string;
  }[];
}

async function submit(s: Seed, draftId: string, text: string) {
  const draft = await draftRow(draftId);
  return admin.rpc("skill_authoring_submit_message", {
    p_actor_id: s.actorId,
    p_deal_id: s.dealId,
    p_draft_id: draftId,
    p_expected_revision: draft.edit_revision,
    p_client_message_id: randomUUID(),
    p_text: text,
    p_correlation_id: randomUUID(),
  });
}

afterAll(async () => {
  for (const dealId of dealIds) {
    await admin
      .from("skill_authoring_attempts")
      .delete()
      .in(
        "draft_id",
        (
          (
            await admin
              .from("skill_authoring_drafts")
              .select("id")
              .eq("deal_id", dealId)
          ).data ?? []
        ).map((d) => d.id),
      );
  }
});

describe("skill_teaching_offer", () => {
  it("writes the prompt into an empty composer and records the comment as waiting", async () => {
    const s = await seed();
    const before = await draftRow(s.draftId);

    const { data, error } = await offer(s, [s.taughtEditId], "P1");

    expect(error).toBeNull();
    expect((data as { offered: boolean }).offered).toBe(true);
    const after = await draftRow(s.draftId);
    expect(after.composer_text).toBe("P1");
    expect(after.edit_revision).toBe(before.edit_revision + 1);
    const waiting = await rows(s.taughtEditId);
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      kind: "waiting",
      draft_id: s.draftId,
      message_id: null,
    });
  });

  it("adds the prompt after text already in the composer", async () => {
    const s = await seed();
    await setComposer(s, "My note");

    const { error } = await offer(s, [s.taughtEditId], "P1");

    expect(error).toBeNull();
    expect((await draftRow(s.draftId)).composer_text).toBe("My note\n\nP1");
  });

  it("offers nothing when any edit already waits on the draft", async () => {
    const s = await seed();
    await offer(s, [s.taughtEditId], "P1");
    const before = await draftRow(s.draftId);

    const { data, error } = await offer(s, [s.taughtEditId], "P1");

    expect(error).toBeNull();
    expect((data as { offered: boolean }).offered).toBe(false);
    expect(await draftRow(s.draftId)).toEqual(before);
    expect(await rows(s.taughtEditId)).toHaveLength(1);
  });

  it("refuses an edit that is not an applied, taught comment of the draft step", async () => {
    const s = await seed();

    const plain = await offer(s, [s.plainEditId], "P1");
    const unknown = await offer(s, [randomUUID()], "P1");
    const empty = await offer(s, [], "P1");

    expect(plain.error?.message).toContain("skill_teaching_invalid_edit");
    expect(unknown.error?.message).toContain("skill_teaching_invalid_edit");
    expect(empty.error?.message).toContain("skill_teaching_invalid_edit");
    expect(await rows(s.plainEditId)).toHaveLength(0);
  });

  it("refuses a taught comment from another deal's output", async () => {
    const s = await seed();
    const other = await seed();

    const crossed = await admin.rpc("skill_teaching_offer", {
      p_actor_id: s.actorId,
      p_deal_id: s.dealId,
      p_draft_id: s.draftId,
      p_edits: [{ runId: other.revisionId, editId: other.taughtEditId }],
      p_prompt: "P1",
      p_correlation_id: randomUUID(),
    });

    expect(crossed.error?.message).toContain("skill_teaching_invalid_edit");
    expect(await rows(other.taughtEditId)).toHaveLength(0);
    expect((await draftRow(s.draftId)).composer_text).toBe("");
  });

  it("offers nothing when the result would exceed 20,000 characters", async () => {
    const s = await seed();
    await setComposer(s, "x".repeat(19999));
    const before = await draftRow(s.draftId);

    const { data, error } = await offer(s, [s.taughtEditId], "P1");

    expect(error).toBeNull();
    expect((data as { offered: boolean }).offered).toBe(false);
    expect(await draftRow(s.draftId)).toEqual(before);
    expect(await rows(s.taughtEditId)).toHaveLength(0);
  });

  it("marks waiting comments as sent when the next message is admitted, and counts them in the audit row", async () => {
    const s = await seed();
    await offer(s, [s.taughtEditId], "P1");

    const first = await submit(s, s.draftId, "Please improve the skill.");
    expect(first.error).toBeNull();
    const messageId = (first.data as { message: { id: string } }).message.id;

    const sent = (await rows(s.taughtEditId)).filter((r) => r.kind === "sent");
    expect(sent).toHaveLength(1);
    expect(sent[0].message_id).toBe(messageId);

    await admin
      .from("skill_authoring_attempts")
      .update({
        status: "failed",
        error_code: "x",
        error_message: "x",
        completed_at: new Date().toISOString(),
      })
      .eq("draft_id", s.draftId);
    const second = await submit(s, s.draftId, "Another note.");
    expect(second.error).toBeNull();
    expect(
      (await rows(s.taughtEditId)).filter((r) => r.kind === "sent"),
    ).toHaveLength(1);

    const audits = await admin
      .from("audit_log")
      .select("detail, ts")
      .eq("deal_id", s.dealId)
      .eq("action", "skill_authoring.message_admitted")
      .order("ts", { ascending: true });
    expectNoError("audit read", audits.error);
    expect(
      (audits.data ?? []).map(
        (a) => (a.detail as { taughtComments: number }).taughtComments,
      ),
    ).toEqual([1, 0]);
  });

  it("offers a comment again on a new draft after the old one is discarded", async () => {
    const s = await seed();
    await offer(s, [s.taughtEditId], "P1");
    const old = await draftRow(s.draftId);
    const discard = await admin.rpc("skill_authoring_discard_draft", {
      p_actor_id: s.actorId,
      p_deal_id: s.dealId,
      p_draft_id: s.draftId,
      p_expected_revision: old.edit_revision,
      p_correlation_id: randomUUID(),
    });
    expect(discard.error).toBeNull();
    const fresh = await openDraft(s);

    const { data, error } = await offer(s, [s.taughtEditId], "P1", fresh.id);

    expect(error).toBeNull();
    expect((data as { offered: boolean }).offered).toBe(true);
  });

  it("never offers a comment that was already sent", async () => {
    const s = await seed();
    await offer(s, [s.taughtEditId], "P1");
    const sentResult = await submit(s, s.draftId, "Go.");
    expect(sentResult.error).toBeNull();
    const old = await draftRow(s.draftId);
    await admin.rpc("skill_authoring_discard_draft", {
      p_actor_id: s.actorId,
      p_deal_id: s.dealId,
      p_draft_id: s.draftId,
      p_expected_revision: old.edit_revision,
      p_correlation_id: randomUUID(),
    });
    const fresh = await openDraft(s);

    const { data, error } = await offer(s, [s.taughtEditId], "P1", fresh.id);

    expect(error).toBeNull();
    expect((data as { offered: boolean }).offered).toBe(false);
  });

  it("refuses to change or delete a teaching row", async () => {
    const s = await seed();
    await offer(s, [s.taughtEditId], "P1");

    const update = await admin
      .from("skill_comment_teachings")
      .update({ actor_id: s.actorId })
      .eq("edit_id", s.taughtEditId);
    const del = await admin
      .from("skill_comment_teachings")
      .delete()
      .eq("edit_id", s.taughtEditId);

    expect(update.error?.message).toMatch(/immutable/);
    expect(del.error?.message).toMatch(/immutable/);
    expect(await rows(s.taughtEditId)).toHaveLength(1);
  });
});
