'use client';

import * as React from 'react';
import { Download, Upload } from 'lucide-react';

import {
  dealBlocked,
  DealBlocked,
  LoadErrorAlert,
  loadFailureForStatus,
  type DocumentLoadFailure,
} from '@/components/dataroom/dealAvailability';
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
import { useCurrentUser } from '@/lib/auth/useCurrentUser';
import { DataRoomAccessInvite } from '@/components/dataroom/DataRoomAccessInvite';
import { WhoHasAccess } from '@/components/dataroom/WhoHasAccess';
import { categoryColorForFolder } from '@/lib/dataroom/categoryColors';
import { DEAL_FOLDER_LABELS, isDealFolder, type DealFolder } from '@/lib/dataroom/taxonomy';
import { formatBytes } from '@/lib/dataroom/tree';
import { useProjectId } from '@/lib/project/useProjectId';
import { formatDate } from '@/lib/format/date';

/**
 * DataRoomLive — the Data Room destination over the REAL document store
 * (platform_onboarding flag ON). Replaces the fixture explorer with the rows
 * GET /api/v1/deals/{dealId}/documents actually returns: the server walls
 * documents per viewer (room, phase, classification), so this surface renders
 * exactly what it is given and adds nothing.
 *
 * Two sections: Deal Folder filings (bank work product; the server never
 * returns these rows to external users, and the section is omitted entirely
 * when it has zero rows so an external viewer never sees an empty internal
 * header) and client documents. Uploads from this page always land in the
 * client room — room, classification, and disclosure phase are platform
 * defaults, not banker fields. Destination in the Deal Folder taxonomy is
 * the one choice they make.
 */

/** One row from GET /api/v1/deals/{dealId}/documents. Field casing mirrors the
 *  route verbatim (snake_case DB columns + camelCase derived fields). */
type LiveDocument = {
  id: string;
  name: string;
  room: 'internal' | 'deal';
  classification: number;
  minPhase: number;
  uploadedBy: string | null;
  createdAt: string;
  sizeBytes: number | null;
  contentType: string | null;
  hasFile: boolean;
  canOpen: boolean;
  /** Which of the eight Deal Folder folders the file is filed in. */
  folder?: string;
};

function CategoryTag({ folder }: { folder: string | undefined }) {
  const color = categoryColorForFolder(folder);
  if (!folder || !color || !isDealFolder(folder)) return <span aria-hidden />;
  return (
    <span
      className="inline-flex max-w-full items-center gap-[6px] justify-self-start truncate rounded-full px-[10px] py-[3px] text-[length:var(--text-xs)] font-medium text-[var(--ink)]"
      style={{ backgroundColor: color.fill }}
    >
      <span
        aria-hidden
        className="h-[6px] w-[6px] shrink-0 rounded-full"
        style={{ backgroundColor: color.dot }}
      />
      <span className="truncate">{DEAL_FOLDER_LABELS[folder]}</span>
    </span>
  );
}

function formatDay(iso: string): string {
  return formatDate(iso) || iso;
}

function DocumentRows({
  documents,
  dealId,
  showCategory,
}: {
  documents: LiveDocument[];
  dealId: string;
  /** Folder categories are bank vocabulary: shown to bank viewers only. */
  showCategory: boolean;
}) {
  return (
    <ul className="m-0 list-none p-0">
      {documents.map((doc) => (
        <li
          key={doc.id}
          className="flex min-h-[52px] flex-wrap items-center gap-x-[var(--space-4)] gap-y-[6px] border-b border-[var(--stroke)] px-[var(--space-4)] py-[10px] last:border-b-0 md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,220px)_72px_104px_104px]"
        >
          <span
            className={`min-w-0 basis-full truncate md:basis-auto text-[length:var(--text-base)] font-medium ${
              doc.canOpen ? 'text-[var(--ink)]' : 'text-[var(--ink-secondary)]'
            }`}
          >
            {doc.name}
          </span>
          {showCategory ? <CategoryTag folder={doc.folder} /> : <span aria-hidden />}
          <span className="font-mono text-[length:var(--text-xs)] tabular-nums text-[var(--ink-tertiary)]">
            {doc.canOpen && doc.hasFile && doc.sizeBytes != null && doc.sizeBytes > 0
              ? formatBytes(doc.sizeBytes)
              : 'Not shown'}
          </span>
          <span className="font-mono text-[length:var(--text-xs)] tabular-nums text-[var(--ink-tertiary)]">
            {formatDay(doc.createdAt)}
          </span>
          {doc.canOpen && doc.hasFile ? (
            <a
              href={`/api/v1/deals/${dealId}/documents/${doc.id}/download`}
              className="relative inline-flex items-center gap-[6px] rounded-[var(--radius-button)] before:absolute before:inset-x-0 before:top-1/2 before:h-11 before:-translate-y-1/2 before:content-[''] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-2)] py-[6px] text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <Download size={14} aria-hidden />
              Download
            </a>
          ) : (
            <span
              className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]"
              title={
                doc.hasFile
                  ? 'Your seat is not cleared to open this file yet.'
                  : 'No stored file. This row is a record, not a download.'
              }
            >
              {doc.hasFile ? 'Restricted' : 'Record only'}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function RoomSection({
  title,
  note,
  documents,
  dealId,
  showCategory = false,
}: {
  title: string;
  note: string;
  documents: LiveDocument[];
  dealId: string;
  showCategory?: boolean;
}) {
  return (
    <section
      aria-label={title}
      className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--stroke)] bg-[var(--surface)]"
    >
      <header className="flex items-baseline justify-between gap-[var(--space-3)] border-b border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-4)] py-[var(--space-3)]">
        <div className="flex items-baseline gap-[var(--space-3)]">
          <h2 className="text-[length:var(--text-md)] font-semibold text-[var(--ink)]">
            {title}
          </h2>
          <p className="text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">{note}</p>
        </div>
        <span className="font-mono text-[length:var(--text-xs)] tabular-nums text-[var(--ink-tertiary)]">
          {documents.length} {documents.length === 1 ? 'document' : 'documents'}
        </span>
      </header>
      {documents.length > 0 ? (
        <DocumentRows documents={documents} dealId={dealId} showCategory={showCategory} />
      ) : (
        <p className="px-[var(--space-4)] py-[var(--space-3)] text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
          No documents in this room yet.
        </p>
      )}
    </section>
  );
}

/**
 * The folders a Data Room upload may land in. Every upload from this page goes
 * to Client documents (room "deal"), which the client and the buyers given
 * access can see, so the choice offers only the client-facing folders, never
 * bank work product. Letting a bank user choose the room is E23.
 */
const CLIENT_DOCUMENT_FOLDERS: readonly DealFolder[] = ['received-from-client', 'data-room-index', 'due-diligence'];

/**
 * An outside viewer's seat role on this deal, from GET /api/v1/me memberships:
 * undefined while reading or for a bank viewer, null when no seat matched or
 * the read failed. Only used to keep the upload form from an outside seat
 * the server would refuse (403) anyway.
 */
function useOutsideSeatRole(dealId: string, outside: boolean): string | null | undefined {
  const [seat, setSeat] = React.useState<{ dealId: string; role: string | null } | null>(null);
  React.useEffect(() => {
    if (!outside) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/v1/me', { headers: { Accept: 'application/json' } });
        const body = res.ok
          ? ((await res.json()) as { memberships?: Array<{ deal_id?: string; deal_code?: string | null; deal_role?: string }> })
          : null;
        const match = body?.memberships?.find((m) => m.deal_id === dealId || m.deal_code === dealId);
        if (!cancelled) setSeat({ dealId, role: match?.deal_role ?? null });
      } catch {
        if (!cancelled) setSeat({ dealId, role: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dealId, outside]);
  if (!outside || seat?.dealId !== dealId) return undefined;
  return seat.role;
}

/** Upload panel — terminal-dense inline form over the multipart POST. */
function UploadPanel({
  dealId,
  onUploaded,
  bankSide,
}: {
  dealId: string;
  onUploaded: () => void;
  /** Only bank-side viewers choose a Deal Folder destination; others get the server default. */
  bankSide: boolean;
}) {
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [nameOverride, setNameOverride] = React.useState('');
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
      displayName: nameOverride.trim() || file.name,
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
      body.append('room', DOCUMENT_ROOM.DEAL);
      body.append('classification', String(DOCUMENT_CLASSIFICATION.INTERNAL));
      body.append('minPhase', '0');
      const name = nameOverride.trim();
      if (name) body.append('name', name);
      if (bankSide) appendFilingDestination(body, destination);

      const res = await fetch(`/api/v1/deals/${dealId}/documents`, {
        method: 'POST',
        body,
      });
      if (res.status === 502) {
        setError('Storage is unavailable. Try again.');
        return;
      }
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        setError(payload?.error ?? 'The upload was rejected.');
        return;
      }
      // 201: reset the form and refresh the list.
      if (fileRef.current) fileRef.current.value = '';
      setNameOverride('');
      onUploaded();
    } catch {
      setError('Network error. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  const selectClass =
    'rounded-[var(--radius-button)] border border-[var(--stroke-strong)] bg-[var(--surface)] px-[var(--space-2)] py-[6px] text-[length:var(--text-sm)] text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]';

  return (
    <section
      aria-label="Upload a document"
      className="rounded-[var(--radius-card)] border border-dashed border-[var(--stroke-strong)] bg-[var(--surface-subtle)] px-[var(--space-4)] py-[var(--space-3)]"
    >
      <div className="flex items-baseline justify-between gap-[var(--space-3)]">
        <h2 className="text-[length:var(--text-md)] font-semibold text-[var(--ink)]">
          Upload a document
        </h2>
        <p className="text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
          Every upload is logged.
        </p>
      </div>
      <form
        onSubmit={handleSubmit}
        className="mt-[var(--space-2)] flex flex-wrap items-end gap-[var(--space-3)]"
      >
        <label className="flex flex-col gap-[var(--space-1)]">
          <span className="text-[length:var(--text-sm)] font-medium text-[var(--ink-tertiary)]">
            File
          </span>
          <input
            ref={fileRef}
            type="file"
            name="file"
            accept={DOCUMENT_ACCEPT_ATTRIBUTE}
            className="text-[length:var(--text-sm)] text-[var(--ink-secondary)] file:mr-[var(--space-2)] file:rounded-[var(--radius-button)] file:border file:border-[var(--stroke-strong)] file:bg-[var(--surface)] file:px-[var(--space-2)] file:py-[5px] file:text-[length:var(--text-xs)] file:font-medium file:text-[var(--ink-secondary)]"
          />
        </label>
        {bankSide ? (
          <DealFolderDestinationSelect
            value={destination}
            onChange={setDestination}
            className={selectClass}
            label="Client documents folder"
            folders={CLIENT_DOCUMENT_FOLDERS}
          />
        ) : null}
        <label className="flex min-w-[180px] flex-1 flex-col gap-[var(--space-1)]">
          <span className="text-[length:var(--text-sm)] font-medium text-[var(--ink-tertiary)]">
            Name override (optional)
          </span>
          <input
            type="text"
            value={nameOverride}
            onChange={(e) => setNameOverride(e.target.value)}
            placeholder="Defaults to the file name"
            className={selectClass}
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-[6px] rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-3)] py-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-dark)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 disabled:opacity-60"
        >
          <Upload size={14} aria-hidden />
          {busy ? 'Uploading' : 'Upload'}
        </button>
        {/* Who sees the file, in the uploader's own terms. */}
        <p className="self-center text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
          {bankSide
            ? 'Visible to the client and the buyers you give access.'
            : "Visible to the bank's deal team and the buyers it gives access."}
        </p>
      </form>
      {error ? (
        <p role="alert" className="mt-[var(--space-2)] text-[length:var(--text-sm)] font-medium text-[var(--negative)]">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function DataRoomLive() {
  const dealId = useProjectId();
  const [documents, setDocuments] = React.useState<LiveDocument[] | null>(null);
  const [loadError, setLoadError] = React.useState<DocumentLoadFailure | null>(null);
  const [fetchToken, setFetchToken] = React.useState(0);

  // Reset on a deal switch during render (React's "reset state on prop change"
  // pattern, matching DataRoom) so one deal's rows never linger under another
  // deal's URL.
  const [loadedDealId, setLoadedDealId] = React.useState(dealId);
  if (loadedDealId !== dealId) {
    setLoadedDealId(dealId);
    setDocuments(null);
    setLoadError(null);
  }

  // Retry / post-upload refresh: clear to the loading state in the event
  // handler, then bump the token so the effect refetches.
  const refresh = React.useCallback(() => {
    setDocuments(null);
    setLoadError(null);
    setFetchToken((token) => token + 1);
  }, []);

  // The fetch effect sets state only AFTER await points (never synchronously),
  // so a cancelled (superseded) run can bail without touching state.
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

  // Fails closed: not bank-side until the profile has loaded and says so.
  const { state: userState } = useCurrentUser();
  const bankSide = userState.status === 'ready' && userState.data.user?.is_external === false;
  const ownFirm = userState.status === 'ready' ? (userState.data.company?.name ?? null) : null;
  // Outside, only a seller seat gets the upload form: the server takes
  // outside uploads from sellers only (documentAccess.ts
  // userCanUploadDocument). Outside seats wait for their role, so the form
  // fails closed.
  const outsideViewer = userState.status === 'ready' && userState.data.user?.is_external === true;
  const outsideRole = useOutsideSeatRole(dealId, outsideViewer);
  const mayUpload = bankSide || (outsideViewer && outsideRole === 'seller');

  const loading = documents === null && loadError === null;
  const unavailable = dealBlocked(loadError);

  const internal =
    documents?.filter((doc) => doc.room === DOCUMENT_ROOM.INTERNAL) ?? [];
  const deal = documents?.filter((doc) => doc.room === DOCUMENT_ROOM.DEAL) ?? [];

  return (
    <section
      aria-label="Data room"
      className="flex h-full min-h-0 w-full flex-col bg-[var(--surface-warm)]"
    >
      <header className="flex shrink-0 flex-col gap-[var(--space-1)] border-b border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-5)] py-[var(--space-4)]">
        <span className="eyebrow">Data room</span>
        <h1 className="text-[length:var(--text-lg)] font-semibold leading-tight text-[var(--ink)]">
          Deal documents
        </h1>
        {/* Bank side only: the Deal Folder section is omitted at zero rows,
            so this is where a bank viewer always learns where work product goes. */}
        {unavailable || !bankSide ? null : (
          <p className="max-w-3xl text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
            Bank work product is filed in the Deal Folder, which no outside party can see.
          </p>
        )}
        {unavailable ? null : (
          <div className="mt-[var(--space-2)] flex flex-wrap items-center justify-between gap-[var(--space-3)]">
            <WhoHasAccess dealId={dealId} kind="data-room" bankSide={bankSide} ownFirm={ownFirm} />
            <DataRoomAccessInvite dealId={dealId} onCreated={refresh} />
          </div>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-[var(--space-4)] overflow-y-auto px-[var(--space-5)] py-[var(--space-4)]">
        {unavailable || !mayUpload ? null : <UploadPanel dealId={dealId} onUploaded={refresh} bankSide={bankSide} />}

        {unavailable ? (
          <DealBlocked failure={unavailable} />
        ) : loading ? (
          <p className="text-[length:var(--text-sm)] text-[var(--ink-tertiary)]">
            Loading documents.
          </p>
        ) : loadError && loadError.kind === 'error' ? (
          <LoadErrorAlert message={loadError.message} onRetry={refresh} />
        ) : (
          <>
            {/* Deal Folder filings: omitted at zero rows so an external
                viewer never sees an empty internal header. */}
            {internal.length > 0 ? (
              <RoomSection
                title="Deal Folder"
                note="Bank work product. No outside party can see these."
                documents={internal}
                dealId={dealId}
                showCategory
              />
            ) : null}
            {/* The category chip shows on Client documents rows too (bank
                viewers only: the folder names are bank vocabulary). */}
            <RoomSection
              title="Client documents"
              note="The client's own files, staged for buyer access."
              documents={deal}
              dealId={dealId}
              showCategory={bankSide}
            />
          </>
        )}
      </div>
    </section>
  );
}

export default DataRoomLive;
