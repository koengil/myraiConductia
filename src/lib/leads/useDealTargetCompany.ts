'use client';

import * as React from 'react';

import { useFlag } from '@/lib/flags/FlagsContext';
import { overlayFixtureDealFields, resolveDeal } from '@/lib/rail/deals';

type TargetCompanyState =
  | { status: 'loading' }
  | { status: 'ready'; companyId: string; companyName: string }
  | { status: 'none'; reason: string }
  | { status: 'error' };

type ApiParty = {
  party_role?: string;
  company?: { id?: string; name?: string } | { id?: string; name?: string }[] | null;
};

/**
 * Resolve the lead/target company for a deal so Relationship Pathing can read
 * the persisted stakeholder and relationship maps.
 */
export function useDealTargetCompany(dealId: string): TargetCompanyState {
  const apiEnabled = useFlag('gate0_api_create');
  const fixture = React.useMemo(() => {
    const deal = resolveDeal(dealId);
    return deal ? overlayFixtureDealFields(deal) : null;
  }, [dealId]);

  const [state, setState] = React.useState<TargetCompanyState>(() => {
    if (fixture?.targetCompanyId) {
      return {
        status: 'ready',
        companyId: fixture.targetCompanyId,
        companyName: fixture.target,
      };
    }
    return { status: 'loading' };
  });

  React.useEffect(() => {
    if (fixture?.targetCompanyId) return;

    if (!apiEnabled) {
      queueMicrotask(() => {
        setState({
          status: 'none',
          reason:
            'This deal has no linked lead company. Register the target on Leads and create the mandate from that lead.',
        });
      });
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const res = await fetch(`/api/v1/deals/${encodeURIComponent(dealId)}`, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`deal: ${res.status}`);
        const body = (await res.json()) as { parties?: ApiParty[] };
        const target = (body.parties ?? []).find((p) => p.party_role === 'target');
        const rawCompany = target?.company;
        const company = Array.isArray(rawCompany) ? rawCompany[0] : rawCompany;
        const companyId = company?.id?.trim();
        const companyName = company?.name?.trim() ?? fixture?.target ?? '';

        if (cancelled) return;
        if (!companyId) {
          setState({
            status: 'none',
            reason:
              'No target company is linked to this deal. Register the lead on Leads first, then open the mandate from that lead.',
          });
          return;
        }
        setState({ status: 'ready', companyId, companyName });
      } catch {
        if (cancelled) return;
        setState({ status: 'error' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiEnabled, dealId, fixture?.target, fixture?.targetCompanyId]);

  return state;
}
