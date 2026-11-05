import { DEAL_FOLDER_LABELS, DEAL_FOLDERS, type DealFolder } from '@/lib/dataroom/taxonomy';

/**
 * Category colours for the eight Deal Folder folders (Workbench category grammar:
 * a 6px dot plus a soft pastel wash of the same hue). Every colour is an
 * existing Workbench token or a mix of two of them. No new hex values.
 * Violet (--ai) is left out on purpose: it belongs to the AI actor only.
 */
export type CategoryColor = {
  /** The solid dot and folder-edge colour. */
  dot: string;
  /** The pastel wash behind a category label. */
  fill: string;
};

const DOT: Readonly<Record<DealFolder, string>> = {
  'received-from-client': 'var(--sync)',
  admin: 'var(--accent)',
  'client-presentations': 'var(--positive)',
  'marketing-materials': 'var(--hold)',
  buyers: 'var(--negative)',
  'data-room-index': 'color-mix(in srgb, var(--sync) 55%, var(--positive))',
  'due-diligence': 'color-mix(in srgb, var(--negative) 55%, var(--hold))',
  closing: 'var(--ink)',
};

function wash(dot: string): string {
  return `color-mix(in srgb, ${dot} 22%, var(--surface))`;
}

/**
 * Washes: the Workbench solid pastel fills where a token exists (green, amber,
 * red, the navy accent wash). Admin takes the accent wash and Closing the one
 * grey, so 01 and 07 never read alike.
 */
const FILL: Readonly<Partial<Record<DealFolder, string>>> = {
  'client-presentations': 'var(--positive-fill)',
  'marketing-materials': 'var(--hold-fill)',
  buyers: 'var(--negative-fill)',
  admin: 'var(--accent-soft)',
  closing: 'var(--surface-subtle)',
};

export const DEAL_FOLDER_COLORS: Readonly<Record<DealFolder, CategoryColor>> = Object.fromEntries(
  DEAL_FOLDERS.map((folder) => [folder, { dot: DOT[folder], fill: FILL[folder] ?? wash(DOT[folder]) }]),
) as Record<DealFolder, CategoryColor>;

const BY_LABEL: ReadonlyMap<string, CategoryColor> = new Map(
  DEAL_FOLDERS.map((folder) => [DEAL_FOLDER_LABELS[folder], DEAL_FOLDER_COLORS[folder]]),
);

/** Colour for a top-level folder by its display label ("04. Buyers"), or null for anything else. */
export function categoryColorForLabel(label: string): CategoryColor | null {
  return BY_LABEL.get(label) ?? null;
}

/** Colour for a stored folder id, or null when the id is not one of the eight. */
export function categoryColorForFolder(folder: string | null | undefined): CategoryColor | null {
  if (!folder) return null;
  return (DEAL_FOLDERS as readonly string[]).includes(folder) ? DEAL_FOLDER_COLORS[folder as DealFolder] : null;
}
