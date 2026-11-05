-- Demo only (#460): the deal proposal step's answers about mail the firm rules
-- did not route. Removed when #459 lands: drop the table, the two triggers on
-- deal_candidates and the four functions.
--
-- One row per message the model answered in each mailbox it was read from,
-- keyed by the source and a hash of the message's Internet message id (the raw
-- id is sender-written and can look like an address). A message in two
-- mailboxes is asked and stored once per mailbox, so each owner sees their own
-- answer, made only from the deals that owner can see. There is no subject, body, address or display-name column: a row
-- holds the item's content hash (for recorded-reply lookup and the join to
-- routing_ledger.item_hash), its date, its participant domains, and the answer.
-- Only a 'deal' row carries a deal key, name and phase. The deal name comes from
-- mail, with codename_guess's sensitivity, and is never logged.
--
-- Who reads: the owner of the mailbox the message was read from, while that
-- mailbox is on the allowlist (app_owns_item's ownership join), and only the
-- live 'deal' rows: never an archived row, nor one naming a candidate the owner
-- cannot see (app_can_see_candidate). Who writes: the worker, through
-- discovery_record_model_proposal.
--
-- A candidate that goes away never takes its proposals with it (owner decision on
-- review #509-3: archive, do not delete; deletion waits on user feedback). When a
-- candidate is deleted, rejected or merged into another, the rows that name it are
-- archived (archived_at set) and keep deal_key = 'c:<id>', deal_name and
-- candidate_id, so clearing archived_at restores them. candidate_id is therefore a
-- plain uuid, checked against the tenant when written, not a foreign key that would
-- null it. The rows still go with their mailbox source (on delete cascade).

create table if not exists discovery_model_proposals (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  -- #461's purge reaches the rows through their source.
  content_source_id uuid not null references content_sources (id) on delete cascade,
  message_key       text not null check (message_key ~ '^[0-9a-f]{64}$'),
  item_hash         text not null check (item_hash ~ '^[0-9a-f]{64}$'),
  sent_at           timestamptz,
  -- Domains only: lowercase labels, never a local part.
  party_domains     text[] not null default '{}'
                    check (cardinality(party_domains) <= 100
                           and array_to_string(party_domains, ',') ~ '^([a-z0-9.-]+(,[a-z0-9.-]+)*)?$'),
  outcome           text not null check (outcome in ('deal', 'not_deal', 'invalid')),
  deal_key          text check (deal_key ~ '^(c:[0-9a-f-]{36}|m:[a-z0-9-]{1,64})$'),
  deal_name         text check (char_length(deal_name) between 1 and 80),
  -- No foreign key: a deleted candidate archives its rows and keeps the id (see the header).
  candidate_id      uuid,
  phase             text check (phase ~ '^phase-[1-5]$'),
  p_deal            numeric(4,3) check (p_deal between 0 and 1),
  p_phase           numeric(4,3) check (p_phase between 0 and 1),
  model             text not null,
  prompt_version    text not null,
  prompt_hash       text not null,
  response_id       text,
  run_id            uuid not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Set when the named candidate is deleted, rejected or merged; null is live.
  archived_at       timestamptz,
  unique (tenant_id, content_source_id, message_key, prompt_version, model),
  check ((outcome = 'deal') = (deal_key is not null and deal_name is not null and phase is not null)),
  check (outcome = 'deal' or (candidate_id is null and p_phase is null)),
  check (candidate_id is null or deal_key = 'c:' || candidate_id::text),
  -- Only a row that names a rules-found candidate is ever archived.
  check (archived_at is null or deal_key like 'c:%')
);
create index if not exists discovery_model_proposals_source_idx on discovery_model_proposals (content_source_id);
create index if not exists discovery_model_proposals_deal_idx
  on discovery_model_proposals (tenant_id, deal_key) where outcome = 'deal';

alter table discovery_model_proposals enable row level security;
revoke all on discovery_model_proposals from anon, authenticated;
grant select, insert, update, delete on discovery_model_proposals to service_role;
grant select on discovery_model_proposals to authenticated;

-- A mailbox source's owner: the user it belongs to, in its tenant, while the
-- mailbox is allowlisted (the join app_owns_item makes per item). Answers only
-- about the caller, like every RLS helper (20260930180000).
create or replace function app_owns_mailbox_source(p_source uuid, p_tenant uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select (coalesce(auth.role(), '') = 'service_role' or p_user = auth.uid())
     and exists (
       select 1
       from content_sources c
       join users u on u.id = c.owner_user_id and u.tenant_id = c.tenant_id
       join allowed_mailboxes a on a.tenant_id = c.tenant_id
                               and a.address = lower(c.address)
                               and a.user_id = c.owner_user_id
                               and a.provider = c.provider
       where c.id = p_source and c.tenant_id = p_tenant and c.kind = 'mailbox' and c.owner_user_id = p_user
     );
$$;
revoke all on function app_owns_mailbox_source(uuid, uuid, uuid) from public, anon;
grant execute on function app_owns_mailbox_source(uuid, uuid, uuid) to authenticated, service_role;

drop policy if exists discovery_model_proposals_select on discovery_model_proposals;
-- Live rows only, and a row naming a rules-found candidate only while the reader
-- can see that candidate: the same rule the read route applies, held here so a
-- direct table read cannot get around it. Restoring an archived row is a
-- service_role update; signed-in users hold select only.
create policy discovery_model_proposals_select on discovery_model_proposals for select to authenticated
  using (outcome = 'deal'
         and archived_at is null
         and app_owns_mailbox_source(content_source_id, tenant_id, auth.uid())
         and (deal_key is null or deal_key like 'm:%' or app_can_see_candidate(candidate_id, auth.uid())));

-- The one writer. The source and any candidate must be the tenant's, and the
-- candidate one the source's owner can see (app_can_see_candidate); a repeat
-- answer for the same source, message, prompt version and model updates the row.
-- A run reads its known deals before it asks the model, so the candidate it names
-- may have been deleted, rejected or merged since. The writer takes a share lock on
-- the candidate (the archive triggers' row lock waits for it, or it waits for
-- them) and writes such a row already archived, keeping key, name and id: nothing
-- is lost and nothing stale is shown.
create or replace function discovery_record_model_proposal(p_tenant_id uuid, p_proposal jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id        uuid;
  v_source    uuid := (p_proposal->>'content_source_id')::uuid;
  v_candidate uuid := (p_proposal->>'candidate_id')::uuid;
  v_cand_tenant uuid;
  v_state     text;
  v_archived  timestamptz;
  v_owner     uuid;
  v_known     boolean;
begin
  select owner_user_id into v_owner from content_sources where id = v_source and tenant_id = p_tenant_id and kind = 'mailbox';
  if not found then
    raise exception 'discovery_record_model_proposal: source not in tenant' using errcode = '22023';
  end if;
  if v_candidate is not null then
    select tenant_id, discovery_state into v_cand_tenant, v_state from deal_candidates where id = v_candidate for share;
    v_known := found;
    if v_known and v_cand_tenant is distinct from p_tenant_id then
      raise exception 'discovery_record_model_proposal: candidate not in tenant' using errcode = '22023';
    end if;
    -- The information barrier on write too (review #509-5): a row the source's owner
    -- reads may name only a candidate that owner can see.
    if v_known and (v_owner is null or not app_can_see_candidate(v_candidate, v_owner)) then
      raise exception 'discovery_record_model_proposal: candidate not visible to the source owner' using errcode = '22023';
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

-- The deals a propose run may name for mail read from one mailbox source: the
-- live candidates the source's owner can see (app_can_see_candidate, the
-- information barrier), then the deals the model named in that owner's own
-- mailboxes. Never another user's candidate or another mailbox's model-named
-- deal: these names go into the owner's prompt and into rows the owner reads.
create or replace function discovery_proposal_known_deals(p_tenant_id uuid, p_source uuid)
returns table (ref text, name text, candidate_id uuid)
language sql security definer stable set search_path = public as $$
  with owner as (
    select c.owner_user_id as user_id
    from content_sources c
    where c.id = p_source and c.tenant_id = p_tenant_id and c.kind = 'mailbox' and c.owner_user_id is not null
  ),
  seen as (
    select 'c:' || dc.id::text as ref, btrim(coalesce(dc.proposed_name, dc.codename_guess, '')) as name,
           dc.id as candidate_id, 0 as tier, dc.last_seen_at as at
    from deal_candidates dc
    cross join owner o
    where dc.tenant_id = p_tenant_id
      and dc.discovery_state in ('proposed', 'confirmed')
      and app_can_see_candidate(dc.id, o.user_id)
  ),
  named as (
    select distinct on (p.deal_key) p.deal_key as ref, p.deal_name as name, null::uuid as candidate_id,
           1 as tier, p.updated_at as at
    from discovery_model_proposals p
    join content_sources c on c.id = p.content_source_id and c.tenant_id = p.tenant_id and c.kind = 'mailbox'
    join owner o on o.user_id = c.owner_user_id
    where p.tenant_id = p_tenant_id and p.outcome = 'deal' and p.deal_key like 'm:%'
    order by p.deal_key, p.updated_at desc
  )
  select k.ref, k.name, k.candidate_id
  from (select * from seen where name <> '' union all select * from named) k
  order by k.tier, k.at desc nulls last, k.ref;
$$;
revoke all on function discovery_proposal_known_deals(uuid, uuid) from public, anon, authenticated;
grant execute on function discovery_proposal_known_deals(uuid, uuid) to service_role;

-- Archive, never delete (review #509-3): a candidate leaving the live set
-- (proposed, confirmed) archives the proposals that name it, by its key, and
-- keeps them whole. Both transitions are terminal in discovery (a rejected or
-- merged candidate is never revived), so nothing un-archives automatically.
create or replace function discovery_model_proposals_archive_candidate()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and not (old.discovery_state in ('proposed', 'confirmed')
                               and new.discovery_state in ('rejected', 'merged_into')) then
    return new;
  end if;
  update public.discovery_model_proposals
     set archived_at = now()
   where tenant_id = old.tenant_id and deal_key = 'c:' || old.id::text and archived_at is null;
  return case when tg_op = 'DELETE' then old else new end;
end; $$;
revoke all on function discovery_model_proposals_archive_candidate() from public, anon, authenticated;

drop trigger if exists discovery_model_proposals_archive_on_delete on deal_candidates;
create trigger discovery_model_proposals_archive_on_delete before delete on deal_candidates
  for each row execute function discovery_model_proposals_archive_candidate();
drop trigger if exists discovery_model_proposals_archive_on_state on deal_candidates;
create trigger discovery_model_proposals_archive_on_state after update of discovery_state on deal_candidates
  for each row execute function discovery_model_proposals_archive_candidate();
