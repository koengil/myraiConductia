import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { MD_BRIEFING_STEP_ID } from '@/lib/ignatious/config';
import type { TriggerClaims } from '@/lib/ignatious/jwt';
import { fileBytesToStepDataroom } from '@/lib/dataroom/fileToStep';
import { loadDealByIdOrCode } from '@/lib/dataroom/steps';
import {
  documentSummary,
  LEAD_DOCUMENT_PAGE_MAX,
  listLeadDocuments,
  persistLeadDocument,
} from '@/lib/conductia/documents';
import { requireConductiaLead } from '@/lib/conductia/route';
import { SCOPE } from '@/lib/conductia/scopes';
import { conductiaError } from '@/lib/conductia/errors';
import { errorCodeOf } from '@/lib/errors/upstream';

type RouteContext = { params: Promise<{ leadId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { leadId } = await context.params;
  const gate = await requireConductiaLead(request, leadId, SCOPE.DOCUMENTS_READ);
  if (!gate.ok) return gate.response;

  const query = new URL(request.url).searchParams;
  const limit = wholeNumber(query.get('limit') ?? String(LEAD_DOCUMENT_PAGE_MAX));
  if (limit === null || limit < 1 || limit > LEAD_DOCUMENT_PAGE_MAX) {
    return conductiaError(
      'validation',
      `limit must be a whole number from 1 to ${LEAD_DOCUMENT_PAGE_MAX}`,
      400,
    );
  }
  const offset = wholeNumber(query.get('cursor') ?? '0');
  if (offset === null) {
    return conductiaError('validation', 'cursor is not one this server issued', 400);
  }

  let page;
  try {
    page = await listLeadDocuments(gate.admin, leadId, { limit, offset });
  } catch (error) {
    // PL-07 (#199): a storage failure is an error, never an empty or stale list.
    return conductiaError('server_error', `Document list failed (${errorCodeOf(error)})`, 500);
  }

  return NextResponse.json({
    documents: page.documents.map((doc) =>
      documentSummary(doc, gate.scope.agentName, gate.scope.runId),
    ),
    nextCursor: page.nextOffset === null ? null : String(page.nextOffset),
  });
}

function wholeNumber(value: string): number | null {
  return /^\d{1,9}$/.test(value) ? Number(value) : null;
}

export async function POST(request: Request, context: RouteContext) {
  const { leadId } = await context.params;
  const gate = await requireConductiaLead(request, leadId, SCOPE.DOCUMENTS_WRITE);
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return conductiaError('validation', 'Invalid JSON body', 400);
  }

  const title =
    typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Filed document';
  const text = decodeText(body);
  let filed;
  try {
    filed = await persistLeadDocument(gate.admin, {
      tenantId: gate.scope.tenantId,
      leadId,
      title,
      documentType: String(body.documentType ?? 'other'),
      folder: String(body.folder ?? 'md-brief'),
      text,
      originalFilename: typeof body.originalFilename === 'string' ? body.originalFilename : null,
    });
  } catch (error) {
    // PL-07 (#199): the agent must learn the filing was not saved, so no receipt.
    return conductiaError('server_error', `Document filing failed (${errorCodeOf(error)})`, 500);
  }

  const bytes = decodeBase64(body.contentBase64);
  if (bytes) {
    try {
      const deal = await loadDealByIdOrCode(gate.admin, leadId);
      // Both the filing actor and the rail step come from the signature-verified
      // claims only; an unverified token files to MD Briefing as the mandate owner.
      const claims = gate.scope.claims;
      const actorId = await resolveFilingActor(gate.admin, claims, deal?.id ?? null);
      if (deal && actorId) {
        const fileName =
          (typeof body.originalFilename === 'string' && body.originalFilename.trim()) ||
          `${title.replace(/[/\\]/g, '-')}.docx`;
        await fileBytesToStepDataroom({
          admin: gate.admin,
          dealId: deal.id,
          dealCode: deal.code,
          stepId: claims?.stepId ?? MD_BRIEFING_STEP_ID,
          stepTitle: claims?.stepTitle,
          fileName,
          bytes,
          uploadedBy: actorId,
          stepSkillRunId: gate.scope.runId,
          auditDetail: {
            source: 'ignatious',
            agent: gate.scope.agentName,
            runId: gate.scope.runId,
            documentType: filed.documentType,
          },
        });
      }
    } catch (error) {
      return conductiaError('server_error', `Dataroom storage failed (${errorCodeOf(error)})`, 500);
    }
  }

  return NextResponse.json({
    documentId: filed.documentId,
    outcome: filed.version === 1 ? 'created' : 'version_added',
    version: filed.version,
    folder: filed.folder,
    documentType: filed.documentType,
    filedAt: filed.uploadedAt,
  });
}

function decodeText(body: Record<string, unknown>): string | null {
  if (typeof body.text === 'string' && body.text.trim()) return body.text;
  if (typeof body.canonicalText === 'string' && body.canonicalText.trim()) return body.canonicalText;
  const bytes = decodeBase64(body.contentBase64);
  if (!bytes) return null;
  const mime = typeof body.mimeType === 'string' ? body.mimeType : '';
  if (mime.startsWith('text/') || mime === '' || mime === 'application/json') {
    return bytes.toString('utf8');
  }
  return null;
}

function decodeBase64(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const buffer = Buffer.from(value, 'base64');
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}

/** Whether this user is on this deal. A failed read denies. */
async function isDealMember(
  admin: SupabaseClient,
  dealId: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from('deal_memberships')
    .select('id')
    .eq('deal_id', dealId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) return false;
  return Boolean(data?.id);
}

/**
 * Who this filing is recorded as.
 *
 * `audit_log.actor_id` is the compliance record, so it may only ever name a
 * user the request actually proved. The claims passed here come from a
 * SIGNATURE-VERIFIED token and are null otherwise, and even then the named
 * user must be on this deal. Anything unproven falls through to the deal's
 * mandate owner, which is read from the database rather than the request.
 *
 * Before the seam verified signatures this read the header directly, so a
 * forged token could name anyone as the actor on a filing.
 */
async function resolveFilingActor(
  admin: SupabaseClient,
  claims: TriggerClaims | null,
  dealId: string | null,
): Promise<string | null> {
  if (claims && dealId) {
    if (claims.userId && (await isDealMember(admin, dealId, claims.userId))) {
      return claims.userId;
    }
    if (claims.userEmail) {
      const { data } = await admin
        .from('users')
        .select('id')
        .eq('email', claims.userEmail)
        .maybeSingle();
      const id = data?.id as string | undefined;
      if (id && (await isDealMember(admin, dealId, id))) return id;
    }
  }
  if (!dealId) return null;
  const { data: deal } = await admin
    .from('deals')
    .select('mandate_owner_id')
    .eq('id', dealId)
    .maybeSingle();
  return (deal?.mandate_owner_id as string | null) ?? null;
}
