import dataRoomExternalJson from './data-room-manifest.json';
import {
  DEAL_FOLDER_LABELS,
  DEAL_FOLDER_TEMPLATE,
  DEAL_FOLDERS,
  DEFAULT_DEAL_FOLDER,
  isDealFolder,
  type DealFolder,
} from './taxonomy';

/**
 * Typed loader for the ingested document manifests.
 *
 * ONE explorer, TWO surfaces (2026-07-09 Deal Folder / Data Room split):
 *   - Deal Folder — the Ignatious eight-folder taxonomy, empty until a banker
 *     uploads. Internal-only: the client cannot access it.
 *   - `dataRoomExternalManifest` — the client's own documents (the "Data Room",
 *     external / staged buyer access). Placeholder set under
 *     `/public/data-room-external/`.
 *
 * The JSON is the source of truth for each tree — this module just gives it a
 * precise type and a few pure helpers the explorer reads. No JSX, no state.
 */

/** Which manifest a surface is rendering — internal work product vs the
 *  client's external document room. Drives the explorer header + access note. */
export type ManifestKind = 'deal-folder' | 'data-room';

/** A downloadable document leaf. */
export type FileNode = {
  name: string;
  kind: 'file';
  /** File extension without the dot, e.g. 'docx' | 'pptx' | 'xlsx'. */
  ext: string;
  /** Ingest-reported size string (unreliable — prefer `bytes`). */
  size: string;
  bytes: number;
  /** Static download URL under /public/data-room. */
  href: string;
  /** Pre-rendered preview HTML URL under /public/data-room-previews, if any. */
  preview?: string;
  /**
   * Meta tags on the document — seed for a future Enterprise Search over the
   * room (typed now, no search built). Empty on the placeholder manifests.
   */
  tags?: readonly string[];
};

/** A folder, possibly empty. */
export type FolderNode = {
  name: string;
  kind: 'folder';
  children: TreeNode[];
};

export type TreeNode = FileNode | FolderNode;

export type DataRoomManifest = {
  /** Human name of the deal folder root, e.g. "Deal Folder". */
  root: string;
  /** Self-describing kind, when the JSON carries it (the external manifest does). */
  kind?: ManifestKind;
  note: string;
  children: TreeNode[];
  /** `previews` is absent on the external (client-document) manifest. */
  counts: { files: number; previews?: number; folders: number };
};

/**
 * The external Data Room — the client's own documents, staged for buyer access.
 * Placeholder pending the real VDR index. Shown by the `/data-room` route.
 */
export const dataRoomExternalManifest =
  dataRoomExternalJson as unknown as DataRoomManifest;

// --- Per-deal manifests -------------------------------------------------------
// The Deal Folder is the Ignatious taxonomy, empty on every deal (including the
// sandbox): eight closed folders plus the standard subfolders, no Destiny files
// and no Folder Guide. The Data Room on a fresh deal stays honestly empty (a
// VDR is a Preparation-phase artifact). The sandbox Data Room still uses its
// own placeholder manifest.

const SANDBOX_DEAL_IDS = new Set(['project-summit', 'atlassian']);

function templateToFolders(nodes: readonly { name: string; children: readonly unknown[] }[]): FolderNode[] {
  return nodes.map((node) => ({
    name: node.name,
    kind: 'folder' as const,
    children: templateToFolders(node.children as typeof nodes),
  }));
}

/** The eight top-level folders and their standard subfolders, with no files. */
export function dealFolderScaffold(): FolderNode[] {
  return DEAL_FOLDERS.map((folder) => ({
    name: DEAL_FOLDER_LABELS[folder],
    kind: 'folder' as const,
    children: templateToFolders(DEAL_FOLDER_TEMPLATE[folder]),
  }));
}

function countFolders(nodes: readonly TreeNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (isFolder(node)) total += 1 + countFolders(node.children);
  }
  return total;
}

function cloneTree(nodes: readonly TreeNode[]): TreeNode[] {
  return nodes.map((node) =>
    isFolder(node) ? { ...node, children: cloneTree(node.children) } : { ...node },
  );
}

function findOrCreateFolder(children: TreeNode[], name: string): FolderNode {
  const existing = children.find((node): node is FolderNode => isFolder(node) && node.name === name);
  if (existing) return existing;
  const created: FolderNode = { name, kind: 'folder', children: [] };
  children.push(created);
  return created;
}

export type PlacedDealFolderFile = {
  name: string;
  folder: string;
  subpath?: readonly string[];
  bytes: number;
  href: string;
  preview?: string;
};

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Overlay live documents onto the standard Deal Folder scaffold. Unknown
 * top-level folder values fall back to `received-from-client` so a row can
 * never vanish. A subpath that is not in the template is created on read so
 * the file stays reachable; that is display, not a user-created folder.
 */
export function manifestFromDealFolderDocuments(
  documents: readonly PlacedDealFolderFile[],
  options?: { root?: string; note?: string },
): DataRoomManifest {
  const children = cloneTree(dealFolderScaffold());
  for (const doc of documents) {
    const folder: DealFolder = isDealFolder(doc.folder) ? doc.folder : DEFAULT_DEAL_FOLDER;
    const top = findOrCreateFolder(children, DEAL_FOLDER_LABELS[folder]);
    let cursor = top;
    for (const segment of doc.subpath ?? []) {
      cursor = findOrCreateFolder(cursor.children, segment);
    }
    cursor.children.push({
      name: doc.name,
      kind: 'file',
      ext: extOf(doc.name),
      size: formatBytes(doc.bytes),
      bytes: doc.bytes,
      href: doc.href,
      preview: doc.preview,
    });
  }
  const files = countFiles(children);
  return {
    root: options?.root ?? 'Deal Folder',
    kind: 'deal-folder',
    // No default note: the header's access line and the folder line under it
    // already say this is internal work product and files stay where uploaded.
    note: options?.note ?? '',
    children,
    counts: { files, previews: 0, folders: countFolders(children) },
  };
}

// A generic, localStorage-free root — SSR-safe (no deal lookup), so the server
// HTML never ships another deal's code name. The active deal's identity is shown
// by the shell's DealContextBar, not by the room root.
function pendingManifest(kind: ManifestKind): DataRoomManifest {
  const isDealFolder = kind === 'deal-folder';
  if (isDealFolder) {
    return manifestFromDealFolderDocuments([]);
  }
  return {
    root: 'Data Room',
    kind,
    note: "The client's document room for this deal. Populated in Preparation, ahead of buyer access.",
    children: [],
    counts: { files: 0, folders: 0 },
  };
}

/** Resolve a deal's Data Room / Deal Folder manifest. Deal Folder is always
 *  the empty Ignatious taxonomy. The sandbox Data Room still uses its
 *  placeholder; every other deal's Data Room is empty. SSR-safe. */
export function manifestFor(dealId: string, kind: ManifestKind): DataRoomManifest {
  if (kind === 'deal-folder') return pendingManifest('deal-folder');
  if (SANDBOX_DEAL_IDS.has(dealId)) return dataRoomExternalManifest;
  return pendingManifest('data-room');
}

export function isFolder(node: TreeNode): node is FolderNode {
  return node.kind === 'folder';
}

export function isFile(node: TreeNode): node is FileNode {
  return node.kind === 'file';
}

/** Count files reachable within a list of nodes (recurses into subfolders). */
export function countFiles(nodes: readonly TreeNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (isFile(node)) total += 1;
    else total += countFiles(node.children);
  }
  return total;
}

/** A selection: the file plus the ordered folder-name path down to it. */
export type FileSelection = {
  file: FileNode;
  /** Path segments from the root down to and including the file name. */
  path: string[];
};

/**
 * The document to show on first open. Prefers a root-level file; otherwise
 * the first file found in depth-first order. Returns null for an empty room.
 */
export function defaultSelection(manifest: DataRoomManifest): FileSelection | null {
  const rootFile = manifest.children.find(isFile);
  if (rootFile) return { file: rootFile, path: [rootFile.name] };
  return firstFileDepthFirst(manifest.children, []);
}

function firstFileDepthFirst(
  nodes: readonly TreeNode[],
  trail: string[],
): FileSelection | null {
  for (const node of nodes) {
    if (isFile(node)) return { file: node, path: [...trail, node.name] };
    const found = firstFileDepthFirst(node.children, [...trail, node.name]);
    if (found) return found;
  }
  return null;
}

/** Human, accurate size from the byte count (the ingest `size` string lies). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exponent;
  const rounded = value >= 10 || exponent === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[exponent]}`;
}

/** Friendly document-type label from the extension. */
export function fileTypeLabel(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'docx':
    case 'doc':
      return 'Word Document';
    case 'pptx':
    case 'ppt':
      return 'PowerPoint Presentation';
    case 'xlsx':
    case 'xls':
      return 'Excel Spreadsheet';
    case 'pdf':
      return 'PDF Document';
    default:
      return `${ext.toUpperCase()} File`;
  }
}
