import { describe, expect, it } from "vitest";

import type { BenchSkill } from "@/lib/ignatious/bench";
import type { CatalogVersionRecord } from "@/lib/skillRun/versions";
import {
  catalogOptions,
  catalogVersionDigest,
  projectOptions,
  resolveMountForStep,
} from "@/lib/skillRun/versions";

const SEED_HEX = "1991f0e865a24403de95e47b6df2e7a05357ad61240d9c624c456763d7546c5f";
const OLDER_HEX = "2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a";

function repoSeeded(overrides: Partial<CatalogVersionRecord> = {}): CatalogVersionRecord {
  return {
    version: 1,
    origin: "repo",
    sha256: null,
    contentHash: `sha256:${SEED_HEX}`,
    downloadable: true,
    updatedBy: "repo",
    updatedAt: "2026-09-13T12:32:36.037Z",
    inputs: [],
    ...overrides,
  };
}

function uploaded(overrides: Partial<CatalogVersionRecord> = {}): CatalogVersionRecord {
  return {
    version: 3,
    origin: "upload",
    sha256: "a".repeat(64),
    contentHash: null,
    downloadable: true,
    updatedBy: "sd@x.com",
    updatedAt: "2026-09-10T00:00:00Z",
    inputs: [],
    ...overrides,
  };
}

function benchSkill(overrides: Partial<BenchSkill> = {}): BenchSkill {
  return {
    name: "acquirer-strategy",
    origin: "repo",
    tag: { stageId: "phase-1", applicationId: "seq-9" },
    status: "ok",
    reason: null,
    description: null,
    version: 1,
    model: null,
    modelFrom: "seed",
    maxModel: null,
    maxEffort: null,
    routingFrom: "seed",
    tester: null,
    testStatus: "untested",
    enabled: true,
    sizeBytes: null,
    updatedAt: null,
    updatedBy: null,
    ...overrides,
  } as BenchSkill;
}

describe("catalogVersionDigest", () => {
  it("strips the algorithm prefix a repo version's content hash carries", () => {
    expect(catalogVersionDigest(repoSeeded())).toBe(SEED_HEX);
  });

  it("prefers the uploaded zip's hash when there is one", () => {
    expect(catalogVersionDigest(uploaded({ contentHash: `sha256:${SEED_HEX}` }))).toBe("a".repeat(64));
  });

  it("refuses a content hash that is not bare hex once the prefix is gone", () => {
    expect(catalogVersionDigest(repoSeeded({ contentHash: "sha256:not-a-hash" }))).toBeNull();
    expect(catalogVersionDigest(repoSeeded({ contentHash: null }))).toBeNull();
  });
});

describe("catalogOptions", () => {
  it("offers a current repo-seeded version that kept no zip, pinned on its content hash", () => {
    const options = catalogOptions("acquirer-strategy", [repoSeeded()]);

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      label: "v1",
      available: true,
      unavailableReason: null,
      reference: {
        kind: "mount",
        name: "acquirer-strategy",
        version: 1,
        digest: SEED_HEX,
      },
    });
  });

  it("lists an older repo-seeded version disabled, with the reason, rather than hiding it", () => {
    const options = catalogOptions("acquirer-strategy", [
      repoSeeded({ version: 2 }),
      repoSeeded({ version: 1, contentHash: `sha256:${OLDER_HEX}`, downloadable: false }),
    ]);

    expect(options.map((option) => option.label)).toEqual(["v2", "v1"]);
    expect(options[1]).toMatchObject({
      available: false,
      unavailableReason:
        "This catalog version shipped with a deployment that is gone, so its bytes are not here.",
      reference: { kind: "mount", name: "acquirer-strategy", version: 1, digest: OLDER_HEX },
    });
  });

  it("names pruning, not a missing image, when an upload lost its bytes", () => {
    const options = catalogOptions("demo", [
      uploaded(),
      uploaded({ version: 2, sha256: "b".repeat(64), downloadable: false }),
    ]);

    expect(options.map((option) => option.label)).toEqual(["v3", "v2"]);
    expect(options[0]).toMatchObject({ available: true, authorName: "sd@x.com" });
    expect(options[1]).toMatchObject({
      available: false,
      unavailableReason: "This catalog version no longer keeps its bytes.",
    });
  });

  it("drops a version with no recorded hash of any kind, which cannot be pinned", () => {
    expect(
      catalogOptions("demo", [
        uploaded({ version: 1, sha256: null, contentHash: null, downloadable: false }),
      ]),
    ).toEqual([]);
  });

  it("copies a record's declared input fields onto its option", () => {
    const options = catalogOptions("acquirer-strategy", [
      repoSeeded({ inputs: [{ name: "asOf", label: "As of", description: null, type: "date", values: [], required: false, default: null }] }),
    ]);

    expect(options[0].inputs).toEqual([
      { name: "asOf", label: "As of", description: null, type: "date", values: [], required: false, default: null },
    ]);
  });
});

describe("projectOptions", () => {
  it("lists a lineage newest first with its author", () => {
    const options = projectOptions("11111111-1111-4111-8111-111111111111", [
      { versionId: "22222222-2222-4222-8222-222222222222", digest: "c".repeat(64), publishedAt: "2026-09-12T00:00:00Z", authorName: "Storm Duncan", inputs: [] },
    ]);

    expect(options[0]).toMatchObject({
      label: "v1",
      authorName: "Storm Duncan",
      available: true,
    });
  });

  it("copies a lineage entry's declared input fields onto its option", () => {
    const field = { name: "asOf", label: "As of", description: null, type: "date" as const, values: [], required: false, default: null };
    const options = projectOptions("11111111-1111-4111-8111-111111111111", [
      { versionId: "22222222-2222-4222-8222-222222222222", digest: "c".repeat(64), publishedAt: "2026-09-12T00:00:00Z", authorName: "Storm Duncan", inputs: [field] },
    ]);

    expect(options[0].inputs).toEqual([field]);
  });

  it("numbers a lineage by publication order so same-day versions stay distinct", () => {
    const options = projectOptions("11111111-1111-4111-8111-111111111111", [
      { versionId: "33333333-3333-4333-8333-333333333333", digest: "d".repeat(64), publishedAt: "2026-09-16T14:00:00Z", authorName: "Storm Duncan", inputs: [] },
      { versionId: "22222222-2222-4222-8222-222222222222", digest: "c".repeat(64), publishedAt: "2026-09-16T09:00:00Z", authorName: "Storm Duncan", inputs: [] },
    ]);

    expect(options.map((option) => option.label)).toEqual(["v2", "v1"]);
    expect(options[0].reference).toMatchObject({ versionId: "33333333-3333-4333-8333-333333333333" });
    expect(options[1].reference).toMatchObject({ versionId: "22222222-2222-4222-8222-222222222222" });
  });
});

describe("resolveMountForStep", () => {
  const tag = { stageId: "phase-1", applicationId: "seq-9" };

  it("resolves a repo-seeded current version onto its bare content hash", async () => {
    const result = await resolveMountForStep(tag, [benchSkill()], async (name) => {
      expect(name).toBe("acquirer-strategy");
      return { current: 1, versions: [repoSeeded()] };
    });

    expect(result).toEqual({ name: "acquirer-strategy", version: 1, digest: SEED_HEX });
  });

  it("resolves an uploaded current version onto the zip hash", async () => {
    const result = await resolveMountForStep(
      tag,
      [benchSkill({ name: "demo", version: 3 })],
      async () => ({ current: 3, versions: [uploaded()] }),
    );

    expect(result).toEqual({ name: "demo", version: 3, digest: "a".repeat(64) });
  });

  it("returns null when no skill matches the tag", async () => {
    const result = await resolveMountForStep(tag, [], async () => ({ current: null, versions: [] }));
    expect(result).toBeNull();
  });

  it("returns null when the current repo version's bytes are not on this deployment", async () => {
    const result = await resolveMountForStep(tag, [benchSkill()], async () => ({
      current: 1,
      versions: [repoSeeded({ downloadable: false })],
    }));

    expect(result).toBeNull();
  });

  it("returns null when the matched version records no hash at all", async () => {
    const result = await resolveMountForStep(tag, [benchSkill()], async () => ({
      current: 1,
      versions: [repoSeeded({ contentHash: null })],
    }));

    expect(result).toBeNull();
  });
});
