import { createSupabaseAdminClient } from '@/lib/supabase/server';

export async function adminItems() {
  return createSupabaseAdminClient().from('source_items').select('subject');
}
