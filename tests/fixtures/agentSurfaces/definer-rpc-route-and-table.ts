// The declared definer RPC, plus a direct read of a discovery table: the route
// may not name the table whatever it declares.
import { createSupabaseAdminClient } from '@/lib/supabase/server';

export async function POST(request: Request) {
  const { candidateId } = (await request.json()) as { candidateId: string };
  const db = createSupabaseAdminClient();
  await db.rpc('discovery_record_assessment', { p_candidate_id: candidateId });
  return Response.json(await db.from('deal_candidates').select('display_name').eq('id', candidateId));
}
