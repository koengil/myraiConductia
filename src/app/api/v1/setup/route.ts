import { NextResponse } from 'next/server';
import { jsonError, requireApiUser } from '@/lib/api/v1/http';
import { isFlagEnabled, requireFlag } from '@/lib/api/v1/requireFlag';
import {
  parseSetupProgress,
  resolveSetupActor,
  type SetupProgress,
} from '@/lib/api/v1/setupWalkthroughs';
import { isBoxConfigured } from '@/lib/box/types';
import {
  SETUP_WALKTHROUGH_CONTENT_VERSION,
  SETUP_WALKTHROUGHS,
} from '@/lib/constants/setupWalkthroughs';
import { graphConfigured } from '@/lib/email/graph';
import { resolveStorageProvider } from '@/lib/storage';
import { TABLE } from '@/lib/constants/tables';

type ProgressRow = {
  track: unknown;
  content_version: unknown;
  revision: unknown;
  completed_steps: unknown;
  completed_at: unknown;
};

export async function GET() {
  const gate = await requireFlag('setup_walkthroughs');
  if (gate) return gate;

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  const setupActor = await resolveSetupActor(auth.admin, auth.user.id);
  if (!setupActor.ok) {
    return jsonError(
      setupActor.reason === 'not_eligible' ? 'Setup is not available' : 'Unable to resolve setup access',
      setupActor.reason === 'not_eligible' ? 403 : 503,
    );
  }

  const { data: rawProgress, error: progressError } = await auth.admin
    .from(TABLE.SETUP_WALKTHROUGH_PROGRESS)
    .select('track, content_version, revision, completed_steps, completed_at')
    .eq('user_id', auth.user.id)
    .eq('content_version', SETUP_WALKTHROUGH_CONTENT_VERSION);
  if (progressError) return jsonError('Unable to load setup progress', 500);

  const progress = new Map<string, SetupProgress>();
  for (const raw of (rawProgress ?? []) as ProgressRow[]) {
    const parsed = parseSetupProgress(raw);
    if (!parsed) return jsonError('Unable to load setup progress', 500);
    progress.set(parsed.track, parsed);
  }

  const integrationEligible = !setupActor.actor.isExternal;
  const mailEnabled = integrationEligible && (await isFlagEnabled('mail_channel'));
  const microsoftConfigured = mailEnabled && graphConfigured();
  let mailbox: { email: string; connected_at: string } | null = null;
  if (integrationEligible && microsoftConfigured) {
    const { data, error } = await auth.admin
      .from('mailbox_connections')
      .select('email, connected_at')
      .eq('user_id', auth.user.id)
      .eq('provider', 'microsoft')
      .maybeSingle();
    if (error) return jsonError('Unable to load mailbox status', 500);
    mailbox = data as { email: string; connected_at: string } | null;
  }

  const boxConfigured = integrationEligible && isBoxConfigured();
  const walkthroughs = setupActor.tracks.map((track) => {
    const definition = SETUP_WALKTHROUGHS[track];
    const stored = progress.get(track);
    return {
      track,
      content_version: SETUP_WALKTHROUGH_CONTENT_VERSION,
      revision: stored?.revision ?? 0,
      title: definition.title,
      description: definition.description,
      completed_step_ids: stored?.completed_steps ?? [],
      completed_at: stored?.completed_at ?? null,
      steps: definition.steps,
    };
  });

  return NextResponse.json({
    integrations: {
      microsoft_365: {
        eligible: integrationEligible,
        configured: microsoftConfigured,
        connected: Boolean(mailbox),
        email: mailbox?.email ?? null,
        connected_at: mailbox?.connected_at ?? null,
        connect_url: '/api/v1/mailbox/connect?next=/setup',
      },
      box: {
        eligible: integrationEligible,
        configured: boxConfigured,
        active: boxConfigured && resolveStorageProvider() === 'box',
      },
    },
    walkthroughs,
    training_notice:
      'These walkthroughs explain Conductia controls. They do not replace employer, legal, or regulatory training.',
  });
}
