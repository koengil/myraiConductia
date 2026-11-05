import { NextResponse } from 'next/server';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { requireFlag } from '@/lib/api/v1/requireFlag';
import { parseSetupProgress, resolveSetupActor } from '@/lib/api/v1/setupWalkthroughs';
import {
  isSetupWalkthroughTrack,
  normalizeSetupWalkthroughSteps,
  SETUP_WALKTHROUGH_CONTENT_VERSION,
} from '@/lib/constants/setupWalkthroughs';

type RouteContext = { params: Promise<{ track: string }> };

const ALLOWED_FIELDS = new Set(['contentVersion', 'expectedRevision', 'completedStepIds']);

function databaseErrorResponse(error: { message?: string }): NextResponse {
  const message = error.message ?? '';
  if (message.includes('invalid_walkthrough')) {
    return jsonError('Invalid walkthrough progress', 400);
  }
  if (
    message.includes('administrator_track_not_permitted') ||
    message.includes('actor_not_eligible')
  ) {
    return jsonError('Walkthrough is not available', 403);
  }
  if (message.includes('stale_revision')) {
    return jsonError('Walkthrough progress changed. Reload and try again.', 409);
  }
  if (message.includes('walkthrough_already_completed')) {
    return jsonError('Completed walkthroughs cannot be changed', 409);
  }
  return jsonError('Unable to update walkthrough progress', 500);
}

export async function PATCH(request: Request, context: RouteContext) {
  const gate = await requireFlag('setup_walkthroughs');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const { track: rawTrack } = await context.params;
  if (!isSetupWalkthroughTrack(rawTrack)) return jsonError('Not found', 404);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON body', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError('JSON body must be an object', 400);
  }
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).find((field) => !ALLOWED_FIELDS.has(field));
  if (unknown) return jsonError(`Unknown field: ${unknown}`, 400);
  if (
    record.contentVersion !== SETUP_WALKTHROUGH_CONTENT_VERSION ||
    typeof record.expectedRevision !== 'number' ||
    !Number.isSafeInteger(record.expectedRevision) ||
    record.expectedRevision < 0 ||
    !Array.isArray(record.completedStepIds) ||
    !record.completedStepIds.every((step) => typeof step === 'string')
  ) {
    return jsonError('Invalid walkthrough progress', 400);
  }
  const completedSteps = normalizeSetupWalkthroughSteps(
    rawTrack,
    record.completedStepIds as string[],
  );
  if (!completedSteps) return jsonError('Invalid walkthrough progress', 400);

  const setupActor = await resolveSetupActor(auth.admin, auth.user.id);
  if (!setupActor.ok) {
    return jsonError(
      setupActor.reason === 'not_eligible' ? 'Walkthrough is not available' : 'Unable to resolve setup access',
      setupActor.reason === 'not_eligible' ? 403 : 503,
    );
  }
  if (!setupActor.tracks.includes(rawTrack)) return jsonError('Walkthrough is not available', 403);

  const { data, error } = await auth.admin.rpc('update_setup_walkthrough_progress', {
    p_actor_id: auth.user.id,
    p_track: rawTrack,
    p_content_version: SETUP_WALKTHROUGH_CONTENT_VERSION,
    p_expected_revision: record.expectedRevision,
    p_completed_steps: completedSteps,
  });
  if (error) return databaseErrorResponse(error);

  const progress = parseSetupProgress(data);
  if (!progress) return jsonError('Unable to update walkthrough progress', 500);
  return NextResponse.json({ progress });
}
