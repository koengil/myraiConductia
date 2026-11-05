// A future search route that skips the guard.
import { createSupabaseAdminClient } from '@/lib/supabase/server';

export async function GET() {
  return Response.json(await createSupabaseAdminClient().from('source_items').select('subject'));
}
