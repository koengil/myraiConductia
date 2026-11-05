import { notFound } from 'next/navigation';

import { CandidateDetailView } from '@/components/discovery/CandidateDetailView';
import { isUuid } from '@/lib/api/v1/http';
import { FIRM_ROLE } from '@/lib/constants/roles';
import { isEnabled } from '@/lib/flags/isEnabled';
import { supabaseFlagSource } from '@/lib/flags/supabaseSource';

import { DiscoveryUnavailable } from '../DiscoveryUnavailable';
import { currentViewer } from '../viewer';

export const dynamic = 'force-dynamic';

/**
 * /discovery/{candidateId}: one proposed deal, with the step the evidence
 * suggests, why, and the mail it rests on. The same gates as /discovery: behind
 * `deal_discovery`, and an external party gets the same "not available"
 * statement (#395). Unlike /discovery, a firm admin (who sees connector health,
 * never a candidate, Q19) gets a 404 here. Whether this viewer may see this
 * candidate is the data route's RLS read, not this page's.
 */
export default async function CandidatePage({ params }: { params: Promise<{ candidateId: string }> }) {
  if (!(await isEnabled('deal_discovery', supabaseFlagSource))) notFound();
  const viewer = await currentViewer();
  if (!viewer) notFound();
  if (viewer.isExternal) return <DiscoveryUnavailable />;
  if (viewer.firmRole === FIRM_ROLE.ADMIN) notFound();
  const { candidateId } = await params;
  if (!isUuid(candidateId)) notFound();

  return (
    <div className="min-h-full w-full bg-[var(--surface-warm)]">
      <CandidateDetailView candidateId={candidateId} />
    </div>
  );
}
