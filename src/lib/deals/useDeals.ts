'use client';

import type { LifecycleCategory, ScheduleStatus } from '@/lib/constants/deals';
import type { BenchRunStatus } from '@/lib/constants/dealSteps';
import * as React from 'react';

import {
  bumpGeneration,
  generationOfError,
  identityGeneration,
  isCurrentGeneration,
  isReadTimeout,
  readGeneration,
  sharedRead,
  subscribeGeneration,
} from '@/lib/api/inflightRead';
import { useFlag } from '@/lib/flags/FlagsContext';
import {
  SEED_DEALS,
  getAllDeals,
  type DealCurrentStep,
  type FixtureDeal,
} from '@/lib/rail/deals';
import { phaseForStep, stepIdForSeq, MVP_DEAL_RAIL } from '@/lib/rail/dealRail';
import { RAIL_LOAD_DEADLINE_MS } from '@/lib/rail/railLoadStage';

/**
 * useDeals — the deal-list read side (G13). Mirrors `useCurrentUser`: a hook (no
 * provider), API-first behind the `gate0_api_create` flag with a fixture
 * fallback, exposing a `reload`. Every deal-list surface (sidebar, portfolio,
 * command center, deal switcher) reads through this so a created deal appears
 * everywhere without a page reload.
 *
 * Fixture mode (platform_onboarding OFF, gate0_api_create OFF): the
 * localStorage fixture set (`getAllDeals`), unchanged demo.
 * API mode (either flag ON): GET /api/v1/deals, mapped into the same
 * `FixtureDeal` shape the surfaces already render. Fixtures stand in for a
 * failed fetch only while platform_onboarding is OFF, and never for a read
 * that outlived its deadline: that is an `error` state with a retry (#162).
 *
 * COMPLIANCE: the routing `id` is the deal CODE (never the target) — matching
 * the wizard's flag-on landing and the forthcoming code-as-URL cutover (G14).
 */

/** The person the deal's current step is assigned to. */
type DealAssignee = { id: string; name: string };

/** One phase's progress on the deal's own rail: done (complete or skipped) of total. */
type PhaseProgress = { phaseIndex: number; done: number; total: number };

/** The current step as GET /api/v1/deals carries it. */
type ListedCurrentStep = DealCurrentStep & {
  assignee?: DealAssignee | null;
  /** The step's draft run: 'running' while Conductia is drafting it. */
  benchRunStatus?: BenchRunStatus | null;
};

/** A deal as the list read side returns it: the fixture shape plus what the
 *  API adds for the Conductor Center. Fixture deals carry none of the extras. */
export type ListedDeal = FixtureDeal & {
  currentStep?: ListedCurrentStep | null;
  /** Per phase, from the deal's own steps; null or absent when not read. */
  phaseProgress?: PhaseProgress[] | null;
  /**
   * The deal's database id. Notifications name a deal by it (deal_id) while
   * the URL uses the code, so the nav's per-deal count badges match on it.
   */
  uuid?: string;
};

type ApiDeal = {
  id: string;
  code: string;
  codename: string;
  status: string;
  createdAt: string;
  entryStepSeq: number;
  currentStepSeq: number;
  currentStep?: ListedCurrentStep | null;
  phaseProgress?: PhaseProgress[] | null;
  targetName: string | null;
  dealRole: string | null;
  conflictsApprovedBy: string | null;
  conflictsApprovedOn: string | null;
  /** The MD's target close date (ISO date) — Book graduation field 1. */
  targetCloseDate?: string | null;
  /** The mandate fee in whole USD — Book graduation field 2. */
  feeUsd?: number | null;
  /** ahead | on_time | late — Book graduation field 3. */
  scheduleStatus?: ScheduleStatus | null;
  /** Storm's lifecycle category — Book graduation field 4. */
  lifecycleCategory?: LifecycleCategory | null;
};

export type DealListSource = { apiEnabled: boolean; fixtureFallback: boolean };

export function dealListSource(
  apiCreateEnabled: boolean,
  platformOnboardingEnabled: boolean,
): DealListSource {
  return {
    apiEnabled: apiCreateEnabled || platformOnboardingEnabled,
    fixtureFallback: !platformOnboardingEnabled,
  };
}

export function useDealListSource(): DealListSource {
  return dealListSource(useFlag('gate0_api_create'), useFlag('platform_onboarding'));
}

/**
 * An honest placeholder for a real deal that isn't resolved yet (list still
 * loading) or has no authored dataset. Shows the deal CODE as its identity —
 * never another deal's name — with an empty/day-one body. Used so flag-on
 * surfaces never fall back to a seed deal (e.g. Project Summit) for a real deal.
 */
export function pendingDealForCode(code: string): FixtureDeal {
  return {
    id: code,
    codename: code,
    code,
    target: '',
    sector: '',
    status: 'Intake',
    cursorStepId: stepIdForSeq(1),
    entryStepSeq: 1,
    gate0Complete: true,
    dealRole: 'Member',
  };
}

/**
 * True when a deal row matches the /projects/[segment] route param: its
 * routing id, its code, or its database uuid. Links stored server-side
 * (notification hrefs) still carry the uuid (handoff E33), so a uuid route
 * resolves the same deal by name, never shows the raw uuid.
 */
export function dealMatchesSegment(deal: FixtureDeal, segment: string): boolean {
  if (!segment) return false;
  return deal.id === segment || deal.code === segment || dealUuidOf(deal) === segment;
}

export function findDealBySegment(
  deals: readonly FixtureDeal[],
  segment: string,
): FixtureDeal | null {
  return deals.find((d) => dealMatchesSegment(d, segment)) ?? null;
}

/**
 * The deal for the URL segment when it is one of the viewer's own deals (the
 * list, or the fixture set while that stands in), else null. Never the pending
 * placeholder, so a switcher label built from it never shows a raw code.
 */
export function resolveListedDeal(
  segment: string,
  deals: readonly FixtureDeal[],
  source: DealListSource,
): FixtureDeal | null {
  const inList = findDealBySegment(deals, segment);
  if (inList) return inList;

  if (source.fixtureFallback) return findDealBySegment(getAllDeals(), segment);

  return null;
}

/** Resolve the deal for the active URL segment — mirrors DealContextBar (G22). */
export function resolveActiveDeal(
  segment: string,
  deals: readonly FixtureDeal[],
  source: DealListSource,
): FixtureDeal | null {
  const listed = resolveListedDeal(segment, deals, source);
  if (listed) return listed;

  if (source.apiEnabled) return pendingDealForCode(segment);

  return null;
}

/**
 * The deal for this URL segment — same resolution as DealContextBar (G22).
 * Flag-on never falls back to a seed deal (e.g. Project Summit) for a real
 * code; an unresolved real deal shows an honest pending placeholder.
 */
export function useActiveDeal(segment: string): FixtureDeal {
  return useActiveDealState(segment).deal;
}

/**
 * `useActiveDeal` for callers outside the rail gate (#162). When the deal list
 * failed, `unavailable` is true: the caller renders the unavailable statement
 * with `retry` instead of the placeholder's facts. `deal` keeps
 * `useActiveDeal`'s contract (a deal, or the pending placeholder).
 */
export function useActiveDealState(segment: string): {
  deal: FixtureDeal;
  unavailable: boolean;
  retry: () => void;
} {
  const { deals, error, reload } = useDeals();
  const source = useDealListSource();
  const deal = resolveActiveDeal(segment, deals, source) ?? pendingDealForCode(segment);
  return { deal, unavailable: error, retry: reload };
}

export type ResolvedDeal =
  | { status: 'resolving' }
  | { status: 'ready'; deal: FixtureDeal }
  | { status: 'unknown' }
  /** The deal list failed: never "not found", never a fixture. */
  | { status: 'error'; retry: () => void };

export function useResolvedDeal(segment: string): ResolvedDeal {
  const { deals, loading, error, reload } = useDeals();
  const source = useDealListSource();
  // A failed list is checked first: a deal is never reported missing, or
  // resolved to a seed fixture, because its list did not load.
  if (error) return { status: 'error', retry: reload };
  const deal =
    findDealBySegment(deals, segment) ??
    (source.fixtureFallback ? findDealBySegment(getAllDeals(), segment) : null);
  if (deal) return { status: 'ready', deal };
  return loading ? { status: 'resolving' } : { status: 'unknown' };
}

/** The deal's database id (UUID), when it came from the API list. */
export function dealUuidOf(deal: FixtureDeal | null | undefined): string | null {
  return (deal as ListedDeal | null | undefined)?.uuid ?? null;
}

/** Map an API deal row into the `FixtureDeal` shape the surfaces render. */
export function mapApiDeal(d: ApiDeal): ListedDeal {
  const cursorStepId = stepIdForSeq(d.currentStepSeq, MVP_DEAL_RAIL);
  const phase = phaseForStep(cursorStepId, MVP_DEAL_RAIL);
  return {
    // Route by code so links match the wizard's flag-on landing (and G14).
    id: d.code,
    uuid: d.id,
    codename: d.codename,
    code: d.code,
    target: d.targetName ?? d.codename,
    sector: '',
    status: phase?.name ?? d.status,
    cursorStepId,
    currentStep: d.currentStep,
    phaseProgress: d.phaseProgress ?? null,
    entryStepSeq: d.entryStepSeq,
    gate0Complete: true,
    dealRole: d.dealRole ?? 'Member',
    createdAt: d.createdAt,
    targetCloseDate: d.targetCloseDate ?? null,
    feeUsd: d.feeUsd ?? null,
    scheduleStatus: d.scheduleStatus ?? null,
    lifecycleCategory: d.lifecycleCategory ?? 'live',
    conflictsAttestation:
      d.conflictsApprovedBy && d.conflictsApprovedOn
        ? { approvedBy: d.conflictsApprovedBy, approvedOn: d.conflictsApprovedOn }
        : undefined,
  };
}

export type DealsState =
  | { status: 'loading' }
  | { status: 'ready'; deals: readonly ListedDeal[] }
  /**
   * The list could not be read (#162). `timeout`: the shared read outlived
   * RAIL_LOAD_DEADLINE_MS. `failed`: any other failure under
   * platform_onboarding. `deals` is what the flag-off path may still show
   * (fixtures on a timeout), never another user's data.
   */
  | { status: 'error'; reason: 'timeout' | 'failed'; deals: readonly ListedDeal[] };

async function fetchDeals(signal: AbortSignal): Promise<ListedDeal[]> {
  const res = await fetch('/api/v1/deals', {
    credentials: 'include',
    // User-scoped and never cacheable: no-store keeps identical concurrent reads out of Chromium's HTTP cache lock (#162).
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`deals: ${res.status}`);
  const body = (await res.json()) as { deals?: ApiDeal[] };
  return (body.deals ?? []).map(mapApiDeal);
}

/** Hook state stamped with the generation, identity and source it was read under. */
type StampedDeals = { generation: number; identity: number; apiEnabled: boolean; state: DealsState };

const LOADING: DealsState = { status: 'loading' };
const UNREAD: StampedDeals = { generation: -1, identity: -1, apiEnabled: false, state: LOADING };

function useDealsGeneration(): number {
  return React.useSyncExternalStore(
    subscribeGeneration,
    () => readGeneration('deals'),
    () => readGeneration('deals'),
  );
}

function useIdentityGeneration(): number {
  return React.useSyncExternalStore(subscribeGeneration, identityGeneration, identityGeneration);
}

export function useDeals() {
  const { apiEnabled, fixtureFallback } = useDealListSource();
  const generation = useDealsGeneration();
  const identity = useIdentityGeneration();
  const [stamped, setStamped] = React.useState<StampedDeals>(UNREAD);

  // One read per generation. In API mode every instance mounted in the same
  // wave joins the single in-flight GET /api/v1/deals (#162); a result or
  // rejection from an older generation is dropped. DEALS_EVENT and the
  // fixture-store `storage` event bump the generation once, module-wide
  // (inflightRead), so each instance lands here again.
  React.useEffect(() => {
    let active = true;
    void (async () => {
      if (!apiEnabled) {
        if (active) {
          setStamped({ generation, identity, apiEnabled, state: { status: 'ready', deals: getAllDeals() } });
        }
        return;
      }
      try {
        const { generation: readAt, value } = await sharedRead('deals', fetchDeals, {
          deadlineMs: RAIL_LOAD_DEADLINE_MS,
        });
        if (!active || !isCurrentGeneration('deals', readAt)) return;
        setStamped({ generation: readAt, identity, apiEnabled, state: { status: 'ready', deals: value } });
      } catch (error) {
        const readAt = generationOfError(error);
        if (!active || readAt === null || !isCurrentGeneration('deals', readAt)) return;
        setStamped({ generation: readAt, identity, apiEnabled, state: failedState(error, fixtureFallback) });
      }
    })();
    return () => {
      active = false;
    };
  }, [apiEnabled, fixtureFallback, generation, identity]);

  // Every consumer re-joins one fresh read.
  const reload = React.useCallback(() => bumpGeneration('deals'), []);

  // API mode, while a newer generation is read:
  // - a list read under another identity presents as loading with no data,
  //   so it stops rendering the moment the identity changes;
  // - an error presents as loading, so Try again leaves no live button
  //   during its own refetch;
  // - a list read for this same identity stays on screen until the fresh one
  //   lands. A reload after a write (DEALS_EVENT, a Book field save) never
  //   blanks the page, which would unmount every editor under it and drop
  //   the receipt it just showed.
  // Fixture mode keeps the last local list too (the fixtures are local, never
  // another user's data).
  const stale = stamped.generation !== generation;
  const state: DealsState =
    stamped.apiEnabled !== apiEnabled
      ? LOADING
      : apiEnabled && stamped.identity !== identity
        ? LOADING
        : apiEnabled && stale && stamped.state.status !== 'ready'
          ? LOADING
          : stamped.state;

  // While loading: flag-on shows nothing (no fixture FLASH before the real list
  // arrives, G24); flag-off shows the seeds (the fixtures ARE the real data).
  const deals =
    state.status === 'loading' ? (apiEnabled ? EMPTY_DEALS : SEED_DEALS) : state.deals;
  // `loading` lives at the seam so consumers share one guard instead of each
  // hand-rolling a state.status check (the loading-flash class fixed twice
  // downstream before this: BookHome, BookDeal). It means "`deals` is not yet
  // meaningful": flag-off hands the seeds back synchronously, so it is never
  // loading — only the API path has a window where the list is empty.
  // `error` is the list-failed guard every consumer checks before stating a
  // fact from the list (#162): never an empty book, "No deal here yet" or a
  // seed fixture in its place.
  return {
    state,
    deals,
    loading: apiEnabled && state.status === 'loading',
    error: state.status === 'error',
    reload,
  };
}

/**
 * A failed read, by cause:
 * - timeout (any API mode) → error('timeout'), fixtures only where the
 *   flag-off path already allows them;
 * - another failure under platform_onboarding → error('failed', []);
 * - another failure on the flag-off path (G1 P0) → today's fixture fallback.
 */
function failedState(error: unknown, fixtureFallback: boolean): DealsState {
  if (isReadTimeout(error)) {
    return {
      status: 'error',
      reason: 'timeout',
      deals: fixtureFallback ? getAllDeals() : EMPTY_DEALS,
    };
  }
  if (!fixtureFallback) return { status: 'error', reason: 'failed', deals: EMPTY_DEALS };
  return { status: 'ready', deals: getAllDeals() };
}

const EMPTY_DEALS: readonly ListedDeal[] = [];
