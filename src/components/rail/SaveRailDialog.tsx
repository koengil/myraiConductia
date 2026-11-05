"use client";

import * as React from "react";

import { Button } from "@/components/atoms/Button";
import {
  activeSteps,
  skillBindingForStep,
  useProjectRail,
} from "@/lib/rail/projectRail";
import { listRailTemplates } from "@/lib/railTemplates/client";
import {
  TEMPLATE_DESCRIPTION_LIMIT,
  TEMPLATE_NAME_LIMIT,
  type SaveRailCommand,
  type TemplateSummary,
} from "@/lib/railTemplates/types";
import { useSaveRail } from "@/lib/railTemplates/useSaveRail";

import { FIELD_INPUT, FIELD_LABEL } from "./SkillBuilderPlacementFields";
import { Dialog } from "@/components/overlay";

const SHARING_TEXT =
  "Shares step descriptions and selected skill instructions with your company. People, deal work and results are not copied.";
const REPLACEMENT_TEXT =
  "Deals built from this rail are told about the changes and choose what to take.";
const FOLLOW_TEXT = "This deal will follow the saved rail from now on.";
const PUBLISHED_ONLY_TEXT = "Only published steps are included.";
const REMOVED_TEXT =
  "Removed standard steps stay removed on new deals, where they can be restored.";
const BUSY_TEXT = "Saving this rail to your company.";
/** A Preview move (handoff E1) never rides along on a save, so the dialog says so. */
export const PREVIEW_ORDER_NOT_INCLUDED =
  "The order you moved in this browser is not included. The saved rail keeps the deal's saved order.";
const LIST_ERROR_TEXT = "Your company's saved rails could not be loaded.";
const EMPTY_LIST_TEXT =
  "Your company has no saved rails yet. Create this one as new, then replace it from a later deal.";
const RAIL_ERROR_TEXT =
  "This rail could not be previewed. The saved result from the server is authoritative.";

const ERROR_ID = "save-rail-error";

const TEXTAREA_INPUT =
  "mt-1 block w-full resize-none rounded-[var(--radius-input)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink)] transition-colors placeholder:text-[var(--ink-quiet)] hover:border-[var(--ink-quiet)] focus-visible:border-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-subtle)] disabled:opacity-60";

type Mode = "new" | "replace";

function collapseTemplateName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function countLabel(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

function skillFloorText(count: number): string {
  if (count === 0) {
    return "No skill is visible from here. The saved rail may include more.";
  }
  const subject = count === 1 ? "1 step carries" : `${count} steps carry`;
  return `At least ${subject} a skill. The saved rail may include more.`;
}

function targetOf(
  mode: Mode,
  name: string,
  selected: TemplateSummary | undefined,
): SaveRailCommand["target"] | null {
  if (mode === "new") return { kind: "new", name };
  if (selected === undefined) return null;
  return {
    kind: "replace",
    templateId: selected.id,
    expectedRevisionId: selected.revisionId,
  };
}

export function SaveRailDialog({
  dealId,
  previewOrderPending = false,
  onClose,
  onSaved,
}: {
  dealId: string;
  /** A reorder Preview is active on the deal rail: say plainly it is left out. */
  previewOrderPending?: boolean;
  onClose: () => void;
  onSaved: (summary: TemplateSummary) => void;
}) {
  const { rail, status: railStatus } = useProjectRail(dealId);
  const { state, error, summary, save } = useSaveRail();

  const [mode, setMode] = React.useState<Mode>("new");
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [templateId, setTemplateId] = React.useState("");
  const [templates, setTemplates] = React.useState<TemplateSummary[]>([]);
  const [listStatus, setListStatus] = React.useState<
    "loading" | "ready" | "error"
  >("loading");
  const [listNonce, setListNonce] = React.useState(0);
  const [descriptionEdited, setDescriptionEdited] = React.useState(false);
  const [seenState, setSeenState] = React.useState(state);

  const formId = React.useId();
  const settledRef = React.useRef(false);
  const submittingRef = React.useRef(false);
  const fieldRef = React.useRef<HTMLInputElement | HTMLSelectElement>(null);
  const seenErrorRef = React.useRef<string | null>(null);

  const reloadTemplates = React.useCallback(() => {
    setListStatus("loading");
    setListNonce((value) => value + 1);
  }, []);

  if (state !== seenState) {
    setSeenState(state);
    if (state === "conflict") {
      setTemplateId("");
      reloadTemplates();
    }
  }

  React.useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const loaded = await listRailTemplates("save");
        if (active) {
          setTemplates(loaded);
          setListStatus("ready");
        }
      } catch {
        if (active) setListStatus("error");
      }
    })();
    return () => {
      active = false;
    };
  }, [listNonce]);

  React.useEffect(() => {
    if (state !== "saved" || summary === null || settledRef.current) return;
    settledRef.current = true;
    onSaved(summary);
    onClose();
  }, [state, summary, onSaved, onClose]);

  React.useEffect(() => {
    if (error === seenErrorRef.current) return;
    seenErrorRef.current = error;
    if (error !== null) fieldRef.current?.focus();
  }, [error]);

  const steps = rail === null ? [] : activeSteps(rail);
  const skillSteps = steps.filter(
    (step) => skillBindingForStep(step) !== null,
  ).length;

  const canonicalName = collapseTemplateName(name);
  const nameUsable =
    canonicalName.length >= 1 && canonicalName.length <= TEMPLATE_NAME_LIMIT;
  const selected = templates.find((template) => template.id === templateId);
  const busy = state === "saving";
  const fieldError = busy ? null : error;
  const submitLabel = mode === "new" ? "Save rail" : "Replace rail";
  const submitDisabled =
    busy || (mode === "new" ? !nameUsable : selected === undefined);

  async function runOnce(operation: () => Promise<void>) {
    if (submittingRef.current) return;
    submittingRef.current = true;
    try {
      await operation();
    } finally {
      submittingRef.current = false;
    }
  }

  function submit(event?: React.FormEvent) {
    event?.preventDefault();
    if (submitDisabled) return;
    const target = targetOf(mode, canonicalName, selected);
    if (target === null) return;
    const command: SaveRailCommand = {
      requestId: crypto.randomUUID(),
      sourceDealId: dealId,
      description: description.trim(),
      target,
    };
    void runOnce(() => save(command));
  }

  function editDescription(value: string) {
    setDescription(value);
    setDescriptionEdited(true);
  }

  function selectTemplate(value: string) {
    setTemplateId(value);
    if (descriptionEdited) return;
    const next = templates.find((template) => template.id === value);
    setDescription(next === undefined ? "" : next.description);
  }

  return (
    <Dialog
      open
      onClose={onClose}
      eyebrow="Company rail"
      title="Save rail"
      size="lg"
      dismissOnScrim={false}
      initialFocus={fieldRef as React.RefObject<HTMLElement | null>}
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={submitDisabled} aria-busy={busy}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate>
        <RailPreview
          status={railStatus}
          stepCount={steps.length}
          skillCount={skillSteps}
        />

        <fieldset className="mt-[var(--space-3)] border-0 p-0">
          <legend className={FIELD_LABEL}>Save mode</legend>
          <div className="mt-1 flex flex-wrap gap-[var(--space-3)]">
            <ModeChoice
              label="Create new"
              value="new"
              mode={mode}
              onSelect={setMode}
            />
            <ModeChoice
              label="Replace existing"
              value="replace"
              mode={mode}
              onSelect={setMode}
            />
          </div>
        </fieldset>

        {mode === "new" ? (
          <label className="mt-[var(--space-3)] block">
            <span className={FIELD_LABEL}>Name</span>
            <input
              ref={fieldRef as React.RefObject<HTMLInputElement>}
              type="text"
              value={name}
              maxLength={TEMPLATE_NAME_LIMIT}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={fieldError !== null}
              aria-describedby={fieldError === null ? undefined : ERROR_ID}
              className={FIELD_INPUT}
            />
          </label>
        ) : (
          <ReplaceTarget
            selectRef={fieldRef as React.RefObject<HTMLSelectElement>}
            invalid={fieldError !== null}
            errorId={fieldError === null ? undefined : ERROR_ID}
            status={listStatus}
            templates={templates}
            templateId={templateId}
            onSelect={selectTemplate}
            onReload={reloadTemplates}
          />
        )}

        {fieldError !== null ? (
          <p
            id={ERROR_ID}
            role="alert"
            className="mt-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--negative-deep)]"
          >
            {fieldError}
          </p>
        ) : null}

        <label className="mt-[var(--space-3)] block">
          <span className={FIELD_LABEL}>Description</span>
          <textarea
            value={description}
            rows={3}
            maxLength={TEMPLATE_DESCRIPTION_LIMIT}
            onChange={(event) => editDescription(event.target.value)}
            className={TEXTAREA_INPUT}
          />
        </label>

        <div className="mt-[var(--space-3)] space-y-[var(--space-2)] text-[length:var(--text-xs)] text-[var(--ink-secondary)]">
          {previewOrderPending ? (
            <p data-testid="save-rail-preview-order" className="text-[var(--ink)]">
              {PREVIEW_ORDER_NOT_INCLUDED}
            </p>
          ) : null}
          <p>{SHARING_TEXT}</p>
          <p>{FOLLOW_TEXT}</p>
          <p>{PUBLISHED_ONLY_TEXT}</p>
          <p>{REMOVED_TEXT}</p>
          {mode === "replace" ? <p>{REPLACEMENT_TEXT}</p> : null}
        </div>

        <StatusLines busy={busy} error={null} />
      </form>
    </Dialog>
  );
}

function ModeChoice({
  label,
  value,
  mode,
  onSelect,
}: {
  label: string;
  value: Mode;
  mode: Mode;
  onSelect: (value: Mode) => void;
}) {
  return (
    <label className="inline-flex items-center gap-2 text-[length:var(--text-sm)] text-[var(--ink)]">
      <input
        type="radio"
        name="save-rail-mode"
        value={value}
        checked={mode === value}
        onChange={() => onSelect(value)}
        className="h-4 w-4 accent-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface)]"
      />
      {label}
    </label>
  );
}

function RailPreview({
  status,
  stepCount,
  skillCount,
}: {
  status: "loading" | "ready" | "error";
  stepCount: number;
  skillCount: number;
}) {
  if (status === "loading") {
    return (
      <p
        role="status"
        aria-live="polite"
        className="mt-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink-tertiary)]"
      >
        Reading this rail.
      </p>
    );
  }
  if (status === "error") {
    return (
      <p className="mt-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        {RAIL_ERROR_TEXT}
      </p>
    );
  }
  return (
    <div className="mt-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
      <p>{countLabel(stepCount, "active step")}.</p>
      <p>{skillFloorText(skillCount)}</p>
    </div>
  );
}

function ReplaceTarget({
  selectRef,
  invalid,
  errorId,
  status,
  templates,
  templateId,
  onSelect,
  onReload,
}: {
  selectRef: React.RefObject<HTMLSelectElement>;
  invalid: boolean;
  errorId: string | undefined;
  status: "loading" | "ready" | "error";
  templates: TemplateSummary[];
  templateId: string;
  onSelect: (value: string) => void;
  onReload: () => void;
}) {
  if (status === "loading") {
    return (
      <p
        role="status"
        aria-live="polite"
        className="mt-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink-tertiary)]"
      >
        Reading your company&apos;s saved rails.
      </p>
    );
  }

  if (status === "error") {
    return (
      <div className="mt-[var(--space-3)]">
        <p className="text-[length:var(--text-sm)] text-[var(--negative-deep)]">
          {LIST_ERROR_TEXT}
        </p>
        <Button
          variant="secondary"
          size="sm"
          className="mt-[var(--space-2)]"
          onClick={onReload}
        >
          Reload saved rails
        </Button>
      </div>
    );
  }

  if (templates.length === 0) {
    return (
      <p className="mt-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
        {EMPTY_LIST_TEXT}
      </p>
    );
  }

  return (
    <div className="mt-[var(--space-3)]">
      <label className="block">
        <span className={FIELD_LABEL}>Saved rail</span>
        <select
          ref={selectRef}
          value={templateId}
          onChange={(event) => onSelect(event.target.value)}
          aria-invalid={invalid}
          aria-describedby={errorId}
          className={FIELD_INPUT}
        >
          <option value="">Select a saved rail</option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function StatusLines({ busy, error }: { busy: boolean; error: string | null }) {
  return (
    <>
      {busy ? (
        <p
          role="status"
          aria-live="polite"
          className="mt-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink-tertiary)]"
        >
          {BUSY_TEXT}
        </p>
      ) : null}
      {error !== null && !busy ? (
        <p
          role="alert"
          className="mt-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--negative-deep)]"
        >
          {error}
        </p>
      ) : null}
    </>
  );
}

export default SaveRailDialog;
