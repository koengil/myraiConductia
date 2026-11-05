import { vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  PreparationReceipt,
  PublicationLookup,
  PublicationReceipt,
} from "@/lib/skillPublication/types";
import type {
  OperationRow,
  ProcessorDeps,
  SkillPublicationClientResult,
} from "@/lib/skillPublication/processorTypes";
import {
  CANDIDATE_NAME,
  COMPARISON_SET_DIGEST,
  NOW,
  CORRELATION_ID,
  TENANT_ID,
  preparationReceipt,
  publicationReceipt,
} from "./skillPublicationProcessorFixtures";

type PatchLike = Record<string, unknown>;

const PATCH_COLUMN_MAP: Record<string, string> = {
  statusCode: "status_code",
  statusDealStepId: "status_deal_step_id",
  nextRetryAt: "next_retry_at",
  attemptCount: "attempt_count",
  comparisonSetDigest: "comparison_set_digest",
  preparationId: "preparation_id",
  assessmentDigest: "assessment_digest",
  duplicateMatches: "duplicate_matches",
  publishedSkillId: "published_skill_id",
  publishedVersionId: "published_version_id",
  publishedDigest: "published_digest",
};

function applyPatch(
  row: Record<string, unknown>,
  nextState: string,
  patch: PatchLike,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...row, state: nextState };
  for (const [patchKey, column] of Object.entries(PATCH_COLUMN_MAP)) {
    if (patchKey in patch) next[column] = patch[patchKey];
  }
  return next;
}

export type RpcCall = { fn: string; args: Record<string, unknown> };

export type StatefulAdminOptions = {
  operation: OperationRow;
  deals?: Record<string, { tenant_id: string }>;
  candidates?: Record<string, { preview: { name: string } }>;
  drafts?: Record<string, { basis_deal_step_id: string | null }>;
  authError?: { code: string } | null;
  attachResponse?: {
    data: unknown;
    error: { code?: string; message?: string } | null;
  };
  dueIds?: string[];
};

type AdminState = {
  opRow: Record<string, unknown>;
  deals: Record<string, { tenant_id: string }>;
  candidates: Record<string, { preview: { name: string } }>;
  drafts: Record<string, { basis_deal_step_id: string | null }>;
  authError: { code: string } | null;
  attachResponse: {
    data: unknown;
    error: { code?: string; message?: string } | null;
  };
  dueIds: string[];
  calls: RpcCall[];
};

function selectEq(
  state: AdminState,
  table: string,
  column: string,
  value: unknown,
) {
  if (table === "skill_publication_operations") {
    return Promise.resolve({
      data: state.opRow[column] === value ? [state.opRow] : [],
      error: null,
    });
  }
  if (table === "deals") {
    const row = state.deals[value as string];
    return Promise.resolve({
      data: row ? [{ tenant_id: row.tenant_id }] : [],
      error: null,
    });
  }
  if (table === "skill_authoring_candidates") {
    const row = state.candidates[value as string];
    return Promise.resolve({ data: row ? [row] : [], error: null });
  }
  if (table === "skill_authoring_drafts") {
    const row = state.drafts[value as string];
    return Promise.resolve({ data: row ? [row] : [], error: null });
  }
  return Promise.resolve({ data: [], error: null });
}

function buildFrom(state: AdminState) {
  return (table: string) => ({
    select: () => ({
      eq: (column: string, value: unknown) =>
        selectEq(state, table, column, value),
    }),
  });
}

function transitionRpc(state: AdminState, args: Record<string, unknown>) {
  const expectedStates = args.p_expected_states as string[];
  if (!expectedStates.includes(state.opRow.state as string)) {
    return { data: null, error: null };
  }
  state.opRow = applyPatch(
    state.opRow,
    args.p_next_state as string,
    args.p_patch as PatchLike,
  );
  return { data: { ...state.opRow }, error: null };
}

async function callRpc(
  state: AdminState,
  fn: string,
  args: Record<string, unknown>,
) {
  state.calls.push({ fn, args });
  if (fn === "skill_publication_read")
    return { data: state.authError ? null : {}, error: state.authError };
  if (fn === "skill_publication_transition") return transitionRpc(state, args);
  if (fn === "skill_publication_attach") return state.attachResponse;
  if (fn === "skill_publication_due")
    return { data: state.dueIds, error: null };
  return { data: null, error: null };
}

function buildAdminState(options: StatefulAdminOptions): AdminState {
  return {
    opRow: { ...options.operation },
    deals: options.deals ?? {
      [options.operation.deal_id]: { tenant_id: TENANT_ID },
    },
    candidates: options.candidates ?? {
      [options.operation.candidate_id]: { preview: { name: CANDIDATE_NAME } },
    },
    drafts: options.drafts ?? {},
    authError: options.authError ?? null,
    attachResponse: options.attachResponse ?? {
      data: { state: "published" },
      error: null,
    },
    dueIds: options.dueIds ?? [],
    calls: [],
  };
}

export function createStatefulAdmin(options: StatefulAdminOptions) {
  const state = buildAdminState(options);
  const admin = {
    from: buildFrom(state),
    rpc: (fn: string, args: Record<string, unknown>) =>
      callRpc(state, fn, args),
  } as unknown as SupabaseClient;

  return {
    admin,
    calls: state.calls,
    getOperation: () => state.opRow,
    setAuthError: (error: { code: string } | null) => {
      state.authError = error;
    },
    setAttachResponse: (response: {
      data: unknown;
      error: { code?: string; message?: string } | null;
    }) => {
      state.attachResponse = response;
    },
  };
}

export function fakeIgnatious(overrides: {
  prepare?: () => Promise<SkillPublicationClientResult<PreparationReceipt>>;
  publish?: () => Promise<SkillPublicationClientResult<PublicationReceipt>>;
  lookup?: () => Promise<SkillPublicationClientResult<PublicationLookup>>;
}) {
  return {
    prepare: vi.fn(
      overrides.prepare ??
        (async () => ({
          outcome: "success" as const,
          body: preparationReceipt(),
        })),
    ),
    publish: vi.fn(
      overrides.publish ??
        (async () => ({
          outcome: "success" as const,
          body: publicationReceipt(),
        })),
    ),
    lookup: vi.fn(
      overrides.lookup ??
        (async () => ({
          outcome: "success" as const,
          body: { status: "not_published" as const },
        })),
    ),
  };
}

export function fakeDeps(overrides: {
  admin: SupabaseClient;
  ignatious?: ReturnType<typeof fakeIgnatious>;
  buildComparisonSet?: ProcessorDeps["buildComparisonSet"];
  isFlagEnabled?: ProcessorDeps["isFlagEnabled"];
  now?: () => Date;
}): ProcessorDeps {
  return {
    admin: overrides.admin,
    ignatious: overrides.ignatious ?? fakeIgnatious({}),
    buildComparisonSet:
      overrides.buildComparisonSet ??
      (async () => ({
        targets: [],
        comparisonSetDigest: COMPARISON_SET_DIGEST,
      })),
    isFlagEnabled: overrides.isFlagEnabled ?? (async () => true),
    now: overrides.now ?? (() => NOW),
    correlationId: () => CORRELATION_ID,
  };
}
