// A future search route done right (declared guarded).
import { readMailboxItemsForTool } from '@/lib/mailboxAccess/accessors';
import { currentActingUser } from '@/lib/mailboxAccess/principal';
import { createSupabaseAdminClient } from '@/lib/supabase/server';

export async function GET(request: Request) {
  const user = await currentActingUser();
  if (!user) return new Response(null, { status: 401 });
  const url = new URL(request.url);
  return Response.json(
    await readMailboxItemsForTool(
      createSupabaseAdminClient(),
      {
        address: url.searchParams.get('address') ?? '',
        caller: 'search',
        onBehalfOf: user,
      },
      'search',
    ),
  );
}
