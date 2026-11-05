import { NextResponse } from 'next/server';
import { userCanAccessDeal } from '@/lib/api/v1/access';
import {
  getDocumentViewer,
  parseDocumentRoom,
  userCanListDocument,
  userCanListDocumentName,
  type DocumentGate,
  type DocumentSubject,
} from '@/lib/api/v1/documentAccess';
import { isUuid, jsonError, requireApiUser } from '@/lib/api/v1/http';
import { DOCUMENT_CLASSIFICATION, DOCUMENT_ROOM } from '@/lib/constants/documents';
import { dealNotVisible } from '@/lib/api/v1/dealNotVisible';

type RouteContext = { params: Promise<{ dealId: string }> };

/** Cap one read so a long-lived deal cannot balloon the response; newest rows
 *  win (the register renders newest-first). */
const AUDIT_READ_LIMIT = 500;

/** Detail keys that carry a document's name (upload paths write `fileName`). */
const DOCUMENT_NAME_KEYS = ['name', 'fileName'];

/** A referenced document that no longer resolves is judged as the most
 *  restricted kind (internal room, class 4), so a missing row fails closed. */
const UNKNOWN_DOCUMENT_GATE: DocumentGate = {
  room: DOCUMENT_ROOM.INTERNAL,
  classification: DOCUMENT_CLASSIFICATION.MNPI,
  min_phase: 0,
};

type AuditRow = {
  document_id: string | null;
  detail: Record<string, unknown> | null;
  [key: string]: unknown;
};

/** The document walls applied to the trail (#229): a name the viewer could
 *  not list is redacted, and an internal-room event loses its document_id for
 *  an external viewer, the same lines the document list route draws. */
function redactAuditRow(
  viewer: DocumentSubject,
  row: AuditRow,
  gates: Map<string, DocumentGate>,
): AuditRow {
  if (!row.document_id) return row;
  const gate = gates.get(row.document_id) ?? UNKNOWN_DOCUMENT_GATE;
  const listable = userCanListDocument(viewer, gate);
  if (listable && userCanListDocumentName(viewer, gate)) return row;
  const detail = row.detail
    ? Object.fromEntries(
        Object.entries(row.detail).filter(([key]) => !DOCUMENT_NAME_KEYS.includes(key)),
      )
    : row.detail;
  return { ...row, document_id: listable ? row.document_id : null, detail };
}

/**
 * GET /api/v1/deals/{dealId}/audit — the deal's audit trail, read-side.
 *
 * The append-only audit_log made visible per deal: who did what, when
 * (create, conflicts attestation, seat grants/revokes, CCO notifications,
 * rail advances, document views, legal holds). Any deal member may read it —
 * the trail is a transparency instrument, not a supervisory secret — plus the
 * firm overseers (CCO/admin) via the same predicate that gates every other
 * deal read. Document events pass through the document walls first: names
 * the viewer could not list are redacted (#229). The segment is the deal CODE or UUID (G14); the response carries
 * code + code name only, never the target.
 */
export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { dealId } = await context.params;

  // Resolve the canonical row (code or UUID), then gate on the real id.
  const base = auth.admin.from('deals').select('id, code, codename');
  const { data: deal, error: dealError } = await (isUuid(dealId)
    ? base.eq('id', dealId)
    : base.eq('code', dealId)
  ).maybeSingle();
  if (dealError) return jsonError(dealError.message, 500);
  if (!deal) return jsonError('Deal not found', 404);

  const allowed = await userCanAccessDeal(auth.admin, auth.user.id, deal.id);
  if (!allowed) return dealNotVisible();

  const viewer = await getDocumentViewer(auth.admin, auth.user.id, deal.id);
  if (!viewer) return dealNotVisible();

  const { data: events, error: eventsError } = await auth.admin
    .from('audit_log')
    .select(
      'id, ts, action, document_id, detail, actor:users(id, full_name, display_name)',
    )
    .eq('deal_id', deal.id)
    .order('ts', { ascending: false })
    .limit(AUDIT_READ_LIMIT);
  if (eventsError) return jsonError(eventsError.message, 500);

  const rows = (events ?? []) as AuditRow[];
  // One read for every document the trail references, never one per event.
  const documentIds = [
    ...new Set(rows.flatMap((row) => (row.document_id ? [row.document_id] : []))),
  ];
  const gates = new Map<string, DocumentGate>();
  if (documentIds.length > 0) {
    const { data: documents, error: documentsError } = await auth.admin
      .from('documents')
      .select('id, room, classification, min_phase')
      .in('id', documentIds);
    if (documentsError) return jsonError(documentsError.message, 500);
    for (const doc of documents ?? []) {
      const room = parseDocumentRoom(doc.room);
      if (room) {
        gates.set(doc.id, {
          room,
          classification: doc.classification,
          min_phase: doc.min_phase,
        });
      }
    }
  }

  return NextResponse.json({
    deal: { id: deal.id, code: deal.code, codename: deal.codename },
    events: rows.map((row) => redactAuditRow(viewer, row, gates)),
  });
}
