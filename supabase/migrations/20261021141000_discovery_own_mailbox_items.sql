-- The Deal email thread and its reply read only the caller's own connected mailbox (Martín's review of PR #650, N2;
-- Issue #339 slice 1).
--
-- Since 20261019160000 (PR #614), app_owns_item also answers true for an item in a team inbox the caller reads as a
-- member. The thread route kept rows by that `own`, so a member could open a team conversation and reply into it
-- from their personal address. Until there is an explicit decision on who answers a client from a team inbox, the
-- thread keeps only items with provenance in a mailbox the caller owns, and source_item_sources and content_sources
-- have no policy the caller could read that through.
--
-- discovery_own_mailbox_items(p_items) answers, for the caller only, which of p_items came from a mailbox they own
-- (the first disjunct of app_owns_item, unchanged: their own allowlisted mailbox source), with that mailbox's
-- address. A team source has no owner, so it never matches. The address also marks the caller's own sends where it
-- differs from the sign-in address (an alias). It names nothing the caller does not already own.
--
-- Reverse: drop function discovery_own_mailbox_items(uuid[]);

create or replace function discovery_own_mailbox_items(p_items uuid[])
returns table (id uuid, mailbox_address text)
language sql stable security definer set search_path = public, pg_temp as $$
  select distinct s.source_item_id, lower(c.address)
  from source_item_sources s
  join source_items si on si.id = s.source_item_id
  join content_sources c on c.id = s.content_source_id and c.kind = 'mailbox'
                        and c.tenant_id = si.tenant_id
  join users u on u.id = c.owner_user_id and u.tenant_id = c.tenant_id
  join allowed_mailboxes a on a.tenant_id = c.tenant_id
                          and a.address = lower(c.address)
                          and a.user_id = c.owner_user_id
                          and a.provider = c.provider
  where auth.uid() is not null
    and c.owner_user_id = auth.uid()
    and s.source_item_id = any (coalesce(p_items, '{}'::uuid[]));
$$;

revoke all on function discovery_own_mailbox_items(uuid[]) from public, anon, authenticated;
grant execute on function discovery_own_mailbox_items(uuid[]) to authenticated;
