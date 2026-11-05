import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { importedComparisonTarget } from "@/lib/skillPublication/comparisonTargets";
import type { PublicationMetadata } from "@/lib/skillRun/publicationMetadata";
import {
  readPublicationMetadata,
  readPublicationMetadataBatch,
} from "@/lib/skillRun/publicationMetadata";
import type { SkillReference } from "@/lib/skillRun/types";
import { readStepVersions } from "@/lib/skillRun/versions";

import { queryStub } from "./support/railTemplateFixtures";

vi.mock("@/lib/ignatious/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ignatious/config")>()),
  readIgnatiousConfig: () => null,
}));

vi.mock("@/lib/ignatious/bench", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ignatious/bench")>()),
  listPublicationLineage: async () => state.lineage,
}));

const DEAL = "dddddddd-0000-4000-8000-000000000001";
const OTHER_DEAL = "dddddddd-0000-4000-8000-000000000002";
const SKILL = "55555555-5555-4555-8555-555555555555";
const VERSION_ONE = "66666666-6666-4666-8666-666666666661";
const VERSION_TWO = "66666666-6666-4666-8666-666666666662";
const ACTOR_IMPORTER = "cccccccc-0000-4000-8000-000000000001";
const ACTOR_AUTHOR = "cccccccc-0000-4000-8000-000000000002";
const DIGEST_ONE = "a".repeat(64);
const DIGEST_TWO = "b".repeat(64);

type Row = Record<string, unknown>;

const state = {
  tables: {} as Record<string, Row[]>,
  lineage: [] as Array<{ versionId: string; digest: string; publishedAt: string }>,
};

const admin = {
  from: (table: string) => queryStub(state.tables[table] ?? []),
} as unknown as SupabaseClient;

function publication(versionId: string, digest: string): SkillReference & {
  kind: "publication";
} {
  return { kind: "publication", skillId: SKILL, versionId, digest };
}

function importedRow(overrides: Row = {}): Row {
  return {
    skill_id: SKILL,
    deal_id: DEAL,
    version_id: VERSION_ONE,
    digest: DIGEST_ONE,
    name: "Weekly memo",
    capability_contract: {
      purpose: "Draft the imported memo.",
      expectedInput: "A reporting period.",
      expectedOutput: "A concise memo.",
    },
    imported_by: ACTOR_IMPORTER,
    created_at: "2026-09-01T08:00:00.000Z",
    ...overrides,
  };
}

function operationRow(overrides: Row = {}): Row {
  return {
    deal_id: DEAL,
    published_skill_id: SKILL,
    published_version_id: VERSION_TWO,
    published_digest: DIGEST_TWO,
    name: "Weekly memo v2",
    capability_contract: {
      purpose: "Draft the enhanced memo.",
      expectedInput: "A reporting period and a theme.",
      expectedOutput: "A sharper memo.",
    },
    actor_id: ACTOR_AUTHOR,
    created_at: "2026-09-10T08:00:00.000Z",
    ...overrides,
  };
}

describe("publication metadata across authored and imported skills", () => {
  beforeEach(() => {
    state.tables = {
      deal_skill_imports: [importedRow()],
      skill_publication_operations: [operationRow()],
    };
  });

  it("reads an imported version and an authored version with their own contracts", async () => {
    const resolved = await readPublicationMetadataBatch(admin, DEAL, [
      publication(VERSION_ONE, DIGEST_ONE),
      publication(VERSION_TWO, DIGEST_TWO),
    ]);

    expect(resolved.get(VERSION_ONE)).toEqual({
      name: "Weekly memo",
      contract: {
        purpose: "Draft the imported memo.",
        expectedInput: "A reporting period.",
        expectedOutput: "A concise memo.",
      },
      actorId: ACTOR_IMPORTER,
      createdAt: "2026-09-01T08:00:00.000Z",
    });
    expect(resolved.get(VERSION_TWO)?.actorId).toBe(ACTOR_AUTHOR);
    expect(resolved.get(VERSION_TWO)?.contract.purpose).toBe(
      "Draft the enhanced memo.",
    );
  });

  it("prefers the publication operation when both origins hold a version", async () => {
    state.tables.deal_skill_imports = [
      importedRow({ version_id: VERSION_TWO, digest: DIGEST_TWO }),
    ];

    const resolved = await readPublicationMetadata(
      admin,
      DEAL,
      publication(VERSION_TWO, DIGEST_TWO),
    );

    expect(resolved?.actorId).toBe(ACTOR_AUTHOR);
  });

  it("refuses a row recorded against another deal", async () => {
    state.tables.deal_skill_imports = [importedRow({ deal_id: OTHER_DEAL })];

    expect(
      await readPublicationMetadata(
        admin,
        DEAL,
        publication(VERSION_ONE, DIGEST_ONE),
      ),
    ).toBeNull();
  });

  it("refuses a row whose digest does not match the reference", async () => {
    expect(
      await readPublicationMetadata(
        admin,
        DEAL,
        publication(VERSION_ONE, DIGEST_TWO),
      ),
    ).toBeNull();
  });

  it("refuses a row published under another skill identity", async () => {
    state.tables.deal_skill_imports = [
      importedRow({ skill_id: "55555555-5555-4555-8555-555555555556" }),
    ];

    expect(
      await readPublicationMetadata(
        admin,
        DEAL,
        publication(VERSION_ONE, DIGEST_ONE),
      ),
    ).toBeNull();
  });

  it("never substitutes another version's contract for an unknown version", async () => {
    const unknown = "66666666-6666-4666-8666-666666666669";

    const resolved = await readPublicationMetadataBatch(admin, DEAL, [
      publication(unknown, DIGEST_ONE),
    ]);

    expect(resolved.size).toBe(0);
  });

  it("refuses a row carrying an unusable capability contract", async () => {
    state.tables.deal_skill_imports = [
      importedRow({ capability_contract: { purpose: "Draft the memo." } }),
    ];

    expect(
      await readPublicationMetadata(
        admin,
        DEAL,
        publication(VERSION_ONE, DIGEST_ONE),
      ),
    ).toBeNull();
  });
});

describe("destination lineage for a copied skill", () => {
  const STEP_ROW = "77777777-7777-4777-8777-777777777771";
  const STEP_KEY = "custom:copied-memo";

  function stepRow(): Row {
    return {
      id: STEP_ROW,
      deal_id: DEAL,
      step_id: STEP_KEY,
      origin: "custom",
      removed_at: null,
      work: {},
      definition: null,
      assigned_to: null,
      status: "pending",
    };
  }

  function bindingRow(versionId: string, digest: string): Row {
    return {
      deal_step_id: STEP_ROW,
      deal_id: DEAL,
      kind: "publication",
      skill_id: SKILL,
      version_id: versionId,
      mount_name: null,
      mount_version: null,
      digest,
    };
  }

  beforeEach(() => {
    state.lineage = [
      { versionId: VERSION_ONE, digest: DIGEST_ONE, publishedAt: "2026-09-01T08:00:00.000Z" },
      { versionId: VERSION_TWO, digest: DIGEST_TWO, publishedAt: "2026-09-10T08:00:00.000Z" },
    ];
    state.tables = {
      deal_steps: [stepRow()],
      deal_step_skill_bindings: [bindingRow(VERSION_ONE, DIGEST_ONE)],
      deal_skill_imports: [importedRow()],
      skill_publication_operations: [operationRow()],
      users: [
        { id: ACTOR_IMPORTER, full_name: null, display_name: "Storm Duncan", email: "storm@bank.test" },
        { id: ACTOR_AUTHOR, full_name: null, display_name: "Amara Boyd", email: "amara@bank.test" },
      ],
    };
  });

  it("attributes an imported version to its importer and an authored version to its author", async () => {
    const versions = await readStepVersions(admin, { id: DEAL }, STEP_KEY);

    expect(versions?.project.map((option) => [option.label, option.authorName])).toEqual([
      ["v2", "Amara Boyd"],
      ["v1", "Storm Duncan"],
    ]);
  });

  it("previews the imported ancestor's own contract when the step still selects it", async () => {
    const versions = await readStepVersions(admin, { id: DEAL }, STEP_KEY);

    expect(versions?.ancestorContract).toEqual({
      purpose: "Draft the imported memo.",
      expectedInput: "A reporting period.",
      expectedOutput: "A concise memo.",
    });
  });

  it("previews the authored contract once the step is rebound to the enhanced version", async () => {
    state.tables.deal_step_skill_bindings = [bindingRow(VERSION_TWO, DIGEST_TWO)];

    const versions = await readStepVersions(admin, { id: DEAL }, STEP_KEY);

    expect(versions?.ancestorContract?.purpose).toBe("Draft the enhanced memo.");
  });

  it("refuses a version another deal published under the same identity", async () => {
    state.tables.skill_publication_operations = [operationRow({ deal_id: OTHER_DEAL })];

    const versions = await readStepVersions(admin, { id: DEAL }, STEP_KEY);

    expect(versions?.project.map((option) => [option.label, option.authorName])).toEqual([
      ["v2", null],
      ["v1", "Storm Duncan"],
    ]);
  });
});

describe("imported comparison targets", () => {
  it("treats an imported skill as a duplicate target without an authoring draft", () => {
    const contract = {
      purpose: "Weekly memo",
      expectedInput: "Deal update",
      expectedOutput: "Memo",
    };
    const metadata: PublicationMetadata = {
      name: "Weekly memo",
      contract,
      actorId: "importer",
      createdAt: "2026-09-21T00:00:00Z",
    };
    const target = importedComparisonTarget("step-row", false, metadata, {
      skillId: "skill",
      versionId: "version",
      digest: "a".repeat(64),
    });

    expect(target.state).toBe("active");
    expect(target.capabilityContract).toEqual(contract);
    expect(target.candidate).toBeNull();
  });

  it("marks a removed step's imported target removed, keeping its binding", () => {
    const metadata: PublicationMetadata = {
      name: "Weekly memo",
      contract: {
        purpose: "Weekly memo",
        expectedInput: "Deal update",
        expectedOutput: "Memo",
      },
      actorId: "importer",
      createdAt: "2026-09-21T00:00:00Z",
    };
    const binding = { skillId: "skill", versionId: "version", digest: "a".repeat(64) };

    const target = importedComparisonTarget("step-row", true, metadata, binding);

    expect(target).toEqual({
      targetId: "step-row",
      state: "removed",
      displayName: "Weekly memo",
      capabilityContract: metadata.contract,
      skillBinding: binding,
      candidate: null,
    });
  });
});
