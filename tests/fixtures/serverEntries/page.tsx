// A server component page that reads mailbox data with the service role. The
// old fence judged route.ts only, so a page skipped the guard.
import { createSupabaseAdminClient } from '@/lib/supabase/server';

export default async function Page() {
  const { data } = await createSupabaseAdminClient().from('source_items').select('subject');
  return <pre>{JSON.stringify(data)}</pre>;
}
