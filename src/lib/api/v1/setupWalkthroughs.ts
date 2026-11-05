import type { SupabaseClient } from '@supabase/supabase-js';
import { hasCompanyPermissionChecked } from '@/lib/api/v1/companyAccess';
import { COMPANY_PERMISSION } from '@/lib/constants/companyPermissions';
import { COMPANY_ROLE, FIRM_ROLE } from '@/lib/constants/roles';
import {
  SETUP_WALKTHROUGH_TRACK,
  type SetupWalkthroughTrack,
} from '@/lib/constants/setupWalkthroughs';
import { USER_STATUS } from '@/lib/constants/users';

export type SetupActor = {
  firmRole: string | null;
  companyId: string | null;
  companyRole: string | null;
  isExternal: boolean;
};

export type SetupActorResult =
  | { ok: true; actor: SetupActor; tracks: SetupWalkthroughTrack[] }
  | { ok: false; reason: 'not_eligible' | 'unreadable' };

type ActorRow = {
  firm_role: string | null;
  company_id: string | null;
  company_role: string | null;
  is_external: boolean;
  status: string;
};

/** Resolve only the tracks the caller may attest. Unknown authority fails closed. */
export async function resolveSetupActor(
  admin: SupabaseClient,
  userId: string,
): Promise<SetupActorResult> {
  const { data, error } = await admin
    .from('users')
    .select('firm_role, company_id, company_role, is_external, status')
    .eq('id', userId)
    .maybeSingle();
  if (error || !data) return { ok: false, reason: 'unreadable' };

  const row = data as ActorRow;
  if (row.status !== USER_STATUS.ACTIVE) return { ok: false, reason: 'not_eligible' };

  const actor: SetupActor = {
    firmRole: row.firm_role,
    companyId: row.company_id,
    companyRole: row.company_role,
    isExternal: row.is_external,
  };
  const tracks: SetupWalkthroughTrack[] = [SETUP_WALKTHROUGH_TRACK.USER];
  if (actor.isExternal) {
    if (actor.companyId && actor.companyRole === COMPANY_ROLE.DIRECTOR) {
      tracks.push(SETUP_WALKTHROUGH_TRACK.ADMINISTRATOR);
    }
    return { ok: true, actor, tracks };
  }

  const isRoot =
    actor.firmRole === FIRM_ROLE.ADMIN ||
    (actor.companyId !== null && actor.companyRole === COMPANY_ROLE.DIRECTOR);
  if (isRoot) {
    tracks.push(SETUP_WALKTHROUGH_TRACK.ADMINISTRATOR);
    return { ok: true, actor, tracks };
  }

  if (actor.companyId) {
    const delegated = await hasCompanyPermissionChecked(
      admin,
      userId,
      actor.companyId,
      COMPANY_PERMISSION.ACCESS_ASSIGN,
    );
    if (delegated === 'unreadable') return { ok: false, reason: 'unreadable' };
    if (delegated) tracks.push(SETUP_WALKTHROUGH_TRACK.ADMINISTRATOR);
  }
  return { ok: true, actor, tracks };
}

export type SetupProgress = {
  track: SetupWalkthroughTrack;
  content_version: number;
  revision: number;
  completed_steps: string[];
  completed_at: string | null;
};

export function parseSetupProgress(value: unknown): SetupProgress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    (row.track !== SETUP_WALKTHROUGH_TRACK.USER &&
      row.track !== SETUP_WALKTHROUGH_TRACK.ADMINISTRATOR) ||
    typeof row.content_version !== 'number' ||
    !Number.isSafeInteger(row.content_version) ||
    typeof row.revision !== 'number' ||
    !Number.isSafeInteger(row.revision) ||
    !Array.isArray(row.completed_steps) ||
    !row.completed_steps.every((step) => typeof step === 'string') ||
    (row.completed_at !== null && typeof row.completed_at !== 'string')
  ) {
    return null;
  }
  return row as SetupProgress;
}
