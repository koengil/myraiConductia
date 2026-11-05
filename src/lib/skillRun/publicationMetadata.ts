import type { SupabaseClient } from "@supabase/supabase-js";

import { TABLE } from "@/lib/constants/tables";
import { isRecord } from "@/lib/skillPublication/parse";
import { parseCapabilityContract } from "@/lib/skillPublication/parseService";
import type { CapabilityContract } from "@/lib/skillPublication/types";

import type { SkillReference } from "./types";
import { dbFailure } from '@/lib/errors/upstream';

export type PublicationMetadata = {
  name: string;
  contract: CapabilityContract;
  actorId: string;
  createdAt: string;
};

type PublicationRef = Extract<SkillReference, { kind: "publication" }>;

type MetadataRow = {
  skillId: unknown;
  digest: unknown;
  name: unknown;
  contract: unknown;
  actorId: unknown;
  createdAt: unknown;
};

const OPERATION_COLUMNS =
  "published_skill_id, published_version_id, published_digest, name, capability_contract, actor_id, created_at";
const IMPORT_COLUMNS =
  "skill_id, version_id, digest, name, capability_contract, imported_by, created_at";

export async function readPublicationMetadataBatch(
  admin: SupabaseClient,
  dealId: string,
  references: PublicationRef[],
): Promise<Map<string, PublicationMetadata>> {
  const wanted = new Map<string, PublicationRef>();
  for (const reference of references) {
    wanted.set(reference.versionId, reference);
  }
  const resolved = new Map<string, PublicationMetadata>();
  if (wanted.size === 0) return resolved;

  const operations = await readRows(
    admin,
    TABLE.SKILL_PUBLICATION_OPERATIONS,
    OPERATION_COLUMNS,
    dealId,
    "published_version_id",
    [...wanted.keys()],
  );
  collect(wanted, resolved, operations, (row) => ({
    skillId: row.published_skill_id,
    digest: row.published_digest,
    name: row.name,
    contract: row.capability_contract,
    actorId: row.actor_id,
    createdAt: row.created_at,
    versionId: row.published_version_id,
  }));

  const missing = [...wanted.keys()].filter(
    (versionId) => !resolved.has(versionId),
  );
  if (missing.length === 0) return resolved;

  const imports = await readRows(
    admin,
    TABLE.DEAL_SKILL_IMPORTS,
    IMPORT_COLUMNS,
    dealId,
    "version_id",
    missing,
  );
  collect(wanted, resolved, imports, (row) => ({
    skillId: row.skill_id,
    digest: row.digest,
    name: row.name,
    contract: row.capability_contract,
    actorId: row.imported_by,
    createdAt: row.created_at,
    versionId: row.version_id,
  }));

  return resolved;
}

export async function readPublicationMetadata(
  admin: SupabaseClient,
  dealId: string,
  reference: PublicationRef,
): Promise<PublicationMetadata | null> {
  const batch = await readPublicationMetadataBatch(admin, dealId, [reference]);
  return batch.get(reference.versionId) ?? null;
}

async function readRows(
  admin: SupabaseClient,
  table: string,
  columns: string,
  dealId: string,
  versionColumn: string,
  versionIds: string[],
): Promise<Record<string, unknown>[]> {
  const { data, error } = await admin
    .from(table)
    .select(columns)
    .eq("deal_id", dealId)
    .in(versionColumn, versionIds);
  if (error) throw dbFailure('Publication metadata read', error);
  return Array.isArray(data) ? (data as unknown as Record<string, unknown>[]) : [];
}

function collect(
  wanted: Map<string, PublicationRef>,
  resolved: Map<string, PublicationMetadata>,
  rows: Record<string, unknown>[],
  read: (row: Record<string, unknown>) => MetadataRow & { versionId: unknown },
): void {
  for (const raw of rows) {
    if (!isRecord(raw)) continue;
    const row = read(raw);
    if (typeof row.versionId !== "string") continue;
    const reference = wanted.get(row.versionId);
    if (!reference || resolved.has(row.versionId)) continue;
    if (row.skillId !== reference.skillId || row.digest !== reference.digest) {
      continue;
    }
    const contract = parseCapabilityContract(row.contract);
    if (
      contract === null ||
      typeof row.name !== "string" ||
      row.name.trim() === "" ||
      typeof row.actorId !== "string" ||
      typeof row.createdAt !== "string"
    ) {
      continue;
    }
    resolved.set(row.versionId, {
      name: row.name,
      contract,
      actorId: row.actorId,
      createdAt: row.createdAt,
    });
  }
}
