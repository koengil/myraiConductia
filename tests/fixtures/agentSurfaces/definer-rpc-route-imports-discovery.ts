// The declared definer RPC, plus an import from src/lib/discovery/ (here a pure
// module): nothing under that folder may sit in the route's closure.
import { MILESTONE_TYPES } from '@/lib/discovery/milestones';
import { createSupabaseAdminClient } from '@/lib/supabase/server';

export async function POST(request: Request) {
  const { candidateId } = (await request.json()) as { candidateId: string };
  const known = MILESTONE_TYPES.length;
  return Response.json(
    await createSupabaseAdminClient().rpc('discovery_record_assessment', { p_candidate_id: candidateId, p_known: known }),
  );
}
