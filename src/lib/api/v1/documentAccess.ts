import type { SupabaseClient } from '@supabase/supabase-js';
import { DEAL_ROLE, FIRM_ROLE } from '@/lib/constants/roles';
import { DOCUMENT_ROOM, DOCUMENT_CLASSIFICATION, type DocumentRoom } from '@/lib/constants/documents';

/** Mirrors roles.permissions document:read:classN ceilings in the seed migration. */
const DEAL_ROLE_READ_CLASSIFICATION_CEILING: Partial<Record<string, number>> = {
  [DEAL_ROLE.DEAL_TEAM]: DOCUMENT_CLASSIFICATION.CONFIDENTIAL,
  [DEAL_ROLE.LEGAL]: DOCUMENT_CLASSIFICATION.CONFIDENTIAL,
  [DEAL_ROLE.READ_ONLY]: DOCUMENT_CLASSIFICATION.INTERNAL,
  [DEAL_ROLE.SELLER]: DOCUMENT_CLASSIFICATION.CONFIDENTIAL,
};

function maxReadableClassification(viewer: DocumentSubject): number | null {
  if (viewer.hasOversight || viewer.dealRole === DEAL_ROLE.MD) return null;
  if (!viewer.dealRole) return null;
  return DEAL_ROLE_READ_CLASSIFICATION_CEILING[viewer.dealRole] ?? null;
}

/**
 * The document wall (spec-v3 criteria 7–8). Every document path — list, view,
 * upload, download — runs through these predicates. Handlers hold service-role
 * clients, so this module IS the enforcement point; there is no RLS to fall
 * back on (ADR-0008 belt-over-suspenders, cr-plan-v2 5.2).
 *
 * Order of checks is load-bearing: the internal-room exclusion for external
 * users comes BEFORE phase or classification are even consulted.
 */

/**
 * What the wall decides ABOUT — identity-free, so the same predicates can be
 * asked about a real viewer or a *proposed* one (plan-v5 §1). The perimeter
 * preview relies on this: it feeds these predicates a subject that does not
 * exist yet, which is what makes "what they'll see" identical to what they
 * see, by construction rather than by discipline.
 */
export type DocumentSubject = {
  isExternal: boolean;
  /** Firm-level oversight (cco) or platform admin. */
  hasOversight: boolean;
  /** Deal seat, null when the user has no membership on this deal. */
  dealRole: string | null;
  /** Disclosure phase of the seat (external staging). */
  phase: number;
};

/** A subject that is a real, resolved user. */
export type DocumentViewer = DocumentSubject & {
  userId: string;
};

export type DocumentGate = {
  room: DocumentRoom;
  classification: number;
  min_phase: number;
};

/**
 * Decode a stored room value. `userCanOpenDocument` only special-cases the
 * internal room, so an unrecognized value would fall through its walls and be
 * treated as visible. The DB CHECK constraint means such a row should not
 * exist; this keeps that a fact rather than an assumption, at the decode
 * boundary instead of by loosening the predicate (cr-plan-v3 5.3).
 */
export function parseDocumentRoom(value: unknown): DocumentRoom | null {
  return value === DOCUMENT_ROOM.INTERNAL || value === DOCUMENT_ROOM.DEAL
    ? (value as DocumentRoom)
    : null;
}

export async function getDocumentViewer(
  admin: SupabaseClient,
  userId: string,
  dealId: string,
): Promise<DocumentViewer | null> {
  const [{ data: profile }, { data: membership }] = await Promise.all([
    admin.from('users').select('is_external, firm_role').eq('id', userId).maybeSingle(),
    admin
      .from('deal_memberships')
      .select('deal_role, phase')
      .eq('deal_id', dealId)
      .eq('user_id', userId)
      .maybeSingle(),
  ]);
  if (!profile) return null;

  // hasOversight is tenant-blind: it reads firm_role only, so a cco/admin of
  // ANY tenant gets it. That is safe only because every caller runs the
  // tenant-scoped userCanAccessDeal (access.ts) first. Never call this without
  // that gate. The RLS twin folds the tenant in (app_is_deal_overseer, #78).
  const hasOversight =
    profile.firm_role === FIRM_ROLE.CCO || profile.firm_role === FIRM_ROLE.ADMIN;
  if (!membership && !hasOversight) return null;

  return {
    userId,
    isExternal: Boolean(profile.is_external),
    hasOversight,
    dealRole: membership?.deal_role ?? null,
    phase: membership?.phase ?? 0,
  };
}

/** Filename/metadata visibility in the dataroom index. Deal-room names are
 *  visible to every deal member; internal-room names never cross to externals. */
export function userCanListDocument(viewer: DocumentSubject, doc: DocumentGate): boolean {
  if (doc.room === DOCUMENT_ROOM.INTERNAL && viewer.isExternal) return false;
  return true;
}

/** Whether the document's NAME may be shown at all. A class-4 (MNPI) title can
 *  itself be MNPI, so it is visible only to the deal MD and oversight, the same
 *  test as wall 2 below (D1 = B). Mirrors the class-4 conjunct of RLS
 *  documents_select (20260928120000). Callers still apply userCanListDocument
 *  for the room wall. */
export function userCanListDocumentName(viewer: DocumentSubject, doc: DocumentGate): boolean {
  if (doc.classification >= DOCUMENT_CLASSIFICATION.MNPI) {
    const isMd = viewer.dealRole === DEAL_ROLE.MD;
    if (!isMd && !viewer.hasOversight) return false;
  }
  return true;
}

/** Open, download, or view bytes — full room / classification / phase wall. */
export function userCanOpenDocument(viewer: DocumentSubject, doc: DocumentGate): boolean {
  if (!userCanListDocument(viewer, doc)) return false;

  // Wall 2 — MNPI (classification 4) is md/cco only.
  if (!userCanListDocumentName(viewer, doc)) return false;

  // Wall 2b — per-seat classification ceiling (deal_team/legal class 1-3,
  // read_only class 1-2). Buyers remain phase-gated only.
  const classificationCeiling = maxReadableClassification(viewer);
  if (classificationCeiling !== null && doc.classification > classificationCeiling) {
    return false;
  }

  // Wall 3 — phased disclosure gates EXTERNAL viewers; internal staff work
  // the deal at every phase.
  if (viewer.isExternal && doc.min_phase > viewer.phase) return false;

  return true;
}

/** @alias userCanOpenDocument — perimeter preview and develop call sites. */
export const userCanSeeDocument = userCanOpenDocument;

/** Seller uploads are capped below MNPI (roles seed document:upload:class1-3). */
export const SELLER_MAX_CLASSIFICATION = DOCUMENT_CLASSIFICATION.CONFIDENTIAL;

export function userCanUploadDocument(
  viewer: DocumentSubject,
  room: DocumentRoom | string,
  classification: number,
): boolean {
  if (viewer.isExternal) {
    // External uploads: sellers only, deal room only, class 1–3 only.
    if (room !== DOCUMENT_ROOM.DEAL) return false;
    if (viewer.dealRole !== DEAL_ROLE.SELLER) return false;
    return classification <= SELLER_MAX_CLASSIFICATION;
  }
  // Internal staff upload to either room; MNPI stays md/cco-authored.
  if (classification >= DOCUMENT_CLASSIFICATION.MNPI) {
    return viewer.dealRole === DEAL_ROLE.MD || viewer.hasOversight;
  }
  return true;
}
