-- supabase/migrations/20261001170000_mailbox_tool_visibility.sql
-- Tool reads run as the service role, which RLS does not filter (#262, R22).
-- This keeps only the items the acting user could see in a session, using the
-- same helper the source_items policy uses. Service role only.
create or replace function mailbox_items_visible_to(p_user uuid, p_items uuid[])
-- Returns one uuid[] (not setof uuid), so PostgREST serializes a flat JSON
-- array of strings and the accessor needs no row unwrapping (review round 4).
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(i), '{}'::uuid[])
  from unnest(coalesce(p_items, '{}'::uuid[])) as i
  where p_user is not null and app_can_see_item(i, p_user);
$$;
revoke all on function mailbox_items_visible_to(uuid, uuid[]) from public, anon, authenticated;
grant execute on function mailbox_items_visible_to(uuid, uuid[]) to service_role;
