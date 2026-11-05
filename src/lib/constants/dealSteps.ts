// Deal step-state constants (G16). Mirror the deal_steps.status CHECK enum in
// supabase/migrations/20260716180000_deal_steps.sql (the migration is the source
// of truth). Kept in sync by tests/constants-schema-sync.test.ts.

import { DEAL_ROLE, type DealRole } from '@/lib/constants/roles';

export const STEP_STATUS = {
  /** Not reached yet (after the current cursor). */
  PENDING: 'pending',
  /** The cursor — the step the deal is on. */
  CURRENT: 'current',
  /** Done. */
  COMPLETE: 'complete',
  /** Before the lifecycle entry point — skipped at Gate 0 (NOT completed). */
  SKIPPED_ENTRY: 'skipped_entry',
  /** Explicitly skipped later on the rail (logged skip). */
  SKIPPED: 'skipped',
} as const;

export type StepStatus = (typeof STEP_STATUS)[keyof typeof STEP_STATUS];
export const STEP_STATUSES = Object.values(STEP_STATUS) as StepStatus[];

/**
 * Deal seats whose holder may approve a step skip (#312): MD, deal team, legal.
 * Counterparty seats and read_only are not approvers. Owner decision 2026-10-16
 * (1B). The skip routes and the Skip modal both read this list.
 */
export const SKIP_APPROVER_DEAL_ROLES = [
  DEAL_ROLE.MD,
  DEAL_ROLE.DEAL_TEAM,
  DEAL_ROLE.LEGAL,
] as const satisfies readonly DealRole[];

/**
 * The rail census this step-state was seeded against. Stored on every deal_steps
 * row so a future re-cut (the 5/65 census has re-cut once already;
 * normalizeStoredDeal exists for exactly this) is detectable and re-mappable
 * rather than silently drifting. Bump when the canonical census changes.
 */
export const RAIL_CENSUS_VERSION = 'hv-5x65-2026-07-08';

/**
 * Lifecycle of a skill-bench draft run recorded on a step. Mirrors the
 * deal_steps.bench_run_status CHECK enum in
 * supabase/migrations/20260903130000_deal_step_bench_session.sql.
 */
export const BENCH_RUN_STATUS = {
  RUNNING: 'running',
  COMPLETE: 'complete',
  FAILED: 'failed',
} as const;

export type BenchRunStatus = (typeof BENCH_RUN_STATUS)[keyof typeof BENCH_RUN_STATUS];
export const BENCH_RUN_STATUSES = Object.values(BENCH_RUN_STATUS) as BenchRunStatus[];

/**
 * Which kind of skill reference a step binding names. Mirrors the
 * deal_step_skill_bindings.kind CHECK enum in
 * supabase/migrations/20260916140000_skill_enhancement_and_version_selection.sql.
 */
export const SKILL_BINDING_KIND = {
  PUBLICATION: 'publication',
  MOUNT: 'mount',
} as const;

export type SkillBindingKind = (typeof SKILL_BINDING_KIND)[keyof typeof SKILL_BINDING_KIND];
export const SKILL_BINDING_KINDS = Object.values(SKILL_BINDING_KIND) as SkillBindingKind[];

/**
 * How a step came to be bound to that reference. Mirrors the
 * deal_step_skill_bindings.source CHECK enum, last widened with 'template' in
 * 20260921110000_create_deal_from_template.sql.
 */
export const SKILL_BINDING_SOURCE = {
  PUBLICATION: 'publication',
  SELECTION: 'selection',
  TEMPLATE: 'template',
} as const;

export type SkillBindingSource = (typeof SKILL_BINDING_SOURCE)[keyof typeof SKILL_BINDING_SOURCE];
export const SKILL_BINDING_SOURCES = Object.values(SKILL_BINDING_SOURCE) as SkillBindingSource[];

/**
 * Where a recorded run came from. Mirrors the deal_step_skill_runs.source CHECK
 * enum in the same migration.
 */
export const SKILL_RUN_SOURCE = {
  EXECUTION: 'execution',
  IMPORTED: 'imported',
  REVISION: 'revision',
} as const;

export type SkillRunSource = (typeof SKILL_RUN_SOURCE)[keyof typeof SKILL_RUN_SOURCE];
export const SKILL_RUN_SOURCES = Object.values(SKILL_RUN_SOURCE) as SkillRunSource[];
