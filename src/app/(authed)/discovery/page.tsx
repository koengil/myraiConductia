import { notFound } from 'next/navigation';

import { CandidateList } from '@/components/discovery/CandidateList';
import { IngestionHealth } from '@/components/discovery/IngestionHealth';
import { ModelProposals } from '@/components/discovery/ModelProposals';
import { TeamInboxAuditTrail } from '@/components/discovery/TeamInboxAuditTrail';
import { TeamInboxes } from '@/components/discovery/TeamInboxes';
import { FIRM_ROLE } from '@/lib/constants/roles';
import { isEnabled } from '@/lib/flags/isEnabled';
import { supabaseFlagSource } from '@/lib/flags/supabaseSource';

import { DiscoveryUnavailable } from './DiscoveryUnavailable';
import { currentViewer } from './viewer';

export const dynamic = 'force-dynamic';

/**
 * /discovery: tier 2, beside /leads. The deals Conductia proposes from the
 * viewer's own mail. Behind `deal_discovery`, and for the bank side only: an
 * external party, who is never shown the nav link, gets a plain statement that
 * Discovery is not available to them rather than a 404 (#395).
 *
 * Who sees what (Q19): a banker sees the proposed deals their own mail is
 * evidence for; the control room (cco) sees every proposed deal and the
 * connector's health; a firm admin, who runs the connector, sees its health
 * and the team inboxes it manages (#581), never a candidate or a party. The
 * admin and the control room also see the team inbox audit trail of their
 * own firm (#173 G-03). The data routes enforce the same rule;
 * this only chooses what to render.
 */
export default async function DiscoveryPage() {
  if (!(await isEnabled('deal_discovery', supabaseFlagSource))) notFound();
  const viewer = await currentViewer();
  if (!viewer) notFound();
  if (viewer.isExternal) return <DiscoveryUnavailable />;

  const isAdmin = viewer.firmRole === FIRM_ROLE.ADMIN;
  const seesHealth = isAdmin || viewer.firmRole === FIRM_ROLE.CCO;

  return (
    <div className="min-h-full w-full bg-[var(--surface-warm)]">
      <div className="mx-auto max-w-[880px] px-6 py-10">
        <p className="eyebrow mb-1">Discovery</p>
        {isAdmin ? (
          <>
            <h1 className="mb-1 text-[26px] font-semibold leading-tight tracking-[-0.012em] text-[var(--ink)]">
              Ingestion health
            </h1>
            <p className="mb-9 text-[length:var(--text-md)] text-[var(--ink-tertiary)]">
              The connector&apos;s sources, sync state and counts. Proposed deals stay with the bankers whose mail found them.
            </p>
            <IngestionHealth />
            {/* Admin only (#581): the page already limits this branch to the firm admin; the route answers 404 to anyone else. */}
            <div className="mt-8">
              <TeamInboxes />
            </div>
            {/* The firm's team inbox audit trail (#173 G-03); the route answers 404, and it renders nothing, for a firm without one. */}
            <div className="mt-8">
              <TeamInboxAuditTrail />
            </div>
          </>
        ) : (
          <>
            <h1 className="mb-1 text-[26px] font-semibold leading-tight tracking-[-0.012em] text-[var(--ink)]">
              Proposed deals
            </h1>
            <p className="mb-9 text-[length:var(--text-md)] text-[var(--ink-tertiary)]">
              Deals found in your own mail. Each one stays a proposal until it is promoted.
            </p>
            {seesHealth ? (
              <div className="mb-8">
                <IngestionHealth />
              </div>
            ) : null}
            {/* The control room only (#173 G-03): the firm's team inbox audit trail, under Ingestion health. */}
            {viewer.firmRole === FIRM_ROLE.CCO ? (
              <div className="mb-8">
                <TeamInboxAuditTrail />
              </div>
            ) : null}
            <CandidateList />
            {/* Demo only (#460): model proposals, below the rules-found list; renders nothing unless its flag is on. */}
            <ModelProposals />
          </>
        )}
      </div>
    </div>
  );
}
