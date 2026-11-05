-- supabase/migrations/20261023120200_known_deals_skip_dismissed.sql
-- G-02a (#173), slice 3 of 5: the propose step stops offering a model-named deal its source's owner dismissed.
--
-- Demo only, like the proposals (#460): removed with them when #459 lands.
--
-- discovery_proposal_known_deals(p_tenant_id, p_source) lists the deals a propose run may name for one mailbox
-- source: `seen`, the live candidates the source may name (discovery_proposal_may_name), then `named`, the `m:`
-- deals the model named in this source's own mail. A dismissed `m:` name kept going back into the prompt, so the
-- model kept proposing the deal the owner had just dismissed. One change: `named` offers a key only while some
-- live row of it on THIS source is not covered, so a key whose every live row there is covered is dropped:
--
--   covered   a live dismissal (restored_at is null) on the row's source, of its current deal_key, lists the
--             row's id in proposal_ids (20261023120100's link, the one the dismiss RPC and the reader use)
--
-- Per source: a dismissal only ever lists rows of its own source, so a personal dismissal can never change a team
-- source's list. A later proposal of the key on the source is a row no dismissal lists, so the key is offered
-- again (it shows again in the reader too, and the owner can dismiss it again), whatever its created_at. A `c:`
-- key is not filtered here: dismissing a candidate's proposals never touches the candidate (design R5).
--
-- Body restated from 20261023110000_discovery_proposal_own_source.sql (G-01 slice 1), NOT from 20261014120000:
-- every line is that file's apart from the `exists` in `named`. The signature, the search path and the grants
-- are unchanged (G-01's signature-freeze case in discovery_model_proposals.sql still holds). A later migration
-- that restates this function (G-01's team slices) must carry the dismissal filter (threads TH1-2).
--
-- Reverse: restate 20261023110000's body of discovery_proposal_known_deals.

create or replace function discovery_proposal_known_deals(p_tenant_id uuid, p_source uuid)
returns table (ref text, name text, candidate_id uuid)
language sql security definer stable set search_path = public, pg_temp as $$
  with src as (
    select c.id, c.tenant_id, c.owner_user_id, c.team_mailbox_id, lower(c.address) as address, c.provider
    from content_sources c
    where c.id = p_source and c.tenant_id = p_tenant_id and c.kind = 'mailbox'
  ),
  -- Only candidates linked to an item read from this source are put to may_name, so the test runs once per linked
  -- candidate, not once per live candidate of the tenant. may_name still decides.
  linked as (
    select distinct l.candidate_id
    from src
    join source_item_sources s on s.content_source_id = src.id
    join evidence_links l on l.source_item_id = s.source_item_id
  ),
  seen as (
    select 'c:' || dc.id::text as ref, btrim(coalesce(dc.proposed_name, dc.codename_guess, '')) as name,
           dc.id as candidate_id, 0 as tier, dc.last_seen_at as at
    from linked
    join deal_candidates dc on dc.id = linked.candidate_id
    cross join src
    where dc.tenant_id = p_tenant_id
      and dc.discovery_state in ('proposed', 'confirmed')
      and discovery_proposal_may_name(src.id, dc.id)
  ),
  named as (
    select distinct on (p.deal_key) p.deal_key as ref, p.deal_name as name, null::uuid as candidate_id,
           1 as tier, p.updated_at as at
    from discovery_model_proposals p
    join src on src.id = p.content_source_id
    where p.tenant_id = p_tenant_id and p.outcome = 'deal' and p.deal_key like 'm:%'
      and (
        (src.team_mailbox_id is not null
         and exists (select 1 from allowed_team_mailboxes a
                     where a.team_mailbox_id = src.team_mailbox_id and a.tenant_id = src.tenant_id
                       and a.address = src.address and a.provider = src.provider))
        or (src.team_mailbox_id is null and src.owner_user_id is not null
            and exists (select 1
                        from users u
                        join allowed_mailboxes a on a.tenant_id = u.tenant_id and a.user_id = u.id
                        where u.id = src.owner_user_id and u.tenant_id = src.tenant_id
                          and a.address = src.address and a.provider = src.provider))
      )
      -- G-02a: offered while some live row of the key on this source is not covered (the link rule).
      and exists (
        select 1
        from discovery_model_proposals q
        where q.tenant_id = src.tenant_id and q.content_source_id = src.id
          and q.outcome = 'deal' and q.archived_at is null and q.deal_key = p.deal_key
          and not exists (select 1
                          from discovery_model_proposal_dismissals d
                          where d.content_source_id = q.content_source_id and d.deal_key = q.deal_key
                            and d.restored_at is null and q.id = any (d.proposal_ids))
      )
    order by p.deal_key, p.updated_at desc
  )
  select k.ref, k.name, k.candidate_id
  from (select * from seen where name <> '' union all select * from named) k
  order by k.tier, k.at desc nulls last, k.ref;
$$;
revoke all on function discovery_proposal_known_deals(uuid, uuid) from public, anon, authenticated;
grant execute on function discovery_proposal_known_deals(uuid, uuid) to service_role;
