import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';

import { validateRules } from '@/lib/discovery/exclusion/validate';

import { DEMO_POLICY_REQUESTED_BY, ensureDemoExclusionPolicy, readDemoPolicyRules } from '../../scripts/discovery/lib/demoPolicy';

/*
 * The demo replay seed's exclusion policy (cdt-261-demo-gmail D4) against a REAL database: the first call writes
 * version 1 through discovery_exclusion_policy_set with one audit row, a repeat writes nothing, and changed rules
 * write the next version with the current one as expected_version. A throwaway tenant: policy rows are append-only,
 * so nothing is cleaned up (the audit rows stay as well).
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!url || !secret) throw new Error('needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY (local stack)');
const db = createClient(url, secret, { auth: { persistSession: false } });
const TENANT = crypto.randomUUID();

async function versions() {
  const { data, error } = await db.from('discovery_exclusion_policies').select('version, requested_by').eq('tenant_id', TENANT).order('version');
  if (error) throw error;
  return data ?? [];
}
async function audits() {
  const { data, error } = await db.from('audit_log').select('detail').eq('tenant_id', TENANT).eq('action', 'discovery.exclusion_policy_changed');
  if (error) throw error;
  return data ?? [];
}

describe('ensureDemoExclusionPolicy', () => {
  it('reads the committed demo rules', () => {
    expect(readDemoPolicyRules()).toEqual([]);
  });

  it('writes version 1 once, audited, then nothing on a repeat', async () => {
    expect(await ensureDemoExclusionPolicy(db, TENANT, [])).toEqual({ version: 1, written: true });
    expect(await ensureDemoExclusionPolicy(db, TENANT, [])).toEqual({ version: 1, written: false });
    expect(await versions()).toEqual([{ version: 1, requested_by: DEMO_POLICY_REQUESTED_BY }]);
    expect(await audits()).toHaveLength(1);
  });

  it('writes the next version when the rules change, keyed on the current one', async () => {
    const parsed = validateRules([
      { id: 'demo-domain', category: 'privileged', scope: 'message', kind: 'participant_domain', domains: ['counsel.example'] },
    ]);
    if (!parsed.ok) throw new Error(`fixture rule must validate: ${parsed.errors.join('; ')}`);
    expect(await ensureDemoExclusionPolicy(db, TENANT, parsed.rules)).toEqual({ version: 2, written: true });
    expect(await ensureDemoExclusionPolicy(db, TENANT, parsed.rules)).toEqual({ version: 2, written: false });
    expect(await audits()).toHaveLength(2);
  });
});
