// The right way: the guarded accessor, for the user the tool acts for.
import { readMailboxItemsForTool } from '@/lib/mailboxAccess/accessors';
import type { ActingUser } from '@/lib/mailboxAccess/principal';
import { createSupabaseAdminClient } from '@/lib/supabase/server';

export async function tool(address: string, user: ActingUser) {
  return readMailboxItemsForTool(
    createSupabaseAdminClient(),
    { address, caller: 'agent-tool:fixture', onBehalfOf: user },
    'agent_tool',
  );
}
