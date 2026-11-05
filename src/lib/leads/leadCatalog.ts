import { COMPANY_TYPE } from '@/lib/constants/companies';
import type { SearchableCompany } from '@/lib/rail/deals';

export type LeadCatalogState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; leads: SearchableCompany[] }
  | { status: 'error' };

let cache: LeadCatalogState = { status: 'idle' };
let inflight: Promise<LeadCatalogState> | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function getLeadCatalogState(): LeadCatalogState {
  return cache;
}

export function subscribeLeadCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Drop cached leads (e.g. after registering a new lead elsewhere). */
export function invalidateLeadCatalog() {
  cache = { status: 'idle' };
  inflight = null;
  notify();
}

export function prefetchLeadCatalog(): Promise<LeadCatalogState> {
  const warm = cache.status === 'ready' ? cache : null;

  if (!inflight) {
    if (!warm) {
      cache = { status: 'loading' };
      notify();
    }

    inflight = fetch(`/api/v1/companies?type=${COMPANY_TYPE.CLIENT}`, {
      headers: { Accept: 'application/json' },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`companies: ${res.status}`);
        const data = (await res.json()) as { companies?: Array<{ id: string; name: string }> };
        const leads = (data.companies ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          sector: '',
        }));
        cache = { status: 'ready', leads };
        return cache;
      })
      .catch(() => {
        cache = warm ?? { status: 'error' };
        return cache;
      })
      .finally(() => {
        inflight = null;
        notify();
      });
  }

  return warm ? Promise.resolve(warm) : inflight;
}

/** Opens the new-mandate dialog and starts the lead catalog fetch immediately. */
export function openNewMandateDialog(setOpen: (open: boolean) => void) {
  void prefetchLeadCatalog();
  setOpen(true);
}
