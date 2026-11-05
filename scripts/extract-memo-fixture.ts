// scripts/extract-memo-fixture.ts
//
// Pulls a presearch memo out of lead_research so the markdown atom is tested
// against real agent grammar. Prints the memo to stdout; the excerpt is cut by
// hand and committed under tests/fixtures/. Re-run it to refresh a fixture or
// to capture a different run.
//
//   node --env-file=.env.local --import tsx scripts/extract-memo-fixture.ts > /tmp/memo.md
//   node --env-file=.env.local --import tsx scripts/extract-memo-fixture.ts exec_0123456789abcdef > /tmp/memo.md
import { createClient } from '@supabase/supabase-js';

// The run behind tests/fixtures/presearch-memo-excerpt.md.
const DEFAULT_EXECUTION_ID = 'exec_4f221d3891008d48';
const EXECUTION_ID = process.argv[2] ?? DEFAULT_EXECUTION_ID;

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY must be set (see .env.example)');
  }
  const supabase = createClient(url, key);
  const { data, error } = await supabase
    .from('lead_research')
    .select('execution_id, memo_md')
    .eq('execution_id', EXECUTION_ID)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.memo_md) throw new Error(`no memo_md for ${EXECUTION_ID}`);
  process.stdout.write(data.memo_md);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
