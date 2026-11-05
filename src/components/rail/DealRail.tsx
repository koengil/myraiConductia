"use client";

import * as React from "react";
import { AnimatePresence } from "framer-motion";
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation";

import { resolveProjectId } from "@/lib/project/resolveProjectId";
import { progressSaverFor } from "@/lib/rail/progressSave";
import { Plus } from "lucide-react";

import { Button } from "@/components/atoms/Button";
import { StageStatus } from "@/components/shell/StageStatus";
import {
  DealListUnavailableStage,
  NOT_ON_DEAL_COPY,
  NotOnDealStage,
  TRY_AGAIN_COPY,
} from "@/components/deals/DealsUnavailable";
import { DESTINATION_TITLES } from "@/lib/perspective/destinationTitles";
import { useFlag } from "@/lib/flags/FlagsContext";
import { useActiveDeal, useDeals } from "@/lib/deals/useDeals";
import { identityGeneration, subscribeGeneration } from "@/lib/api/inflightRead";
import { storeOwner } from "@/lib/session/storeOwner";
import { STEP_STATUS, type StepStatus } from "@/lib/constants/dealSteps";
import { DEAL_ROLE } from "@/lib/constants/roles";
import {
  activeSteps,
  nextOpenStepIndex,
  railIsStructured,
  stepTitle,
  useProjectRail,
  type ProjectRailStep,
  type SkipStepInput,
  type StepSkipRecord,
} from "@/lib/rail/projectRail";
import { gate0IntakeCompleteStepIds } from "@/lib/rail/stepRecords";
import { withRecordedCloses } from "@/lib/rail/dealStepRecord";
import { useStepActivity, withCurrentAssignment } from "@/lib/rail/stepActivity";
import { useRailFreshness } from "@/lib/rail/useRailFreshness";
import {
  getLocalPref,
  railViewValue,
  railViewsFrom,
  setLocalPref,
  type RailLayout,
  type RailView,
  type RailViewFilter as ViewFilter,
} from "@/lib/prefs/localPrefs";
import { useCurrentUser } from "@/lib/auth/useCurrentUser";
import { Dialog, PreviewBanner, PreviewChip, useRetainedWhileClosing } from "@/components/overlay";
import { SegmentedControl } from "@/components/atoms/SegmentedControl";
import {
  applyPreviewOrder,
  isMovableStep,
  railPlanKey,
  soonestStepDate,
  useRailPlanPreview,
  useReorderPreview,
  allowedMoveIndices,
} from "@/lib/rail/railPreview";
import {
  railLoadCopy,
  retryDealReads,
  useRailLoadStage,
  type RailLoadPending,
} from "@/lib/rail/railLoadStage";
import type { TemplateSummary } from "@/lib/railTemplates/types";
import { useTemplateChanges } from "@/lib/railTemplates/useTemplateChanges";
import { getRunState, RAIL_RUN_EVENT, type RailRunState } from "./railRunState";
import { DataroomPendingBanner } from "./DataroomPendingBanner";
import { EntryLine } from "./EntryLine";
import { EvidenceSuggestionMarker } from "./EvidenceSuggestionMarker";
import { Gate0ReceiptBanner } from "./Gate0ReceiptBanner";
import { RailBoard, type RenderStepCard } from "./RailBoard";
import {
  ownersFromStepRecords,
  phaseSummaries,
  railHeaderProgress,
  type PhaseSummary,
} from "./railBoardModel";
import { RailHeader } from "./RailHeader";
import { SortableStack } from "./SortableStack";
import { MoveStepDialog, type MoveTarget } from "./MoveStepDialog";
import { defaultPlacement } from "./SkillBuilderPlacementFields";
import { DontAskAgainConfirmation, RailEditPrompt, type RailEdit } from "./RailEditPrompt";
import {
  DependencyCardDetail,
  DependencyLines,
  RailDependencyView,
  StepDatesDialog,
  formatStepDay,
} from "./RailDependencyView";
import { RailTimeline } from "./RailTimeline";
import { PROPOSAL_COPY, ProposalTray, ProposeChangeDialog } from "./RailProposals";
import {
  ACTIVITY_FAILED_COPY,
  RAIL_VIEW_OPTIONS,
  RailViewFilter,
  stepInView,
  stepMatchesSearch,
} from "./RailViewFilter";
import { PhaseViewLinks, RailBoardTools } from "./RailBoardTools";
import { StepOwnerFooter } from "./StepOwnerFooter";
import { RemovedStepsSection } from "./RemovedStepsSection";
import {
  SkillBuilderLauncherDialog,
  useSkillBuilderLauncher,
} from "./SkillBuilderLauncher";
import {
  useRestoreExistingStep,
  usePublishedStepFocus,
} from "./usePublishedStepFocus";
import { SaveRailDialog } from "./SaveRailDialog";
import { SkipModal } from "./SkipModal";
import { TemplateChangeBanner } from "./TemplateChangeBanner";
import { TemplateChangesDialog } from "./TemplateChangesDialog";
import { StepZoom, type WalkDirection } from "./StepZoom";
import {
  currentZoomEntry,
  adoptLinkZoomEntry,
  dropZoomEntry,
  leaveZoomEntry,
  pushZoomEntry,
  replaceZoomEntry,
  zoomEntryStepParam,
  zoomEntryStep,
} from "./zoomHistory";
import { restingStepIndex, stepStateForStep } from "./stepState";

/**
 * DealRail: the rail IS the deal, the sell-side execution timeline scoped to
 * one deal, rendered through the `useProjectRail` seam.
 *
 * Two levels of the same rail, never two separate views:
 *   • The board (default): every phase left to right as a column of its steps.
 *   • One step, in a dialog over the board: its full contract, with the steps
 *     before and after to walk to. Closing it returns to the board.
 * `?step=<seq>` (Conductor Center task rows, chat quick actions) lands with that
 * step open. Opening one from the rail pushes one history entry (zoomHistory.ts),
 * so browser Back closes it and Forward opens it again.
 *
 * Step state is read from each step's own status, overlaid with logged skips.
 * Runs go through the one StepRunner surface; verdicts route to the shell's
 * single ComplianceRibbon via SET_COMPLIANCE and every run collapses to a
 * receipt on its step card.
 */

const EMPTY_RUN: RailRunState = { receipts: {}, versions: {} };

/** The step-records read failed: owners are unknown. */
export const OWNERS_FAILED_COPY = "Owners did not load.";

const RAIL_LAYOUT_ID = "rail-layout";
const RAIL_LAYOUT_OPTIONS: readonly { id: RailLayout; label: string }[] = [
  { id: "sequential", label: "Sequential" },
  { id: "dependency", label: "Dependency" },
  { id: "timeline", label: "Timeline" },
];

/**
 * The closed gate names what it waits for (#162): the deal list, then the
 * rail. Past RAIL_LOAD_SLOW_MS the same live region says it is still waiting.
 * One polite region whose text changes in place; mounting starts the slow
 * clock, so each wait flips at most once.
 */
function DealRailLoading({ pending }: { pending: RailLoadPending }) {
  const stage = useRailLoadStage(pending);
  return (
    <div className="mx-auto w-full max-w-[var(--page-max)] px-[var(--space-4)] py-[var(--space-5)]">
      <StageStatus kind="loading" eyebrow="Deal rail">
        <p
          role="status"
          aria-live="polite"
          className="font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
        >
          {railLoadCopy(stage)}
        </p>
      </StageStatus>
    </div>
  );
}

export function DealRail() {
  const params = useParams();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const projectId = resolveProjectId(
    params.projectId as string | string[] | undefined,
  );
  const apiCreateEnabled = useFlag("gate0_api_create");
  const railTemplatesEnabled = useFlag("rail_templates");
  const railModelEnabled = useFlag("project_rail_model");
  const { state: dealsState, deals } = useDeals();
  const deal = useActiveDeal(projectId);
  const {
    rail,
    status: railStatus,
    forbidden: railForbidden,
    notOnDeal: railNotOnDeal,
    refresh,
    skipStep,
    stepRecords,
    refreshStepRecords,
    stepRecordsFailed,
  } = useProjectRail(projectId, { withStepRecords: true });
  const [railStale, setRailStale] = React.useState(false);
  const markRailStale = React.useCallback(() => setRailStale(true), []);
  const templateChanges = useTemplateChanges(projectId, { onApplied: markRailStale });
  const [templateReviewOpen, setTemplateReviewOpen] = React.useState(
    () => searchParams.get("review") === "template",
  );
  const closeTemplateReview = React.useCallback(() => setTemplateReviewOpen(false), []);
  const templateReviewShowing = templateReviewOpen && templateChanges.changeSet !== null;
  const [railRefreshRequests, setRailRefreshRequests] = React.useState(0);
  if (railStale && !templateReviewShowing) {
    setRailStale(false);
    setTemplateReviewOpen(false);
    setRailRefreshRequests((count) => count + 1);
  }
  React.useEffect(() => {
    if (railRefreshRequests > 0) refresh();
  }, [railRefreshRequests, refresh]);
  const canAddStep =
    useFlag("skill_authoring") && Boolean(rail?.canEditStructure);
  const discoveryEnabled = useFlag("deal_discovery");
  const builder = useSkillBuilderLauncher();

  // Local completion and skip overrides belong to one deal AND one identity
  // (#162): a sign-out or account switch moves the identity generation, so
  // nothing one banker marked locally renders on the next banker's rail.
  const identity = React.useSyncExternalStore(
    subscribeGeneration,
    identityGeneration,
    identityGeneration,
  );
  const overrideScope = `${identity}:${projectId}`;
  // The persisted run state is stamped per user; re-read it once the owner
  // is known (the first auth event) and whenever it changes.
  const runOwner = React.useSyncExternalStore(subscribeGeneration, storeOwner, () => null);

  const [statusOverride, setStatusOverride] = React.useState<{
    scope: string;
    overrides: Record<string, StepStatus>;
    currentStepId?: string | null;
  } | null>(null);

  const [localSkipRecords, setLocalSkipRecords] = React.useState<{
    scope: string;
    records: Record<string, StepSkipRecord>;
  } | null>(null);

  const applyOverrides = React.useCallback(
    (overrides: Record<string, StepStatus>) => {
      setStatusOverride((prev) => ({
        scope: overrideScope,
        overrides:
          prev?.scope === overrideScope
            ? { ...prev.overrides, ...overrides }
            : overrides,
      }));
    },
    [overrideScope],
  );

  const applySkipRecord = React.useCallback(
    (id: string, skip: StepSkipRecord) => {
      setLocalSkipRecords((prev) => ({
        scope: overrideScope,
        records:
          prev?.scope === overrideScope
            ? { ...prev.records, [id]: skip }
            : { [id]: skip },
      }));
    },
    [overrideScope],
  );

  // A teammate's completion shows as soon as fresher step records arrive,
  // without re-reading (and blanking) the whole rail.
  const recorded = React.useMemo(
    () => withRecordedCloses(rail ? activeSteps(rail) : [], rail?.currentStepId ?? null, stepRecords),
    [rail, stepRecords],
  );

  const steps = React.useMemo(
    () =>
      recorded.steps.map((step) => {
        let next = step;
        if (statusOverride?.scope === overrideScope) {
          const status = statusOverride.overrides[step.id];
          if (status) next = { ...next, status };
        }
        if (localSkipRecords?.scope === overrideScope) {
          const skip = localSkipRecords.records[step.id];
          if (skip) next = { ...next, skip };
        }
        return next;
      }),
    [recorded, statusOverride, localSkipRecords, overrideScope],
  );

  const apiDeal = deals.find((d) => d.id === projectId);
  const isRealDeal = apiCreateEnabled && Boolean(apiDeal);
  const canSaveRail =
    isRealDeal &&
    railTemplatesEnabled &&
    railModelEnabled &&
    rail !== null &&
    rail.canSaveTemplate &&
    railIsStructured(rail);
  const [skipTarget, setSkipTarget] = React.useState<ProjectRailStep | null>(
    null,
  );
  const [saveRailOpen, setSaveRailOpen] = React.useState(false);
  const [savedRail, setSavedRail] = React.useState<TemplateSummary | null>(null);
  React.useEffect(() => {
    if (savedRail === null) return;
    const timer = window.setTimeout(() => setSavedRail(null), 8000);
    return () => window.clearTimeout(timer);
  }, [savedRail]);
  const [run, setRun] = React.useState<RailRunState>(EMPTY_RUN);

  /**
   * The zoom: null is the board; otherwise the step zoomed in on, by its index
   * on the rail (null follows the deal cursor). It can show any step without
   * moving the cursor.
   */
  const [zoom, setZoom] = React.useState<{
    index: number | null;
    direction: WalkDirection;
    /** The MD zoomed in themselves, so keyboard focus moves with them. */
    takeFocus: boolean;
  } | null>(null);
  const zoomStageRef = React.useRef<HTMLDivElement | null>(null);
  /** A zoom-out stepped back off the zoom's history entry; its popstate is ours. */
  const leavingZoomRef = React.useRef(false);

  const intakeDoneIds = React.useMemo(
    () => gate0IntakeCompleteStepIds(deal),
    [deal],
  );

  /**
   * Open a step over the board. `takeFocus` moves keyboard focus into it: every
   * path the MD starts passes it (a card, the header button, the builder dialog).
   */
  const openStep = React.useCallback(
    (id: string, options: { takeFocus?: boolean } = {}) => {
      const index = steps.findIndex((s) => s.id === id);
      if (index < 0) return;
      setZoom({ index, direction: 0, takeFocus: options.takeFocus ?? false });
      // While a zoom-out's history step is still in flight, its popstate
      // pushes this zoom's entry instead.
      if (!leavingZoomRef.current) pushZoomEntry(projectId, id, steps[index].seq);
    },
    [steps, projectId],
  );
  const openStepFromBoard = React.useCallback(
    (id: string) => openStep(id, { takeFocus: true }),
    [openStep],
  );
  const openPublishedStep = React.useCallback(
    (id: string) => openStep(id, { takeFocus: true }),
    [openStep],
  );

  // Persist rail position for a real deal so an advance survives reload. The
  // canonical seq of the step becoming current is written to deals.current_step_seq
  // through the deal's one saver (progressSaverFor): one write at a time, kept
  // across navigation. A refused or failed write (any non-2xx, or no response)
  // says so under the header, with Try again, which resends the deal's newest
  // position; a later successful write clears it. A 404 (not on this deal)
  // says so in the shared not-on-deal words, with no Try again. Notices are
  // kept per deal.
  const [progressUnsaved, setProgressUnsaved] = React.useState<
    Record<string, { message: string | null; notOnDeal?: true }>
  >({});
  const progressSaver = progressSaverFor(projectId);
  React.useEffect(
    () =>
      progressSaver.subscribe((result) =>
        setProgressUnsaved((prev) => {
          const next = { ...prev };
          if (result.ok) delete next[projectId];
          else next[projectId] = { message: result.message, notOnDeal: result.notOnDeal };
          return next;
        }),
      ),
    [progressSaver, projectId],
  );
  const saveProgressSeq = React.useCallback(
    (seq: number) => progressSaver.save(seq),
    [progressSaver],
  );
  const unsavedHere = progressUnsaved[projectId];
  const persistProgress = React.useCallback(
    (nextStep: ProjectRailStep | undefined) => {
      if (!isRealDeal || !nextStep || nextStep.seq === null) return;
      saveProgressSeq(nextStep.seq);
    },
    [isRealDeal, saveProgressSeq],
  );

  // Honor ?step=<seq>: deep links from the Conductor Center task rows and the
  // chat quick actions name a specific step. The rail renders zoomed in on
  // THAT step from its first ready render (no board first, no zoom flourish),
  // and adopts the link's entry as its zoom, so the address bar keeps ?step=
  // (zoomHistory.ts). A ?step= naming no step is dropped. -1 when ?step= is
  // absent or names no step on this rail.
  const stepDeepLink = searchParams.get("step");
  const deepLinkIndex = React.useMemo(() => {
    if (!stepDeepLink) return -1;
    const seq = Number(stepDeepLink);
    return steps.findIndex((s) => s.seq === seq);
  }, [stepDeepLink, steps]);
  // Consumed during render, so the first ready render is already zoomed in.
  const [consumedDeepLink, setConsumedDeepLink] = React.useState<string | null>(null);
  // A ?step= that names no step on this rail (unknown, malformed or removed):
  // say so once the rail has loaded, and drop the parameter all the same.
  const [missingDeepLink, setMissingDeepLink] = React.useState<string | null>(null);
  const deepLinkReady = dealsState.status !== "loading" && railStatus === "ready" && rail !== null;
  // The rail's own zoom entry carries ?step= too; it is not a deep link. Nor
  // is the ?step= of a zoom entry just left (Back, Esc, a reload), which the
  // router still reports until it catches up with the URL.
  const [leftZoomParam, setLeftZoomParam] = React.useState<string | null>(null);
  const ownZoomEntry = currentZoomEntry(projectId) !== null;
  if (leftZoomParam !== null && stepDeepLink !== leftZoomParam) setLeftZoomParam(null);
  // A zoom entry with the board showing is a reload or a return to this page:
  // the rail opens on its board, and the effect below makes the entry plain.
  if (stepDeepLink !== null && ownZoomEntry && zoom === null && leftZoomParam !== stepDeepLink) {
    setLeftZoomParam(stepDeepLink);
  }
  const zoomParam = ownZoomEntry || (stepDeepLink !== null && stepDeepLink === leftZoomParam);
  if (stepDeepLink && !zoomParam && consumedDeepLink !== stepDeepLink) {
    if (deepLinkIndex >= 0) {
      setConsumedDeepLink(stepDeepLink);
      setMissingDeepLink(null);
      setZoom({ index: deepLinkIndex, direction: 0, takeFocus: false });
    } else if (deepLinkReady) {
      setConsumedDeepLink(stepDeepLink);
      setMissingDeepLink(stepDeepLink);
    }
  }
  // Once the parameter is gone, forget it, so a later ?step= (even the same
  // one) zooms in again.
  if (consumedDeepLink && !stepDeepLink) setConsumedDeepLink(null);
  React.useEffect(() => {
    if (!consumedDeepLink || searchParams.get("step") !== consumedDeepLink) return;
    // A link the rail landed zoomed on keeps its ?step= (adopted below).
    if (missingDeepLink !== consumedDeepLink) return;
    const rest = new URLSearchParams(searchParams.toString());
    rest.delete("step");
    const query = rest.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [consumedDeepLink, missingDeepLink, searchParams, router, pathname]);
  const zoomed = zoom !== null;

  // The board opens scrolled to the cursor once per deal.
  const [openedAtCursorFor, setOpenedAtCursorFor] = React.useState<
    string | null
  >(null);
  const markOpenedAtCursor = React.useCallback(
    () => setOpenedAtCursorFor(projectId),
    [projectId],
  );

  // Live run state (receipts / skips / versions) for this deal, as its owner.
  React.useEffect(() => {
    const sync = () => setRun(getRunState(projectId));
    sync();
    window.addEventListener(RAIL_RUN_EVENT, sync);
    return () => window.removeEventListener(RAIL_RUN_EVENT, sync);
  }, [projectId, runOwner]);

  const overriddenCurrentId =
    statusOverride?.scope === overrideScope
      ? Object.entries(statusOverride.overrides).find(
          ([, status]) => status === STEP_STATUS.CURRENT,
        )?.[0]
      : undefined;
  const currentStepId = statusOverride?.scope === overrideScope && statusOverride.currentStepId !== undefined
    ? statusOverride.currentStepId
    : overriddenCurrentId ?? recorded.currentStepId;
  const activeStep = currentStepId
    ? steps.find((s) => s.id === currentStepId)
    : undefined;
  const cursor = activeStep
    ? steps.findIndex((s) => s.id === activeStep.id)
    : -1;
  const displayIndex =
    zoom?.index ?? (cursor >= 0 ? cursor : restingStepIndex(steps, intakeDoneIds));
  // The dialog keeps showing its step while its exit plays.
  const shownIndex = useRetainedWhileClosing(zoomed ? displayIndex : null) ?? displayIndex;

  // Who is on what: owners from the step records, the last thing done on each
  // step from the audit trail. One read each for the whole rail, refreshed on
  // focus and every 30 seconds while the tab is visible.
  const activity = useStepActivity(projectId, isRealDeal);
  const refreshActivity = activity.refresh;
  const [now, setNow] = React.useState(() => Date.now());
  const refreshPeople = React.useCallback(() => {
    setNow(Date.now());
    refreshStepRecords();
    refreshActivity();
  }, [refreshStepRecords, refreshActivity]);
  useRailFreshness(refreshPeople, isRealDeal);
  // Owners are unknown after a failed step-records read: cards name nobody
  // (never "Unassigned") and one banner says so.
  const peopleFailed = isRealDeal && Boolean(stepRecordsFailed);
  // An "Assigned by" row the records no longer bear out (owner removed, or
  // the assignee left) is dropped: the card never reads "Unassigned" over it.
  const activityByStep = React.useMemo(
    () => withCurrentAssignment(activity.byStep, stepRecords),
    [activity.byStep, stepRecords],
  );
  const owners = React.useMemo(
    () => ownersFromStepRecords(stepRecords, activityByStep),
    [stepRecords, activityByStep],
  );
  const ownerIds = React.useMemo(
    () => new Map(stepRecords.map((r) => [r.stepId, r.assignedTo])),
    [stepRecords],
  );
  const { state: userState } = useCurrentUser();
  const meId = userState.status === "ready" ? userState.data.user.id : null;
  const summaries = React.useMemo(
    () =>
      rail
        ? phaseSummaries(rail.phases, steps, {
            intakeDoneIds,
            currentStepId,
            owners,
            ownersUnknown: peopleFailed,
          })
        : [],
    [rail, steps, intakeDoneIds, currentStepId, owners, peopleFailed],
  );
  const progress = React.useMemo(
    () => railHeaderProgress(summaries, steps, intakeDoneIds),
    [summaries, steps, intakeDoneIds],
  );
  const stateFor = React.useCallback(
    (step: ProjectRailStep) =>
      stepStateForStep(step, { done: intakeDoneIds.has(step.stepId) }),
    [intakeDoneIds],
  );

  // Personal views of the board, kept in this browser only.
  const [viewFilter, setViewFilter] = React.useState(() => getLocalPref("railViewFilter"));
  const changeViews = React.useCallback((next: readonly RailView[]) => {
    const value = railViewValue(next);
    setViewFilter(value);
    setLocalPref("railViewFilter", value);
  }, []);
  const appliedViews = React.useMemo(() => (isRealDeal ? railViewsFrom(viewFilter) : []), [isRealDeal, viewFilter]);
  // One view alone says why it cannot show; several show what they can.
  const onlyView: RailView | null = appliedViews.length === 1 ? appliedViews[0] : null;
  const readableViews = React.useMemo(
    () =>
      appliedViews.filter((view) => {
        if (view === "mine") return meId !== null && !peopleFailed;
        if (view === "unassigned") return !peopleFailed;
        if (view === "has_activity") return !activity.failed;
        return true;
      }),
    [appliedViews, meId, peopleFailed, activity.failed],
  );
  // Search stays with its deal.
  const [search, setSearch] = React.useState<{ scope: string; query: string } | null>(null);
  const query = search?.scope === projectId ? search.query.trim() : "";
  // A view or a search leaves a partial list: nothing is moved or added in it.
  const narrowed = appliedViews.length > 0 || query !== "";

  // Rail numbers are the saved order: a Preview move never renumbers a step.
  const numberById = React.useMemo(
    () => new Map(steps.map((s, i) => [s.id, String(i + 1).padStart(2, "0")])),
    [steps],
  );
  const numberOf = React.useCallback(
    (step: ProjectRailStep) => numberById.get(step.id) ?? "",
    [numberById],
  );

  // Reorder Preview (handoff E1): the new order lives in memory for this deal
  // and identity; a reload shows the saved order. Only people with rail
  // editing rights move steps, by "Move to…" or by pointer drag.
  const canEdit = Boolean(rail?.canEditStructure);
  // Edit rail: moving steps is off until the MD turns it on, per deal.
  const [editingFor, setEditingFor] = React.useState<string | null>(null);
  const editing = canEdit && editingFor === projectId;
  // How the rail is drawn: each person's choice, kept in this browser.
  const [layout, setLayout] = React.useState<RailLayout>(() => getLocalPref("railLayout"));
  const changeLayout = React.useCallback((next: RailLayout) => {
    setLayout(next);
    setLocalPref("railLayout", next);
  }, []);
  const activeLayout: RailLayout = isRealDeal ? layout : "sequential";
  const canDrag = editing && !narrowed && activeLayout === "sequential";
  const reorder = useReorderPreview(overrideScope);
  const phaseOrder = React.useCallback(
    (summary: { phase: { index: number }; steps: ProjectRailStep[] }) =>
      applyPreviewOrder(summary.steps, reorder.order[summary.phase.index]),
    [reorder.order],
  );
  const inView = React.useCallback(
    (filter: ViewFilter, step: ProjectRailStep) =>
      stepInView(filter, step, stateFor(step), {
        ownerId: ownerIds.get(step.stepId) ?? null,
        meId,
        hasActivity: activityByStep.has(step.stepId),
      }),
    [stateFor, ownerIds, meId, activityByStep],
  );
  const matchesTools = React.useCallback(
    (step: ProjectRailStep) => stepMatchesSearch(query, stepTitle(step), steps.indexOf(step) + 1),
    [query, steps],
  );
  const inAppliedViews = React.useCallback(
    (step: ProjectRailStep) =>
      appliedViews.length === 0 || readableViews.some((view) => inView(view, step)),
    [appliedViews, readableViews, inView],
  );
  const stepsFor = React.useMemo(
    () =>
      !narrowed && !reorder.active
        ? undefined
        : (summary: { phase: { index: number }; steps: ProjectRailStep[] }) =>
            phaseOrder(summary).filter((step) => inAppliedViews(step) && matchesTools(step)),
    [narrowed, reorder.active, phaseOrder, inAppliedViews, matchesTools],
  );
  const shownCount = steps.filter((step) => inAppliedViews(step) && matchesTools(step)).length;
  // What each view would show right now. A view that rests on a failed or
  // unfinished read gets no number rather than a wrong one.
  const viewCounts = React.useMemo(() => {
    const counts: Partial<Record<ViewFilter, number>> = {};
    for (const { id } of RAIL_VIEW_OPTIONS) {
      if (id === "mine" && (meId === null || peopleFailed)) continue;
      if (id === "unassigned" && peopleFailed) continue;
      if (id === "has_activity" && activity.failed) continue;
      counts[id] = steps.filter((step) => inView(id, step) && matchesTools(step)).length;
    }
    return counts;
  }, [steps, inView, matchesTools, meId, peopleFailed, activity.failed]);

  // The prompt after a rail edit, for people with rail editing rights only
  // (handoff E3 for per-deal rights). Adds and removes are saved already;
  // moves are a Preview, and the prompt says so.
  const [edit, setEdit] = React.useState<{ edit: RailEdit; addedId?: string } | null>(null);
  const [dontAskShownAt, setDontAskShownAt] = React.useState<number | null>(null);
  const promptEdit = React.useCallback(
    (next: RailEdit, addedId?: string) => {
      if (!canEdit || getLocalPref("railEditPrompt") === "never") return;
      setEdit({ edit: next, addedId });
    },
    [canEdit],
  );
  // An added step lands on the board (phase overview), not zoomed in: its
  // card is highlighted, can be dragged into place, and takes focus. The
  // prompt waits for that, so it opens over the card and closing hands focus
  // back to it.
  const [landing, setLanding] = React.useState<string | null>(null);
  const [landed, setLanded] = React.useState<string | null>(null);
  const shownEdit: RailEdit | null = React.useMemo(() => {
    if (!edit) return null;
    if (edit.edit.kind !== "added" || !edit.addedId) return edit.edit;
    if (landed !== edit.addedId) return null;
    const added = steps.find((s) => s.id === edit.addedId);
    return { kind: "added", title: added ? stepTitle(added) : null };
  }, [edit, steps, landed]);
  React.useEffect(() => {
    if (!landing) return;
    let frames = 0;
    let raf = 0;
    const find = () => {
      const card = zoomStageRef.current?.querySelector<HTMLElement>(
        `[data-testid="step-${landing}"] button[aria-label^="Step "]`,
      );
      if (card) {
        card.scrollIntoView?.({ block: "center" });
        card.focus({ preventScroll: true });
        setLanding(null);
        setLanded(landing);
        return;
      }
      // The board renders the new card after the rail re-reads; give up
      // quietly after about a second (the highlight still marks it).
      if (frames++ > 60) {
        setLanding(null);
        setLanded(landing);
        return;
      }
      raf = window.requestAnimationFrame(find);
    };
    raf = window.requestAnimationFrame(find);
    return () => window.cancelAnimationFrame(raf);
  }, [landing]);
  const closeEditPrompt = React.useCallback(() => setEdit(null), []);
  const [dontAskFocus, setDontAskFocus] = React.useState(false);
  const [dontAskNotKept, setDontAskNotKept] = React.useState(false);
  const dontAskAgain = React.useCallback(({ viaKeyboard }: { viaKeyboard: boolean }) => {
    // Storage can refuse (private window, blocked site data): then the prompt
    // keeps asking, and the confirmation says so rather than pointing at Settings.
    const kept = setLocalPref("railEditPrompt", "never");
    setEdit(null);
    setDontAskNotKept(!kept);
    setDontAskFocus(viaKeyboard && kept);
    setDontAskShownAt(Date.now());
  }, []);
  const hideDontAsk = React.useCallback(() => setDontAskShownAt(null), []);

  // Where a step may go in the Preview: never ahead of a step that cannot
  // move (E1), so the Preview never shows an order a saved move would refuse.
  const allowedFor = React.useCallback(
    (phaseSteps: readonly ProjectRailStep[], step: ProjectRailStep) =>
      allowedMoveIndices(phaseSteps, step, (s) => !isMovableStep(s, stateFor(s))),
    [stateFor],
  );
  const moveStep = React.useCallback(
    (phaseIndex: number, phaseSteps: readonly ProjectRailStep[], step: ProjectRailStep, toIndex: number) => {
      if (!allowedFor(phaseSteps, step).has(toIndex)) return;
      const savedIds = steps.filter((s) => s.phaseIndex === phaseIndex).map((s) => s.id);
      const moved = reorder.move(phaseIndex, phaseSteps.map((s) => s.id), step.id, toIndex, savedIds);
      if (moved) promptEdit({ kind: "moved", title: stepTitle(step) });
    },
    [reorder, promptEdit, allowedFor, steps],
  );
  // Move to… sits in step detail: the keyboard path for what a drag does on the
  // board, offered only where there is somewhere to go.
  const [moveTarget, setMoveTarget] = React.useState<MoveTarget | null>(null);
  const moveAction = React.useCallback(
    (step: ProjectRailStep) => {
      const summary = summaries.find((s) => s.phase.index === step.phaseIndex);
      if (!editing || !summary || !isMovableStep(step, stateFor(step))) return null;
      const phaseSteps = phaseOrder(summary);
      const allowed = allowedFor(phaseSteps, step);
      if (allowed.size <= 1) return null;
      return () =>
        setMoveTarget({ step, phaseName: summary.phase.name, phaseSteps, numberOf, allowed });
    },
    [editing, summaries, stateFor, phaseOrder, allowedFor, numberOf],
  );
  // A removed step leaves the reorder Preview too.
  const dropFromPreview = React.useCallback(
    (step: ProjectRailStep) =>
      reorder.drop(
        step.phaseIndex,
        step.id,
        steps.filter((s) => s.phaseIndex === step.phaseIndex).map((s) => s.id),
      ),
    [reorder, steps],
  );
  // Add step opens where the MD is: after the step whose plus they used. "Change"
  // in the dialog moves it.
  const addStepAfter = React.useCallback(
    (step: ProjectRailStep) => {
      if (!rail) return;
      const placement = defaultPlacement(rail, step.id);
      builder.launch(rail, undefined, placement ? { placement, explicit: true } : null);
    },
    [rail, builder],
  );
  // The step just added stays highlighted on the board (this page view only)
  // so the MD can find it, and move it with Edit rail through the reorder Preview.
  const [justAddedId, setJustAddedId] = React.useState<string | null>(null);
  const stepFooter = React.useCallback(
    (step: ProjectRailStep) => {
      const moved = reorder.moved.has(step.id) ? (
        // Preview: handoff E1 "Save a step reorder (deal rail and rail templates)".
        <p className="flex items-center gap-[var(--space-2)] text-[length:var(--text-xxs)] text-[var(--ink-tertiary)]">
          <PreviewChip />
          <span>Moved in this browser</span>
        </p>
      ) : null;
      const state = stateFor(step);
      // The step just added says so.
      const added =
        step.id === justAddedId ? (
          <p
            data-just-added
            className="flex flex-wrap items-center gap-[var(--space-2)] text-[length:var(--text-xxs)] text-[var(--ink-secondary)]"
          >
            <span className="rounded-[var(--radius-pill)] bg-[var(--accent)] px-[var(--space-2)] py-px font-medium text-[var(--ink-on-dark)]">
              New
            </span>
          </p>
        ) : null;
      if (!isRealDeal) return (
        <>
          {added}
          {moved}
        </>
      );
      if (state === "prior") return moved;
      const owner = owners.get(step.stepId);
      const open = state === "active" || state === "todo";
      // A closed card's "Done by" credit already says who closed it.
      const latest = open && owner?.activity?.kind !== "completed" ? owner?.activity : undefined;
      const shownOwner = peopleFailed
        ? latest
          ? { stepId: step.stepId, activity: latest }
          : undefined
        : owner
          ? { ...owner, activity: latest }
          : undefined;
      return (
        <>
          <StepOwnerFooter
            owner={shownOwner}
            showUnassigned={open && !peopleFailed}
            now={now}
          />
          {added}
          {moved}
        </>
      );
    },
    [isRealDeal, stateFor, owners, now, reorder.moved, justAddedId, peopleFailed],
  );
  // Drawn links, step dates and proposals (handoff E3, E4): kept in this
  // browser for this person and deal; Reset clears them.
  const planPreview = useRailPlanPreview(railPlanKey(meId, projectId));
  const [datesFor, setDatesFor] = React.useState<ProjectRailStep | null>(null);
  const stepById = React.useMemo(() => new Map(steps.map((s) => [s.id, s])), [steps]);
  const drawnLinks = React.useMemo(
    () => planPreview.plan.links.filter((l) => stepById.has(l.fromId) && stepById.has(l.toId)),
    [planPreview.plan.links, stepById],
  );
  // A skipped step will never be done, so a link drawn from it is satisfied too.
  const linkClosed = React.useCallback(
    (id: string) => {
      const step = stepById.get(id);
      const state = step ? stateFor(step) : null;
      return state === "done" || state === "skipped";
    },
    [stepById, stateFor],
  );
  const boardStepFooter = React.useCallback(
    (step: ProjectRailStep) => {
      if (activeLayout !== "dependency" || stateFor(step) === "prior") return stepFooter(step);
      return (
        <>
          {stepFooter(step)}
          <DependencyCardDetail
            step={step}
            links={drawnLinks.filter((link) => link.toId === step.id)}
            byId={stepById}
            isDone={linkClosed}
            stateFor={stateFor}
            label={(s) => `${numberOf(s)} · ${stepTitle(s)}`}
            dates={planPreview.plan.dates[step.id]}
            onEditDates={() => setDatesFor(step)}
          />
        </>
      );
    },
    [activeLayout, stateFor, stepFooter, drawnLinks, stepById, linkClosed, numberOf, planPreview.plan.dates],
  );
  // Each open column ends with its own Add new step, placed after its last step.
  const columnFooter = React.useCallback(
    (summary: PhaseSummary) => {
      if (!canAddStep) return null;
      const last = summary.steps[summary.steps.length - 1];
      if (!last) return null;
      return (
        <button
          type="button"
          onClick={() => addStepAfter(last)}
          className="inline-flex items-center gap-[var(--space-1)] rounded-[var(--radius-input)] text-[length:var(--text-sm)] text-[var(--ink-tertiary)] outline-offset-2 transition-colors hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        >
          <Plus aria-hidden size={16} strokeWidth={1.5} />
          Add new step
        </button>
      );
    },
    [canAddStep, addStepAfter],
  );
  const renderStack = React.useCallback(
    (summary: PhaseSummary, renderCard: RenderStepCard, shown: readonly ProjectRailStep[]) => {
      // Mine needs to know who you are: until then (or if that read failed)
      // the stack says so rather than "No steps in this view".
      if (onlyView === "mine" && meId === null) {
        return (
          <li
            role={userState.status === "error" ? undefined : "status"}
            className="px-[var(--space-2)] py-[var(--space-3)] text-[length:var(--text-xs)] text-[var(--ink-tertiary)]"
          >
            {userState.status === "error"
              ? "Your steps could not be read. Choose All to see every step."
              : "Reading who you are."}
          </li>
        );
      }
      // Who owns what is unknown after a failed read: Mine and Unassigned say
      // so rather than guessing.
      if ((onlyView === "mine" || onlyView === "unassigned") && peopleFailed) {
        return (
          <li className="px-[var(--space-2)] py-[var(--space-3)] text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
            {OWNERS_FAILED_COPY}
          </li>
        );
      }
      // A failed activity read is never shown as "no activity".
      if (onlyView === "has_activity" && activity.failed) {
        return (
          <li className="px-[var(--space-2)] py-[var(--space-3)] text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
            {ACTIVITY_FAILED_COPY}
          </li>
        );
      }
      // Several views, none of them readable: never read as "no steps".
      if (appliedViews.length > 1 && readableViews.length === 0) {
        return (
          <li className="px-[var(--space-2)] py-[var(--space-3)] text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
            {peopleFailed ? OWNERS_FAILED_COPY : ACTIVITY_FAILED_COPY}
          </li>
        );
      }
      if (narrowed) {
        return shown.length > 0 ? (
          shown.map((step) => renderCard(step))
        ) : (
          <li className="px-[var(--space-2)] py-[var(--space-3)] text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
            No steps in this view.
          </li>
        );
      }
      return (
        <SortableStack
          steps={shown}
          renderCard={renderCard}
          canDrag={(step) => isMovableStep(step, stateFor(step))}
          canMoveTo={(step, toIndex) => allowedFor(shown, step).has(toIndex)}
          onMove={(step, toIndex) => moveStep(summary.phase.index, shown, step, toIndex)}
        />
      );
    },
    [onlyView, appliedViews, readableViews, narrowed, stateFor, moveStep, meId, userState.status, allowedFor, activity.failed, peopleFailed],
  );
  const customStack = narrowed || canDrag;

  const [proposeOpen, setProposeOpen] = React.useState(false);
  const [viewAsLead, setViewAsLead] = React.useState(false);
  const canPropose = isRealDeal && rail !== null && !rail.canEditStructure;
  const stepIdSet = React.useMemo(() => new Set(steps.map((s) => s.id)), [steps]);
  const soonest = soonestStepDate(planPreview.plan.dates, stepIdSet);
  const soonestStep = soonest ? steps.find((s) => s.id === soonest.stepId) : undefined;

  // Which phases are open on the board: all of them until the MD opens or
  // closes one, per deal.
  const [openPhases, setOpenPhases] = React.useState<{
    scope: string;
    phases: number[];
  } | null>(null);
  const expandedPhases = React.useMemo(
    () =>
      new Set(
        openPhases?.scope === projectId
          ? openPhases.phases
          : summaries.map((summary) => summary.phase.index),
      ),
    [openPhases, projectId, summaries],
  );
  const togglePhase = React.useCallback(
    (phaseIndex: number) => {
      const next = new Set(expandedPhases);
      if (next.has(phaseIndex)) next.delete(phaseIndex);
      else next.add(phaseIndex);
      setOpenPhases({ scope: projectId, phases: [...next] });
    },
    [expandedPhases, projectId],
  );
  // Which "N done" rows are unfolded, per deal: held here so a fold stays open
  // across the deal's rail re-reads.
  const [unfolded, setUnfolded] = React.useState<{ scope: string; phases: number[] } | null>(null);
  const unfoldedPhases = React.useMemo(
    () => new Set(unfolded?.scope === projectId ? unfolded.phases : []),
    [unfolded, projectId],
  );
  const toggleFold = React.useCallback(
    (phaseIndex: number) =>
      setUnfolded((prev) => {
        const phases = prev?.scope === projectId ? prev.phases : [];
        return {
          scope: projectId,
          phases: phases.includes(phaseIndex)
            ? phases.filter((index) => index !== phaseIndex)
            : [...phases, phaseIndex],
        };
      }),
    [projectId],
  );
  // The same for each phase's run of steps from before the deal.
  const [unfoldedPrior, setUnfoldedPrior] = React.useState<{ scope: string; phases: number[] } | null>(null);
  const unfoldedPriorPhases = React.useMemo(
    () => new Set(unfoldedPrior?.scope === projectId ? unfoldedPrior.phases : []),
    [unfoldedPrior, projectId],
  );
  const togglePriorFold = React.useCallback(
    (phaseIndex: number) =>
      setUnfoldedPrior((prev) => {
        const phases = prev?.scope === projectId ? prev.phases : [];
        return {
          scope: projectId,
          phases: phases.includes(phaseIndex)
            ? phases.filter((index) => index !== phaseIndex)
            : [...phases, phaseIndex],
        };
      }),
    [projectId],
  );
  // A closed phase opens while it holds a search result.
  const boardExpanded = React.useMemo(() => {
    if (!query) return expandedPhases;
    const next = new Set(expandedPhases);
    for (const summary of summaries) {
      if (summary.steps.some(matchesTools)) next.add(summary.phase.index);
    }
    return next;
  }, [query, expandedPhases, summaries, matchesTools]);
  const phaseHeaderExtra = React.useCallback(
    (summary: PhaseSummary) =>
      isRealDeal && !peopleFailed ? (
        <PhaseViewLinks
          unassigned={summary.steps.filter((step) => inView("unassigned", step)).length}
          mine={meId === null ? 0 : summary.steps.filter((step) => inView("mine", step)).length}
          value={onlyView ?? "all"}
          onChange={(next) => changeViews(next === "all" ? [] : [next])}
        />
      ) : null,
    [isRealDeal, peopleFailed, inView, meId, onlyView, changeViews],
  );

  const [focusPhase, setFocusPhase] = React.useState<{
    phaseIndex: number;
    stepId?: string;
    nonce: number;
  } | null>(null);
  // Leaving the rail's own entry, stepped back off (pushed) or made plain
  // (an adopted deep link): either way the router still reports the entry's
  // ?step= for a render, so that param is marked as left, never a fresh
  // link. It is read from the entry itself: a walk inside the zoom replaced
  // it after the last render this callback saw.
  const leaveZoomHistory = React.useCallback(() => {
    if (leavingZoomRef.current) return;
    const leftParam = zoomEntryStepParam(projectId);
    if (leaveZoomEntry(projectId)) leavingZoomRef.current = true;
    if (leftParam !== null) setLeftZoomParam(leftParam);
  }, [projectId]);
  const zoomOut = React.useCallback(() => {
    const phaseIndex = steps[displayIndex]?.phaseIndex;
    const stepId = steps[displayIndex]?.id;
    setZoom(null);
    leaveZoomHistory();
    if (phaseIndex === undefined) return;
    if (!expandedPhases.has(phaseIndex)) {
      setOpenPhases({ scope: projectId, phases: [...expandedPhases, phaseIndex] });
    }
    setFocusPhase((prev) => ({ phaseIndex, stepId, nonce: (prev?.nonce ?? 0) + 1 }));
  }, [steps, displayIndex, expandedPhases, projectId, leaveZoomHistory]);

  // After "Save skill and add step": back to the board with the new step's
  // phase open; the landing effect focuses its highlighted card.
  const showAddedOnBoard = React.useCallback(
    (id: string) => {
      const step = steps.find((s) => s.id === id);
      setZoom(null);
      leaveZoomHistory();
      if (step && !expandedPhases.has(step.phaseIndex)) {
        setOpenPhases({ scope: projectId, phases: [...expandedPhases, step.phaseIndex] });
      }
      setLanding(id);
    },
    [steps, expandedPhases, projectId, leaveZoomHistory],
  );

  // Browser history for the zoom. A zoom entry left over from a reload or a
  // return to this page is made plain, so the rail opens on its board; so is
  // one the rail is still on when it unmounts.
  React.useEffect(() => {
    dropZoomEntry(projectId);
    return () => dropZoomEntry(projectId);
  }, [projectId]);
  // A ?step= deep link the rail landed zoomed on becomes its zoom entry in
  // place (after the reset above, so a fresh link is never dropped): the
  // address bar keeps ?step=, and Back still leaves the page.
  const adoptedLinkStep =
    zoomed && consumedDeepLink !== null && missingDeepLink !== consumedDeepLink
      ? steps[displayIndex]
      : undefined;
  const adoptedLinkStepId = adoptedLinkStep?.id;
  const adoptedLinkSeq = adoptedLinkStep?.seq ?? null;
  React.useEffect(() => {
    if (!adoptedLinkStepId || leavingZoomRef.current) return;
    adoptLinkZoomEntry(projectId, adoptedLinkStepId, adoptedLinkSeq);
  }, [projectId, adoptedLinkStepId, adoptedLinkSeq]);
  // Previous / Next, an advance or a skip inside the zoom: the one entry
  // names the step now shown (replaced, never one entry per step).
  const shownStep = zoomed ? steps[displayIndex] : undefined;
  const shownStepId = shownStep?.id;
  const shownStepSeq = shownStep?.seq ?? null;
  React.useEffect(() => {
    if (!shownStepId || leavingZoomRef.current) return;
    const entry = currentZoomEntry(projectId);
    if (entry !== null && entry !== shownStepId) replaceZoomEntry(projectId, shownStepId, shownStepSeq);
  }, [projectId, shownStepId, shownStepSeq]);
  // Back lands on the board's entry: zoom out to the step's phase, as the
  // zoom-out button does. Forward lands on a zoom entry: zoom back in. One
  // listener for the rail's life: the router re-renders the rail inside the
  // same popstate, and a listener swapped mid-dispatch would never run.
  const onPopState = React.useEffectEvent((event: PopStateEvent) => {
    if (leavingZoomRef.current) {
      // The step back a zoom-out took. The view already changed; if the MD
      // zoomed in again meanwhile, that zoom gets its entry now.
      leavingZoomRef.current = false;
      if (shownStepId) pushZoomEntry(projectId, shownStepId, shownStepSeq);
      return;
    }
    const stepId = zoomEntryStep(event.state, projectId);
    const index = stepId ? steps.findIndex((s) => s.id === stepId) : -1;
    if (index >= 0) {
      setZoom({ index, direction: 0, takeFocus: true });
      return;
    }
    // An entry for a step no longer on the rail reads as the board.
    if (stepId) dropZoomEntry(projectId);
    if (zoomed) {
      setLeftZoomParam(stepDeepLink);
      zoomOut();
    }
  });
  React.useEffect(() => {
    const listener = (event: PopStateEvent) => onPopState(event);
    window.addEventListener("popstate", listener);
    return () => window.removeEventListener("popstate", listener);
  }, []);

  const walkTo = React.useCallback(
    (index: number) =>
      setZoom({ index, direction: index > displayIndex ? 1 : -1, takeFocus: false }),
    [displayIndex],
  );

  // A completion the step PATCH already recorded advanced the rail in
  // deal_step_save (#200); a second /progress write could only disagree with
  // it. The bare "Move to the next step" buttons never reach the step row
  // (handoff E28), so the rail position is still theirs to persist. Recorded completions use the cursor
  // returned by that transaction and refresh the rest of the rail.
  const markComplete = React.useCallback((options?: { recorded?: boolean; stepId?: string; currentStepId?: string | null }) => {
    const completedId = options?.stepId ?? currentStepId;
    if (options?.recorded === true && completedId) {
      // The transaction chose the cursor; this view may be missing, reordered,
      // or carrying stale status for the next step. Never infer it locally.
      setStatusOverride((prev) => ({
        scope: overrideScope,
        currentStepId: options.currentStepId,
        overrides: {
          ...Object.fromEntries(Object.entries(prev?.scope === overrideScope ? prev.overrides : {})
            .filter(([, status]) => status !== STEP_STATUS.CURRENT)),
          [completedId]: STEP_STATUS.COMPLETE,
          ...(options.currentStepId && options.currentStepId !== completedId
            ? { [options.currentStepId]: STEP_STATUS.CURRENT } : {}),
        },
      }));
      // Zoomed in on the cursor: follow it to the step the transaction chose.
      if (completedId === currentStepId) {
        setZoom((z) => (z ? { ...z, index: null, direction: 1 } : z));
      }
      refresh();
      return;
    }
    if (completedId && completedId !== currentStepId) {
      applyOverrides({ [completedId]: STEP_STATUS.COMPLETE });
      return;
    }
    const index = currentStepId
      ? steps.findIndex((s) => s.id === currentStepId)
      : -1;
    if (index < 0) return;
    const current = steps[index];
    const nextIndex = nextOpenStepIndex(steps, index);
    const next = nextIndex >= 0 ? steps[nextIndex] : undefined;
    applyOverrides({
      [current.id]: STEP_STATUS.COMPLETE,
      ...(next ? { [next.id]: STEP_STATUS.CURRENT } : {}),
    });
    setZoom((z) => ({
      index: nextIndex >= 0 ? nextIndex : index + 1,
      direction: 1,
      takeFocus: z?.takeFocus ?? false,
    }));
    persistProgress(next);
  }, [steps, currentStepId, applyOverrides, persistProgress, overrideScope, refresh]);

  const confirmSkip = React.useCallback(
    async (input: SkipStepInput) => {
      if (!skipTarget) return;
      const outcome = await skipStep(steps, skipTarget, input);
      if (outcome.statusOverrides) applyOverrides(outcome.statusOverrides);
      if (outcome.skipRecord)
        applySkipRecord(outcome.skipRecord.id, outcome.skipRecord.skip);
      const advanceTo = outcome.advanceTo;
      if (advanceTo) {
        const nextIndex = steps.findIndex((s) => s.id === advanceTo.id);
        if (nextIndex >= 0) {
          setZoom((z) => ({ index: nextIndex, direction: 1, takeFocus: z?.takeFocus ?? false }));
        }
        persistProgress(advanceTo);
      }
      setSkipTarget(null);
    },
    [
      skipTarget,
      skipStep,
      steps,
      applyOverrides,
      applySkipRecord,
      persistProgress,
    ],
  );

  const loading =
    dealsState.status === "loading" || railStatus === "loading" || !rail;
  const { handlePublished, focusExisting } = usePublishedStepFocus({
    close: builder.close,
    refresh,
    steps,
    loading,
    openStepInFocus: openPublishedStep,
  });
  const onRestoreStep = useRestoreExistingStep(projectId, handlePublished);
  const { handlePublished: handleAddedOnBoard } = usePublishedStepFocus({
    close: builder.close,
    refresh,
    steps,
    loading,
    openStepInFocus: showAddedOnBoard,
  });

  const handleEnhance = React.useCallback(
    (basisStepId: string, seedRunId: string | null, teach?: boolean) => {
      if (!rail) return;
      builder.launch(rail, {
        basisStepId,
        ...(seedRunId ? { seedRunId } : {}),
        ...(teach ? { teach } : {}),
      });
    },
    [rail, builder],
  );

  // Try again re-joins one fresh read for every deal consumer at once: the
  // deal list (identity, the shell), this rail and its step records. The
  // shell's Try again on this route runs the same refresh.
  const retry = () => retryDealReads(projectId);

  // The deal list failed or timed out: say so, never "not found" and never a
  // fixture or catalog rail in its place.
  // The save-failure notice stays where the MD is: on the page, or in the open step.
  const unsavedNotice = unsavedHere ? (
          <div className="mb-[var(--space-3)] flex flex-wrap items-center gap-[var(--space-3)]">
            <p
              role="status"
              className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
            >
              {unsavedHere.notOnDeal
                ? `Your place on the rail was not saved. ${NOT_ON_DEAL_COPY}`
                : unsavedHere.message
                  ? `Your place on the rail was not saved: ${unsavedHere.message.replace(/\.$/, "")}.`
                  : "Your place on the rail was not saved."}
            </p>
            {/* A retry cannot change a deal you are not on: no Try again (the shared not-on-deal rule). */}
            {unsavedHere.notOnDeal ? null : (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => progressSaver.retry()}
              >
                {TRY_AGAIN_COPY}
              </Button>
            )}
          </div>
  ) : null;

  if (dealsState.status === "error") {
    return (
      <div className="mx-auto w-full max-w-[var(--page-max)] px-[var(--space-4)] py-[var(--space-5)]">
        <DealListUnavailableStage eyebrow="Deal rail" onRetry={retry} />
      </div>
    );
  }

  // An outside party (or anyone the server refuses) is not on the deal team:
  // say so plainly, with no Try again, since a retry cannot change the answer.
  if (railStatus === "error" && railForbidden) {
    return (
      <div className="mx-auto w-full max-w-[var(--page-max)] px-[var(--space-4)] py-[var(--space-5)]">
        <StageStatus kind="error" eyebrow="Deal rail">
          <p
            role="status"
            className="font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
          >
            The deal rail is for the bank&apos;s deal team.
          </p>
        </StageStatus>
      </div>
    );
  }

  // The server answers 404 for a deal the caller is not on: a retry cannot
  // change that, so say it plainly and point home.
  if (railStatus === "error" && railNotOnDeal) {
    return (
      <div className="mx-auto w-full max-w-[var(--page-max)] px-[var(--space-4)] py-[var(--space-5)]">
        <NotOnDealStage eyebrow="Deal rail" title={DESTINATION_TITLES.rail} />
      </div>
    );
  }

  if (railStatus === "error") {
    return (
      <div className="mx-auto w-full max-w-[var(--page-max)] px-[var(--space-4)] py-[var(--space-5)]">
        <StageStatus kind="error" eyebrow="Deal rail">
          <p
            role="status"
            className="font-mono text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
          >
            The deal rail could not be loaded right now.
          </p>
          <div className="mt-[var(--space-4)] flex justify-center">
            <Button variant="primary" size="sm" onClick={retry}>
              {TRY_AGAIN_COPY}
            </Button>
          </div>
        </StageStatus>
      </div>
    );
  }

  if (!loading && !railIsStructured(rail)) {
    return (
      <div className="mx-auto w-full max-w-[var(--page-max)] px-[var(--space-4)] py-[var(--space-5)]">
        <p className="rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] p-[var(--space-4)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
          This deal&apos;s rail is not set up yet. Its steps appear here once
          setup is complete.
        </p>
      </div>
    );
  }

  const railBoard = (
        <RailBoard
          summaries={summaries}
          steps={steps}
          stateFor={stateFor}
          run={run}
          deal={stepRecords.length > 0 ? { ...deal, stepRecords } : deal}
          expanded={boardExpanded}
          onTogglePhase={togglePhase}
          onOpenStep={openStepFromBoard}
          focusPhase={focusPhase}
          currentStepId={currentStepId}
          openAtCursor={!zoomed && openedAtCursorFor !== projectId}
          onOpenedAtCursor={markOpenedAtCursor}
          stepsFor={stepsFor}
          renderStack={customStack ? renderStack : undefined}
          stepFooter={boardStepFooter}
          highlightStepId={justAddedId}
          columnFooter={columnFooter}
          unfolded={unfoldedPhases}
          onToggleFold={toggleFold}
          unfoldedPrior={unfoldedPriorPhases}
          onTogglePriorFold={togglePriorFold}
          foldDone={!query}
          phaseHeaderExtra={phaseHeaderExtra}
          overlay={activeLayout === "dependency" ? <DependencyLines links={drawnLinks} /> : undefined}
          // Only where the cards shown are the rail's own order:
          // a filter or a Preview reorder would misplace the plus.
          onAddStepAfter={
            canAddStep && !narrowed && !reorder.active
              ? addStepAfter
              : undefined
          }
        />
  );
  // On the board they share the row with the views and the search.
  const railActions = (
    <>
        {activeStep ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => openStep(activeStep.id, { takeFocus: true })}
          >
            Open current step
          </Button>
        ) : null}
        {canSaveRail ? (
          <Button variant="secondary" size="sm" onClick={() => setSaveRailOpen(true)}>
            Save rail
          </Button>
        ) : null}
        {/* Preview: handoff E3 "Per-deal rail edit rights and \"Propose a change\"". Proposals stay in this browser. */}
        {canPropose ? (
          <>
            <Button variant="secondary" size="sm" onClick={() => setProposeOpen(true)}>
              {PROPOSAL_COPY.propose}
            </Button>
            <label className="inline-flex min-h-[34px] items-center gap-[var(--space-2)] text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)]">
              <input
                type="checkbox"
                checked={viewAsLead}
                onChange={(e) => setViewAsLead(e.target.checked)}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              {PROPOSAL_COPY.viewAsLead}
              <PreviewChip />
            </label>
          </>
        ) : null}
        {canEdit ? (
          <Button
            variant={editing ? "secondary" : "primary"}
            size="sm"
            onClick={() => setEditingFor(editing ? null : projectId)}
          >
            {editing ? "Done" : "Edit rail"}
          </Button>
        ) : null}
    </>
  );
  return (
    <>
      {loading ? (
        <DealRailLoading
          pending={dealsState.status === "loading" ? "deals" : "rail"}
        />
      ) : (
        <div
          // The page behind an open step is only a picture, as behind any dialog.
          aria-hidden={zoomed ? true : undefined}
          inert={zoomed}
          className="mx-auto w-full max-w-[var(--page-max)] px-[var(--space-4)] py-[var(--space-5)]"
        >
          {/* Honest Gate 0 create receipt, shown once on the ?new=1 landing (G20). */}
          <Gate0ReceiptBanner
            code={deal.code}
            active={searchParams.get("new") === "1"}
          />

          {isRealDeal ? <DataroomPendingBanner dealCode={deal.code} /> : null}

          {/* What late mail says about the step (design R9). Nothing moves until the MD accepts. */}
          {discoveryEnabled && isRealDeal ? (
            <EvidenceSuggestionMarker
              dealCode={deal.code}
              steps={steps.map((s) => ({
                stepId: s.stepId,
                seq: s.seq,
                title: stepTitle(s),
                removed: s.removedAt !== null,
              }))}
              currentStepId={activeStep?.stepId ?? null}
              canDismiss={deal.dealRole === DEAL_ROLE.MD}
              onMoved={refresh}
            />
          ) : null}

          {templateChanges.changeSet ? (
            <TemplateChangeBanner
              changeSet={templateChanges.changeSet}
              pendingCount={templateChanges.pending.length}
              onReview={() => setTemplateReviewOpen(true)}
            />
          ) : null}

          <RailHeader
            dealName={deal.codename}
            progress={progress}
            targetCloseDate={deal.targetCloseDate}
            entryLine={<EntryLine steps={steps} entryStepSeq={deal.entryStepSeq} />}
            beside={
              // Preview: handoff E4 "Step dependencies, per-step dates and \"started\" facts". The soonest step date set in this browser.
              soonest && soonestStep ? (
                <span
                  data-testid="rail-preview-date"
                  className="inline-flex flex-wrap items-center gap-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-tertiary)]"
                >
                  <span>
                    {soonest.kind === "dropDead" ? "Drop-dead" : "Step target"}{" "}
                    <span className="text-[var(--ink-secondary)]">{formatStepDay(soonest.day)}</span>
                    {" · "}
                    {stepTitle(soonestStep)}
                  </span>
                  <PreviewChip />
                </span>
              ) : null
            }
          />

          {zoomed ? null : unsavedNotice}

          {canPropose && viewAsLead ? (
            <ProposalTray
              proposals={planPreview.plan.proposals}
              stepFor={(id) => steps.find((s) => s.id === id)}
              numberOf={numberOf}
              now={now}
              onDecide={planPreview.decide}
              onReset={planPreview.resetProposals}
            />
          ) : null}

          <div ref={zoomStageRef}>
                <>
                  {missingDeepLink ? (
                    <p
                      role="status"
                      className="mb-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]"
                    >
                      That step is no longer on this rail.
                    </p>
                  ) : null}
                  {isRealDeal ? (
                    <div className="mb-[var(--space-3)] flex items-center gap-[var(--space-2)]">
                      <span className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">View</span>
                      <div className="min-w-0 flex-1 sm:w-[340px] sm:flex-none">
                        <SegmentedControl
                          items={RAIL_LAYOUT_OPTIONS}
                          value={activeLayout}
                          onChange={(id) => changeLayout(id as RailLayout)}
                          idBase={RAIL_LAYOUT_ID}
                          // Only the shown view's panel is on the page.
                          panelIdFor={(id) => (id === activeLayout ? `${RAIL_LAYOUT_ID}-panel-${id}` : undefined)}
                          aria-label="Rail view"
                        />
                      </div>
                    </div>
                  ) : null}
                  <RailBoardTools
                    trailing={railActions}
                    views={
                      isRealDeal ? (
                        <RailViewFilter
                          value={appliedViews}
                          onChange={changeViews}
                          counts={viewCounts}
                          shownCount={shownCount}
                          capped={activity.capped}
                          activityFailed={activity.failed}
                          onRetryActivity={refreshActivity}
                        />
                      ) : null
                    }
                    query={search?.scope === projectId ? search.query : ""}
                    onQueryChange={(next) => setSearch({ scope: projectId, query: next })}
                    matchCount={query ? shownCount : null}
                  />
                  <div
                    {...(isRealDeal
                      ? {
                          id: `${RAIL_LAYOUT_ID}-panel-${activeLayout}`,
                          role: "tabpanel" as const,
                          "aria-labelledby": `${RAIL_LAYOUT_ID}-tab-${activeLayout}`,
                        }
                      : {})}
                  >
                      {peopleFailed ? (
                        <p
                          role="alert"
                          className="mb-[var(--space-3)] flex flex-wrap items-center gap-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]"
                        >
                          <span>{OWNERS_FAILED_COPY}</span>
                          <Button variant="ghost" size="sm" onClick={refreshPeople}>
                            {TRY_AGAIN_COPY}
                          </Button>
                        </p>
                      ) : null}
                      {/* Preview: handoff E1 "Save a step reorder (deal rail and rail templates)". The moved order shows in this browser only. */}
                      {/* Preview: handoff E1 "Save a step reorder (deal rail and rail templates)". Says so before the first move. */}
                      {canDrag && !reorder.active ? (
                        <p
                          role="status"
                          className="mb-[var(--space-3)] flex flex-wrap items-center gap-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]"
                        >
                          <PreviewChip />
                          <span>Drag a step that is still open to move it. Only you see the new order.</span>
                        </p>
                      ) : null}
                      {editing && !canDrag ? (
                        <p
                          role="status"
                          className="mb-[var(--space-3)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]"
                        >
                          {activeLayout === "sequential"
                            ? "Choose All and clear the search to move a step."
                            : "Choose Sequential to move a step."}
                        </p>
                      ) : null}
                      {reorder.active ? (
                        // Stays in view while scrolling a phone-width board, so Reset is reachable.
                        <PreviewBanner
                          onReset={reorder.reset}
                          className="sticky top-0 z-10 mb-[var(--space-3)] sm:static"
                        />
                      ) : null}
                      {activeLayout === "timeline" ? (
                        <RailTimeline
                          phases={rail.phases}
                          steps={steps.filter((s) => stateFor(s) !== "prior" && inAppliedViews(s) && matchesTools(s))}
                          stateFor={stateFor}
                          dates={planPreview.plan.dates}
                          owners={peopleFailed ? undefined : owners}
                          closedAtFor={(s) => stepRecords.find((r) => r.stepId === s.stepId)?.completedAt}
                          targetCloseDate={deal.targetCloseDate}
                          numberOf={numberOf}
                          onOpenStep={openStepFromBoard}
                          onEditDates={setDatesFor}
                          onReset={planPreview.resetPlan}
                        />
                      ) : activeLayout === "dependency" ? (
                        <RailDependencyView
                          steps={steps}
                          stateFor={stateFor}
                          numberOf={numberOf}
                          plan={planPreview.plan}
                          onAddLink={planPreview.addLink}
                          onRemoveLink={planPreview.removeLink}
                          onReset={planPreview.resetPlan}
                        >
                          {railBoard}
                        </RailDependencyView>
                      ) : (
                        railBoard
                      )}
                      <StepDatesDialog
                        step={datesFor}
                        dates={datesFor ? planPreview.plan.dates[datesFor.id] : undefined}
                        onClose={() => setDatesFor(null)}
                        onSave={(dates) => {
                          if (datesFor) planPreview.setDates(datesFor.id, dates);
                          setDatesFor(null);
                        }}
                      />
                  </div>
                  {savedRail ? (
                    <p
                      role="status"
                      className="mt-[var(--space-2)] text-right text-[length:var(--text-xs)] text-[var(--ink-secondary)]"
                    >
                      {savedRail.version === undefined
                        ? `Saved as ${savedRail.name}.`
                        : `Saved as ${savedRail.name}, version ${savedRail.version}.`}{" "}
                      New mandates in your company can start from it.
                    </p>
                  ) : null}
                  <RemovedStepsSection
                    projectId={projectId}
                    rail={rail}
                    canRestore={rail.canEditStructure}
                    onRestored={refresh}
                  />
                </>
          </div>

          {/* The step holds work in progress: a stray click on the scrim never
              closes it. Escape and its close button do. */}
          <Dialog
            open={zoomed}
            onClose={zoomOut}
            title={null}
            ariaLabel="Rail step"
            headless
            size="xl"
            dismissOnScrim={false}
          >
            {unsavedNotice}
                <StepZoom
                  steps={steps}
                  phases={rail.phases}
                  viewIndex={shownIndex}
                  direction={zoom?.direction ?? 0}
                  run={run}
                  dealId={deal.id}
                  onComplete={markComplete}
                  onSkip={setSkipTarget}
                  onJump={walkTo}
                  onZoomOut={zoomOut}
                  stateFor={stateFor}
                  takeFocus={zoom?.takeFocus ?? false}
                  canRemove={rail.canEditStructure}
                  onRemoved={() => {
                    const removed = steps[displayIndex];
                    if (removed) {
                      dropFromPreview(removed);
                      promptEdit({ kind: "removed", title: stepTitle(removed) });
                    }
                    refresh();
                  }}
                  showOwner={isRealDeal}
                  onAssigned={refreshPeople}
                  moveAction={moveAction}
                  onEnhance={handleEnhance}
                  canTeach={rail.canEditStructure}
                  builderChanges={builder.changeCount}
                />
          </Dialog>

          <AnimatePresence>
          {templateReviewShowing && templateChanges.changeSet ? (
            <TemplateChangesDialog
              key="template-changes"
              changeSet={templateChanges.changeSet}
              rail={rail}
              canDecide={rail.canEditStructure}
              busy={templateChanges.busy}
              error={templateChanges.error}
              onDecide={templateChanges.decide}
              onReopen={templateChanges.reopen}
              onClose={closeTemplateReview}
            />
          ) : null}
          </AnimatePresence>

          <MoveStepDialog
            target={moveTarget}
            onClose={() => setMoveTarget(null)}
            onMove={(step, toIndex) => {
              const target = moveTarget;
              setMoveTarget(null);
              if (target) moveStep(step.phaseIndex, target.phaseSteps, step, toIndex);
            }}
          />

          {canPropose ? (
            <ProposeChangeDialog
              open={proposeOpen}
              steps={steps.filter((s) => stateFor(s) !== "prior")}
              numberOf={numberOf}
              onClose={() => setProposeOpen(false)}
              onPropose={planPreview.propose}
            />
          ) : null}

          <AnimatePresence>
          {saveRailOpen ? (
            <SaveRailDialog
              key="save-rail"
              dealId={projectId}
              previewOrderPending={reorder.active}
              onClose={() => setSaveRailOpen(false)}
              onSaved={(saved) => {
                setSavedRail(saved);
                void templateChanges.refresh();
              }}
            />
          ) : null}
          </AnimatePresence>

          {skipTarget ? (
            <SkipModal
              step={skipTarget}
              stepNumber={steps.findIndex((s) => s.id === skipTarget.id) + 1}
              dealId={deal.id}
              live={isRealDeal || railModelEnabled}
              onConfirm={confirmSkip}
              onClose={() => setSkipTarget(null)}
            />
          ) : null}
        </div>
      )}
      <RailEditPrompt
        edit={loading ? null : shownEdit}
        canSaveRail={canSaveRail}
        onApply={closeEditPrompt}
        onReset={() => {
          reorder.reset();
          setEdit(null);
        }}
        onSaveAsCompanyRail={() => {
          setEdit(null);
          setSaveRailOpen(true);
        }}
        onDontAskAgain={dontAskAgain}
      />
      <DontAskAgainConfirmation
        shownAt={dontAskShownAt}
        focusLink={dontAskFocus}
        notKept={dontAskNotKept}
        onDone={hideDontAsk}
      />
      <SkillBuilderLauncherDialog
        projectId={projectId}
        launcher={builder}
        liveRail={rail}
        onPublished={(stepId) => {
          setJustAddedId(stepId);
          handleAddedOnBoard(stepId);
          promptEdit({ kind: "added", title: null }, stepId);
        }}
        onFocusStep={focusExisting}
        onRestoreStep={onRestoreStep}
      />
    </>
  );
}

export default DealRail;
