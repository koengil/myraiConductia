/**
 * Seed the dev tenant with the familiar demo companies as LEADS (type=client),
 * so the Gate 0 lead selector is populated when the `gate0_api_create` flag is
 * on. Idempotent: matches names case-insensitively (respecting the
 * (tenant_id, lower(name)) unique index), so re-running never duplicates.
 *
 * Run: npm run seed:leads   (node --env-file=.env.local --import tsx ...)
 *
 * Note: the `companies` table holds only name + type + tenant_id — the
 * relationship/stakeholder CRM fields on the /leads form are visualization-only
 * and do not persist yet, so there is no richer "fake data" to seed here.
 */
import { createClient } from '@supabase/supabase-js';

import { DEV_TENANT_ID } from '../src/lib/db/tenant';
import { COMPANY_TYPE } from '../src/lib/constants/companies';
import { TABLE } from '../src/lib/constants/tables';

// The familiar demo companies, registered as prospective sell-side clients.
const LEAD_NAMES = [
  'Atlassian',
  'Canva',
  'Figma',
  'Notion',
  'Databricks',
  'Anthropic',
  'Vercel',
  'Linear',
  'Ramp',
  'Retool',
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = ReturnType<typeof createClient<any, 'public', any>>;

async function ensureLead(db: Db, name: string): Promise<'created' | 'exists'> {
  const { data, error } = await db
    .from(TABLE.COMPANIES)
    .select('id')
    .eq('tenant_id', DEV_TENANT_ID)
    .ilike('name', name)
    .limit(1);
  if (error) throw error;
  if (data?.[0]?.id) return 'exists';

  const { error: createError } = await db
    .from(TABLE.COMPANIES)
    .insert({ tenant_id: DEV_TENANT_ID, name, type: COMPANY_TYPE.CLIENT });
  if (createError) throw createError;
  return 'created';
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set (see .env.example)',
    );
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  let created = 0;
  for (const name of LEAD_NAMES) {
    const result = await ensureLead(db, name);
    console.log(`  ${result === 'created' ? 'created' : 'exists '}  ${name}`);
    if (result === 'created') created += 1;
  }
  console.log(`\nSeeded ${LEAD_NAMES.length} demo leads (${created} new) in the dev tenant.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
