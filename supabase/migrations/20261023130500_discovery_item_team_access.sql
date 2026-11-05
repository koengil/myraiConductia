-- G-07 slice 2b (#173, design R11): the caller's per-item team access, so team mail can read "Team inbox".
--
-- discovery_item_metadata.own already counts a team inbox reader as an owner (20261021160000: the owned sources
-- include a team inbox the caller reads), so the API cannot tell a member's team mail from their own mailbox. This
-- new caller-bound read answers that one bit, per item, beside the metadata, so discovery_item_metadata is not
-- dropped and recreated with a new column.
--
--   team = the caller reads the item through a team inbox they are an open member of, and through no mailbox or
--          site of their own. An item also in the caller's own mailbox is their own mail (team false); an item the
--          caller sees only as a colleague or as the control room is not theirs at all (team false).
--
-- The owned sources are app_owned_source_ids()'s, the same set discovery_item_metadata's `own` reads, split by
-- whether the source is a team inbox. Items are those app_can_see_item admits for auth.uid() (an owned item skips
-- it, as in discovery_item_metadata), and nothing without a signed-in caller. Ids and a boolean only, never text, a
-- subject or an address. Nobody sees anything they did not see before: the caller learns, for an item they already
-- read, which of their own sources holds it, which source_item_texts and their own inbox list already tell them.

create or replace function discovery_item_team_access(p_item_ids uuid[])
returns table (item_id uuid, team boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  with owned as materialized (
    select coalesce(array_agg(c.id) filter (where c.team_mailbox_id is not null), '{}'::uuid[]) as team_ids,
           coalesce(array_agg(c.id) filter (where c.team_mailbox_id is null), '{}'::uuid[]) as own_ids
    from unnest(app_owned_source_ids()) o(id)
    join content_sources c on c.id = o.id
  )
  select si.id, a.via_team and not a.via_own
  from owned
  cross join source_items si
  -- offset 0 keeps each test one call per item.
  cross join lateral (select app_item_from_sources(si.id, owned.team_ids) as via_team,
                             app_item_from_sources(si.id, owned.own_ids) as via_own offset 0) a
  where auth.uid() is not null
    and si.id = any (coalesce(p_item_ids, '{}'::uuid[]))
    and case when a.via_team or a.via_own then true else app_can_see_item(si.id, auth.uid()) end;
$$;

revoke all on function discovery_item_team_access(uuid[]) from public, anon, authenticated;
grant execute on function discovery_item_team_access(uuid[]) to authenticated;
