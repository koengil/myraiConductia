// A tool that skips the guard: reads source_items with the service role.
import { createSupabaseAdminClient } from '@/lib/supabase/server';

export async function tool() {
  return createSupabaseAdminClient().from('source_items').select('subject');
}
