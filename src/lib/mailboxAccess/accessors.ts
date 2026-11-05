// Guarded reads of mailbox-derived tables for agent tools, search and
// retrieval (#262, R13, R22). The service-role reads of these tables for tools
// live here and only here. Each call asks the guard before reading any item,
// bound to the source's owner (looked up first, id, owner and registration
// only; a team inbox has no owner, so its guard owner is the acting user), and every
// refusal is audited (R10). The service role skips RLS, so each call then
// keeps only the rows its acting user could see in a session
// (app_can_see_item), never a colleague's.

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  MAILBOX_GUARD_PURPOSE,
  MAILBOX_PROVIDER,
  MAILBOX_REFUSAL_REASON,
  SOURCE_KIND,
  type MailboxGuardPurpose,
  type MailboxProvider,
} from '@/lib/constants/discovery';
import { TABLE } from '@/lib/constants/tables';
import { errorCodeOf } from '@/lib/errors/upstream';

import { assertMailboxAllowed, MailboxAccessRefusedError } from './guard';
import { assertActingUser, type ActingUser } from './principal';

export type ToolPurpose = Extract<MailboxGuardPurpose, 'agent_tool' | 'search' | 'retrieval'>;
export const TOOL_PURPOSES: readonly ToolPurpose[] = [
  MAILBOX_GUARD_PURPOSE.AGENT_TOOL,
  MAILBOX_GUARD_PURPOSE.SEARCH,
  MAILBOX_GUARD_PURPOSE.RETRIEVAL,
];

export type MailboxItemMetadata = { id: string; subject: string | null; sentAt: string | null };

export async function readMailboxItemsForTool(
  db: SupabaseClient,
  request: {
    // No tenant here: it is the acting user's (principal.ts), never a caller's.
    address: string;
    caller: string;
    /** The user the tool acts for, from verified auth only (principal.ts). */
    onBehalfOf: ActingUser;
    limit?: number;
  },
  purpose: ToolPurpose,
): Promise<MailboxItemMetadata[]> {
  if (!TOOL_PURPOSES.includes(purpose)) throw new Error(`not a tool purpose: ${purpose}`);
  // Only a user minted from the verified session (principal.ts): a value of the
  // right shape from anywhere else is refused before any read or guard call.
  const { tenantId, userId } = assertActingUser(request.onBehalfOf);
  const address = request.address.trim().toLowerCase();
  // 1. The source for exactly this address (content_sources is unique on
  //    lower(address)): only its id and owner are read, so the guard can bind the
  //    owner (R4). No item, provenance or text is read before the guard answers.
  const { data: source, error } = await db
    .from(TABLE.CONTENT_SOURCES)
    .select('id, owner_user_id, provider, team_mailbox_id')
    .eq('tenant_id', tenantId)
    .eq('kind', SOURCE_KIND.MAILBOX)
    .ilike('address', address.replace(/[\\%_]/g, (ch) => `\\${ch}`))
    .maybeSingle();
  if (error) throw new Error(`source lookup failed (${errorCodeOf(error)})`);
  // 2. The guard, bound to the source's owner: a tool, search, retrieval or
  //    export read always binds it (the SQL function refuses a call without
  //    one). The guard asks its own service client; `db` never answers for it.
  //    A tool names no reader, so it passes the provider of the row it just read:
  //    the guard's own lookup must agree (provider_mismatch when the row changed
  //    in between). An address with no source row is still put to the guard, so
  //    the refusal is audited: the guard refuses it `no_source` before comparing
  //    any owner or provider (round 3, item 6), so the null owner and the
  //    placeholder provider here are never judged.
  const found = source as {
    id: string;
    owner_user_id: string | null;
    provider: MailboxProvider;
    team_mailbox_id?: string | null;
  } | null;
  //    A team inbox (#581) belongs to the firm, so its source has no owner to bind. A tool reads it for a
  //    person: the acting user is named as the guard's owner, and the guard admits them only while they are
  //    one of the registration's readers (the verdict reads team_mailbox_readers; a null owner is the
  //    worker's provider_read alone). The binding is still the verified session's user, never a caller's
  //    value. A personal source binds its own owner exactly as before.
  const guardOwner = found?.team_mailbox_id ? userId : (found?.owner_user_id ?? null);
  await assertMailboxAllowed(tenantId, address, {
    purpose,
    caller: request.caller,
    owner: { userId: guardOwner },
    provider: found?.provider ?? MAILBOX_PROVIDER.MICROSOFT,
  });
  // Fail closed: a sourceless address is never readable, whatever the guard said.
  if (!found) throw new MailboxAccessRefusedError(tenantId, address, MAILBOX_REFUSAL_REASON.NO_SOURCE, purpose);
  const { data: links, error: linkError } = await db
    .from(TABLE.SOURCE_ITEM_SOURCES)
    .select('source_item_id')
    .eq('content_source_id', found.id)
    .limit(request.limit ?? 50);
  if (linkError) throw new Error(`provenance lookup failed (${errorCodeOf(linkError)})`);
  const linked = ((links ?? []) as Array<{ source_item_id: string }>).map((row) => row.source_item_id);
  if (linked.length === 0) return [];
  // Only what the acting user may see (app_can_see_item, the RLS helper).
  const { data: visible, error: visibleError } = await db.rpc('mailbox_items_visible_to', {
    p_user: userId,
    p_items: linked,
  });
  if (visibleError) throw new Error(`visibility check failed (${errorCodeOf(visibleError)})`);
  const ids = Array.isArray(visible) ? (visible as string[]) : [];
  if (ids.length === 0) return [];
  const { data: items, error: itemError } = await db
    .from(TABLE.SOURCE_ITEMS)
    .select('id, subject, sent_at')
    .in('id', ids)
    .eq('tenant_id', tenantId);
  if (itemError) throw new Error(`item lookup failed (${errorCodeOf(itemError)})`);
  return ((items ?? []) as Array<{ id: string; subject: string | null; sent_at: string | null }>).map((row) => ({
    id: row.id,
    subject: row.subject,
    sentAt: row.sent_at,
  }));
}
