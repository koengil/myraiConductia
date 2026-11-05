// A discovery-zone route that builds its own supabase-js client with a key,
// which fence A (no admin-client import) did not see.
import { createClient } from '@supabase/supabase-js';

export async function GET() {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', process.env.SUPABASE_SECRET_KEY ?? '');
  return Response.json(await db.from('source_items').select('subject'));
}
