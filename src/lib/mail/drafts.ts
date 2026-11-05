/**
 * Local draft persistence for the mail composer. Drafts live in localStorage
 * only (this machine, this browser) — a server-side drafts table is a later
 * slice. Sending or discarding a draft removes it.
 *
 * Drafts are keyed PER PROJECT (the `scope` is the project URL segment), so a
 * draft started inside one deal never surfaces in another. Pre-scoping drafts
 * under the legacy unscoped key are intentionally left where they are.
 */

export type MailDraft = {
  id: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  bodyHtml: string;
  updatedAt: string;
};

const KEY = 'conductia.mail.drafts';

function storageKey(scope?: string | null): string {
  return scope ? `${KEY}:${scope}` : KEY;
}

function read(scope?: string | null): MailDraft[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(storageKey(scope));
    const list = raw ? (JSON.parse(raw) as MailDraft[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list: MailDraft[], scope?: string | null) {
  try {
    localStorage.setItem(storageKey(scope), JSON.stringify(list));
  } catch {
    // Storage full or unavailable — drafts silently stop persisting.
  }
}

export function listDrafts(scope?: string | null): MailDraft[] {
  return read(scope).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function saveDraft(draft: MailDraft, scope?: string | null) {
  const rest = read(scope).filter((d) => d.id !== draft.id);
  write([...rest, draft], scope);
}

export function deleteDraft(id: string, scope?: string | null) {
  write(read(scope).filter((d) => d.id !== id), scope);
}

export function newDraftId(): string {
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function clearAllDrafts() {
  if (typeof localStorage === 'undefined') return;
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i);
    if (k === KEY || k?.startsWith(`${KEY}:`)) keys.push(k);
  }
  keys.forEach((k) => localStorage.removeItem(k));
}
