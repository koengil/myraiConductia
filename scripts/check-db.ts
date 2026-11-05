import { createClient } from '@supabase/supabase-js';
import { PERMISSION_TABLES, TABLE } from '../src/lib/constants/tables';
import { ROLE_SLUGS } from '../src/lib/constants/roles';

// Connectivity check for the REST/API path (the one our app + seed use): the
// Supabase Secret key against the project URL. Run with: npm run check:db
async function tableExists(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: ReturnType<typeof createClient<any, 'public', any>>,
  table: string,
): Promise<boolean> {
  const { error } = await supabase.from(table).select('*', { head: true, count: 'exact' });
  if (!error) return true;
  if (
    error.code === '42P01' ||
    error.code === 'PGRST205' ||
    /does not exist|schema cache|could not find the table/i.test(error.message)
  ) {
    return false;
  }
  throw new Error(`${table}: ${error.message} ${error.code ?? ''}`.trim());
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set (see .env.example)',
    );
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const flagsExist = await tableExists(supabase, TABLE.FEATURE_FLAGS);
  if (flagsExist) {
    const { data, error } = await supabase.from(TABLE.FEATURE_FLAGS).select('key, enabled');
    if (error) throw error;
    console.log(`✅ ${TABLE.FEATURE_FLAGS} — ${data.length} row(s)`);
    for (const r of data) console.log(`   - ${r.key}: ${r.enabled}`);
  } else {
    console.log(`⚠️  ${TABLE.FEATURE_FLAGS} — table missing (apply migrations)`);
  }

  const missing: string[] = [];
  for (const table of PERMISSION_TABLES) {
    const exists = await tableExists(supabase, table);
    if (exists) {
      const { count, error } = await supabase
        .from(table)
        .select('*', { head: true, count: 'exact' });
      if (error) throw error;
      console.log(`✅ ${table} — ${count ?? 0} row(s)`);
    } else {
      missing.push(table);
      console.log(`❌ ${table} — missing`);
    }
  }

  if (missing.length > 0) {
    console.log('\n→ Apply supabase/migrations/, then npm run seed:flags && npm run seed:users');
    process.exit(1);
  }

  const expectedRoles = ROLE_SLUGS.length;
  const { count: roleCount, error: rolesError } = await supabase
    .from(TABLE.ROLES)
    .select('*', { head: true, count: 'exact' });
  if (rolesError) throw rolesError;
  if ((roleCount ?? 0) < expectedRoles) {
    console.log(
      `\n⚠️  ${TABLE.ROLES} table has fewer than ${expectedRoles} seed rows — re-run migrations`,
    );
    process.exit(1);
  }

  console.log('\n✅ Connected + authenticated. Phase 1 permissions schema present.');
}

main().catch((e: unknown) => {
  console.error('❌', e instanceof Error ? e.message : e);
  process.exit(1);
});
