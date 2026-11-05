// The send-as feature's tables and routes are not mailbox-derived reads.
import { createSupabaseAdminClient } from '@/lib/supabase/server';

export async function tool() {
  return createSupabaseAdminClient().from('mailbox_connections').select('id');
}
