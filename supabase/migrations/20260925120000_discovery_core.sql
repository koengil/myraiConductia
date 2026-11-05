-- supabase/migrations/20260925120000_discovery_core.sql
-- Deal discovery, phase 3 (the tracer bullet): the core discovery tables and
-- the RLS policies that make them the first tables in the repo read under
-- RLS as the primary gate (ADR-006, ADR-008, design discussion Q7, Q8, Q19).
--
-- Who writes. The classification worker (worker/classify.ts) writes every
-- row with the service role. It never serves a user request.
--
-- Who reads. /api/v1/discovery/* reads through the user-scoped client
-- (requireApiUserScoped), so these policies are the gate, not a backstop:
--   - a candidate is visible to the people its evidence came from
--     (candidate_visibility) and to the control room (firm_role 'cco') of
--     its tenant. A firm admin sees none of it (Q19);
--   - an item's metadata row (source_items) is visible to its owners, to the
--     control room, and to anyone who can see a candidate the item is firm or
--     confirmed evidence for. A colleague therefore sees another banker's item
--     as metadata only;
--   - an item's text (source_item_texts) is visible to its owners only.
--     Everyone else, the control room included, reads text through an
--     audited RPC that lands in phase 6;
--   - a tentative link, and the item behind it, is visible to the item's
--     owners and the control room only, and never counts toward
--     candidate_visibility.
-- The registration, source, ledger and provenance tables have no user policy
-- and no grant to anon or authenticated.
--
-- Ownership comes from provenance, not headers: an item's owners are the
-- owner_user_id of every content_source it was observed in
-- (source_item_sources). Deduplication by internet_message_id keeps every
-- mailbox an item came from, so one item can have several owners.
--
-- Helper functions. Each is security definer so a policy on one table can
-- consult another without recursing through that table's RLS. Each answers
-- only about the session user (or for the service role): asked about anyone
-- else it returns false, so a signed-in caller cannot use /rest/v1/rpc to
-- probe another user's evidence. Every policy passes auth.uid().
--
-- Grants. auto_expose_new_tables is off, so nothing here is reachable until a
-- grant says so. Functions are closed to public and anon, opened to
-- service_role, and opened to authenticated only for the RLS helpers the
-- policies call. When 20260924120000_close_definer_function_grants.sql lands,
-- the four helpers below join AUTHENTICATED_DEFINER_ALLOWLIST in
-- scripts/preflight-db.ts; each already reads auth.uid().

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ─────────────────────────────────────────────────────────────────────────────

-- One app-only Graph reader registration per firm tenant (Q3). Holds a
-- reference to the certificate in a secret store, never key material.
create table if not exists graph_reader_registrations (
  tenant_id        uuid primary key,
  ms_tenant_id     text not null,
  client_id        text not null,
  cert_thumbprint  text,
  cert_secret_ref  text,
  status           text not null default 'pending'
                   check (status in ('pending', 'active', 'disabled')),
  consented_at     timestamptz,
  created_at       timestamptz not null default now()
);

-- Each configured mailbox or SharePoint site (Q4), with its owner set by
-- configuration (Q6) and its delta checkpoint.
create table if not exists content_sources (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references graph_reader_registrations (tenant_id) on delete cascade,
  kind              text not null check (kind in ('mailbox', 'sharepoint_site')),
  address           text not null,
  owner_user_id     uuid references users (id) on delete set null,
  delta_checkpoint  text,
  status            text not null default 'active' check (status in ('active', 'paused')),
  created_at        timestamptz not null default now()
);

create unique index if not exists content_sources_tenant_kind_address_key
  on content_sources (tenant_id, kind, lower(address));

-- Every item the worker reads, routed or not (Q5): a hash and a decision,
-- never content.
create table if not exists routing_ledger (
  source_id         uuid not null references content_sources (id) on delete cascade,
  provider_item_id  text not null,
  item_hash         text not null,
  decision          text not null check (decision in ('routed', 'unrouted')),
  method            text check (method in ('codename', 'alias', 'thread_continuation')),
  confidence        numeric check (confidence between 0 and 1),
  run_id            uuid not null,
  recorded_at       timestamptz not null default now(),
  primary key (source_id, provider_item_id),
  check ((decision = 'routed') = (method is not null))
);

-- Metadata of a deal-routed item. Listable by more people than its text.
create table if not exists source_items (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  kind                 text not null check (kind in ('message', 'document')),
  subject              text,
  participants         jsonb not null default '[]'::jsonb,
  sent_at              timestamptz,
  internet_message_id  text,
  conversation_id      text,
  drive_path           text,
  content_hash         text not null,
  sensitivity          text not null default 'standard' check (sensitivity in ('standard', 'restricted')),
  created_at           timestamptz not null default now(),
  -- The cross-mailbox dedupe key. NULLs stay distinct, so documents (no
  -- internet_message_id) never collide here.
  constraint source_items_tenant_message_key unique (tenant_id, internet_message_id)
);

-- Provenance is ownership: every content source an item was observed in.
create table if not exists source_item_sources (
  source_item_id     uuid not null references source_items (id) on delete cascade,
  content_source_id  uuid not null references content_sources (id) on delete cascade,
  provider_item_id   text not null,
  observed_at        timestamptz not null default now(),
  primary key (source_item_id, content_source_id)
);

-- The normalized text of a deal-routed item: the top of the message, quoted
-- history dropped. Owners read it directly; nobody else does.
create table if not exists source_item_texts (
  source_item_id   uuid primary key references source_items (id) on delete cascade,
  body_text        text not null,
  attachment_text  jsonb not null default '[]'::jsonb
);

-- A proposed deal. Discovery state is its own dimension, apart from the
-- deal lifecycle status (ADR-006). cluster_key is the worker's stable
-- identity for the group, so a re-run updates a candidate instead of adding
-- a second one.
create table if not exists deal_candidates (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  cluster_key       text not null,
  discovery_state   text not null default 'proposed'
                    check (discovery_state in ('proposed', 'confirmed', 'rejected', 'merged_into')),
  merged_into_id    uuid references deal_candidates (id),
  promoted_deal_id  uuid references deals (id),
  proposed_name     text not null,
  codename_guess    text,
  parties           jsonb not null default '[]'::jsonb,
  first_seen_at     timestamptz,
  last_seen_at      timestamptz,
  deal_side         text not null default 'unknown' check (deal_side in ('sell', 'buy', 'unknown')),
  confidence        numeric check (confidence between 0 and 1),
  discovery_run_id  uuid,
  pinned            boolean not null default false,
  created_at        timestamptz not null default now(),
  constraint deal_candidates_tenant_cluster_key unique (tenant_id, cluster_key),
  check ((discovery_state = 'merged_into') = (merged_into_id is not null))
);

-- An item's route to a candidate, or (after promotion, phase 9) to a deal.
-- route_tier comes from the method, never from a score (Q7).
create table if not exists evidence_links (
  id                       uuid primary key default gen_random_uuid(),
  candidate_id             uuid references deal_candidates (id) on delete cascade,
  deal_id                  uuid references deals (id),
  source_item_id           uuid not null references source_items (id) on delete cascade,
  method                   text not null check (method in ('codename', 'alias', 'thread_continuation')),
  confidence               numeric check (confidence between 0 and 1),
  route_tier               text not null check (route_tier in ('firm', 'tentative')),
  state                    text not null default 'proposed' check (state in ('proposed', 'confirmed', 'rejected')),
  pinned_by_correction_id  uuid,
  created_at               timestamptz not null default now(),
  check (num_nonnulls(candidate_id, deal_id) = 1),
  constraint evidence_links_candidate_item_key unique (candidate_id, source_item_id)
);

create index if not exists evidence_links_source_item_idx on evidence_links (source_item_id);

-- Who can see a candidate because their own items are its evidence. Rebuilt
-- by discovery_refresh_candidate_visibility; never written by a user.
create table if not exists candidate_visibility (
  candidate_id       uuid not null references deal_candidates (id) on delete cascade,
  person_id          uuid not null references users (id) on delete cascade,
  source_item_count  integer not null check (source_item_count > 0),
  primary key (candidate_id, person_id)
);

create index if not exists candidate_visibility_person_idx on candidate_visibility (person_id);

alter table graph_reader_registrations enable row level security;
alter table content_sources           enable row level security;
alter table routing_ledger            enable row level security;
alter table source_items              enable row level security;
alter table source_item_sources       enable row level security;
alter table source_item_texts         enable row level security;
alter table deal_candidates           enable row level security;
alter table evidence_links            enable row level security;
alter table candidate_visibility      enable row level security;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Grants. The worker writes with the service role; users read five tables
--    under the policies below and write none.
-- ─────────────────────────────────────────────────────────────────────────────

revoke all on graph_reader_registrations, content_sources, routing_ledger, source_items,
  source_item_sources, source_item_texts, deal_candidates, evidence_links, candidate_visibility
  from anon, authenticated;

grant select, insert, update, delete on graph_reader_registrations, content_sources, routing_ledger,
  source_items, source_item_sources, source_item_texts, deal_candidates, evidence_links,
  candidate_visibility
  to service_role;

grant select on source_items, source_item_texts, deal_candidates, evidence_links, candidate_visibility
  to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. RLS helpers. Each returns false unless the caller is the service role or
--    the user it is asked about.
-- ─────────────────────────────────────────────────────────────────────────────

-- The control room is the cco (Q19). Tenant scoping is the caller's job.
create or replace function app_is_control_room(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from users
    where id = p_user and firm_role = 'cco'
      and (coalesce(auth.role(), '') = 'service_role' or p_user = auth.uid())
  );
$$;

-- An item's owner: the owner of a content source, in the user's own tenant,
-- that the item was observed in.
create or replace function app_owns_item(p_item uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select (coalesce(auth.role(), '') = 'service_role' or p_user = auth.uid())
     and exists (
       select 1
       from source_item_sources s
       join content_sources c on c.id = s.content_source_id
       join users u on u.id = c.owner_user_id and u.tenant_id = c.tenant_id
       where s.source_item_id = p_item and c.owner_user_id = p_user
     );
$$;

-- A candidate is visible through a candidate_visibility row, or to the
-- control room of the candidate's tenant.
create or replace function app_can_see_candidate(p_candidate uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select (coalesce(auth.role(), '') = 'service_role' or p_user = auth.uid())
     and exists (
       select 1 from deal_candidates dc
       join users u on u.id = p_user and u.tenant_id = dc.tenant_id
       where dc.id = p_candidate
         and (
           exists (select 1 from candidate_visibility v
                   where v.candidate_id = dc.id and v.person_id = p_user)
           or (u.firm_role = 'cco')
         )
     );
$$;

-- An item's metadata row is visible to its owners, to the control room of
-- its tenant, and through a firm or confirmed route to a candidate the user
-- can see. A tentative or rejected route shows the item to nobody else.
create or replace function app_can_see_item(p_item uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select (coalesce(auth.role(), '') = 'service_role' or p_user = auth.uid())
     and (
       app_owns_item(p_item, p_user)
       or exists (
         select 1 from source_items si
         join users u on u.id = p_user and u.tenant_id = si.tenant_id and u.firm_role = 'cco'
         where si.id = p_item
       )
       or exists (
         select 1 from evidence_links l
         where l.source_item_id = p_item
           and l.candidate_id is not null
           and l.state <> 'rejected'
           and (l.route_tier = 'firm' or l.state = 'confirmed')
           and app_can_see_candidate(l.candidate_id, p_user)
       )
     );
$$;

revoke all on function app_is_control_room(uuid) from public, anon;
revoke all on function app_owns_item(uuid, uuid) from public, anon;
revoke all on function app_can_see_candidate(uuid, uuid) from public, anon;
revoke all on function app_can_see_item(uuid, uuid) from public, anon;
grant execute on function
  app_is_control_room(uuid), app_owns_item(uuid, uuid),
  app_can_see_candidate(uuid, uuid), app_can_see_item(uuid, uuid)
  to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Policies (select only; users write nothing here)
-- ─────────────────────────────────────────────────────────────────────────────

drop policy if exists deal_candidates_select on deal_candidates;
create policy deal_candidates_select on deal_candidates for select to authenticated
  using (app_can_see_candidate(id, auth.uid()));

-- A link is visible with its candidate, except a tentative or rejected one,
-- which only the item's owners and the control room see.
drop policy if exists evidence_links_select on evidence_links;
create policy evidence_links_select on evidence_links for select to authenticated
  using (
    candidate_id is not null
    and app_can_see_candidate(candidate_id, auth.uid())
    and (
      (state <> 'rejected' and (route_tier = 'firm' or state = 'confirmed'))
      or app_owns_item(source_item_id, auth.uid())
      or app_is_control_room(auth.uid())
    )
  );

drop policy if exists source_items_select on source_items;
create policy source_items_select on source_items for select to authenticated
  using (app_can_see_item(id, auth.uid()));

drop policy if exists source_item_texts_select on source_item_texts;
create policy source_item_texts_select on source_item_texts for select to authenticated
  using (app_owns_item(source_item_id, auth.uid()));

-- Your own row only, so nobody learns which colleagues hold evidence. The
-- control room sees every row of a candidate it can see.
drop policy if exists candidate_visibility_select on candidate_visibility;
create policy candidate_visibility_select on candidate_visibility for select to authenticated
  using (
    person_id = auth.uid()
    or (app_is_control_room(auth.uid()) and app_can_see_candidate(candidate_id, auth.uid()))
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Worker RPCs (service role only)
-- ─────────────────────────────────────────────────────────────────────────────

-- Rebuild one candidate's visibility from its evidence: each owner of a firm
-- or confirmed, unrejected item, in the candidate's tenant, with a count of
-- their items. One statement pair in one transaction, so readers see either
-- the old rows or the new ones.
create or replace function discovery_refresh_candidate_visibility(p_candidate_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from candidate_visibility where candidate_id = p_candidate_id;

  insert into candidate_visibility (candidate_id, person_id, source_item_count)
  select l.candidate_id, c.owner_user_id, count(distinct l.source_item_id)::integer
  from evidence_links l
  join deal_candidates dc on dc.id = l.candidate_id
  join source_item_sources s on s.source_item_id = l.source_item_id
  join content_sources c on c.id = s.content_source_id and c.tenant_id = dc.tenant_id
  join users u on u.id = c.owner_user_id and u.tenant_id = dc.tenant_id
  where l.candidate_id = p_candidate_id
    and l.state <> 'rejected'
    and (l.route_tier = 'firm' or l.state = 'confirmed')
  group by l.candidate_id, c.owner_user_id;
end;
$$;

-- Upsert the candidates of one classification run, with their firm links,
-- in one transaction. A new candidate is audited as
-- discovery.candidate_proposed by the service, in its tenant's chain (D62).
-- An existing candidate is refreshed only while it is still proposed and not
-- pinned, so a re-run never undoes a person's decision. Links are added,
-- never removed. Returns [{ clusterKey, candidateId, created }].
--
-- p_groups: [{ clusterKey, proposedName, codenameGuess, parties, firstSeenAt,
--              lastSeenAt, confidence, links: [{ sourceItemId, method, confidence }] }]
create or replace function discovery_upsert_candidates(
  p_tenant_id uuid,
  p_run_id uuid,
  p_groups jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group     jsonb;
  v_id        uuid;
  v_state     text;
  v_pinned    boolean;
  v_created   boolean;
  v_links     integer;
  v_result    jsonb := '[]'::jsonb;
begin
  if p_tenant_id is null or p_run_id is null then
    raise exception 'discovery_upsert_candidates: tenant and run are required'
      using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_groups, '[]'::jsonb)) <> 'array' then
    raise exception 'discovery_upsert_candidates: groups must be an array'
      using errcode = '22023';
  end if;

  for v_group in select value from jsonb_array_elements(coalesce(p_groups, '[]'::jsonb)) loop
    v_id := null;
    v_created := false;

    insert into deal_candidates (
      tenant_id, cluster_key, proposed_name, codename_guess, parties,
      first_seen_at, last_seen_at, confidence, discovery_run_id
    ) values (
      p_tenant_id,
      v_group->>'clusterKey',
      v_group->>'proposedName',
      v_group->>'codenameGuess',
      coalesce(v_group->'parties', '[]'::jsonb),
      (v_group->>'firstSeenAt')::timestamptz,
      (v_group->>'lastSeenAt')::timestamptz,
      (v_group->>'confidence')::numeric,
      p_run_id
    )
    on conflict (tenant_id, cluster_key) do nothing
    returning id into v_id;

    if v_id is not null then
      v_created := true;
      v_state := 'proposed';
      v_pinned := false;
    else
      select id, discovery_state, pinned into v_id, v_state, v_pinned
      from deal_candidates
      where tenant_id = p_tenant_id and cluster_key = v_group->>'clusterKey';

      if v_state = 'proposed' and not v_pinned then
        update deal_candidates set
          proposed_name    = v_group->>'proposedName',
          codename_guess   = v_group->>'codenameGuess',
          parties          = coalesce(v_group->'parties', '[]'::jsonb),
          first_seen_at    = least(first_seen_at, (v_group->>'firstSeenAt')::timestamptz),
          last_seen_at     = greatest(last_seen_at, (v_group->>'lastSeenAt')::timestamptz),
          confidence       = (v_group->>'confidence')::numeric,
          discovery_run_id = p_run_id
        where id = v_id;
      end if;
    end if;

    if v_state = 'proposed' and not v_pinned then
      -- Only items of this tenant can become evidence.
      insert into evidence_links (candidate_id, source_item_id, method, confidence, route_tier)
      select v_id, si.id, link->>'method', (link->>'confidence')::numeric, 'firm'
      from jsonb_array_elements(coalesce(v_group->'links', '[]'::jsonb)) as link
      join source_items si on si.id = (link->>'sourceItemId')::uuid and si.tenant_id = p_tenant_id
      on conflict (candidate_id, source_item_id) do nothing;

      perform discovery_refresh_candidate_visibility(v_id);
    end if;

    if v_created then
      select count(*) into v_links from evidence_links where candidate_id = v_id;
      -- No codename, name or party in detail: overseers (admin included) read
      -- audit_log, and a firm admin sees no candidate content (Q19).
      insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
      values (
        p_tenant_id, 'service', 'discovery-worker', 'discovery.candidate_proposed',
        jsonb_build_object('candidateId', v_id, 'runId', p_run_id, 'evidenceCount', v_links)
      );
    end if;

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'clusterKey', v_group->>'clusterKey', 'candidateId', v_id, 'created', v_created
    ));
  end loop;

  return v_result;
end;
$$;

revoke all on function discovery_refresh_candidate_visibility(uuid) from public, anon, authenticated;
revoke all on function discovery_upsert_candidates(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function discovery_refresh_candidate_visibility(uuid) to service_role;
grant execute on function discovery_upsert_candidates(uuid, uuid, jsonb) to service_role;
