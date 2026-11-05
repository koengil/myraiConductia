-- SharePoint sites (#262, R23; owner decision T10, 2026-09-29). A site is
-- read only when an active, internal firm admin of the bank's own firm has
-- registered its address for that firm, and the tenant's reader is active.
-- No per-user consent: a site is the firm's, not a person's mail. Site items
-- share the discovery content tables, so the RLS helpers gain a site branch.

-- ── 1. The registry ─────────────────────────────────────────────────────────
-- address: the content_sources.address #243 writes, lower-cased: a Graph site
-- id (host,guid,guid) or host:/sites|teams/path, as #243's write-registration
-- SITE pattern accepts.
create table if not exists registered_sites (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  firm_company_id  uuid not null references companies (id),
  address          text not null check (address = lower(btrim(address)) and length(address) between 3 and 400),
  registered_by    uuid not null references users (id),
  registered_at    timestamptz not null default now(),
  unregistered_by  uuid references users (id),
  unregistered_at  timestamptz,
  constraint registered_sites_unregister_pair check ((unregistered_at is null) = (unregistered_by is null)),
  constraint registered_sites_unregister_after check (unregistered_at is null or unregistered_at >= registered_at)
);
create unique index if not exists registered_sites_open
  on registered_sites (tenant_id, address) where unregistered_at is null;
create index if not exists registered_sites_latest
  on registered_sites (tenant_id, address, registered_at desc);

-- A site is read through the Graph reader only: site_guard_check judges every
-- site against the 'microsoft' registration (audit round 2, item 7). A site
-- source of another provider would be judged by the wrong registration, so it
-- cannot exist. Mailboxes are unaffected.
alter table content_sources drop constraint if exists content_sources_site_provider_check;
alter table content_sources
  add constraint content_sources_site_provider_check
  check (kind <> 'sharepoint_site' or provider = 'microsoft');

-- Whether a registrant still stands where the registration validator requires
-- them to stand: an active, internal admin seated in the registered firm. The
-- one definition of that predicate (C10): registered_sites_validate tests it when
-- a row is written, allowed_sites on every read, and site_register and
-- discovery_site_registrations to tell a stale row (its registrant no longer
-- stands) from a live one. Not callable by the API roles.
create or replace function site_registrant_stands(p_tenant_id uuid, p_firm_company_id uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from users u
                 where u.id = p_user and u.tenant_id = p_tenant_id and u.company_id = p_firm_company_id
                   and u.firm_role = 'admin' and u.status = 'active' and u.is_external = false);
$$;
revoke all on function site_registrant_stands(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function site_registrant_stands(uuid, uuid, uuid) to service_role;

-- Every writer, the service role included, must name a real firm admin of a
-- same-tenant bank firm, and that admin must be the session's own user
-- (audit round 1, item 15: a registration is an admin's act, so no writer can
-- record one on an admin's behalf; site_register and site_unregister satisfy it
-- because they write for auth.uid()). P0001, like the other invariant triggers.
create or replace function registered_sites_validate()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_admin uuid := case when tg_op = 'INSERT' then new.registered_by else new.unregistered_by end;
begin
  if tg_op = 'UPDATE' then
    if (new.id, new.tenant_id, new.firm_company_id, new.address, new.registered_by, new.registered_at)
         is distinct from (old.id, old.tenant_id, old.firm_company_id, old.address, old.registered_by, old.registered_at)
       or old.unregistered_at is not null then
      raise exception 'registered_sites rows are append-only' using errcode = 'P0001';
    end if;
    if new.unregistered_at is null then
      return new;   -- a no-op update
    end if;
  elsif new.unregistered_at is not null or new.unregistered_by is not null then
    -- A row is born open, so every unregistration goes through an update and
    -- is audited (review T10 round, C10-3).
    raise exception 'registered_sites rows start open' using errcode = 'P0001';
  end if;
  if auth.uid() is distinct from v_admin then
    raise exception 'site_admin_not_session' using errcode = 'P0001';
  end if;
  if not exists (select 1 from companies c
                 where c.id = new.firm_company_id and c.tenant_id = new.tenant_id and c.type = 'bank') then
    raise exception 'site_firm_not_bank' using errcode = 'P0001';
  end if;
  if not site_registrant_stands(new.tenant_id, new.firm_company_id, v_admin) then
    raise exception 'site_admin_not_firm_admin' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function registered_sites_validate() from public, anon, authenticated;
drop trigger if exists registered_sites_validate on registered_sites;
create trigger registered_sites_validate before insert or update on registered_sites
  for each row execute function registered_sites_validate();

-- The one audit writer for the registry, like mailbox_consents_audit.
create or replace function registered_sites_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_admin   uuid := case when tg_op = 'INSERT' then new.registered_by else new.unregistered_by end;
  v_by_user boolean := auth.uid() is not null and auth.uid() = v_admin;
  v_action  text;
  v_detail  jsonb;
  v_reason  text := nullif(current_setting('conductia.site_close_reason', true), '');
begin
  if tg_op = 'INSERT' then
    v_action := 'discovery.site_registered';
  elsif old.unregistered_at is null and new.unregistered_at is not null then
    v_action := 'discovery.site_unregistered';
  else
    return null;
  end if;
  v_detail := jsonb_build_object('registrationId', new.id, 'address', new.address,
                                 'firmCompanyId', new.firm_company_id, 'adminId', v_admin);
  -- site_register() states why it closes a row that is not the caller's own
  -- (its registrant no longer stands), and whose it was, for the rest of its own
  -- update. Every other close carries neither key.
  if tg_op = 'UPDATE' and v_reason is not null then
    v_detail := v_detail || jsonb_build_object('reason', v_reason, 'registeredBy', new.registered_by);
  end if;
  insert into audit_log (tenant_id, actor_id, actor_type, service_identity, action, detail)
  values (new.tenant_id,
          case when v_by_user then v_admin end,
          case when v_by_user then 'user' else 'service' end,
          case when v_by_user then null else 'site-registry' end,
          v_action, v_detail);
  return null;
end;
$$;
revoke all on function registered_sites_audit() from public, anon, authenticated;
drop trigger if exists registered_sites_audit on registered_sites;
create trigger registered_sites_audit after insert or update on registered_sites
  for each row execute function registered_sites_audit();

alter table registered_sites enable row level security;
-- No delete and no insert for any API role: append-only, and a new row comes
-- only from site_register(). Supabase's default privileges give service_role
-- ALL, so revoke it explicitly before the narrow grant (review T10 round,
-- C10-2; audit round 1, items 15 and 17).
revoke all on registered_sites from public, anon, authenticated, service_role;
grant select, update on registered_sites to service_role;

-- Open registrations of the tenant's firm, while its Graph reader is active
-- and while the registrant still stands where the registration validator
-- required them to stand (C10): an active, internal admin seated in the
-- registered firm. registered_sites_validate tests that when a row is written;
-- this view tests it on every read, so a registrant who is suspended, removed
-- from the firm, made external or stripped of the admin role closes the site
-- at once, with no background job. The row itself stays open, so restoring the
-- registrant reopens the site, or the next firm admin to register the site
-- replaces the row (site_register). One predicate, site_registrant_stands.
-- Sites are read by the Graph reader only, so this joins the active Graph
-- registration directly rather than reader_firm_company_ids(tenant, provider),
-- so no other provider's registration can ever admit a site (review T10 round,
-- C10-1; C5). This view is the only Graph-only reader of the registration on
-- purpose; site_guard_check asks reader_registration_active(tenant, 'microsoft').
create or replace view allowed_sites as
select r.tenant_id, r.address, r.id as registration_id, r.registered_by, r.firm_company_id
from registered_sites r
join graph_reader_registrations g on g.tenant_id = r.tenant_id
                                 and g.status = 'active'
                                 and g.firm_company_id = r.firm_company_id
join companies c on c.id = r.firm_company_id and c.tenant_id = r.tenant_id and c.type = 'bank'
where r.unregistered_at is null
  and site_registrant_stands(r.tenant_id, r.firm_company_id, r.registered_by);
revoke all on allowed_sites from public, anon, authenticated, service_role;
grant select on allowed_sites to service_role;

-- ── 2. Session RPCs: firm admins register and unregister ───────────────────
create or replace function site_register(p_address text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user    users%rowtype;
  v_address text := lower(btrim(coalesce(p_address, '')));
  v_row     registered_sites%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select * into v_user from users
  where id = auth.uid() and status = 'active' and is_external = false and firm_role = 'admin'
  for share;
  if not found or (v_user.company_id = any (firm_company_ids(v_user.tenant_id))) is not true then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_address !~ '^[a-z0-9.-]+\.sharepoint\.(com|us|cn|de)(,[0-9a-f-]{36},[0-9a-f-]{36}|:/(sites|teams)/[^[:space:]]+)$' then
    raise exception 'invalid_site_address' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('site:' || v_user.tenant_id::text || ':' || v_address, 0));
  select * into v_row from registered_sites
  where tenant_id = v_user.tenant_id and address = v_address and unregistered_at is null;
  if found then
    if v_row.firm_company_id is distinct from v_user.company_id then
      raise exception 'registered_by_other_firm' using errcode = 'P0001';
    end if;
    if site_registrant_stands(v_row.tenant_id, v_row.firm_company_id, v_row.registered_by) then
      return jsonb_build_object('registered', true, 'address', v_address, 'since', v_row.registered_at);
    end if;
    -- An open row whose registrant no longer stands admits nothing (allowed_sites
    -- drops it), so to the next firm admin the site is not registered: the stale
    -- row is closed and a new one is written for the caller. The rows are
    -- append-only with close semantics, so this is a close and an insert, each
    -- audited in its own right. The close is the caller's act
    -- (registered_sites_validate requires unregistered_by to be the session user
    -- and a standing firm admin, which the caller is, of the same firm), so it is
    -- bound to the caller and audited as site_unregistered with the reason and
    -- the lapsed registrant; the registration that follows is the caller's own.
    perform set_config('conductia.site_close_reason', 'registrant_lost_standing', true);
    update registered_sites set unregistered_at = now(), unregistered_by = v_user.id where id = v_row.id;
    perform set_config('conductia.site_close_reason', '', true);
  end if;
  insert into registered_sites (tenant_id, firm_company_id, address, registered_by)
  values (v_user.tenant_id, v_user.company_id, v_address, v_user.id)
  returning * into v_row;
  return jsonb_build_object('registered', true, 'address', v_address, 'since', v_row.registered_at);
end;
$$;

create or replace function site_unregister(p_address text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user    users%rowtype;
  v_address text := lower(btrim(coalesce(p_address, '')));
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select * into v_user from users
  where id = auth.uid() and status = 'active' and is_external = false and firm_role = 'admin';
  if not found or (v_user.company_id = any (firm_company_ids(v_user.tenant_id))) is not true then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Only the caller's own firm's registration; another firm's stays untouched.
  update registered_sites set unregistered_at = now(), unregistered_by = v_user.id
  where tenant_id = v_user.tenant_id and address = v_address and unregistered_at is null
    and firm_company_id = v_user.company_id;
  return jsonb_build_object('registered', false, 'address', v_address);
end;
$$;

-- The firm's admins and CCO list the open registrations of their tenant.
create or replace function discovery_site_registrations()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_user users%rowtype;
begin
  select * into v_user from users where id = auth.uid() and status = 'active' and is_external = false;
  if not found or v_user.firm_role is null or v_user.firm_role not in ('admin', 'cco')
     or (v_user.company_id = any (firm_company_ids(v_user.tenant_id))) is not true then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('address', r.address, 'registeredAt', r.registered_at,
                                        'registeredBy', r.registered_by,
                                        -- true when the registrant no longer stands: the site is not read until
                                        -- a firm admin registers it again (site_register replaces the row)
                                        'stale', not site_registrant_stands(r.tenant_id, r.firm_company_id, r.registered_by))
                     order by r.address)
    from registered_sites r
    where r.tenant_id = v_user.tenant_id and r.unregistered_at is null
      and r.firm_company_id = v_user.company_id
  ), '[]'::jsonb);
end;
$$;

revoke all on function site_register(text), site_unregister(text), discovery_site_registrations()
  from public, anon;
grant execute on function site_register(text), site_unregister(text), discovery_site_registrations()
  to authenticated;

-- ── 3. The site guard: a sibling of mailbox_guard_check (R23) ──────────────
create or replace function site_guard_check(p_tenant_id uuid, p_address text, p_purpose text, p_caller text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_address  text := lower(btrim(coalesce(p_address, '')));
  v_latest   registered_sites%rowtype;
  v_reason   text;
  v_changed  integer := 1;
begin
  -- The same argument checks as mailbox_guard_check (tenant, address, purpose, caller).
  if p_tenant_id is null or v_address = '' then
    raise exception 'site_guard_check: tenant and address are required' using errcode = '22023';
  end if;
  if p_purpose is null or p_purpose not in ('provider_read', 'agent_tool', 'search', 'retrieval', 'export') then
    raise exception 'site_guard_check: unknown purpose' using errcode = '22023';
  end if;
  if coalesce(length(btrim(p_caller)), 0) not between 1 and 100 then
    raise exception 'site_guard_check: caller is required' using errcode = '22023';
  end if;

  if not exists (select 1 from allowed_sites a where a.tenant_id = p_tenant_id and a.address = v_address) then
    select * into v_latest from registered_sites
    where tenant_id = p_tenant_id and address = v_address
    order by registered_at desc, id desc limit 1;
    if not found then
      v_reason := 'site_not_registered';
    elsif v_latest.unregistered_at is not null
       or not reader_registration_active(p_tenant_id, 'microsoft') then   -- sites: the Graph reader only
      v_reason := 'registration_inactive';
    elsif not site_registrant_stands(v_latest.tenant_id, v_latest.firm_company_id, v_latest.registered_by) then
      -- Open, and the reader is active, but the registrant no longer stands where the
      -- validator requires (suspended, removed, external, not an admin): allowed_sites
      -- dropped it for that, not for its firm (audit round 3, L8).
      v_reason := 'site_registrant_lost';
    else
      v_reason := 'site_wrong_firm';   -- open, its registrant stands, but not for the reader's firm
    end if;
  end if;

  -- From here on, mailbox_guard_check's tail verbatim, with the action
  -- 'discovery.site_refused': reset mailbox_guard_state on an allowed
  -- provider_read, dedupe provider_read refusals on change, audit every
  -- other refusal, return v_reason.
  if v_reason is null then
    if p_purpose = 'provider_read' then
      update mailbox_guard_state set last_reason = null, decided_at = now()
      where tenant_id = p_tenant_id and address = v_address and last_reason is not null;
    end if;
    return null;
  end if;
  if p_purpose = 'provider_read' then
    insert into mailbox_guard_state (tenant_id, address, last_reason)
    values (p_tenant_id, v_address, v_reason)
    on conflict (tenant_id, address) do update
      set last_reason = excluded.last_reason, decided_at = now()
      where mailbox_guard_state.last_reason is distinct from excluded.last_reason;
    get diagnostics v_changed = row_count;
  end if;
  if v_changed > 0 then
    insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
    values (p_tenant_id, 'service', btrim(p_caller), 'discovery.site_refused',
            jsonb_build_object('address', v_address, 'reason', v_reason, 'purpose', p_purpose));
  end if;
  return v_reason;
end;
$$;
revoke all on function site_guard_check(uuid, text, text, text) from public, anon, authenticated;
grant execute on function site_guard_check(uuid, text, text, text) to service_role;

-- ── 4. RLS: site provenance counts like mail provenance ────────────────────
-- The firm's admin: mirrors app_is_firm_cco (any registration status).
create or replace function app_is_firm_admin(p_tenant_id uuid, p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from users u
                 where u.id = p_user and u.tenant_id = p_tenant_id and u.firm_role = 'admin'
                   and u.status = 'active' and u.is_external = false
                   and u.company_id = any (firm_company_ids(p_tenant_id)));
$$;
revoke all on function app_is_firm_admin(uuid, uuid) from public, anon, authenticated;
grant execute on function app_is_firm_admin(uuid, uuid) to service_role;

-- (1) An item still has an allowed source: an allowlisted mailbox, or a registered site.
-- Every provenance join also requires the item and the source to share a
-- tenant, so a cross-tenant provenance row can never expose an item
-- (review T10 round, C10-5; mail branch included).
create or replace function app_item_has_allowed_source(p_item uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
           select 1 from source_item_sources s
           join source_items si on si.id = s.source_item_id
           join content_sources c on c.id = s.content_source_id and c.kind = 'mailbox'
                                 and c.tenant_id = si.tenant_id
           join allowed_mailboxes a on a.tenant_id = c.tenant_id
                                   and a.address = lower(c.address) and a.user_id = c.owner_user_id
                                   and a.provider = c.provider
           where s.source_item_id = p_item)
      or exists (
           select 1 from source_item_sources s
           join source_items si on si.id = s.source_item_id
           join content_sources c on c.id = s.content_source_id and c.kind = 'sharepoint_site'
                                 and c.tenant_id = si.tenant_id
           join allowed_sites a on a.tenant_id = c.tenant_id and a.address = lower(c.address)
           where s.source_item_id = p_item);
$$;

-- (2) An item's owner: the allowlisted mailbox owner, or, for a site, the
-- admin whose open registration admits it while they remain the firm's admin.
-- content_sources.owner_user_id is ignored for sites.
create or replace function app_owns_item(p_item uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select (coalesce(auth.role(), '') = 'service_role' or p_user = auth.uid())
     and (
       exists (
         select 1
         from source_item_sources s
         join source_items si on si.id = s.source_item_id
         join content_sources c on c.id = s.content_source_id and c.kind = 'mailbox'
                               and c.tenant_id = si.tenant_id
         join users u on u.id = c.owner_user_id and u.tenant_id = c.tenant_id
         join allowed_mailboxes a on a.tenant_id = c.tenant_id
                                 and a.address = lower(c.address)
                                 and a.user_id = c.owner_user_id
                                 and a.provider = c.provider
         where s.source_item_id = p_item and c.owner_user_id = p_user)
       or exists (
         select 1
         from source_item_sources s
         join source_items si on si.id = s.source_item_id
         join content_sources c on c.id = s.content_source_id and c.kind = 'sharepoint_site'
                               and c.tenant_id = si.tenant_id
         join allowed_sites a on a.tenant_id = c.tenant_id and a.address = lower(c.address)
                             and a.registered_by = p_user
         where s.source_item_id = p_item and app_is_firm_admin(c.tenant_id, p_user))
     );
$$;

-- (3) app_can_see_candidate: the body of 20261001150000 with two changes.
-- (a) The non-CCO evidence join now requires a mailbox source
--     join content_sources c on c.id = s.content_source_id and c.kind = 'mailbox'
--                           and c.tenant_id = dc.tenant_id and c.owner_user_id = p_user
--     so site evidence never grants candidate visibility on its own.
-- (b) Item, source and candidate must share a tenant (audit round 1, item 16).
--     The join checked the source's tenant against the candidate's but never
--     the item's, so a candidate whose only evidence was a foreign-tenant item
--     hung on the viewer's own mailbox was admitted. Both the viewer branch and
--     the CCO branch now join source_items on the candidate's tenant, and
--     source_item_sources / evidence_links refuse a cross-tenant row when it is
--     written (section 5).
-- The CCO branch otherwise stays as it is and counts site evidence through (1).
create or replace function app_can_see_candidate(p_candidate uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select (coalesce(auth.role(), '') = 'service_role' or p_user = auth.uid())
     and exists (
       select 1 from deal_candidates dc
       join users u on u.id = p_user and u.tenant_id = dc.tenant_id
       where dc.id = p_candidate
         and (
           (exists (select 1 from candidate_visibility v where v.candidate_id = dc.id and v.person_id = p_user)
            and exists (
              select 1
              from evidence_links l
              join source_items si on si.id = l.source_item_id and si.tenant_id = dc.tenant_id
              join source_item_sources s on s.source_item_id = si.id
              join content_sources c on c.id = s.content_source_id and c.kind = 'mailbox'
                                    and c.tenant_id = dc.tenant_id and c.owner_user_id = p_user
              join allowed_mailboxes a on a.tenant_id = c.tenant_id
                                      and a.address = lower(c.address) and a.user_id = p_user
                                      and a.provider = c.provider
              where l.candidate_id = dc.id and l.state <> 'rejected'
                and (l.route_tier = 'firm' or l.state = 'confirmed')))
           or (app_is_firm_cco(dc.tenant_id, p_user)
               and (app_mailbox_retained_for_control_room(dc.tenant_id, p_user)
                    or exists (select 1 from evidence_links l
                               join source_items si on si.id = l.source_item_id and si.tenant_id = dc.tenant_id
                               where l.candidate_id = dc.id and app_item_has_allowed_source(si.id))))
         )
     );
$$;

-- (4) app_can_see_item, the policies, app_mailbox_retained_for_control_room
-- and discovery_refresh_candidate_visibility are unchanged. They inherit the
-- site branch through (1) and (2). create or replace keeps the grants of
-- app_item_has_allowed_source, app_owns_item and app_can_see_candidate.

-- ── 5. Tenant agreement where provenance and evidence are written ───────────
-- Audit round 1, item 16. discovery_upsert_candidates already keeps a foreign
-- item out of a candidate's links; these two triggers make the same rule hold
-- for every writer, so an item, the source it was seen in and the candidate it
-- backs always share one tenant. The read side (1), (2) and (3) does not rely
-- on it: it checks the same thing, for a row that predates or bypasses these.
create or replace function source_item_sources_tenant_match()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select si.tenant_id from source_items si where si.id = new.source_item_id)
     is distinct from (select c.tenant_id from content_sources c where c.id = new.content_source_id) then
    raise exception 'source_item_sources: item and source must share a tenant' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function source_item_sources_tenant_match() from public, anon, authenticated;
drop trigger if exists source_item_sources_tenant_match on source_item_sources;
create trigger source_item_sources_tenant_match
  before insert or update of source_item_id, content_source_id on source_item_sources
  for each row execute function source_item_sources_tenant_match();

create or replace function evidence_links_tenant_match()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.candidate_id is not null
     and (select si.tenant_id from source_items si where si.id = new.source_item_id)
         is distinct from (select dc.tenant_id from deal_candidates dc where dc.id = new.candidate_id) then
    raise exception 'evidence_links: item and candidate must share a tenant' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function evidence_links_tenant_match() from public, anon, authenticated;
drop trigger if exists evidence_links_tenant_match on evidence_links;
create trigger evidence_links_tenant_match
  before insert or update of candidate_id, source_item_id on evidence_links
  for each row execute function evidence_links_tenant_match();
