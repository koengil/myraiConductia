-- supabase/migrations/20261023110000_discovery_proposal_own_source.sql
-- G-01 (#173), slice 1 of 5: the propose step's information barrier is judged per SOURCE.
--
-- Until now the deals a propose run may name for one mailbox source (discovery_proposal_known_deals) and the
-- candidate a proposal row may name (discovery_record_model_proposal) were decided per OWNER, through
-- app_can_see_candidate and every mailbox the owner holds. That crosses the barrier in three ways, and this
-- migration closes all three on live code (it only narrows; it ships regardless of the owner's answer on
-- ADR-0026 residual 4):
--
--   1. A banker who also reads a team inbox sees team-derived candidates (app_can_see_candidate admits
--      evidence from a team inbox the viewer reads), so those deal names went into the prompt of their
--      PERSONAL source (T6 of the allow-list task).
--   2. A firm CCO who owned a personal mailbox saw every control-room candidate through the same helper, so
--      the prompt of that mailbox would have named deals the CCO's own mail never backed.
--   3. One owner's mailbox A fed `m:` names, and candidates, into the same owner's mailbox B, and kept
--      feeding them after A was withdrawn.
--
-- discovery_proposal_may_name(p_source, p_candidate) is the one test, written once with its FINAL body (the
-- team branch included, so a later slice restates neither function): a source may name a candidate when an
-- unrejected link that is firm-routed or confirmed ties the candidate to an item read from THAT source, while
-- the source is currently readable:
--
--   team source             its inbox is in allowed_team_mailboxes (the registration is open and admitted)
--   personal source         its owner has a current allowed_mailboxes row for the source's address
--   ownerless, non-team     nothing
--
-- It never asks whether some person can see the candidate, and never another source of the same owner.
-- The team branch has no effect today: since #683 no team source reaches the propose step.
--
--   discovery_proposal_known_deals   seen: live candidates the source may name; named: the latest `m:` rows
--                                    of THIS source, while it is readable. Signature unchanged.
--   discovery_record_model_proposal  an ownerless non-team source is refused (22023); a team source is refused
--                                    (42501 team_not_approved: ADR-0026 residual 4 holds even if this slice merges
--                                    alone); a known candidate the source may not name is refused (22023).
--                                    Signature unchanged. A later slice restates it once more and replaces the
--                                    team refusal with the approval and open-pass check.
--
-- Bodies restated from 20261014120000_discovery_model_proposals.sql (the only definition of either function).
-- Every unchanged branch is that file's, apart from the helper call. The search path is pinned to
-- `public, pg_temp` (20261016100000: create or replace resets the configuration to what it states).
-- create or replace keeps the owner and the grants of the two existing functions; the grants are restated
-- below all the same.
--
-- Reverse: restate the two bodies from 20261014120000 (with `set search_path = public, pg_temp`) and drop
-- discovery_proposal_may_name.

-- ── 1. The barrier test: may this source name this candidate? ───────────────
create or replace function discovery_proposal_may_name(p_source uuid, p_candidate uuid)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_tenant   uuid;
  v_owner    uuid;
  v_team     uuid;
  v_address  text;
  v_provider text;
begin
  select c.tenant_id, c.owner_user_id, c.team_mailbox_id, lower(c.address), c.provider
    into v_tenant, v_owner, v_team, v_address, v_provider
  from content_sources c
  where c.id = p_source and c.kind = 'mailbox';
  if not found then
    return false;
  end if;

  if v_team is not null then
    -- A team source: its inbox must still be admitted by the allowlist (a refused or removed inbox names nothing).
    if not exists (select 1 from allowed_team_mailboxes a
                   where a.team_mailbox_id = v_team and a.tenant_id = v_tenant
                     and a.address = v_address and a.provider = v_provider) then
      return false;
    end if;
  elsif v_owner is not null then
    -- A personal source: its owner must hold a current allowlist row for this very mailbox
    -- (the join app_owns_mailbox_source makes), so a withdrawn mailbox names nothing.
    if not exists (select 1
                   from users u
                   join allowed_mailboxes a on a.tenant_id = u.tenant_id and a.user_id = u.id
                   where u.id = v_owner and u.tenant_id = v_tenant
                     and a.address = v_address and a.provider = v_provider) then
      return false;
    end if;
  else
    -- Ownerless and not a team source: nobody reads it, so it names nothing.
    return false;
  end if;

  -- Backing evidence from THIS source's own mail only: an unrejected link that is firm-routed or confirmed.
  return exists (
    select 1
    from deal_candidates dc
    join evidence_links l on l.candidate_id = dc.id
    join source_items si on si.id = l.source_item_id and si.tenant_id = dc.tenant_id
    join source_item_sources s on s.source_item_id = si.id and s.content_source_id = p_source
    where dc.id = p_candidate and dc.tenant_id = v_tenant
      and l.state <> 'rejected'
      and (l.route_tier = 'firm' or l.state = 'confirmed'));
end;
$$;
revoke all on function discovery_proposal_may_name(uuid, uuid) from public, anon, authenticated;
grant execute on function discovery_proposal_may_name(uuid, uuid) to service_role;

-- ── 2. The deals a propose run may name for one mailbox source ──────────────
-- seen:  the live candidates this source may name. named: the deals the model named in this source's own
-- mail, while the source is readable (a team inbox the allowlist admits, or a personal mailbox its owner
-- still holds on the allowlist). Never another user's candidate, never another mailbox's model-named deal,
-- never a withdrawn mailbox's: these names go into the source's prompt and into rows its readers read.
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
    order by p.deal_key, p.updated_at desc
  )
  select k.ref, k.name, k.candidate_id
  from (select * from seen where name <> '' union all select * from named) k
  order by k.tier, k.at desc nulls last, k.ref;
$$;
revoke all on function discovery_proposal_known_deals(uuid, uuid) from public, anon, authenticated;
grant execute on function discovery_proposal_known_deals(uuid, uuid) to service_role;

-- ── 3. The one writer ───────────────────────────────────────────────────────
-- 20261014120000's body. Three changes: a source nobody reads (ownerless and not a team source) is refused; a team
-- source is refused outright, since no approval or pass exists yet to admit it (slice 4 replaces this refusal with
-- that check); and a candidate that exists must be one THIS source may name (the information barrier on write,
-- review #509-5), not one its owner can see by some other route.
create or replace function discovery_record_model_proposal(p_tenant_id uuid, p_proposal jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id        uuid;
  v_source    uuid := (p_proposal->>'content_source_id')::uuid;
  v_candidate uuid := (p_proposal->>'candidate_id')::uuid;
  v_cand_tenant uuid;
  v_state     text;
  v_archived  timestamptz;
  v_owner     uuid;
  v_team      uuid;
  v_known     boolean;
begin
  select owner_user_id, team_mailbox_id into v_owner, v_team
  from content_sources where id = v_source and tenant_id = p_tenant_id and kind = 'mailbox';
  if not found then
    raise exception 'discovery_record_model_proposal: source not in tenant' using errcode = '22023';
  end if;
  if v_owner is null and v_team is null then
    raise exception 'discovery_record_model_proposal: source has no reader' using errcode = '22023';
  end if;
  if v_team is not null then
    -- ADR-0026 residual 4: a team inbox gets no AI proposals. Refused before anything else is read.
    raise exception 'team_not_approved' using errcode = '42501';
  end if;
  if v_candidate is not null then
    select tenant_id, discovery_state into v_cand_tenant, v_state from deal_candidates where id = v_candidate for share;
    v_known := found;
    if v_known and v_cand_tenant is distinct from p_tenant_id then
      raise exception 'discovery_record_model_proposal: candidate not in tenant' using errcode = '22023';
    end if;
    -- The information barrier on write too (review #509-5): a row the source's readers read may name only a
    -- candidate this source's own mail backs.
    if v_known and not discovery_proposal_may_name(v_source, v_candidate) then
      raise exception 'discovery_record_model_proposal: candidate not visible to the source' using errcode = '22023';
    end if;
    if not v_known or v_state not in ('proposed', 'confirmed') then
      v_archived := now(); -- deleted, rejected or merged since the run read it
    end if;
  end if;
  insert into discovery_model_proposals (tenant_id, content_source_id, message_key, item_hash, sent_at, party_domains,
                                         outcome, deal_key, deal_name, candidate_id, phase, p_deal, p_phase,
                                         model, prompt_version, prompt_hash, response_id, run_id, archived_at)
  select p_tenant_id, v_source, r.message_key, r.item_hash, r.sent_at,
         array(select jsonb_array_elements_text(coalesce(p_proposal->'party_domains', '[]'::jsonb))),
         r.outcome, r.deal_key, r.deal_name, v_candidate, r.phase, r.p_deal, r.p_phase,
         r.model, r.prompt_version, r.prompt_hash, r.response_id, r.run_id, v_archived
  from jsonb_to_record(p_proposal) as r(message_key text, item_hash text, sent_at timestamptz, outcome text,
       deal_key text, deal_name text, phase text, p_deal numeric, p_phase numeric, model text,
       prompt_version text, prompt_hash text, response_id text, run_id uuid)
  on conflict (tenant_id, content_source_id, message_key, prompt_version, model) do update
    set item_hash     = excluded.item_hash,
        sent_at       = excluded.sent_at,
        party_domains = excluded.party_domains,
        outcome       = excluded.outcome,
        deal_key      = excluded.deal_key,
        deal_name     = excluded.deal_name,
        candidate_id  = excluded.candidate_id,
        phase         = excluded.phase,
        p_deal        = excluded.p_deal,
        p_phase       = excluded.p_phase,
        archived_at   = excluded.archived_at,
        prompt_hash   = excluded.prompt_hash,
        response_id   = excluded.response_id,
        run_id        = excluded.run_id,
        updated_at    = now()
  returning id into v_id;
  return v_id;
end; $$;
revoke all on function discovery_record_model_proposal(uuid, jsonb) from public, anon, authenticated;
grant execute on function discovery_record_model_proposal(uuid, jsonb) to service_role;
