export const PALETTE_STORAGE_KEY = 'ib-color-palette';
export const STYLE_MODE_STORAGE_KEY = 'ib-style-mode';

export const PALETTES = [
  { id: 'workbench', label: 'Workbench' },
  { id: 'navy', label: 'Navy Gray White' },
  { id: 'gold-navy', label: 'Gold Navy' },
  { id: 'mono', label: 'Black White Luxe' },
  { id: 'navy-orange', label: 'Navy Orange' },
  { id: 'conductia', label: 'Conductia' },
] as const;

export type PaletteId = (typeof PALETTES)[number]['id'];
export const STYLE_MODES = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
] as const;

export type StyleModeId = (typeof STYLE_MODES)[number]['id'];

const PALETTE_ID_SET = new Set<PaletteId>(PALETTES.map((palette) => palette.id));
const STYLE_MODE_ID_SET = new Set<StyleModeId>(STYLE_MODES.map((mode) => mode.id));
const LEGACY_PALETTE_ID_MAP: Record<string, PaletteId> = {
  emerald: 'navy-orange',
};

export function isPaletteId(value: string): value is PaletteId {
  return PALETTE_ID_SET.has(value as PaletteId);
}

export function readStoredPalette(storage: Storage): PaletteId {
  const raw = storage.getItem(PALETTE_STORAGE_KEY);
  if (raw && isPaletteId(raw)) return raw;
  if (raw && raw in LEGACY_PALETTE_ID_MAP) return LEGACY_PALETTE_ID_MAP[raw];
  return 'workbench';
}

export function isStyleModeId(value: string): value is StyleModeId {
  return STYLE_MODE_ID_SET.has(value as StyleModeId);
}

export function readStoredStyleMode(storage: Storage): StyleModeId {
  const raw = storage.getItem(STYLE_MODE_STORAGE_KEY);
  return raw && isStyleModeId(raw) ? raw : 'light';
}

export function applyPaletteToDocument(
  palette: PaletteId,
  root: HTMLElement = document.documentElement,
) {
  root.setAttribute('data-palette', palette);
}

export function applyStyleModeToDocument(
  mode: StyleModeId,
  root: HTMLElement = document.documentElement,
) {
  root.setAttribute('data-style-mode', mode);
}
