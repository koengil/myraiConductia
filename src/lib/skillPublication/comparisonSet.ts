import type { SupabaseClient } from "@supabase/supabase-js";
import { TABLE } from "@/lib/constants/tables";
import {
  readPublicationMetadata,
  readPublicationMetadataBatch,
  type PublicationMetadata,
} from "@/lib/skillRun/publicationMetadata";
import { compareTargetId, comparisonSetDigestOf } from "./comparisonDigest";
import {
  bindingKey,
  buildAdmittedTargets,
  buildStepTargets,
  effectiveStepBindings,
  type DealStepRow,
  type OperationRow,
  type StepBindingRow,
} from "./comparisonTargets";
import type { ComparisonTarget, SkillBinding } from "./types";
import { dbFailure } from '@/lib/errors/upstream';

const OPERATION_SELECT =
  "id, name, capability_contract, candidate_id, provider_candidate_id, candidate_digest, published_skill_id, published_version_id, published_digest, resulting_deal_step_id, state";
const BINDING_SELECT = "deal_step_id, kind, skill_id, version_id, digest";

async function fetchDealSteps(
  admin: SupabaseClient,
  dealId: string,
): Promise<DealStepRow[]> {
  const { data, error } = await admin
    .from(TABLE.DEAL_STEPS)
    .select("id, definition, removed_at")
    .eq("deal_id", dealId);
  if (error) throw dbFailure('Comparison set steps read', error);
  return (data ?? []) as DealStepRow[];
}

async function fetchStepBindings(
  admin: SupabaseClient,
  dealId: string,
): Promise<Map<string, StepBindingRow>> {
  const { data, error } = await admin
    .from(TABLE.DEAL_STEP_SKILL_BINDINGS)
    .select(BINDING_SELECT)
    .eq("deal_id", dealId);
  if (error) throw dbFailure('Comparison set bindings read', error);
  return new Map(
    ((data ?? []) as StepBindingRow[]).map((row) => [row.deal_step_id, row]),
  );
}

async function fetchOperations(
  admin: SupabaseClient,
  dealId: string,
): Promise<OperationRow[]> {
  const { data, error } = await admin
    .from(TABLE.SKILL_PUBLICATION_OPERATIONS)
    .select(OPERATION_SELECT)
    .eq("deal_id", dealId);
  if (error) throw dbFailure('Comparison set operations read', error);
  return (data ?? []) as OperationRow[];
}

async function fetchBindingMetadata(
  admin: SupabaseClient,
  dealId: string,
  bindings: Map<string, SkillBinding>,
): Promise<Map<string, PublicationMetadata>> {
  const distinct = new Map<string, SkillBinding>();
  for (const binding of bindings.values()) {
    distinct.set(bindingKey(binding), binding);
  }

  const byVersion = new Map<string, SkillBinding[]>();
  for (const binding of distinct.values()) {
    const sharing = byVersion.get(binding.versionId);
    if (sharing === undefined) byVersion.set(binding.versionId, [binding]);
    else sharing.push(binding);
  }
  const alone: SkillBinding[] = [];
  const sharingVersion: SkillBinding[] = [];
  for (const group of byVersion.values()) {
    if (group.length === 1) alone.push(group[0]);
    else sharingVersion.push(...group);
  }

  const resolved = new Map<string, PublicationMetadata>();

  const batch = await readPublicationMetadataBatch(
    admin,
    dealId,
    alone.map(publicationRef),
  );
  for (const binding of alone) {
    const found = batch.get(binding.versionId);
    if (found !== undefined) resolved.set(bindingKey(binding), found);
  }

  const separately = await Promise.all(
    sharingVersion.map(async (binding) =>
      [
        bindingKey(binding),
        await readPublicationMetadata(admin, dealId, publicationRef(binding)),
      ] as const,
    ),
  );
  for (const [key, found] of separately) {
    if (found !== null) resolved.set(key, found);
  }

  return resolved;
}

function publicationRef(binding: SkillBinding) {
  return { kind: "publication" as const, ...binding };
}

export async function buildComparisonSet(
  admin: SupabaseClient,
  { dealId, operationId }: { dealId: string; operationId: string },
): Promise<{ targets: ComparisonTarget[]; comparisonSetDigest: string }> {
  const [steps, stepBindings, operations] = await Promise.all([
    fetchDealSteps(admin, dealId),
    fetchStepBindings(admin, dealId),
    fetchOperations(admin, dealId),
  ]);
  const bindings = effectiveStepBindings(steps, stepBindings);
  const metadata = await fetchBindingMetadata(admin, dealId, bindings);
  const stepTargets = buildStepTargets(steps, bindings, operations, metadata);
  const admittedTargets = buildAdmittedTargets(operations, operationId);
  const targets = [...stepTargets, ...admittedTargets].sort(compareTargetId);
  return { targets, comparisonSetDigest: comparisonSetDigestOf(targets) };
}
