"use client";

import * as React from "react";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "framer-motion";

import {
  nonterminal,
  useSkillAuthoringDraft,
} from "@/lib/skillAuthoring/useSkillAuthoringDraft";
import { useSkillAuthoringPublication } from "@/lib/skillAuthoring/useSkillAuthoringPublication";
import {
  publicationFreeze,
  type PublicationFreeze,
} from "@/lib/skillAuthoring/publicationState";
import type {
  DraftBasisRequest,
  SkillAuthoringClient,
} from "@/lib/skillAuthoring/client";
import type { PublicationOperations } from "@/lib/skillAuthoring/useSkillAuthoringPublication";
import type { Placement } from "@/lib/skillAuthoring/types";
import type { TurnCandidatePreview } from "@/lib/skillAuthoring/ignatiousAuthoring";
import {
  useEnhancementBasis,
  type EnhancementBasis,
} from "@/lib/skillAuthoring/useEnhancementBasis";
import type { ProjectRail } from "@/lib/rail/projectRail";
import { Button } from "@/components/atoms/Button";
import { SkillAuthoringConversation } from "./SkillAuthoringConversation";
import { SkillCandidatePreview } from "./SkillCandidatePreview";
import { SkillBuilderBasisRow } from "./SkillBuilderBasisRow";
import { PublicationSection } from "./SkillBuilderPublicationPanel";
import { saveFooterProps } from "./skillPublicationGate";
import { useFlushedHandlers } from "./skillBuilderDialogFlush";
import {
  FieldHelp,
  FIELD_INPUT,
  FIELD_LABEL,
  PlacementFields,
} from "./SkillBuilderPlacementFields";
import { Dialog as OverlayDialog, overlayTransition, travel } from "@/components/overlay";
import { useModalDialog } from "@/lib/ui/useModalDialog";

type DialogFocusHandlers = {
  onFocusStep?: (dealStepId: string) => void;
  onRestoreStep?: (dealStepId: string) => Promise<boolean>;
};

/** Where a new step goes when the dialog opens: the step it was added from
 *  (`explicit`, replaces a resumed draft's spot) or the deal's current step
 *  (fills a draft that has no spot yet). */
export type InitialPlacement = { placement: Placement; explicit: boolean };

type DialogProps = DialogFocusHandlers & {
  open: boolean;
  initialPlacement?: InitialPlacement | null;
  dealId: string;
  rail: ProjectRail;
  onClose: () => void;
  client?: SkillAuthoringClient;
  onPublished?: (stepId: string) => void;
  publicationClient?: PublicationOperations;
  basisStepId?: string;
  seedRunId?: string;
  teach?: boolean;
  onSent?: () => void;
};

export function SkillBuilderDialog({
  open,
  dealId,
  rail,
  onClose,
  client,
  onPublished,
  onFocusStep,
  onRestoreStep,
  publicationClient,
  basisStepId,
  seedRunId,
  teach,
  onSent,
  initialPlacement,
}: DialogProps) {
  // Kept mounted through the exit motion by AnimatePresence.
  return (
    <AnimatePresence>
      {open ? (
    <SkillBuilderDialogBody
      key="skill-builder"
      initialPlacement={initialPlacement}
      dealId={dealId}
      rail={rail}
      onClose={onClose}
      client={client}
      onPublished={onPublished}
      onFocusStep={onFocusStep}
      onRestoreStep={onRestoreStep}
      publicationClient={publicationClient}
      basisStepId={basisStepId}
      seedRunId={seedRunId}
      teach={teach}
      onSent={onSent}
    />
      ) : null}
    </AnimatePresence>
  );
}

type Authoring = ReturnType<typeof useSkillAuthoringDraft>;

export function sendIsDisabled(
  authoring: Authoring,
  closing: boolean,
): boolean {
  return (
    closing ||
    authoring.sending ||
    authoring.saveState === "saving" ||
    authoring.saveState === "error" ||
    nonterminal(authoring.draft?.activeAttempt ?? null) ||
    publicationFreeze(authoring.draft).sendDisabled
  );
}

const NAME_MAX_LENGTH = 100;
const NAME_WHITESPACE_ERROR_TEXT =
  "Enter a step name, or leave it empty; a name cannot be only spaces.";
const NAME_LENGTH_ERROR_TEXT = "Step names can be at most 100 characters.";

export function nameErrorFor(name: string): string | null {
  if (name.length > NAME_MAX_LENGTH) return NAME_LENGTH_ERROR_TEXT;
  if (name.length > 0 && name.trim().length === 0)
    return NAME_WHITESPACE_ERROR_TEXT;
  return null;
}

const DIALOG_HEADER = "Skill builder";
const ENHANCE_HEADER = "Enhance skill";
const SAVE_LABEL = "Save skill and add step";
const PUBLISH_LABEL = "Publish and use on this step";

function dialogHeaderFor(enhancing: boolean): string {
  return enhancing ? ENHANCE_HEADER : DIALOG_HEADER;
}

function saveLabelFor(enhancing: boolean): string {
  return enhancing ? PUBLISH_LABEL : SAVE_LABEL;
}

/**
 * The builder's own scrim, on the shared `--scrim` token. The builder panel
 * stays outside the shared Dialog: it is a fixed-height workspace (title bar
 * with save status, conversation beside the live skill preview, footer), and
 * every way out (Escape, scrim, Close) goes through `requestClose`, which
 * saves the draft first and can fail in place. It still moves like every
 * overlay: the shared fade in and out (overlay motion tokens). The
 * not-permitted state is a plain message, so it uses the shared Dialog.
 */
function Scrim({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  const isPresent = useIsPresent();
  return (
    <motion.div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--scrim)] p-[var(--space-4)]"
      onClick={onClick}
      role="presentation"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={overlayTransition}
      // Leaving: clicks pass through instead of asking to close again.
      style={{ pointerEvents: isPresent ? undefined : "none" }}
    >
      {children}
    </motion.div>
  );
}

const STATUS_CLASS = "text-[length:var(--text-xs)] text-[var(--ink-tertiary)]";
const STATUS_ERROR_CLASS =
  "text-[length:var(--text-xs)] text-[var(--negative-deep)]";

function StatusLine({ state, dirty }: { state: string; dirty: boolean }) {
  if (dirty || state === "saving")
    return (
      <span data-testid="draft-status" role="status" className={STATUS_CLASS}>
        Saving
      </span>
    );
  if (state === "error")
    return (
      <span
        data-testid="draft-status"
        role="alert"
        className={STATUS_ERROR_CLASS}
      >
        Not saved
      </span>
    );
  if (state === "ready")
    return (
      <span data-testid="draft-status" role="status" className={STATUS_CLASS}>
        Saved
      </span>
    );
  return null;
}

function ActionError({
  innerRef,
  text,
}: {
  innerRef: React.RefObject<HTMLParagraphElement | null>;
  text: string;
}) {
  return (
    <div className="shrink-0 border-t border-[var(--stroke)] bg-[color-mix(in_srgb,var(--negative-fill)_40%,var(--surface))] px-[var(--space-4)] py-[var(--space-3)]">
      <p
        ref={innerRef}
        tabIndex={-1}
        role="alert"
        className="text-[length:var(--text-sm)] text-[var(--negative-deep)]"
      >
        {text}
      </p>
    </div>
  );
}

function CloseError({
  innerRef,
}: {
  innerRef: React.RefObject<HTMLParagraphElement | null>;
}) {
  return (
    <ActionError
      innerRef={innerRef}
      text="The latest text is not durable yet. Try closing again."
    />
  );
}

function FlushError({
  innerRef,
}: {
  innerRef: React.RefObject<HTMLParagraphElement | null>;
}) {
  return (
    <ActionError
      innerRef={innerRef}
      text="The latest text is not durable yet. Try again."
    />
  );
}

const SAVE_HELP_ID = "skill-authoring-save-help";

function SaveGateHelp({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p
      id={SAVE_HELP_ID}
      className="max-w-[38ch] text-[length:var(--text-xs)] text-[var(--ink-tertiary)]"
    >
      {text}
    </p>
  );
}

function SaveSkillButton({
  label,
  disabled,
  reason,
  onSave,
}: {
  label: string;
  disabled: boolean;
  reason: string | null;
  onSave: () => void;
}) {
  return (
    <Button
      disabled={disabled}
      onClick={onSave}
      aria-describedby={reason ? SAVE_HELP_ID : undefined}
    >
      {label}
    </Button>
  );
}

const NAME_ERROR_ID = "skill-authoring-name-error";

function NameField({
  name,
  onNameChange,
  disabled,
  error,
}: {
  name: string;
  onNameChange: (value: string) => void;
  disabled: boolean;
  error: string | null;
}) {
  return (
    <div>
      <label className="block">
        <span className={FIELD_LABEL}>Step name</span>
        <input
          value={name}
          placeholder="Name this step"
          disabled={disabled}
          onChange={(event) => onNameChange(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? NAME_ERROR_ID : undefined}
          className={FIELD_INPUT}
        />
      </label>
      <FieldHelp id={NAME_ERROR_ID} text={error} tone="negative" />
    </div>
  );
}

type HeaderFieldsProps = {
  rail: ProjectRail;
  name: string;
  onNameChange: (value: string) => void;
  nameError: string | null;
  placement: Placement | null;
  onPlacementChange: (value: Placement | null) => void;
  disabled: boolean;
  /** The draft has been read. */
  ready: boolean;
};

function HeaderFields({
  rail,
  name,
  onNameChange,
  nameError,
  placement,
  onPlacementChange,
  disabled,
  ready,
}: HeaderFieldsProps) {
  // The step name comes first and on its own; where the step goes is one
  // line that opens the phase and position choices only on Change.
  return (
    <div className="flex flex-col gap-[var(--space-2)]">
      <NameField
        name={name}
        onNameChange={onNameChange}
        disabled={disabled}
        error={nameError}
      />
      {/* Where the step goes shows once the draft is read, so the choices
          never flash open before its spot is known. */}
      {ready ? (
        <PlacementFields
          rail={rail}
          placement={placement}
          onPlacementChange={onPlacementChange}
          disabled={disabled}
        />
      ) : null}
    </div>
  );
}

type DiscardConfirmProps = {
  discarding: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

const CONFIRM_DESTRUCTIVE_BUTTON =
  "inline-flex h-[34px] items-center justify-center rounded-[var(--radius-control)] bg-[var(--negative-deep)] px-[var(--space-4)] text-[length:var(--text-base)] font-medium text-[var(--accent-contrast)] transition-colors hover:bg-[color-mix(in_srgb,var(--negative-deep)_88%,var(--ink))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--negative-deep)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] disabled:pointer-events-none disabled:opacity-50";

const DISCARD_CONFIRM_ID = "skill-authoring-discard-confirm";

function DiscardConfirm({
  discarding,
  onConfirm,
  onCancel,
}: DiscardConfirmProps) {
  return (
    <div
      id={DISCARD_CONFIRM_ID}
      role="group"
      aria-label="Discard draft"
      className="absolute bottom-full left-0 z-10 mb-[var(--space-2)] w-[max-content] max-w-[min(320px,70vw)] rounded-[var(--radius-card)] border border-[var(--stroke-strong)] bg-[var(--surface)] p-[var(--space-3)] shadow-[var(--shadow-ambient)]"
    >
      <p className="text-[length:var(--text-sm)] font-medium text-[var(--ink)]">
        Discard this draft?
      </p>
      <p className="mt-1 text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
        This removes the conversation and the candidate skill. It cannot be
        undone.
      </p>
      <div className="mt-[var(--space-3)] flex items-center gap-[var(--space-2)]">
        <button
          type="button"
          disabled={discarding}
          onClick={onConfirm}
          className={CONFIRM_DESTRUCTIVE_BUTTON}
        >
          Yes, discard
        </button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

type DiscardControlProps = {
  disabled: boolean;
  confirming: boolean;
  discarding: boolean;
  onAsk: () => void;
  onConfirm: () => void;
  onCancel: () => void;
};

const QUIET_DESTRUCTIVE_BUTTON =
  "inline-flex h-[34px] items-center justify-center rounded-[var(--radius-control)] px-[var(--space-3)] text-[length:var(--text-base)] font-medium text-[var(--negative-deep)] transition-colors hover:bg-[color-mix(in_srgb,var(--negative-fill)_45%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--negative-deep)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)] disabled:pointer-events-none disabled:opacity-50";

function DiscardControl({
  disabled,
  confirming,
  discarding,
  onAsk,
  onConfirm,
  onCancel,
}: DiscardControlProps) {
  return (
    <div
      className="relative"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !confirming) return;
        event.stopPropagation();
        onCancel();
      }}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onAsk}
        aria-expanded={confirming}
        aria-controls={confirming ? DISCARD_CONFIRM_ID : undefined}
        className={QUIET_DESTRUCTIVE_BUTTON}
      >
        Discard draft
      </button>
      {confirming ? (
        <DiscardConfirm
          discarding={discarding}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      ) : null}
    </div>
  );
}

type Publication = ReturnType<typeof useSkillAuthoringPublication>;

type DialogBodyProps = DialogFocusHandlers & {
  rail: ProjectRail;
  authoring: Authoring;
  publication: Publication;
  closing: boolean;
  enhancing: boolean;
  basis: EnhancementBasis;
};

function DialogBody({
  rail,
  authoring,
  publication,
  closing,
  enhancing,
  basis,
  onFocusStep,
  onRestoreStep,
}: DialogBodyProps) {
  const name = authoring.draft?.name ?? "";
  const fieldsDisabled = closing || publication.publicationFreeze.patchDisabled;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--surface-subtle)]">
      <div className="min-h-16 max-h-[35vh] overflow-y-auto border-b border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-3)]">
        {enhancing ? (
          <SkillBuilderBasisRow
            stepTitle={basis.stepTitle}
            version={basis.version}
            versionError={basis.versionError}
            seedRunAttached={basis.seedRunAttached}
            seedRun={basis.seedRun}
            runsError={basis.runsError}
          />
        ) : (
        <HeaderFields
          rail={rail}
          name={name}
          onNameChange={(value) => authoring.updateFields({ name: value })}
          nameError={nameErrorFor(name)}
          placement={authoring.draft?.placement ?? null}
          onPlacementChange={(value) =>
            authoring.updateFields({ placement: value })
          }
          disabled={fieldsDisabled}
          ready={authoring.draft !== null}
        />
        )}
        <PublicationSection
          rail={rail}
          draft={authoring.draft}
          publication={publication}
          onFocusStep={onFocusStep}
          onRestoreStep={onRestoreStep}
        />
      </div>
      <SkillAuthoringPanels
        authoring={authoring}
        publication={publication}
        fieldsDisabled={fieldsDisabled}
        sendDisabled={sendIsDisabled(authoring, closing)}
        enhancing={enhancing}
        ancestor={basis.ancestor}
      />
    </div>
  );
}

function SkillAuthoringPanels({
  authoring,
  publication,
  fieldsDisabled,
  sendDisabled,
  enhancing,
  ancestor,
}: {
  authoring: Authoring;
  publication: Publication;
  fieldsDisabled: boolean;
  sendDisabled: boolean;
  enhancing: boolean;
  ancestor: TurnCandidatePreview | null;
}) {
  const draft = authoring.draft;
  return (
    <div className="flex min-h-[22rem] flex-1 flex-col gap-[var(--space-3)] overflow-y-auto px-[var(--space-4)] py-[var(--space-3)] md:grid md:min-h-0 md:grid-cols-2 md:grid-rows-[minmax(0,1fr)] md:gap-[var(--space-4)]">
      <SkillAuthoringConversation
        messages={draft?.messages ?? []}
        composerValue={draft?.composerText ?? ""}
        onComposerChange={(value) => {
          if (!fieldsDisabled) authoring.updateFields({ composerText: value });
        }}
        composerDisabled={fieldsDisabled || authoring.sending}
        onSend={() => void authoring.send()}
        sendDisabled={sendDisabled}
        onRetry={(messageId) => void authoring.retry(messageId)}
        retryDisabled={publication.publicationFreeze.retryDisabled}
      />
      <SkillCandidatePreview
        candidate={draft?.candidate ?? null}
        ancestor={ancestor}
        enhancing={enhancing}
      />
    </div>
  );
}

type DialogFooterProps = {
  closing: boolean;
  requestClose: () => void;
  discardDisabled: boolean;
  confirming: boolean;
  discarding: boolean;
  setConfirming: (value: boolean) => void;
  confirm: () => void;
  showSave: boolean;
  saveLabel: string;
  saveDisabled: boolean;
  saveReason: string | null;
  onSave: () => void;
};

function DialogFooter({
  closing,
  requestClose,
  discardDisabled,
  confirming,
  discarding,
  setConfirming,
  confirm,
  showSave,
  saveLabel,
  saveDisabled,
  saveReason,
  onSave,
}: DialogFooterProps) {
  return (
    <div
      data-testid="skill-builder-footer"
      className="flex shrink-0 flex-wrap items-center justify-between gap-[var(--space-3)] border-t border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-4)] py-[var(--space-3)]"
    >

      <DiscardControl
        disabled={discardDisabled}
        confirming={confirming}
        discarding={discarding}
        onAsk={() => setConfirming(true)}
        onConfirm={confirm}
        onCancel={() => setConfirming(false)}
      />
      <div
        data-testid="skill-builder-footer-actions"
        className="flex flex-wrap items-center justify-end gap-[var(--space-3)]"
      >
        {showSave ? <SaveGateHelp text={saveReason} /> : null}
        <Button variant="secondary" onClick={requestClose} disabled={closing}>
          Close
        </Button>
        {showSave ? (
          <SaveSkillButton
            label={saveLabel}
            disabled={saveDisabled}
            reason={saveReason}
            onSave={onSave}
          />
        ) : null}
      </div>
    </div>
  );
}

function statusLineState(saveState: Authoring["saveState"]): string {
  if (saveState === "saving") return "saving";
  if (saveState === "error") return "error";
  return "ready";
}

function DialogTitleBar({
  header,
  state,
  dirty,
}: {
  header: string;
  state: string;
  dirty: boolean;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-[var(--space-3)] border-b border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-4)] py-[var(--space-3)]">
      <h2 className="text-[length:var(--text-md)] font-semibold text-[var(--ink)]">
        {header}
      </h2>
      <div className="flex items-center gap-[var(--space-3)]">
        <StatusLine state={state} dirty={dirty} />
      </div>
    </div>
  );
}

function useCloseHandler(
  closeRequested: () => Promise<boolean>,
  onClose: () => void,
  errorRef: React.RefObject<HTMLParagraphElement | null>,
) {
  const [closing, setClosing] = React.useState(false);
  const [closeFailed, setCloseFailed] = React.useState(false);
  const requestClose = React.useCallback(async () => {
    setClosing(true);
    setCloseFailed(false);
    try {
      const ok = await closeRequested();
      if (ok) {
        onClose();
        return;
      }
      setCloseFailed(true);
      window.requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setClosing(false);
    }
  }, [closeRequested, onClose, errorRef]);
  return { closing, closeFailed, requestClose };
}

function useDiscardHandler(
  discard: () => Promise<boolean>,
  onClose: () => void,
) {
  const [confirming, setConfirming] = React.useState(false);
  const [discarding, setDiscarding] = React.useState(false);
  const confirm = React.useCallback(async () => {
    setDiscarding(true);
    try {
      if (await discard()) onClose();
    } finally {
      setDiscarding(false);
      setConfirming(false);
    }
  }, [discard, onClose]);
  return { confirming, discarding, setConfirming, confirm };
}

export function useGatedFlush(
  flush: () => Promise<boolean>,
  freeze: PublicationFreeze,
): () => Promise<boolean> {
  return React.useCallback(async () => {
    if (freeze.patchDisabled) return true;
    return flush();
  }, [flush, freeze.patchDisabled]);
}

function useSkillBuilderDialog(
  dealId: string,
  onClose: () => void,
  suppliedClient?: SkillAuthoringClient,
  onPublished?: (stepId: string) => void,
  publicationClient?: PublicationOperations,
  requestedBasis?: DraftBasisRequest,
  onSent?: () => void,
) {
  const authoring = useSkillAuthoringDraft(
    dealId,
    suppliedClient,
    requestedBasis,
    onSent,
  );
  const publication = useSkillAuthoringPublication(
    dealId,
    authoring,
    onPublished,
    publicationClient,
  );
  const forbidden = authoring.status === "forbidden";
  const gatedFlush = useGatedFlush(
    authoring.flush,
    publication.publicationFreeze,
  );

  const errorRef = React.useRef<HTMLParagraphElement | null>(null);
  const closeHandler = useCloseHandler(gatedFlush, onClose, errorRef);
  const discardHandler = useDiscardHandler(authoring.discard, onClose);

  return {
    authoring,
    publication,
    gatedFlush,
    forbidden,
    errorRef,
    ...closeHandler,
    ...discardHandler,
  };
}

type BodyProps = DialogFocusHandlers & {
  initialPlacement?: InitialPlacement | null;
  dealId: string;
  rail: ProjectRail;
  onClose: () => void;
  client?: SkillAuthoringClient;
  onPublished?: (stepId: string) => void;
  publicationClient?: PublicationOperations;
  basisStepId?: string;
  seedRunId?: string;
  teach?: boolean;
  onSent?: () => void;
};
type Dialog = ReturnType<typeof useSkillBuilderDialog>;

function discardIsDisabled(dialog: Dialog): boolean {
  return (
    dialog.discarding ||
    dialog.closing ||
    !dialog.authoring.draft ||
    dialog.publication.publicationFreeze.discardDisabled
  );
}

function DialogPanelFooter({
  dialog,
  rail,
  enhancing,
}: {
  dialog: Dialog;
  rail: ProjectRail;
  enhancing: boolean;
}) {
  const footer = saveFooterProps(
    dialog.authoring.draft,
    rail,
    dialog.closing,
    dialog.publication.publicationFreeze.readOnly,
    enhancing,
  );
  return (
    <DialogFooter
      closing={dialog.closing}
      requestClose={() => void dialog.requestClose()}
      discardDisabled={discardIsDisabled(dialog)}
      confirming={dialog.confirming}
      discarding={dialog.discarding}
      setConfirming={dialog.setConfirming}
      confirm={() => void dialog.confirm()}
      showSave={footer.showSave}
      saveLabel={saveLabelFor(enhancing)}
      saveDisabled={footer.saveDisabled}
      saveReason={footer.saveReason}
      onSave={() => void dialog.publication.publish()}
    />
  );
}

function DialogPanel({
  rail,
  dialog,
  enhancing,
  basis,
  onFocusStep,
  onRestoreStep,
}: DialogFocusHandlers & {
  rail: ProjectRail;
  dialog: Dialog;
  enhancing: boolean;
  basis: EnhancementBasis;
}) {
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const isPresent = useIsPresent();
  const reduce = useReducedMotion() ?? false;
  const panelMotion = travel(reduce);
  useModalDialog(panelRef, () => void dialog.requestClose(), {
    active: isPresent,
    initialFocus: panelRef,
  });
  const flushed = useFlushedHandlers(
    dialog.gatedFlush,
    onFocusStep,
    onRestoreStep,
  );
  // No save status before the first edit: opening the draft session
  // is not a save the person made, so "Saved" would claim one.
  const saveState = dialog.authoring.saveState;
  const [edited, setEdited] = React.useState(false);
  if (!edited && saveState !== "saved") setEdited(true);
  return (
    <motion.div
      ref={panelRef}
      tabIndex={-1}
      initial={panelMotion.initial}
      animate={panelMotion.animate}
      exit={panelMotion.exit}
      transition={overlayTransition}
      role="dialog"
      aria-modal="true"
      aria-label={dialogHeaderFor(enhancing)}
      onClick={(event) => event.stopPropagation()}
      className="flex h-[min(760px,85vh)] w-full max-w-[880px] flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)] shadow-[var(--shadow-ambient)]"
    >
      <DialogTitleBar
        header={dialogHeaderFor(enhancing)}
        state={edited ? statusLineState(saveState) : "none"}
        dirty={false}
      />
      <DialogBody
        rail={rail}
        authoring={dialog.authoring}
        publication={dialog.publication}
        closing={dialog.closing}
        enhancing={enhancing}
        basis={basis}
        onFocusStep={flushed.focusHandler}
        onRestoreStep={flushed.restoreHandler}
      />
      {flushed.flushFailed ? (
        <FlushError innerRef={flushed.errorRef} />
      ) : dialog.closeFailed ? (
        <CloseError innerRef={dialog.errorRef} />
      ) : null}
      <DialogPanelFooter dialog={dialog} rail={rail} enhancing={enhancing} />
    </motion.div>
  );
}

function SkillBuilderDialogBody({
  dealId,
  rail,
  onClose,
  client,
  onPublished,
  onFocusStep,
  onRestoreStep,
  publicationClient,
  basisStepId,
  seedRunId,
  teach,
  onSent,
  initialPlacement,
}: BodyProps) {
  const requestedBasis = React.useMemo(
    () => ({
      ...(basisStepId ? { basisStepId } : {}),
      ...(seedRunId ? { seedRunId } : {}),
      ...(teach ? { teach } : {}),
    }),
    [basisStepId, seedRunId, teach],
  );
  const dialog = useSkillBuilderDialog(
    dealId,
    onClose,
    client,
    onPublished,
    publicationClient,
    requestedBasis,
    onSent,
  );
  const enhancing = Boolean(basisStepId);
  const shown = useOpeningPlacement(dialog, enhancing ? null : (initialPlacement ?? null));
  const opened = dialog.authoring.openedBasis;
  const basis = useEnhancementBasis(
    dealId,
    rail,
    basisStepId,
    opened ? (opened.seedRunId ?? undefined) : seedRunId,
    opened?.basis ?? null,
  );
  if (dialog.forbidden)
    return <ForbiddenDialog onClose={dialog.requestClose} />;
  return (
    <Scrim onClick={dialog.requestClose}>
      <DialogPanel
        rail={rail}
        dialog={shown}
        enhancing={enhancing}
        basis={basis}
        onFocusStep={onFocusStep}
        onRestoreStep={onRestoreStep}
      />
    </Scrim>
  );
}

/**
 * Where the new step goes when the builder opens, held in the dialog and not
 * saved: opening and closing leave the draft untouched. A resumed draft keeps
 * its own spot unless the MD added from a step's menu (`explicit`). The spot
 * is written with the MD's first edit (name, message or placement), in that
 * same draft save, or just before "Save skill and add step" publishes.
 */
function useOpeningPlacement(dialog: Dialog, initial: InitialPlacement | null): Dialog {
  const [consumed, setConsumed] = React.useState(false);
  const { authoring, publication } = dialog;
  const { draft, updateFields } = authoring;
  const frozen = publication.publicationFreeze.patchDisabled;
  const pending =
    !consumed &&
    !frozen &&
    initial !== null &&
    draft !== null &&
    draft.status === "active" &&
    (initial.explicit || draft.placement === null) &&
    JSON.stringify(draft.placement) !== JSON.stringify(initial.placement)
      ? initial.placement
      : null;
  const update = React.useCallback(
    (fields: Parameters<Authoring["updateFields"]>[0]) => {
      if (!pending) {
        updateFields(fields);
        return;
      }
      setConsumed(true);
      updateFields("placement" in fields ? fields : { ...fields, placement: pending });
    },
    [pending, updateFields],
  );
  const publish = React.useCallback(async () => {
    if (pending) {
      setConsumed(true);
      updateFields({ placement: pending });
    }
    return publication.publish();
  }, [pending, updateFields, publication]);
  if (!pending) return dialog;
  return {
    ...dialog,
    authoring: { ...authoring, draft: draft ? { ...draft, placement: pending } : draft, updateFields: update },
    publication: { ...publication, publish },
  };
}

function ForbiddenDialog({ onClose }: { onClose: () => void }) {
  return (
    <OverlayDialog open onClose={onClose} eyebrow="Skill builder" title="Not permitted">
      <p className="text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        You do not have permission to author skills on this deal.
      </p>
    </OverlayDialog>
  );
}
