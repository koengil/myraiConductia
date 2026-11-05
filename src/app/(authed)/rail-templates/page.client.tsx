'use client';

import * as React from 'react';
import { Plus } from 'lucide-react';

import { AccessNeededPanel } from '@/components/access/AccessNeededPanel';
import { Button } from '@/components/atoms/Button';
import { useCurrentUser } from '@/lib/auth/useCurrentUser';
import { ACCESS_DESTINATION } from '@/lib/constants/accessRequests';
import { useFlag } from '@/lib/flags/FlagsContext';
import { RAIL_TEMPLATES_NAV_LABEL, navUserFromProfile, showRailTemplatesNav } from '@/lib/navigation/navPolicy';
import type { RailTemplateSummary } from '@/lib/rail/railTemplateModel';
import type { TemplateChangeView } from '@/lib/rail/templateChanges';
import { DeleteTemplateDialog, NewTemplateDialog } from './TemplateDialogs';
import { TemplateDetailPanel, type TemplateDetail } from './TemplateDetailPanel';
import { TemplateListPanel, templateKey } from './TemplateListPanel';

/**
 * What a failed template write says. The routes' refusals (4xx) are
 * written as plain sentences and stay; a server failure (5xx) carries raw
 * database text, which goes to the console and never to the screen.
 */
function shownError(status: number | undefined, error: string | undefined, fallback: string): string {
  if (error && (status === undefined || status < 500)) return error;
  if (error) console.error('[rail-templates] request failed', status, error);
  return fallback;
}

export const PUBLISH_FAILED_COPY = 'The template was not published. Try again.';
export const REMOVE_TEMPLATE_STEP_FAILED_COPY = 'The step was not removed. Try again.';

function Loading() {
  return (
    <div
      className="flex h-full min-h-0 w-full flex-col items-center justify-center bg-[var(--surface-warm)]"
      aria-busy="true"
      aria-live="polite"
    >
      <span
        aria-hidden="true"
        className="size-6 animate-spin rounded-full border-2 border-[var(--stroke)] border-t-[var(--accent)]"
      />
    </div>
  );
}

export default function RailTemplatesPageClient() {
  const { state } = useCurrentUser();
  const changeReviewOn = useFlag('template_change_review');
  const [templates, setTemplates] = React.useState<RailTemplateSummary[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [name, setName] = React.useState('');
  const [sourceId, setSourceId] = React.useState('');
  const [formError, setFormError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState<RailTemplateSummary | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<TemplateDetail | null>(null);
  const [detailError, setDetailError] = React.useState<string | null>(null);
  const [editing, setEditing] = React.useState(false);
  const [changes, setChanges] = React.useState<TemplateChangeView[]>([]);
  const [publishing, setPublishing] = React.useState(false);
  const [publishError, setPublishError] = React.useState<string | null>(null);
  const publishingRef = React.useRef(false);
  const detailHeadingRef = React.useRef<HTMLHeadingElement>(null);
  // The template the reader has open now. A response for any other one is
  // stale (it was opened before, or deleted) and is dropped.
  const openIdRef = React.useRef<string | null>(null);
  const focusDetailOnLoad = React.useRef(false);

  const load = React.useCallback(async () => {
    setLoadError(null);
    const response = await fetch('/api/v1/rail-catalog');
    const body = (await response.json().catch(() => null)) as
      | { templates?: RailTemplateSummary[]; error?: string }
      | null;
    if (!response.ok) {
      setTemplates(null);
      setLoadError(body?.error ?? 'Could not load rail templates.');
      return;
    }
    setTemplates(body?.templates ?? []);
  }, []);

  const loadDetail = React.useCallback(async (templateId: string) => {
    // The error banner clears only when a fresh load of the open template
    // succeeds: a stale response never wipes it.
    let response: Response;
    try {
      response = await fetch(`/api/v1/rail-catalog/${templateId}`);
    } catch {
      if (openIdRef.current === templateId) setDetailError('Could not open the template.');
      return;
    }
    const body = (await response.json().catch(() => null)) as (TemplateDetail & { error?: string }) | null;
    if (openIdRef.current !== templateId) return;
    if (!response.ok) {
      setDetail(null);
      setDetailError(body?.error ?? 'Could not open the template.');
      return;
    }
    setDetailError(null);
    setDetail(body);
  }, []);

  const loadChanges = React.useCallback(async (templateId: string) => {
    if (templateId === 'default') {
      setChanges([]);
      return;
    }
    try {
      const response = await fetch(`/api/v1/rail-catalog/${templateId}/changes`);
      const body = (await response.json().catch(() => null)) as { changes?: TemplateChangeView[] } | null;
      if (openIdRef.current !== templateId) return;
      setChanges(response.ok && Array.isArray(body?.changes) ? body.changes : []);
    } catch {
      // History stays as it was; the next change reloads it.
    }
  }, []);

  const permitted =
    state.status === 'ready' &&
    showRailTemplatesNav(navUserFromProfile(state.data.user, state.data.company_permissions));

  React.useEffect(() => {
    if (!permitted) return;
    let cancelled = false;
    void (async () => {
      const response = await fetch('/api/v1/rail-catalog');
      const body = (await response.json().catch(() => null)) as
        | { templates?: RailTemplateSummary[]; error?: string }
        | null;
      if (cancelled) return;
      if (!response.ok) {
        setLoadError(body?.error ?? 'Could not load rail templates.');
        return;
      }
      setTemplates(body?.templates ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [permitted]);

  // Opening a template moves focus (and, on a phone, the view) to its steps.
  const detailName = detail?.template.name;
  React.useEffect(() => {
    if (!focusDetailOnLoad.current || !detailName) return;
    focusDetailOnLoad.current = false;
    detailHeadingRef.current?.focus();
    detailHeadingRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [detailName, openId]);

  if (state.status !== 'ready') return <Loading />;

  if (!permitted) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col bg-[var(--surface-warm)] px-[var(--space-5)] py-[var(--space-5)]">
        <AccessNeededPanel destination={ACCESS_DESTINATION.RAIL_TEMPLATES} />
      </div>
    );
  }

  function openTemplate(template: RailTemplateSummary) {
    const id = templateKey(template);
    focusDetailOnLoad.current = true;
    // Another template: its own load decides the banner, not the last one's.
    if (id !== openId) {
      setDetail(null);
      setDetailError(null);
    }
    openIdRef.current = id;
    setOpenId(id);
    setPublishError(null);
    void loadDetail(id);
    void loadChanges(id);
  }

  function startNewTemplate(source = '') {
    setFormError(null);
    setSourceId(source);
    setCreating(true);
  }

  async function onCreate(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      const response = await fetch('/api/v1/rail-catalog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          sourceTemplateId: sourceId || null,
        }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setFormError(body?.error ?? 'Could not create the template.');
        return;
      }
      setName('');
      setSourceId('');
      setCreating(false);
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!pendingDelete?.id) return;
    setDeleteError(null);
    setDeleting(true);
    try {
      const response = await fetch(`/api/v1/rail-catalog/${pendingDelete.id}`, { method: 'DELETE' });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setDeleteError(body?.error ?? 'Could not delete the template.');
        return;
      }
      const removedId = pendingDelete.id;
      setPendingDelete(null);
      if (openId === removedId) {
        openIdRef.current = null;
        setOpenId(null);
        setDetail(null);
        setChanges([]);
      } else if (openId) {
        void loadDetail(openId);
      }
      await load();
    } finally {
      setDeleting(false);
    }
  }

  /** Re-reads everything a step change touches: the open template, the list and its history. */
  function reloadTemplate(templateId: string) {
    return Promise.all([loadDetail(templateId), load(), loadChanges(templateId)]);
  }

  async function changeSteps(
    templateId: string,
    request: () => Promise<Response>,
    failed = 'Could not update the template.',
  ) {
    setDetailError(null);
    setEditing(true);
    try {
      let response: Response;
      try {
        response = await request();
      } catch {
        setDetailError(failed);
        return false;
      }
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        setDetailError(shownError(response.status, body?.error, failed));
        return false;
      }
      await reloadTemplate(templateId);
      return true;
    } finally {
      setEditing(false);
    }
  }

  /**
   * A description PATCH (the template's or a step's, existing routes). Holds
   * `editing` so Remove and the add gaps wait for it. Resolves to the
   * refusal, or null once saved; the reload after a save never rejects
   * (loadDetail and loadChanges settle on their own errors).
   */
  async function saveDescription(templateId: string, url: string, description: string): Promise<string | null> {
    setEditing(true);
    try {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ description }),
        });
      } catch {
        return 'Could not save the description.';
      }
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) return shownError(response.status, body?.error, 'Could not save the description.');
      await Promise.all([loadDetail(templateId), loadChanges(templateId)]);
      return null;
    } finally {
      setEditing(false);
    }
  }

  async function onPublish(templateId: string) {
    if (publishingRef.current) return;
    publishingRef.current = true;
    setPublishError(null);
    setPublishing(true);
    try {
      const response = await fetch(`/api/v1/rail-catalog/${templateId}/publish`, { method: 'POST' });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setPublishError(shownError(response.status, body?.error, PUBLISH_FAILED_COPY));
      }
      await loadDetail(templateId);
    } catch {
      setPublishError(PUBLISH_FAILED_COPY);
    } finally {
      publishingRef.current = false;
      setPublishing(false);
    }
  }

  const savedCount = templates?.filter((t) => t.kind === 'saved').length ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-[var(--space-5)] bg-[var(--surface-warm)] px-[var(--space-4)] py-[var(--space-5)] md:px-[var(--space-5)]">
      <header className="flex flex-wrap items-start justify-between gap-[var(--space-3)]">
        <div className="min-w-0">
          <h1 className="text-[length:var(--text-lg)] font-semibold text-[var(--ink)]">{RAIL_TEMPLATES_NAV_LABEL}</h1>
          <p className="mt-[var(--space-2)] max-w-xl text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
            New deals can start from published templates.
          </p>
        </div>
        <Button onClick={() => startNewTemplate()} className="gap-[var(--space-2)]">
          <Plus aria-hidden="true" className="size-4" />
          New template
        </Button>
      </header>

      <div className="grid items-start gap-[var(--space-5)] lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
        <TemplateListPanel
          templates={templates}
          loadError={loadError}
          openId={openId}
          onOpen={openTemplate}
          onDelete={(template) => {
            setDeleteError(null);
            setPendingDelete(template);
          }}
        />

        {openId ? (
          <TemplateDetailPanel
            key={openId}
            detail={detail}
            error={detailError}
            editing={editing}
            changes={changes}
            publishing={publishing}
            publishError={publishError}
            changeReviewOn={changeReviewOn}
            headingRef={detailHeadingRef}
            onStartFromDefault={() => startNewTemplate('')}
            onPublish={() => {
              if (!detail?.template.id) return;
              void onPublish(detail.template.id);
            }}
            onAdded={() => {
              if (!detail?.template.id) return;
              void reloadTemplate(detail.template.id);
            }}
            onUndo={(changeId) => {
              if (!detail?.template.id) return;
              void changeSteps(detail.template.id, () =>
                fetch(`/api/v1/rail-catalog/${detail.template.id}/changes/${changeId}`, { method: 'POST' }),
              );
            }}
            onRemove={(stepRowId) => {
              if (!detail?.template.id) return;
              void changeSteps(
                detail.template.id,
                () => fetch(`/api/v1/rail-catalog/${detail.template.id}/steps/${stepRowId}`, { method: 'DELETE' }),
                REMOVE_TEMPLATE_STEP_FAILED_COPY,
              );
            }}
            onSaveTemplateDescription={async (description) => {
              const templateId = detail?.template.id;
              if (!templateId) return 'Could not save the description.';
              return saveDescription(templateId, `/api/v1/rail-catalog/${templateId}`, description);
            }}
            onSaveDescription={async (stepRowId, description) => {
              const templateId = detail?.template.id;
              if (!templateId) return 'Could not save the description.';
              return saveDescription(
                templateId,
                `/api/v1/rail-catalog/${templateId}/steps/${stepRowId}`,
                description,
              );
            }}
          />
        ) : savedCount > 0 ? (
          <div className="hidden rounded-[var(--radius-card)] border border-dashed border-[var(--stroke)] px-[var(--space-5)] py-[var(--space-6)] text-[length:var(--text-sm)] text-[var(--ink-secondary)] lg:block">
            Open a template to see its steps, change them and publish.
          </div>
        ) : null}
      </div>

      <NewTemplateDialog
        open={creating}
        name={name}
        sourceId={sourceId}
        templates={templates ?? []}
        error={formError}
        saving={saving}
        onNameChange={setName}
        onSourceChange={setSourceId}
        onClose={() => setCreating(false)}
        onSubmit={(event) => void onCreate(event)}
      />
      <DeleteTemplateDialog
        template={pendingDelete}
        error={deleteError}
        deleting={deleting}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void onDelete()}
      />
    </div>
  );
}
