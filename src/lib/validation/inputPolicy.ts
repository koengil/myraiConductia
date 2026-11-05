export const DUPLICATE_COMPANY_NAME_CODE = 'duplicate_company_name';

export type PolicyCheck<T> = { ok: true; value: T } | { ok: false; message: string };

export const LEAD_NAME_MIN_LENGTH = 2;
export const LEAD_NAME_MAX_LENGTH = 120;

export const PROFILE_FULL_NAME_MAX_LENGTH = 120;
export const PROFILE_DISPLAY_NAME_MAX_LENGTH = 60;

export const DOCUMENT_NAME_MAX_LENGTH = 200;
export const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;
export const DOCUMENT_MAX_MB = DOCUMENT_MAX_BYTES / (1024 * 1024);

export const DOCUMENT_ALLOWED_EXTENSIONS = [
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'csv',
  'txt',
  'md',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'tif',
  'tiff',
] as const;

export const DOCUMENT_ACCEPT_ATTRIBUTE = DOCUMENT_ALLOWED_EXTENSIONS.map((ext) => `.${ext}`).join(
  ',',
);

export const DEAL_FEE_USD_MAX = 100_000_000_000;
export const DEAL_CLOSE_DATE_MIN_ISO = '2000-01-01';
export const DEAL_CLOSE_DATE_MAX_YEARS_AHEAD = 10;

const DOCUMENT_TYPE_MESSAGE =
  'The data room takes PDF, Office, CSV, text and image files. Convert this one and upload it again.';

export function checkLeadName(raw: unknown): PolicyCheck<string> {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return { ok: false, message: 'Enter a lead name to continue.' };
  if (name.length < LEAD_NAME_MIN_LENGTH) {
    return {
      ok: false,
      message: `A lead name needs at least ${LEAD_NAME_MIN_LENGTH} characters.`,
    };
  }
  if (name.length > LEAD_NAME_MAX_LENGTH) {
    return {
      ok: false,
      message: `A lead name runs to ${LEAD_NAME_MAX_LENGTH} characters at most.`,
    };
  }
  return { ok: true, value: name };
}

export function checkProfileFullName(raw: unknown): PolicyCheck<string> {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return { ok: false, message: 'Enter your full name.' };
  if (name.length > PROFILE_FULL_NAME_MAX_LENGTH) {
    return {
      ok: false,
      message: `A full name runs to ${PROFILE_FULL_NAME_MAX_LENGTH} characters at most.`,
    };
  }
  return { ok: true, value: name };
}

export function checkProfileDisplayName(raw: unknown): PolicyCheck<string | null> {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, message: 'Enter a nickname, or leave it blank.' };
  const name = raw.trim();
  if (!name) return { ok: true, value: null };
  if (name.length > PROFILE_DISPLAY_NAME_MAX_LENGTH) {
    return {
      ok: false,
      message: `A nickname runs to ${PROFILE_DISPLAY_NAME_MAX_LENGTH} characters at most.`,
    };
  }
  return { ok: true, value: name };
}

export function documentExtensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0 || dot === fileName.length - 1) return '';
  return fileName.slice(dot + 1).toLowerCase();
}

export function isAllowedDocumentName(fileName: string): boolean {
  const ext = documentExtensionOf(fileName.trim());
  return (DOCUMENT_ALLOWED_EXTENSIONS as readonly string[]).includes(ext);
}

export function checkDocumentUpload(input: {
  fileName: string;
  displayName?: string;
  sizeBytes: number;
}): PolicyCheck<string> {
  const displayName = (input.displayName ?? input.fileName).trim();
  if (!displayName) return { ok: false, message: 'Name the document before uploading it.' };
  if (displayName.length > DOCUMENT_NAME_MAX_LENGTH) {
    return {
      ok: false,
      message: `A document name runs to ${DOCUMENT_NAME_MAX_LENGTH} characters at most.`,
    };
  }
  if (input.sizeBytes <= 0) return { ok: false, message: 'That file is empty. Upload the document itself.' };
  if (input.sizeBytes > DOCUMENT_MAX_BYTES) {
    return { ok: false, message: `Documents are capped at ${DOCUMENT_MAX_MB} MB.` };
  }
  if (!isAllowedDocumentName(input.fileName)) return { ok: false, message: DOCUMENT_TYPE_MESSAGE };
  if (!isAllowedDocumentName(displayName)) return { ok: false, message: DOCUMENT_TYPE_MESSAGE };
  return { ok: true, value: displayName };
}

export function checkFeeUsd(raw: unknown): PolicyCheck<number | null> {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > DEAL_FEE_USD_MAX) {
    return {
      ok: false,
      message: 'Set the fee as a whole number of US dollars, up to 100 billion.',
    };
  }
  return { ok: true, value: raw };
}

function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function maxTargetCloseDateIso(now: Date = new Date()): string {
  const max = new Date(now.getTime());
  max.setUTCFullYear(max.getUTCFullYear() + DEAL_CLOSE_DATE_MAX_YEARS_AHEAD);
  return max.toISOString().slice(0, 10);
}

export function checkTargetCloseDate(raw: unknown, now: Date = new Date()): PolicyCheck<string | null> {
  if (raw === null) return { ok: true, value: null };
  const latest = maxTargetCloseDateIso(now);
  const outOfRange = {
    ok: false as const,
    message: `Set a target close date between ${DEAL_CLOSE_DATE_MIN_ISO} and ${latest}.`,
  };
  if (typeof raw !== 'string' || !isIsoCalendarDate(raw)) {
    return { ok: false, message: 'Set the target close date as a calendar date.' };
  }
  if (raw < DEAL_CLOSE_DATE_MIN_ISO || raw > latest) return outOfRange;
  return { ok: true, value: raw };
}
