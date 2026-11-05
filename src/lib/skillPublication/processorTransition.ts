import type { SupabaseClient } from "@supabase/supabase-js";
import type { PublicationState } from "./types";
import type { AdvanceResult, TransitionPatch } from "./processorTypes";
import { dbFailure } from '@/lib/errors/upstream';

const PAUSE_CODES = new Set(["access_lost", "feature_disabled"]);

export function isPauseCode(code: string | null): boolean {
  return code !== null && PAUSE_CODES.has(code);
}

export function pauseClearPatch(op: {
  status_code: string | null;
}): TransitionPatch {
  return isPauseCode(op.status_code) ? { statusCode: null } : {};
}

export async function callTransition(
  admin: SupabaseClient,
  publicationId: string,
  expectedStates: PublicationState[],
  nextState: PublicationState,
  patch: TransitionPatch,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await admin.rpc("skill_publication_transition", {
    p_publication_id: publicationId,
    p_expected_states: expectedStates,
    p_next_state: nextState,
    p_patch: patch,
  });
  if (error) {
    throw dbFailure("Skill publication transition", error);
  }
  return (data ?? null) as Record<string, unknown> | null;
}

export function toAdvanceResult(
  publicationId: string,
  fromState: PublicationState,
  nextState: PublicationState,
  data: Record<string, unknown> | null,
): AdvanceResult {
  if (data === null) {
    return { publicationId, state: fromState, progressed: false };
  }
  return { publicationId, state: nextState, progressed: true };
}

export async function transitionResult(
  admin: SupabaseClient,
  publicationId: string,
  fromState: PublicationState,
  nextState: PublicationState,
  patch: TransitionPatch,
): Promise<AdvanceResult> {
  const data = await callTransition(
    admin,
    publicationId,
    [fromState],
    nextState,
    patch,
  );
  return toAdvanceResult(publicationId, fromState, nextState, data);
}
