import { createClient } from '@supabase/supabase-js';
import { FLAG_REGISTRY } from '../src/lib/flags/keys';

// Test/dev provisioning ONLY. Turns every flag in FLAG_REGISTRY on, so an E2E
// stack exercises the shipped capability rather than the pre-flag fallback.
// Deliberately separate from `seed:flags`, whose contract is that it never
// touches the runtime `enabled` toggle (ADR-0007).
async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set');
  }
  if (process.env.NEXT_PUBLIC_APP_ENV === 'prod') {
    throw new Error('Refusing to force flags on in prod');
  }

  // This script force-enables EVERY flag unconditionally. A developer's
  // .env.local can point NEXT_PUBLIC_SUPABASE_URL at a shared remote project
  // (this repo's does), and running this script against it would flip every
  // capability on for every user of that project. Only a local Supabase
  // stack (127.0.0.1 / localhost) is allowed by default; an operator who
  // really means to touch a remote project must opt in explicitly.
  const hostname = new URL(url).hostname;
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  if (!isLocal && process.env.E2E_ALLOW_REMOTE_FLAGS !== '1') {
    throw new Error(
      `Refusing to force flags on for non-local Supabase host "${hostname}". ` +
        'Set E2E_ALLOW_REMOTE_FLAGS=1 to override deliberately.',
    );
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const rows = Object.entries(FLAG_REGISTRY).map(([flagKey, def]) => ({
    key: flagKey,
    description: def.description,
    enabled: true,
  }));

  const { error } = await supabase
    .from('feature_flags')
    .upsert(rows, { onConflict: 'key', ignoreDuplicates: false });
  if (error) throw error;
  console.log(`Enabled ${rows.length} feature flag(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
