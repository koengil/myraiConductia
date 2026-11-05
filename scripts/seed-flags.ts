import { createClient } from '@supabase/supabase-js';
import { FLAG_REGISTRY } from '../src/lib/flags/keys';

// Idempotent seed. Materialises FLAG_REGISTRY (the code source of truth for which
// flags exist) into the target Supabase project. Upserts by `key`, updating
// metadata only — it never overwrites the runtime `enabled` toggle set via the
// management UI (ADR-0007). New rows default to enabled=false (column default).
//
// Run against a chosen environment, e.g.:
//   npm run seed:flags            # uses .env.local (Conductia-dev)
async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set (see .env.example)',
    );
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const rows = Object.entries(FLAG_REGISTRY).map(([flagKey, def]) => ({
    key: flagKey,
    description: def.description,
  }));

  // enabled is omitted from the payload on purpose: on insert it falls to the
  // column default (false); on conflict only key + description are updated, so an
  // existing toggle is preserved.
  const { error } = await supabase
    .from('feature_flags')
    .upsert(rows, { onConflict: 'key', ignoreDuplicates: false });

  if (error) throw error;
  console.log(`Seeded ${rows.length} feature flag(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
