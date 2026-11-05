import type { SupabaseClient } from "@supabase/supabase-js";

import { TABLE } from "@/lib/constants/tables";
import type { BenchSkill } from "@/lib/ignatious/bench";
import { createSkillBench, isRunnableBenchSkill, listPublicationLineage } from "@/lib/ignatious/bench";
import { readIgnatiousConfig } from "@/lib/ignatious/config";
import {
  CATALOG_VERSION_PRUNED_MESSAGE,
  CATALOG_VERSION_UNRECOVERABLE_MESSAGE,
} from "@/lib/ignatious/failure";
import { processTagForRailStep, skillMatchesProcessTag, type ProcessTag } from "@/lib/ignatious/processTag";
import { hasExactKeys, isDigest, isNonnegativeInteger, isRecord, isUuid } from "@/lib/skillPublication/parse";
import type { CapabilityContract } from "@/lib/skillPublication/types";

import {
  readPublicationMetadata,
  readPublicationMetadataBatch,
} from "./publicationMetadata";
import type { SkillInputField } from "./inputs";
import { resolveStepBinding } from "./step";
import type { SkillReference } from "./types";

export type VersionOption = {
  reference: SkillReference;
  label: string;
  authorName: string | null;
  createdAt: string | null;
  available: boolean;
  unavailableReason: string | null;
  inputs: SkillInputField[];
};

export type StepVersions = {
  current: SkillReference | null;
  project: VersionOption[];
  projectUnavailableReason: string | null;
  catalog: VersionOption[];
  ancestorContract: CapabilityContract | null;
};

export type CatalogVersionRecord = {
  version: number;
  origin: "repo" | "upload";
  sha256: string | null;
  contentHash: string | null;
  downloadable: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
  inputs: SkillInputField[];
};

export type LineageAuthorEntry = {
  versionId: string;
  digest: string;
  publishedAt: string;
  authorName: string | null;
  inputs: SkillInputField[];
};

const CONTENT_HASH_PREFIX = "sha256:";

export function catalogVersionDigest(record: CatalogVersionRecord): string | null {
  if (isDigest(record.sha256)) return record.sha256;
  const content = record.contentHash;
  if (typeof content !== "string") return null;
  const bare = content.startsWith(CONTENT_HASH_PREFIX)
    ? content.slice(CONTENT_HASH_PREFIX.length)
    : content;
  return isDigest(bare) ? bare : null;
}

function catalogUnavailableReason(record: CatalogVersionRecord): string {
  return record.origin === "repo" && record.contentHash !== null
    ? CATALOG_VERSION_UNRECOVERABLE_MESSAGE
    : CATALOG_VERSION_PRUNED_MESSAGE;
}

export function catalogOptions(name: string, records: CatalogVersionRecord[]): VersionOption[] {
  return records
    .slice()
    .sort((a, b) => b.version - a.version)
    .flatMap((record): VersionOption[] => {
      const digest = catalogVersionDigest(record);
      if (digest === null) return [];
      return [
        {
          reference: { kind: "mount", name, version: record.version, digest },
          label: `v${record.version}`,
          authorName: record.updatedBy,
          createdAt: record.updatedAt,
          available: record.downloadable,
          unavailableReason: record.downloadable ? null : catalogUnavailableReason(record),
          inputs: record.inputs,
        },
      ];
    });
}

export function projectOptions(skillId: string, entries: LineageAuthorEntry[]): VersionOption[] {
  const oldestFirst = entries
    .slice()
    .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
  const ordinals = new Map(oldestFirst.map((entry, index) => [entry.versionId, index + 1]));
  return oldestFirst
    .reverse()
    .map((entry) => ({
      reference: { kind: "publication", skillId, versionId: entry.versionId, digest: entry.digest },
      label: `v${ordinals.get(entry.versionId) ?? 1}`,
      authorName: entry.authorName,
      createdAt: entry.publishedAt,
      available: true,
      unavailableReason: null,
      inputs: entry.inputs,
    }));
}

export function matchBenchSkill(tag: ProcessTag, skills: BenchSkill[]): BenchSkill | null {
  return (
    skills.find(
      (skill) =>
        isRunnableBenchSkill(skill) &&
        skillMatchesProcessTag(skill.tag, tag) &&
        skill.tag?.stageId !== "always",
    ) ?? null
  );
}

export async function resolveMountForStep(
  tag: ProcessTag,
  skills: BenchSkill[],
  fetchVersions: (name: string) => Promise<{ current: number | null; versions: CatalogVersionRecord[] }>,
): Promise<{ name: string; version: number; digest: string } | null> {
  const match = matchBenchSkill(tag, skills);
  if (!match || match.version === null) return null;

  const { versions } = await fetchVersions(match.name);
  const current = versions.find((version) => version.version === match.version);
  if (!current || !current.downloadable) return null;
  const digest = catalogVersionDigest(current);
  if (digest === null) return null;

  return { name: match.name, version: match.version, digest };
}

export async function resolveMountTripleForStep(
  stepId: string,
): Promise<{ name: string; version: number; digest: string } | null> {
  const config = readIgnatiousConfig();
  const tag = processTagForRailStep(stepId);
  if (!config || !tag) return null;

  const bench = createSkillBench(config);
  const listed = await bench.listSkills();
  return resolveMountForStep(tag, listed.skills, (name) => bench.listVersions(name));
}

const STEP_COLUMNS = "id, step_id, origin, removed_at, work, definition, assigned_to, status";
const BINDING_COLUMNS = "kind, skill_id, version_id, mount_name, mount_version, digest";
const PROJECT_UNAVAILABLE_REASON = "This project's skill version history could not be read.";

export async function readStep(
  admin: SupabaseClient,
  dealId: string,
  stepId: string,
): Promise<Record<string, unknown> | null> {
  const { data } = await admin
    .from(TABLE.DEAL_STEPS)
    .select(STEP_COLUMNS)
    .eq("deal_id", dealId)
    .eq("step_id", stepId)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

async function readBinding(
  admin: SupabaseClient,
  dealStepId: string,
): Promise<Record<string, unknown> | null> {
  const { data } = await admin
    .from(TABLE.DEAL_STEP_SKILL_BINDINGS)
    .select(BINDING_COLUMNS)
    .eq("deal_step_id", dealStepId)
    .maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

async function readProjectOptions(
  admin: SupabaseClient,
  skillId: string,
  dealId: string,
): Promise<{ project: VersionOption[]; projectUnavailableReason: string | null }> {
  let lineage: Awaited<ReturnType<typeof listPublicationLineage>>;
  try {
    lineage = await listPublicationLineage(skillId, dealId);
  } catch {
    return { project: [], projectUnavailableReason: PROJECT_UNAVAILABLE_REASON };
  }
  if (lineage.length === 0) return { project: [], projectUnavailableReason: null };

  const metadata = await readPublicationMetadataBatch(
    admin,
    dealId,
    lineage.map((entry) => ({
      kind: "publication" as const,
      skillId,
      versionId: entry.versionId,
      digest: entry.digest,
    })),
  );
  const actorIds = [...new Set([...metadata.values()].map((found) => found.actorId))];

  const { data: people } =
    actorIds.length > 0
      ? await admin.from(TABLE.USERS).select("id, full_name, display_name, email").in("id", actorIds)
      : { data: [] as Record<string, unknown>[] };

  const nameFor = new Map(
    ((people ?? []) as Record<string, unknown>[]).map((person) => [
      person.id as string,
      (person.display_name as string | null) ??
        (person.full_name as string | null) ??
        (person.email as string),
    ]),
  );

  const entries: LineageAuthorEntry[] = lineage.map((entry) => {
    const actorId = metadata.get(entry.versionId)?.actorId ?? null;
    return {
      ...entry,
      authorName: actorId ? (nameFor.get(actorId) ?? null) : null,
    };
  });

  return { project: projectOptions(skillId, entries), projectUnavailableReason: null };
}

async function readAncestorContract(
  admin: SupabaseClient,
  dealId: string,
  current: SkillReference | null,
): Promise<CapabilityContract | null> {
  if (!current || current.kind !== "publication") return null;
  const metadata = await readPublicationMetadata(admin, dealId, current);
  return metadata?.contract ?? null;
}

export async function readStepVersions(
  admin: SupabaseClient,
  deal: { id: string },
  stepId: string,
): Promise<StepVersions | null> {
  const row = await readStep(admin, deal.id, stepId);
  if (!row || typeof row.id !== "string") return null;

  const binding = await readBinding(admin, row.id);

  let catalog: VersionOption[] = [];
  let mount: { name: string; version: number; digest: string } | null = null;

  const config = readIgnatiousConfig();
  const tag = processTagForRailStep(stepId);
  if (config && tag) {
    const bench = createSkillBench(config);
    const listed = await bench.listSkills();
    const skills: BenchSkill[] = listed.skills;
    const catalogSkill = matchBenchSkill(tag, skills);
    if (catalogSkill) {
      const versionsResult = await bench.listVersions(catalogSkill.name);
      catalog = catalogOptions(catalogSkill.name, versionsResult.versions);
      mount = await resolveMountForStep(tag, skills, async () => versionsResult);
    }
  }

  const resolved = resolveStepBinding(
    row,
    binding,
    mount?.name ?? null,
    mount?.version ?? null,
    mount?.digest ?? null,
  );
  const current = resolved.ok ? resolved.step.binding : null;

  let project: VersionOption[] = [];
  let projectUnavailableReason: string | null = null;
  if (current?.kind === "publication") {
    const result = await readProjectOptions(admin, current.skillId, deal.id);
    project = result.project;
    projectUnavailableReason = result.projectUnavailableReason;
  }

  const ancestorContract = await readAncestorContract(admin, deal.id, current);

  return { current, project, projectUnavailableReason, catalog, ancestorContract };
}

export function parseSkillReference(value: unknown): SkillReference | null {
  if (!isRecord(value)) return null;

  if (value.kind === "publication") {
    if (
      !hasExactKeys(value, ["kind", "skillId", "versionId", "digest"]) ||
      !isUuid(value.skillId) ||
      !isUuid(value.versionId) ||
      !isDigest(value.digest)
    ) {
      return null;
    }
    return { kind: "publication", skillId: value.skillId, versionId: value.versionId, digest: value.digest };
  }

  if (value.kind === "mount") {
    if (
      !hasExactKeys(value, ["kind", "name", "version", "digest"]) ||
      typeof value.name !== "string" ||
      value.name.trim().length === 0 ||
      !isNonnegativeInteger(value.version) ||
      value.version <= 0 ||
      !isDigest(value.digest)
    ) {
      return null;
    }
    return { kind: "mount", name: value.name, version: value.version, digest: value.digest };
  }

  return null;
}

export function referencesMatch(a: SkillReference, b: SkillReference): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "publication" && b.kind === "publication") {
    return a.skillId === b.skillId && a.versionId === b.versionId && a.digest === b.digest;
  }
  if (a.kind === "mount" && b.kind === "mount") {
    return a.name === b.name && a.version === b.version && a.digest === b.digest;
  }
  return false;
}

export function isAvailable(versions: StepVersions, reference: SkillReference): boolean {
  return [...versions.project, ...versions.catalog].some(
    (option) => option.available && referencesMatch(option.reference, reference),
  );
}

export function unavailableReasonFor(
  versions: StepVersions,
  reference: SkillReference,
): string | null {
  const option = [...versions.project, ...versions.catalog].find((candidate) =>
    referencesMatch(candidate.reference, reference),
  );
  return option && !option.available ? option.unavailableReason : null;
}
