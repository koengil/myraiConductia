'use client';

import * as React from 'react';
import {
  ChevronRight,
  Download,
  File as FileIcon,
  FileText,
  Folder,
  FolderOpen,
  Presentation,
  Sheet,
  X,
} from 'lucide-react';

import { logAudit } from '@/lib/audit/store';
import { categoryColorForLabel, type CategoryColor } from '@/lib/dataroom/categoryColors';
import { useActiveDealState } from '@/lib/deals/useDeals';
import { DealListUnavailable } from '@/components/deals/DealsUnavailable';
import { useProjectId } from '@/lib/project/useProjectId';
import {
  countFiles,
  fileTypeLabel,
  formatBytes,
  isFolder,
  manifestFor,
  type DataRoomManifest,
  type FileNode,
  type FileSelection,
  type FolderNode,
  type ManifestKind,
  type TreeNode,
} from '@/lib/dataroom/tree';

/**
 * Data Room / Deal Folder — ONE real, navigable file explorer, parameterized
 * by `(manifest, kind)` (2026-07-09 split):
 *   - `kind="deal-folder"` → our INTERNAL work product. The
 *     client cannot access it.
 *   - `kind="data-room"`   → the client's own documents, staged for buyers.
 *
 * The folder tree spans the full width until a document is selected. Only a
 * file that can render a preview (the pre-rendered docx/pptx HTML) opens a
 * preview pane beside the tree. Any other file shows a bar above the tree with
 * a clear Download action, never an empty pane. The eight Deal Folder folders
 * carry their own category colour (src/lib/dataroom/categoryColors.ts). Any
 * `tags` on the file render as chips (Enterprise Search seed).
 *
 * Compliance stays felt: opening a folder, viewing a file, and downloading a
 * file each write to the client audit trail (`logAudit`).
 */

/** Per-kind header copy — the eyebrow + the access note that makes the
 *  internal/external boundary explicit and demoable. */
const KIND_META: Record<
  ManifestKind,
  { eyebrow: string; accessNote: string }
> = {
  'deal-folder': {
    eyebrow: 'Deal folder',
    accessNote: 'Internal work product. No outside party can see this.',
  },
  'data-room': {
    eyebrow: 'Data room',
    accessNote: 'Client documents. Staged buyer access.',
  },
};

/**
 * File-type glyph, by extension (docx/pptx/xlsx + fallback). Declared at module
 * scope and switching on direct JSX elements (never a dynamic capitalized tag)
 * so it renders a stable component, not one re-created each render.
 */
function FileTypeIcon({
  ext,
  size,
  className,
}: {
  ext: string;
  size: number;
  className?: string;
}) {
  const props = { size, 'aria-hidden': true, className } as const;
  switch (ext.toLowerCase()) {
    case 'docx':
    case 'doc':
      return <FileText {...props} />;
    case 'pptx':
    case 'ppt':
      return <Presentation {...props} />;
    case 'xlsx':
    case 'xls':
      return <Sheet {...props} />;
    default:
      return <FileIcon {...props} />;
  }
}

const pathKey = (path: readonly string[]) => path.join('/');
const INDENT_STEP = 14; // px per nesting level

type TreeRowsProps = {
  nodes: readonly TreeNode[];
  parentPath: readonly string[];
  depth: number;
  expanded: ReadonlySet<string>;
  selectedKey: string | null;
  onToggleFolder: (folder: FolderNode, path: string[]) => void;
  onSelectFile: (file: FileNode, path: string[], origin: HTMLElement) => void;
  /** Category colour inherited from the top-level Deal Folder folder, if any. */
  category?: CategoryColor | null;
};

function TreeRows({
  nodes,
  parentPath,
  depth,
  expanded,
  selectedKey,
  onToggleFolder,
  onSelectFile,
  category: inherited = null,
}: TreeRowsProps) {
  return (
    <ul
      className="m-0 list-none p-0"
      style={inherited ? { borderLeft: `2px solid ${inherited.dot}`, marginLeft: 12 } : undefined}
    >
      {nodes.map((node) => {
        const path = [...parentPath, node.name];
        const key = pathKey(path);
        const pad = 8 + depth * INDENT_STEP;
        const category = depth === 0 ? categoryColorForLabel(node.name) : inherited;

        if (isFolder(node)) {
          const isOpen = expanded.has(key);
          const files = countFiles(node.children);
          return (
            <li key={key}>
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => onToggleFolder(node, path)}
                style={{
                  paddingLeft: pad,
                  ...(depth === 0 && category ? { backgroundColor: category.fill } : null),
                }}
                className="group flex w-full items-center gap-[var(--space-2)] rounded-[var(--radius-control)] py-[var(--space-3)] pr-[var(--space-3)] text-left transition-colors hover:bg-[var(--surface-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <ChevronRight
                  size={13}
                  aria-hidden
                  className={`shrink-0 text-[var(--ink-tertiary)] transition-transform ${isOpen ? 'rotate-90' : ''}`}
                />
                {category ? (
                  <span
                    aria-hidden
                    data-category-dot=""
                    className="h-[8px] w-[8px] shrink-0 rounded-full"
                    style={{ backgroundColor: category.dot }}
                  />
                ) : null}
                {isOpen ? (
                  <FolderOpen size={15} aria-hidden className="shrink-0 text-[var(--accent)]" />
                ) : (
                  <Folder size={15} aria-hidden className="shrink-0 text-[var(--accent)]" />
                )}
                <span className="min-w-0 flex-1 truncate text-[length:var(--text-base)] font-medium text-[var(--ink)]">
                  {node.name}
                </span>
                <span
                  className={`shrink-0 font-mono text-[length:var(--text-xs)] tabular-nums ${
                    depth === 0 && category ? 'text-[var(--ink)]' : 'text-[var(--ink-tertiary)]'
                  }`}
                >
                  {files}
                </span>
              </button>

              {isOpen ? (
                node.children.length > 0 ? (
                  <TreeRows
                    nodes={node.children}
                    parentPath={path}
                    depth={depth + 1}
                    expanded={expanded}
                    selectedKey={selectedKey}
                    onToggleFolder={onToggleFolder}
                    onSelectFile={onSelectFile}
                    category={category}
                  />
                ) : (
                  <p
                    style={{ paddingLeft: pad + INDENT_STEP + 20 }}
                    className="py-[6px] pr-[var(--space-3)] text-[length:var(--text-xs)] italic text-[var(--ink-tertiary)]"
                  >
                    Empty folder
                  </p>
                )
              ) : null}
            </li>
          );
        }

        const isSelected = selectedKey === key;
        return (
          <li key={key}>
            <button
              type="button"
              aria-current={isSelected ? 'true' : undefined}
              onClick={(event) => onSelectFile(node, path, event.currentTarget)}
              style={{ paddingLeft: pad + 19 }}
              className={`flex w-full items-center gap-[var(--space-2)] rounded-[var(--radius-control)] py-[var(--space-3)] pr-[var(--space-3)] text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                isSelected
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                  : 'hover:bg-[var(--surface-subtle)] text-[var(--ink-secondary)]'
              }`}
            >
              <FileTypeIcon
                ext={node.ext}
                size={15}
                className={`shrink-0 ${isSelected ? 'text-[var(--accent)]' : 'text-[var(--ink-tertiary)]'}`}
              />
              <span
                className={`min-w-0 flex-1 truncate text-[length:var(--text-base)] ${isSelected ? 'font-medium text-[var(--accent)]' : 'text-[var(--ink)]'}`}
              >
                {node.name}
              </span>
              <span className="hidden shrink-0 font-mono text-[length:var(--text-xs)] tabular-nums text-[var(--ink-tertiary)] sm:inline">
                {node.bytes > 0 ? formatBytes(node.bytes) : ''}
              </span>
              <span className="w-[44px] shrink-0 text-right font-mono text-[length:var(--text-xs)] uppercase text-[var(--ink-tertiary)]">
                {node.ext}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Breadcrumb, file identity, the action (Download), and tag chips for the selected file. */
function SelectedFileHeader({
  selection,
  rootLabel,
  deal,
  onClose,
  note,
}: {
  selection: FileSelection;
  rootLabel: string;
  deal?: string;
  onClose: () => void;
  /** Plain line under the file name, e.g. why there is no preview. */
  note?: string;
}) {
  const { file, path } = selection;
  const tags = file.tags ?? [];
  const category = categoryColorForLabel(path[0] ?? '');

  return (
    <div className="flex shrink-0 flex-col gap-[var(--space-2)] border-b border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-5)] py-[var(--space-3)]">
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-x-[6px] gap-y-1 text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
          <li className="font-medium text-[var(--ink-secondary)]">{rootLabel}</li>
          {path.map((segment, index) => {
            const last = index === path.length - 1;
            return (
              <li key={index} className="flex items-center gap-x-[6px]">
                <ChevronRight size={11} aria-hidden className="text-[var(--ink-tertiary)]" />
                {index === 0 && category ? (
                  <span
                    className="inline-flex items-center gap-[6px] rounded-full px-[8px] py-[2px] text-[var(--ink)]"
                    style={{ backgroundColor: category.fill }}
                  >
                    <span
                      aria-hidden
                      className="h-[6px] w-[6px] rounded-full"
                      style={{ backgroundColor: category.dot }}
                    />
                    {segment}
                  </span>
                ) : (
                  <span className={last ? 'text-[var(--ink)]' : undefined}>{segment}</span>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="flex flex-wrap items-center gap-[var(--space-3)]">
        <FileTypeIcon ext={file.ext} size={18} className="shrink-0 text-[var(--accent)]" />
        <div className="min-w-0 flex-1 basis-[200px]">
          <p className="truncate text-[length:var(--text-sm)] font-semibold text-[var(--ink)]">
            {file.name}
          </p>
          <p className="text-[length:var(--text-xs)] text-[var(--ink-tertiary)]">
            {fileTypeLabel(file.ext)} · {file.bytes > 0 ? formatBytes(file.bytes) : 'Not shown'}
            {note ? ` · ${note}` : ''}
          </p>
        </div>
        <a
          href={file.href}
          download={file.name}
          onClick={() => logAudit('file', 'Downloaded', file.name, { deal })}
          className="inline-flex shrink-0 items-center gap-[6px] rounded-[var(--radius-button)] bg-[var(--accent)] px-[var(--space-3)] py-[7px] text-[length:var(--text-sm)] font-medium text-[var(--accent-contrast)] transition-colors hover:bg-[var(--accent-dark)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2"
        >
          <Download size={14} aria-hidden />
          {`Download ${file.ext.toUpperCase()}`.trim()}
        </a>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close selected document"
          className="inline-flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[var(--radius-button)] text-[var(--ink-secondary)] transition-colors hover:bg-[var(--surface-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        >
          <X size={16} aria-hidden />
        </button>
      </div>

      {/* Meta-tag chips — Enterprise Search seed. Present only when the file
          carries tags (the placeholder manifests seed empty arrays). */}
      {tags.length > 0 ? (
        <ul aria-label="Document tags" className="m-0 flex flex-wrap gap-[6px] p-0">
          {tags.map((tag) => (
            <li
              key={tag}
              className="inline-flex items-center gap-[6px] rounded-full border border-[var(--stroke-strong)] bg-[var(--surface)] px-[10px] py-[3px] text-[length:var(--text-xs)] font-medium text-[var(--ink-secondary)]"
            >
              <span
                aria-hidden
                className="h-[6px] w-[6px] shrink-0 rounded-full bg-[var(--ink-tertiary)]"
              />
              {tag}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Opens only for a file that can render: the pre-rendered HTML preview. */
function PreviewPane({
  selection,
  rootLabel,
  deal,
  onClose,
}: {
  selection: FileSelection;
  rootLabel: string;
  deal?: string;
  onClose: () => void;
}) {
  const { file } = selection;
  return (
    <section
      aria-label="Document preview"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--surface-warm)]"
    >
      <SelectedFileHeader selection={selection} rootLabel={rootLabel} deal={deal} onClose={onClose} />
      <iframe
        key={file.preview}
        src={file.preview}
        title={`Preview of ${file.name}`}
        className="min-h-[320px] w-full flex-1 border-0 bg-[var(--surface)]"
      />
    </section>
  );
}

export interface DataRoomProps {
  /** Optional explicit manifest (tests pass one). When omitted, the manifest is
   *  resolved PER DEAL from the route so switching deals shows that deal's own
   *  room, not another deal's documents. */
  manifest?: DataRoomManifest;
  /** Which surface this is — drives the header eyebrow + access note. */
  kind: ManifestKind;
  /** Extra chrome in the header (live upload, filing note). */
  headerExtra?: React.ReactNode;
  /** Replaces the two-pane explorer (folder tree and preview) below the header, e.g. the Deal email view. */
  body?: React.ReactNode;
}

export function DataRoom({ manifest: manifestProp, kind, headerExtra, body }: DataRoomProps) {
  const dealId = useProjectId();
  // #162: a failed deal list is stated in the header, with Try again; the
  // explorer itself reads the manifest, not the list.
  const { deal, unavailable: dealUnavailable, retry: retryDeals } = useActiveDealState(dealId);
  // Per-deal manifest (unless a test passes one explicitly). Memoised on the
  // deal so `manifest` keeps a STABLE identity per deal — which is what lets the
  // selection reset below fire only on a deal switch, not on every render.
  const manifest = React.useMemo(
    () => manifestProp ?? manifestFor(dealId, kind),
    [manifestProp, dealId, kind],
  );
  // Nothing is selected on open: the list uses the full width until a document is picked.
  const [selection, setSelection] = React.useState<FileSelection | null>(null);
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  // COMPLIANCE: reset the open document + expanded folders when the deal (and so
  // the manifest) changes. Switching deals does NOT remount this component (it's
  // a param-only navigation), so without this a document selected in one deal
  // would keep showing — and stay downloadable — under the next deal's room.
  // Done during render (React's "reset state on prop change" pattern) to avoid a
  // setState-in-effect cascade.
  const [manifestForDeal, setManifestForDeal] = React.useState(manifest);
  if (manifestForDeal !== manifest) {
    setManifestForDeal(manifest);
    setSelection(null);
    setExpanded(new Set<string>());
  }

  const selectedKey = selection ? pathKey(selection.path) : null;
  const meta = KIND_META[kind];

  const handleToggleFolder = React.useCallback(
    (folder: FolderNode, path: string[]) => {
      const key = pathKey(path);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
          // Audit only on open (matching the folder-guide "Opened" semantics).
          logAudit('folder', 'Opened', folder.name, { deal: deal.codename });
        }
        return next;
      });
    },
    [deal.codename],
  );

  // Closing the selected document returns focus to the row that opened it.
  const originRef = React.useRef<HTMLElement | null>(null);
  const handleSelectFile = React.useCallback(
    (file: FileNode, path: string[], origin: HTMLElement) => {
      originRef.current = origin;
      setSelection({ file, path });
      logAudit('dataroom', 'Viewed', file.name, {
        detail: manifest.root,
        deal: deal.codename,
      });
    },
    [manifest.root, deal.codename],
  );

  const totalFiles = manifest.counts.files;
  const canPreview = Boolean(selection?.file.preview);
  const handleClose = React.useCallback(() => {
    setSelection(null);
    const origin = originRef.current;
    if (origin?.isConnected) origin.focus();
  }, []);

  return (
    <section
      aria-label={meta.eyebrow}
      className="flex h-full min-h-0 w-full flex-col bg-[var(--surface-warm)]"
    >
      {/* Header — kind-driven eyebrow + access note, over the manifest identity. */}
      <header className="flex shrink-0 flex-col gap-[var(--space-1)] border-b border-[var(--stroke)] bg-[var(--surface)] px-[var(--space-5)] py-[var(--space-4)]">
        <span className="eyebrow">{meta.eyebrow}</span>
        <h1 className="text-[length:var(--text-lg)] font-semibold leading-tight text-[var(--ink)]">
          {manifest.root}
        </h1>
        {manifest.note ? (
          <p className="max-w-3xl text-[length:var(--text-sm)] text-[var(--ink-secondary)]">
            {manifest.note}
          </p>
        ) : null}
        <p className="text-[length:var(--text-xs)] font-medium text-[var(--ink-tertiary)]">
          {meta.accessNote}
        </p>
        {headerExtra}
        {dealUnavailable ? <DealListUnavailable onRetry={retryDeals} className="pb-0" /> : null}
      </header>

      {body !== undefined ? (
        <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
      ) : (
      /* Full-width list; a preview pane joins it only for a file that can render. */
      <div className="flex min-h-0 flex-1 flex-col">
        {selection && !canPreview ? (
          <section aria-label="Selected document" className="sticky top-0 z-10">
            <SelectedFileHeader
              selection={selection}
              rootLabel={manifest.root}
              deal={deal.codename}
              onClose={handleClose}
              note="No preview for this file type"
            />
          </section>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside
            aria-label="Folder tree"
            className={`flex min-h-0 flex-col bg-[var(--surface)] ${
              canPreview
                ? 'max-h-[40%] w-full shrink-0 border-b border-[var(--stroke)] md:max-h-none md:w-[320px] md:border-b-0 md:border-r'
                : 'w-full flex-1'
            }`}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-[var(--stroke)] px-[var(--space-4)] py-[var(--space-3)]">
              <span className="eyebrow">Files</span>
              <span className="font-mono text-[length:var(--text-xs)] tabular-nums text-[var(--ink-tertiary)]">
                {totalFiles} {totalFiles === 1 ? 'document' : 'documents'}
              </span>
            </div>
            <nav
              aria-label="Data room folders"
              className="min-h-0 flex-1 overflow-y-auto px-[var(--space-2)] py-[var(--space-2)]"
            >
              {/* Plain lists of disclosure buttons: no tree role
                  without the tree's arrow-key model. */}
              <TreeRows
                nodes={manifest.children}
                parentPath={[]}
                depth={0}
                expanded={expanded}
                selectedKey={selectedKey}
                onToggleFolder={handleToggleFolder}
                onSelectFile={handleSelectFile}
              />
            </nav>
          </aside>

          {selection && canPreview ? (
            <PreviewPane
              selection={selection}
              rootLabel={manifest.root}
              deal={deal.codename}
              onClose={handleClose}
            />
          ) : null}
        </div>
      </div>
      )}
    </section>
  );
}

export default DataRoom;
