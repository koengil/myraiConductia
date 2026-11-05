// Calls a mailbox RPC that the signed-in role may execute. Declaring it as a
// definer_rpc must fail: only service_role-only functions qualify.
import { createSupabaseAdminClient } from '@/lib/supabase/server';

export async function POST(request: Request) {
  const { candidateId } = (await request.json()) as { candidateId: string };
  return Response.json(
    await createSupabaseAdminClient().rpc('discovery_rename_candidate', {
      p_candidate_id: candidateId,
      p_name: 'x',
      p_reason: 'y',
    }),
  );
}
