'use client';

import * as React from 'react';
import { Upload } from 'lucide-react';

import { SegmentedControl } from '@/components/atoms/SegmentedControl';
import { DataRoom } from '@/components/dataroom/DataRoom';
import {
  dealBlocked,
  DealBlocked,
  LoadErrorAlert,
  loadFailureForStatus,
  type DocumentLoadFailure,
} from '@/components/dataroom/dealAvailability';
import { DealEmailList } from '@/components/dataroom/DealEmailList';
import {
  appendFilingDestination,
  DealFolderDestinationSelect,
  DEFAULT_DESTINATION_KEY,
} from '@/components/dataroom/DealFolderDestinationSelect';
import { DOCUMENT_CLASSIFICATION, DOCUMENT_ROOM } from '@/lib/constants/documents';
import {
  DOCUMENT_ACCEPT_ATTRIBUTE,
  checkDocumentUpload,
} from '@/lib/validation/inputPolicy';
import { useFlag } from '@/lib/flags/FlagsContext';
import { useCurrentUser } from '@/lib/auth/useCurrentUser';
import { WhoHasAccess } from '@/components/dataroom/WhoHasAccess';
import { DEFAULT_DEAL_FOLDER } from '@/lib/dataroom/taxonomy';
import { manifestFromDealFolderDocuments } from '@/lib/dataroom/tree';
import { useProjectId } from '@/lib/project/useProjectId';

/**
 * DealFolderLive — the Deal Folder over the real document store
 * (platform_onboarding flag ON).
 *
 * The eight Ignatious folders and the standard Destiny subfolders are always
 * on screen, empty ones included. Every filed document is shown — a Data Room
 * upload and a Deal Folder upload use the same tree. Files stay where they
 * are uploaded: there is no move control and the API has no move verb.
 */

type LiveDocument = {
  id: string;
  name: string;
  room: string;
  classification: number;
  minPhase: number;
  uploadedBy: string | null;
  createdAt: string;
  sizeBytes: number | null;
  contentType: string | null;
  hasFile: boolean;
  canOpen: boolean;
  folder?: string;
  folderSubpath?: string[];
};

function UploadToFolder({
  dealId,
  onUploaded,
}: {
  dealId: string;
  onUploaded: () => void;
}) {
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [destination, setDestination] = React.useState(DEFAULT_DESTINATION_KEY);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Choose a file to upload.');
      return;
    }
    const accepted = checkDocumentUpload({
      fileName: file.name,
      displayName: file.name,
      sizeBytes: file.size,
    });
    if (!accepted.ok) {
      setError(accepted.message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.append('file', file);
      body.append('room', DOCUMENT_ROOM.INTERNAL);
      body.append('classification', String(DOCUMENT_CLASSIFICATION.INTERNAL));
      body.append('minPhase', '0');
      appendFilingDestination(body, destination);

      const res = await fetch(`/api/v1/deals/${dealId}/documents`, {
        method: 'POST',
        body,
      });
      if (res.status === 502) {
        setError('Storage is unavailable. Try again.');
        return;
      }
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? 'The upload was rejected.');
        return;
      }
      if (fileRef.current) fileRef.current.value = '';
      onUploaded();
    } catch {
      setError('Network error. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-[var(--space-3)] flex flex-wrap items-end gap-[var(--space-3)]"
    >
      <DealFolderDestinationSelect value={destination} onChange={setDestination} />
      <label className="flex flex-col gap-[4px]">
        <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--ink-tertiary)]">
          File
        </span>
        <input
          ref={fileRef}
          type="file"
          name="file"
          accept={DOCUMENT_ACCEPT_ATTRIBUTE}
          className="text-[length:var(--text-sm)] text-[var(--ink-secondary)] file:mr-[var(--space-2)] file:rounded-[var(--radius-button)] file:border file:border-[var(--stroke)] file:bg-[var(--surface-subtle)] file:px-[var(--space-2)] file:py-[4px] file:text-[length:var(--text-xs)] file:font-medium file:text-[var(--ink-secondary)]"
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="inline-flex items-center gap-[6px] rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-3)] py-[7px] text-[length:var(--text-sm)] font-medium text-[var(--accent-contrast)] shadow-[var(--elev-1)] transition-colors hover:bg-[var(--accent-dark)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 disabled:opacity-60"
      >
        <Upload size={14} aria-hidden />
        {busy ? 'Uploading' : 'Upload'}
      </button>
      {error ? (
        <p role="alert" className="basis-full text-[length:var(--text-sm)] font-medium text-[var(--negative)]">
          {error}
        </p>
      ) : null}
    </form>
  );
}

type FolderView = 'documents' | 'email';

const VIEW_ITEMS = [
  { id: 'documents', label: 'Documents' },
  { id: 'email', label: 'Deal email' },
] as const;

export function DealFolderLive() {
  const dealId = useProjectId();
  // "Who has access" is bank side only and fails closed.
  const { state: userState } = useCurrentUser();
  const bankSide = userState.status === 'ready' && userState.data.user?.is_external === false;
  const ownFirm = userState.status === 'ready' ? (userState.data.company?.name ?? null) : null;
  // The Deal email view reads discovery evidence, so its switch exists only while deal_discovery is on.
  const dealDiscovery = useFlag('deal_discovery');
  const [view, setView] = React.useState<FolderView>('documents');
  const [documents, setDocuments] = React.useState<LiveDocument[] | null>(null);
  const [loadError, setLoadError] = React.useState<DocumentLoadFailure | null>(null);
  const [fetchToken, setFetchToken] = React.useState(0);

  const [loadedDealId, setLoadedDealId] = React.useState(dealId);
  if (loadedDealId !== dealId) {
    setLoadedDealId(dealId);
    setDocuments(null);
    setLoadError(null);
    setView('documents');
  }

  const refresh = React.useCallback(() => {
    setLoadError(null);
    setFetchToken((token) => token + 1);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/v1/deals/${dealId}/documents`, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
          if (cancelled) return;
          setLoadError(loadFailureForStatus(res.status, null));
          return;
        }
        const data = (await res.json()) as { documents: LiveDocument[] };
        if (cancelled) return;
        setDocuments(data.documents ?? []);
      } catch {
        if (cancelled) return;
        setLoadError({
          kind: 'error',
          message: 'Network error. Check your connection and try again.',
        });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [dealId, fetchToken]);

  const manifest = React.useMemo(
    () =>
      manifestFromDealFolderDocuments(
        (documents ?? []).map((doc) => ({
          name: doc.name,
          folder: doc.folder ?? DEFAULT_DEAL_FOLDER,
          subpath: doc.folderSubpath ?? [],
          bytes: doc.sizeBytes ?? 0,
          href: `/api/v1/deals/${dealId}/documents/${doc.id}/download`,
        })),
      ),
    [dealId, documents],
  );

  const loading = documents === null && loadError === null;
  const unavailable = dealBlocked(loadError);
  // A flag turned off while the email view is open falls back to the
  // documents; so does a deal the viewer is not on (one state, no switch).
  const emailSwitch = dealDiscovery && !unavailable;
  const emailView = emailSwitch && view === 'email';

  return (
    <DataRoom
      manifest={manifest}
      kind="deal-folder"
      // A blocked deal shows its one state in the header and no empty
      // folder tree under it.
      body={emailView ? <DealEmailList dealCode={dealId} /> : unavailable ? null : undefined}
      headerExtra={
        <>
          {emailSwitch ? (
            <SegmentedControl
              items={VIEW_ITEMS}
              value={emailView ? 'email' : 'documents'}
              onChange={(id) => setView(id === 'email' ? 'email' : 'documents')}
              idBase="deal-folder-view"
              aria-label="Deal Folder view"
              className="mt-[var(--space-2)] max-w-[320px]"
            />
          ) : null}
          {unavailable ? null : (
            <div className="mt-[var(--space-2)]">
              <WhoHasAccess dealId={dealId} kind="deal-folder" bankSide={bankSide} ownFirm={ownFirm} />
            </div>
          )}
          {emailView ? null : (
            <>
              {loadError && loadError.kind === 'error' ? (
                <LoadErrorAlert message={loadError.message} onRetry={refresh} />
              ) : null}
              {unavailable ? (
                <div className="mt-[var(--space-3)]">
                  <DealBlocked failure={unavailable} />
                </div>
              ) : loading ? (
                <p className="mt-[var(--space-2)] text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
                  Loading documents.
                </p>
              ) : (
                <UploadToFolder dealId={dealId} onUploaded={refresh} />
              )}
            </>
          )}
        </>
      }
    />
  );
}

export default DealFolderLive;
