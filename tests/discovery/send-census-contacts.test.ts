import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { loadDealContacts } from '@/lib/discovery/sendCensus/load';

describe('loadDealContacts', () => {
  it('normalizes only address and domain rows', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [
      { kind: 'address', value: ' PERSON@BUYER.EXAMPLE ' },
      { kind: 'domain', value: 'TARGET.EXAMPLE' },
      { kind: 'unknown', value: 'ignored' },
      { kind: 'address', value: null },
    ], error: null });
    const onError = vi.fn();
    const contacts = await loadDealContacts({ rpc } as unknown as SupabaseClient, 'tenant', onError);
    expect(rpc).toHaveBeenCalledWith('send_census_deal_contacts', { p_tenant: 'tenant' });
    expect(contacts).toEqual({ addresses: new Set(['person@buyer.example']), domains: ['target.example'] });
    expect(onError).not.toHaveBeenCalled();
  });

  it('leaves sends unclassified after a lookup failure and reports only its code', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: 'XX000', message: 'private address' } });
    const onError = vi.fn();
    expect(await loadDealContacts({ rpc } as unknown as SupabaseClient, 'tenant', onError)).toBeUndefined();
    expect(onError).toHaveBeenCalledWith('XX000');
  });
});
