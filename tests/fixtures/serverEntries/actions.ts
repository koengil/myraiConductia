'use server';
// A server action file: callable from the browser, so it is an entry point.
import { createSupabaseAdminClient } from '@/lib/supabase/server';

export async function readSubjects() {
  return createSupabaseAdminClient().from('source_items').select('subject');
}
