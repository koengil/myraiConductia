import { redirect } from 'next/navigation';

import { ProjectDashboard } from '@/components/workspace/ProjectDashboard';
import { WelcomeBrief } from '@/components/onboarding/WelcomeBrief';
import { perimeterForViewer } from '@/lib/perimeter/perimeter';

import { resolveProjectId } from '@/lib/project/resolveProjectId';
import { getShellIdentity } from '@/lib/perspective/serverIdentity';
import { isEnabled } from '@/lib/flags/isEnabled';
import { supabaseFlagSource } from '@/lib/flags/supabaseSource';
import { createSupabaseAdminClient } from '@/lib/supabase/server';
import { resolveDealRef } from '@/lib/api/v1/http';

export const dynamic = 'force-dynamic';

/**
 * Deal index (/projects/[projectId]).
 *
 * Internal users: the per-deal dashboard (ProjectDashboard, PR #123) — live
 * vitals and quick links; Command Center (/projects) stays the multi-deal
 * home and the rail stays the execution surface.
 *
 * External users (platform_onboarding): this page IS the Deal destination of
 * the scoped shell (spec-v3 criterion 11, cr-prr-124 1.2) — the rail is not
 * in their destination set, so redirecting there would cycle against the
 * AppShell guard. Membership is checked before any deal data renders; the
 * shell's nav gating is presentation, this check is the page's own wall.
 */
export default async function ProjectHomePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId: rawProjectId } = await params;
  const projectId = resolveProjectId(rawProjectId);

  if (await isEnabled('platform_onboarding', supabaseFlagSource)) {
    const identity = await getShellIdentity();
    if (identity?.isExternal) {
      return externalDealHome(identity.userId, projectId);
    }
  }

  return <ProjectDashboard />;
}

async function externalDealHome(userId: string, projectId: string) {
  const admin = createSupabaseAdminClient();

  // The URL segment is the human-readable deal code (or a UUID from older
  // links); resolve the deal row first, then check the seat by its UUID.
  const dealRef = await resolveDealRef(admin, projectId);
  if (!dealRef) redirect('/projects');

  const { data: seat } = await admin
    .from('deal_memberships')
    .select('deal_role, phase')
    .eq('deal_id', dealRef.id)
    .eq('user_id', userId)
    .maybeSingle();
  if (!seat) redirect('/projects');

  const { data: deal } = await admin
    .from('deals')
    .select('id, code, codename, status')
    .eq('id', dealRef.id)
    .maybeSingle();
  if (!deal) redirect('/projects');

  // The viewer's own company only. Criterion C10 forbids surfacing any other
  // company's roster here, so this page never reads one.
  const { data: profile } = await admin
    .from('users')
    .select('company_id')
    .eq('id', userId)
    .maybeSingle();
  const { data: company } = profile?.company_id
    ? await admin.from('companies').select('name').eq('id', profile.company_id).maybeSingle()
    : { data: null };

  // Recomputed on every render, so a phase raise or a new release is reflected
  // on the next visit without anything being invalidated (C1, C3).
  const outcome = await perimeterForViewer(admin, userId, dealRef.id);

  return (
    <div className="mx-auto max-w-[720px] px-[var(--page-pad)] py-[var(--space-8)]">
      <WelcomeBrief
        perimeter={outcome.ok ? outcome.perimeter : null}
        projectId={projectId}
        deal={{
          code: String(deal.code),
          codename: String(deal.codename),
          status: String(deal.status),
        }}
        companyName={company?.name ? String(company.name) : 'your firm'}
        dealRole={seat.deal_role ?? null}
        phase={Number(seat.phase ?? 0)}
      />
    </div>
  );
}
