/**
 * Deal Folder taxonomy — Conductia's eight closed top-level folders, plus the
 * standard subfolder template taken from the Ignatious sample (Project Destiny /
 * Sample-ignatious-Project).
 *
 * The top level is CLOSED: created with the deal, never added, renamed, deleted,
 * or reordered. Subfolders in the template are the bankers' familiar scaffolding
 * (empty folders are shown on purpose). Files stay where they are uploaded —
 * moving between folders is deferred.
 *
 * Ids are ours and stable. Numbers and labels are theirs and display-only, so a
 * renumber on their side does not break a stored document row.
 */

export const DEAL_FOLDERS = [
  'received-from-client',
  'admin',
  'client-presentations',
  'marketing-materials',
  'buyers',
  'data-room-index',
  'due-diligence',
  'closing',
] as const;

export type DealFolder = (typeof DEAL_FOLDERS)[number];

export const DEAL_FOLDER_LABELS: Readonly<Record<DealFolder, string>> = {
  'received-from-client': '00. Received from Client',
  admin: '01. Admin',
  'client-presentations': '02. Client Presentations',
  'marketing-materials': '03. Marketing Materials',
  buyers: '04. Buyers',
  'data-room-index': '05. Data Room',
  'due-diligence': '06. Due Diligence',
  closing: '07. Closing',
};

/** Default landing folder for an upload that does not name one. */
export const DEFAULT_DEAL_FOLDER: DealFolder = 'received-from-client';

/**
 * How deep a subfolder may nest below one of the eight.
 * Three, because that is the sample's deepest path:
 * `04. Buyers / 05. Process Letter and Bid Summary / 01. Process Letter`.
 */
export const MAX_DEAL_FOLDER_DEPTH = 3;

const DEAL_FOLDER_SET: ReadonlySet<string> = new Set(DEAL_FOLDERS);

export function isDealFolder(value: string): value is DealFolder {
  return DEAL_FOLDER_SET.has(value);
}

/** One folder in the standard template (name only; files are not part of it). */
export type FolderTemplateNode = {
  readonly name: string;
  readonly children: readonly FolderTemplateNode[];
};

/**
 * Standard subfolders under each of the eight, taken from the Ignatious sample.
 *
 * Destiny-specific annotations are stripped (`01. Pitch Deck` rather than
 * `01. Pitch Deck (Sample from another engagement)`). Numbering holes are kept
 * (`04. Buyers` has no `03`) because that is the tree they work in.
 */
export const DEAL_FOLDER_TEMPLATE: Readonly<Record<DealFolder, readonly FolderTemplateNode[]>> = {
  'received-from-client': [],
  admin: [
    { name: 'Engagement Letter', children: [] },
    { name: 'Invoice', children: [] },
    { name: 'NDA', children: [] },
    { name: 'WGL and Team', children: [] },
  ],
  'client-presentations': [
    { name: '01. Pitch Deck', children: [] },
    { name: '02. Other Discussion Materials', children: [] },
    { name: '03. Organizational Meeting', children: [] },
    { name: '04. Process Update', children: [] },
  ],
  'marketing-materials': [
    { name: '01. Management Presentation', children: [] },
    { name: '02. Teaser', children: [] },
  ],
  buyers: [
    { name: '01. Buyers Log', children: [] },
    { name: '02. NDA', children: [] },
    { name: '04. Q&A', children: [] },
    {
      name: '05. Process Letter and Bid Summary',
      children: [
        { name: '01. Process Letter', children: [] },
        { name: '02. LOIs and Term Sheets', children: [] },
      ],
    },
  ],
  'data-room-index': [],
  'due-diligence': [
    { name: '01. Business DD', children: [] },
    { name: '02. Financial DD', children: [] },
  ],
  closing: [
    { name: '01. Stock Purchase Agreement', children: [] },
    { name: '02. Marketing at Closing', children: [] },
    { name: '03. Invoices', children: [] },
  ],
};

export type FilingDestination = {
  readonly folder: DealFolder;
  readonly subpath: readonly string[];
  /** `01. Admin / NDA` — display and select-option label. */
  readonly label: string;
};

export function formatFilingDestination(
  folder: DealFolder,
  subpath: readonly string[] = [],
): string {
  return [DEAL_FOLDER_LABELS[folder], ...subpath].join(' / ');
}

function destinationsUnder(
  folder: DealFolder,
  nodes: readonly FolderTemplateNode[],
  trail: readonly string[],
): FilingDestination[] {
  const out: FilingDestination[] = [];
  for (const node of nodes) {
    const subpath = [...trail, node.name];
    out.push({
      folder,
      subpath,
      label: formatFilingDestination(folder, subpath),
    });
    out.push(...destinationsUnder(folder, node.children, subpath));
  }
  return out;
}

/** Every legal filing destination in the template, top-level first, then depth-first. */
export function listFilingDestinations(): FilingDestination[] {
  const out: FilingDestination[] = [];
  for (const folder of DEAL_FOLDERS) {
    out.push({
      folder,
      subpath: [],
      label: DEAL_FOLDER_LABELS[folder],
    });
    out.push(...destinationsUnder(folder, DEAL_FOLDER_TEMPLATE[folder], []));
  }
  return out;
}

export function parseDealFolder(value: unknown): DealFolder | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return isDealFolder(trimmed) ? trimmed : null;
}

/**
 * Parse a subpath from a form field. Accepts a JSON array, a `/`-separated
 * string, or an already-parsed string array. `null` means the value is illegal
 * (too deep, empty segment, path separator inside a segment).
 */
export function parseDealFolderSubpath(value: unknown): string[] | null {
  if (value == null) return [];
  if (typeof value !== 'string' && !Array.isArray(value)) return null;

  let parts: unknown[];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) return null;
        parts = parsed;
      } catch {
        return null;
      }
    } else {
      parts = trimmed.split('/').map((segment) => segment.trim()).filter(Boolean);
    }
  } else {
    parts = value;
  }

  if (parts.length > MAX_DEAL_FOLDER_DEPTH) return null;

  const segments: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'string') return null;
    const segment = part.trim();
    if (
      segment.length === 0 ||
      segment.length > 120 ||
      segment.includes('/') ||
      segment.includes('\\')
    ) {
      return null;
    }
    segments.push(segment);
  }
  return segments;
}

export function sameFolderPath(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((segment, index) => segment === right[index]);
}
