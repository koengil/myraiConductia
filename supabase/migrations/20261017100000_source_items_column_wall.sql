-- The owner-only wall on source_items content columns, enforced by the database.
--
-- source_items is the metadata row of a discovered item. Its policy
-- (source_items_select, app_can_see_item) shows a row to the item's owners, the
-- control room and anyone who sees a candidate it is firm evidence for. RLS
-- filters rows, not columns, and 20260925120000 granted SELECT on the whole
-- table to authenticated, so a colleague who could see the row read the owner's
-- subject and participants straight through PostgREST with their own JWT. The
-- body and attachments already sit owner-only in source_item_texts
-- (app_owns_item); this puts the same wall around the content that stayed on
-- source_items.
--
-- Walled (owner-only): subject, participants (names and addresses), drive_path
-- (a document's folder and file name). Every other column stays readable by
-- whoever the row policy admits: id, tenant_id, kind, sent_at,
-- internet_message_id, conversation_id, drive_item_key, content_hash,
-- sensitivity, created_at. A count(*) or an id lookup keeps working.
--
-- Owners read the walled columns through discovery_item_metadata, a definer
-- that returns them only where app_owns_item holds for auth.uid() (the
-- source_item_texts predicate) and null otherwise, on the rows
-- app_can_see_item admits. It also returns the sender's domain to every row
-- viewer: the one fact non-owners were shown from participants (the deal
-- email list's "from" domain), derived here so the addresses never leave.
-- Accepted residual exposure: an external domain can name the counterparty on
-- its own, so a non-owner still learns who wrote. It is what develop showed
-- before this wall; compliance confirmation is pending, and dropping it for
-- non-owners is the alternative.
--
-- Fail closed for new columns: SELECT is granted per column, so a column added
-- to source_items later is unreadable by authenticated until a migration grants
-- it by name. Grant only non-content columns; never restore a table-wide
-- SELECT, which would reopen the wall.
--
-- The service role (worker, scripts, admin client) is unaffected: its grant is
-- untouched and it bypasses RLS.
--
-- Reverse: drop function discovery_item_metadata(uuid[]);
--          revoke select on source_items from authenticated;
--          grant select on source_items to authenticated;

revoke select on source_items from authenticated;
grant select (id, tenant_id, kind, sent_at, internet_message_id, conversation_id, drive_item_key,
              content_hash, sensitivity, created_at)
  on source_items to authenticated;

create or replace function discovery_item_metadata(p_items uuid[])
returns table (id uuid, kind text, sent_at timestamptz, own boolean, subject text, participants jsonb,
               sender_domain text)
language sql stable security definer set search_path = public, pg_temp as $$
  select si.id, si.kind, si.sent_at, o.own,
         case when o.own then si.subject end,
         case when o.own then si.participants end,
         (select lower(substring(p->>'address' from '^.+@([^@]+)$'))
            from jsonb_array_elements(case when jsonb_typeof(si.participants) = 'array'
                                           then si.participants else '[]'::jsonb end)
                 with ordinality as e(p, n)
           where jsonb_typeof(p) = 'object' and p->>'role' = 'from'
             and jsonb_typeof(p->'address') = 'string' and p->>'address' <> ''
           order by n
           limit 1)
  from source_items si
  cross join lateral (select app_owns_item(si.id, auth.uid()) as own) o
  where auth.uid() is not null
    and si.id = any (coalesce(p_items, '{}'::uuid[]))
    and app_can_see_item(si.id, auth.uid());
$$;

revoke all on function discovery_item_metadata(uuid[]) from public, anon;
grant execute on function discovery_item_metadata(uuid[]) to authenticated;
