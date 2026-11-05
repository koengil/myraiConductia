-- supabase/migrations/20261019110000_team_mailbox_audit_ids.sql
-- Admin-managed team inbox (#581), phase 2: audit rows about a team source carry ids
-- and fixed codes only, never the address.
--
-- A personal mailbox row names the address because the address is the person's own and
-- the audit reader is their firm's admin. A team inbox is the firm's shared mailbox, and
-- the rule for it (design R7) is that no audit row names it: the row says which
-- registration (teamMailboxId) and which source (sourceId), and the reader joins the
-- registry when they need the address. So every writer that can run for a team source
-- drops the address when content_sources.team_mailbox_id is set, and writes
-- teamMailboxId instead. Personal sources are unchanged, key for key.
--
-- Five restatements, each the latest body on this base with only the audit detail changed:
--   1. discovery_set_mailbox_source_status  (20261002181000_discovery_google_connect.sql)
--      pause and resume, by the firm's admin
--   2. discovery_restart_mailbox_source     (20261008210000_discovery_restart_source.sql)
--      restart of a halted source, by the firm's admin
--   3. mailbox_guard_check                  (20261001130000_mailbox_allowlist.sql)
--      the refusal row, discovery.mailbox_refused, written by the worker's guard
--   4. discovery_record_allowlist_drift     (20261014130000_discovery_purge_wiring.sql)
--      a team address in the missing or extra list is recorded as 'team:' || registration id
--   5. discovery_set_mailbox_source_window  (#353, 20261018110000_discovery_set_source_window.sql)
--      a firm admin's first-read window. #353 is on develop (#575), so this restates that body
--      whole, with the same detail branch, and replaces it by version order (20261019110000)
--
-- A registration that was closed still names its address for the audit trail's purposes
-- (audit item 8): a refusal of an address no source holds any more, and a drift entry for it,
-- carry the address's latest team registration id, unless a personal source holds the address
-- now (then it is that person's mailbox, named as any personal one is).
--
-- Each is restated with the search_path pin of 20261016100000 (a create or replace resets
-- the function's settings), and its grants are restated as they stand.
--
-- Not changed, because they already carry ids only: discovery.team_mailbox_* and the
-- archive row discovery_connect_team_mailbox writes (20261019100000), and the reader-pass
-- rows (discovery_reader_pass_valid pins their key set to ids and counts).
-- mailbox_guard_state keeps the address it is keyed by: it is state, not an audit row.

-- ── 1. Pause and resume ────────────────────────────────────────────────────
create or replace function discovery_set_mailbox_source_status(p_source_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_src content_sources;
begin
  if v_uid is null then
    raise exception 'not_available' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('active', 'paused') then
    raise exception 'discovery_set_mailbox_source_status: status must be active or paused' using errcode = '22023';
  end if;
  select * into v_src from content_sources where id = p_source_id for update;
  -- One answer for "no such source", "another tenant's source", "an archived
  -- source", "not a Google mailbox" and "not the firm's admin": the caller learns
  -- nothing about which.
  if not found or v_src.kind <> 'mailbox' or v_src.provider <> 'google' or v_src.archived_at is not null
     or not app_is_firm_admin(v_src.tenant_id, v_uid) then
    raise exception 'not_available' using errcode = '42501';
  end if;

  if v_src.status is distinct from p_status then
    update content_sources set status = p_status where id = v_src.id;
    -- A team source is named by its registration, never by its address (#581).
    insert into audit_log (tenant_id, actor_id, actor_type, action, detail)
    values (v_src.tenant_id, v_uid, 'user', 'discovery.mailbox_access_changed',
            jsonb_build_object('change', case when p_status = 'paused' then 'paused' else 'resumed' end,
                               'provider', v_src.provider, 'sourceId', v_src.id)
            || case when v_src.team_mailbox_id is null
                    then jsonb_build_object('address', lower(v_src.address))
                    else jsonb_build_object('teamMailboxId', v_src.team_mailbox_id) end);
  end if;
  return jsonb_build_object('id', v_src.id, 'status', p_status, 'changed', v_src.status is distinct from p_status);
end;
$$;

revoke all on function discovery_set_mailbox_source_status(uuid, text) from public, anon;
grant execute on function discovery_set_mailbox_source_status(uuid, text) to authenticated, service_role;

-- ── 2. Restart ─────────────────────────────────────────────────────────────
create or replace function discovery_restart_mailbox_source(p_source_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_src content_sources;
begin
  if v_uid is null then
    raise exception 'not_available' using errcode = '42501';
  end if;
  select * into v_src from content_sources where id = p_source_id for update;
  if not found or v_src.kind <> 'mailbox' or v_src.archived_at is not null
     or v_src.last_error is distinct from 'history_window_exceeded'
     or not app_is_firm_admin(v_src.tenant_id, v_uid) then
    raise exception 'not_available' using errcode = '42501';
  end if;
  -- The cooldown, read from the restart's own audit rows (append-only), under the row lock above.
  -- It keys on sourceId, which a team source's row carries too.
  if exists (
    select 1 from audit_log a
     where a.tenant_id = v_src.tenant_id
       and a.action = 'discovery.mailbox_access_changed'
       and a.detail ->> 'change' = 'restarted'
       and a.detail ->> 'sourceId' = v_src.id::text
       and a.ts > now() - interval '86400 seconds'
  ) then
    raise exception 'not_available' using errcode = '42501';
  end if;

  update content_sources
     set last_error = null, last_error_at = null, delta_checkpoint = null,
         backfill_started_at = null, backfill_completed_at = null, history_expiry_streak = 0
   where id = v_src.id;
  -- A team source is named by its registration, never by its address (#581).
  insert into audit_log (tenant_id, actor_id, actor_type, action, detail)
  values (v_src.tenant_id, v_uid, 'user', 'discovery.mailbox_access_changed',
          jsonb_build_object('change', 'restarted', 'provider', v_src.provider, 'sourceId', v_src.id)
          || case when v_src.team_mailbox_id is null
                  then jsonb_build_object('address', lower(v_src.address))
                  else jsonb_build_object('teamMailboxId', v_src.team_mailbox_id) end);
  return jsonb_build_object('id', v_src.id, 'restarted', true);
end;
$$;

revoke all on function discovery_restart_mailbox_source(uuid) from public, anon;
grant execute on function discovery_restart_mailbox_source(uuid) to authenticated, service_role;

-- ── 3. The guard's refusal row ─────────────────────────────────────────────
-- As in 20261001130000_mailbox_allowlist.sql, plus the block marked #581: the source the
-- address names is looked up only when a refusal is about to be written, and a team
-- source's row carries teamMailboxId in place of the address. An address with no source
-- (no_source) has no registration to name and keeps the address, as before.
create or replace function mailbox_guard_check(
  p_tenant_id        uuid,
  p_address          text,
  p_purpose          text,
  p_caller           text,
  p_check_owner      boolean default false,
  p_owner_user_id    uuid default null,
  p_provider_reason  text default null,
  p_provider         text default null
)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_address  text := lower(trim(coalesce(p_address, '')));
  v_reason   text;
  v_changed  integer := 1;
  v_team     uuid;
  v_source   uuid;
begin
  if p_tenant_id is null or v_address = '' then
    raise exception 'mailbox_guard_check: tenant and address are required' using errcode = '22023';
  end if;
  if p_purpose is null or p_purpose not in ('provider_read', 'agent_tool', 'search', 'retrieval', 'export') then
    raise exception 'mailbox_guard_check: unknown purpose' using errcode = '22023';
  end if;
  if p_provider_reason is not null and p_provider_reason not in ('not_in_provider_group', 'mirror_unavailable') then
    raise exception 'mailbox_guard_check: unknown provider reason' using errcode = '22023';
  end if;
  if coalesce(length(trim(p_caller)), 0) not between 1 and 100 then
    raise exception 'mailbox_guard_check: caller is required' using errcode = '22023';
  end if;
  if p_provider is null or p_provider not in ('microsoft', 'google') then
    raise exception 'mailbox_guard_check: a known provider is required' using errcode = '22023';
  end if;
  -- A tool, search, retrieval or export read always binds the source owner
  -- (R4, audit round 1): a caller that leaves the check off is a bug, not a
  -- mode, so it raises instead of skipping the owner comparison.
  if p_purpose in ('agent_tool', 'search', 'retrieval', 'export') and not coalesce(p_check_owner, false) then
    raise exception 'mailbox_guard_check: purpose % requires the owner check', p_purpose using errcode = '22023';
  end if;

  -- The decision itself is mailbox_guard_verdict's (audit round 3, A3), shared with
  -- the member's readiness status. What stays here is the caller's own input: the
  -- worker's provider-group verdict, which is not a database fact, applies only when
  -- the database allows the read.
  v_reason := coalesce(
    mailbox_guard_verdict(p_tenant_id, v_address, p_provider, coalesce(p_check_owner, false), p_owner_user_id),
    p_provider_reason);

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
    -- #581: the registration of the source this address names, if it is a team source.
    -- content_sources holds one row per address, so this is at most one row.
    select s.team_mailbox_id, s.id into v_team, v_source from content_sources s
    where s.tenant_id = p_tenant_id and s.kind = 'mailbox' and lower(s.address) = v_address;
    -- No source holds the address any more (a removed registration's source is archived under
    -- another name): it is named by the latest registration of it, if it ever had one. A
    -- personal source holding the address now is that person's, and keeps the address.
    if v_source is null then
      select t.id into v_team from team_mailboxes t
      where t.tenant_id = p_tenant_id and t.address = v_address
      order by t.connected_at desc, t.id desc limit 1;
    end if;
    insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
    values (p_tenant_id, 'service', trim(p_caller), 'discovery.mailbox_refused',
            jsonb_build_object('reason', v_reason, 'purpose', p_purpose)
            || case when v_team is null
                    then jsonb_build_object('address', v_address)
                    else jsonb_build_object('teamMailboxId', v_team) end);
  end if;
  return v_reason;
end;
$$;
revoke all on function mailbox_guard_check(uuid, text, text, text, boolean, uuid, text, text) from public, anon, authenticated;
grant execute on function mailbox_guard_check(uuid, text, text, text, boolean, uuid, text, text) to service_role;

-- ── 4. The drift recorder ──────────────────────────────────────────────────
-- How the trail names an address that is, or was, a team inbox: 'team:' || the open
-- registration's id, or, with none open and no person's source holding the address now,
-- the closed one whose source still holds the address, else the latest closed one. Null for
-- any other address. Internal to the writers here.
create or replace function discovery_team_audit_ref(p_tenant_id uuid, p_address text)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select 'team:' || t.id::text
  from team_mailboxes t
  left join content_sources held on held.team_mailbox_id = t.id and lower(held.address) = lower(p_address)
  where t.tenant_id = p_tenant_id and t.address = lower(p_address)
    and (t.disconnected_at is null
         or not exists (select 1 from content_sources c
                        where c.tenant_id = p_tenant_id and c.kind = 'mailbox' and lower(c.address) = lower(p_address)
                          and c.owner_user_id is not null and c.archived_at is null))
  order by (t.disconnected_at is null) desc, (held.id is not null) desc, t.connected_at desc, t.id desc
  limit 1;
$$;
revoke all on function discovery_team_audit_ref(uuid, text) from public, anon, authenticated;
grant execute on function discovery_team_audit_ref(uuid, text) to service_role;

-- As in 20261014130000_discovery_purge_wiring.sql, plus the block marked #581. A team
-- address in the missing or extra list is recorded, in the drift state and in its audit
-- row, as 'team:' || the open registration's id. The group-absence bookkeeping below
-- still reads the addresses (it is keyed by them and is not an audit row), and a team
-- address has no row there: absence rows are written from allowed_mailboxes, which a team
-- inbox never reaches.
create or replace function discovery_record_allowlist_drift(
  p_tenant_id uuid, p_provider text, p_status text, p_missing text[], p_extra text[], p_present text[] default null
)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_missing text[] := (select coalesce(array_agg(distinct lower(m) order by lower(m)), '{}') from unnest(coalesce(p_missing, '{}')) m);
  v_extra   text[] := (select coalesce(array_agg(distinct lower(e) order by lower(e)), '{}') from unnest(coalesce(p_extra, '{}')) e);
  v_present text[] := (select coalesce(array_agg(distinct lower(p) order by lower(p)), '{}') from unnest(coalesce(p_present, '{}')) p);
  -- #581: what is stored and audited. An address with a team registration in this tenant
  -- becomes 'team:<registration id>' (discovery_team_audit_ref, above); every other address,
  -- and a closed registration's address that a person's source now holds, is unchanged.
  v_missing_rec text[] := (
    select coalesce(array_agg(distinct q.x order by q.x), '{}')
    from (select coalesce(discovery_team_audit_ref(p_tenant_id, m), m) as x from unnest(v_missing) m) q);
  v_extra_rec text[] := (
    select coalesce(array_agg(distinct q.x order by q.x), '{}')
    from (select coalesce(discovery_team_audit_ref(p_tenant_id, e), e) as x from unnest(v_extra) e) q);
  v_prev    mailbox_allowlist_drift%rowtype;
  v_changed boolean;
begin
  if p_tenant_id is null or p_provider not in ('microsoft', 'google')
     or p_status not in ('in_sync', 'drift', 'unavailable') then
    raise exception 'discovery_record_allowlist_drift: bad arguments' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('allowlist_drift:' || p_tenant_id::text || ':' || p_provider, 0));
  select * into v_prev from mailbox_allowlist_drift where tenant_id = p_tenant_id and provider = p_provider;
  -- A first in-sync record is not news; any later change is.
  v_changed := case
    when not found then p_status <> 'in_sync'
    else (v_prev.status, v_prev.missing_in_group, v_prev.extra_in_group) is distinct from (p_status, v_missing_rec, v_extra_rec)
  end;

  insert into mailbox_allowlist_drift (tenant_id, provider, status, missing_in_group, extra_in_group)
  values (p_tenant_id, p_provider, p_status, v_missing_rec, v_extra_rec)
  on conflict (tenant_id, provider) do update set
    status = excluded.status, missing_in_group = excluded.missing_in_group,
    extra_in_group = excluded.extra_in_group, checked_at = now(),
    changed_at = case when v_changed then now() else mailbox_allowlist_drift.changed_at end;

  -- #461: group removal is judged on successful checks only, and only for an
  -- address seen in the group first.
  if p_status <> 'unavailable' then
    -- Seen in the group. Intersected with the allowlist as it is now, so a
    -- consent purged while the group was read leaves no row behind. A present
    -- row is written once; a row that was missing is cleared, nothing else.
    insert into mailbox_group_absence (tenant_id, provider, address)
    select distinct p_tenant_id, p_provider, am.address
    from allowed_mailboxes am
    where am.tenant_id = p_tenant_id and am.provider = p_provider
      and am.address = any (v_present) and not (am.address = any (v_missing))
    on conflict (tenant_id, provider, address) do update
      set missing_since = null, last_seen_missing = null
      where mailbox_group_absence.missing_since is not null;
    -- Missing after a sighting. Never inserts, so a purge is not undone and a
    -- never-seen address stays without a row.
    update mailbox_group_absence a
    set missing_since = coalesce(a.missing_since, now()), last_seen_missing = now()
    where a.tenant_id = p_tenant_id and a.provider = p_provider and a.address = any (v_missing);
  end if;

  if v_changed then
    insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
    values (p_tenant_id, 'service', 'discovery-worker', 'discovery.allowlist_drift',
            jsonb_build_object('provider', p_provider, 'status', p_status,
                               'missingInGroup', to_jsonb(v_missing_rec), 'extraInGroup', to_jsonb(v_extra_rec)));
    -- The notification needs a seated admin or CCO of the firm: with none there
    -- are no recipients, and the audit row above is the record (C25). There is
    -- deliberately no fallback principal, so a tenant with nobody seated is
    -- never notified through a user outside the firm.
    if p_status <> 'in_sync' then
      insert into notifications (tenant_id, recipient_id, event_type, payload)
      select p_tenant_id, u.id, 'mailbox_allowlist_drift',
             jsonb_build_object('provider', p_provider, 'status', p_status,
                                'missingCount', cardinality(v_missing_rec), 'extraCount', cardinality(v_extra_rec))
      from users u
      where u.tenant_id = p_tenant_id and u.status = 'active' and u.firm_role in ('admin', 'cco')
        and u.is_external = false
        and u.company_id = any (firm_company_ids(p_tenant_id));   -- the firm's own admins (R20)
    end if;
  end if;
  return v_changed;
end;
$$;
revoke all on function discovery_record_allowlist_drift(uuid, text, text, text[], text[], text[]) from public, anon, authenticated;
grant execute on function discovery_record_allowlist_drift(uuid, text, text, text[], text[], text[]) to service_role;

-- ── 5. The first-read window (#353) ─────────────────────────────────────────
-- 20261018110000_discovery_set_source_window.sql's body (#353, slice 3/3), with only the audit
-- detail changed, as for pause and restart: a team source is named by its registration.
create or replace function discovery_set_mailbox_source_window(p_source_id uuid, p_since date)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid   uuid := auth.uid();
  v_today date := (now() at time zone 'utc')::date;
  v_src   content_sources;
begin
  if v_uid is null then
    raise exception 'not_available' using errcode = '42501';
  end if;
  -- The route's gate, held here too: execute is granted to authenticated, so PostgREST reaches this with the flag off.
  if not exists (select 1 from feature_flags where key = 'deal_discovery' and enabled) then
    raise exception 'not_available' using errcode = '42501';
  end if;
  select * into v_src from content_sources where id = p_source_id for update;
  if not found or v_src.kind <> 'mailbox' or v_src.provider <> 'google' or v_src.archived_at is not null
     or not app_is_firm_admin(v_src.tenant_id, v_uid) then
    raise exception 'not_available' using errcode = '42501';
  end if;
  if p_since is null or p_since > v_today or p_since < v_today - 730 then
    raise exception 'out_of_range' using errcode = '22023';
  end if;
  if v_src.delta_checkpoint is not null or v_src.backfill_started_at is not null
     or v_src.backfill_completed_at is not null then
    raise exception 'window_locked' using errcode = '55000';
  end if;

  if v_src.backfill_since is not distinct from p_since then
    return jsonb_build_object('id', v_src.id, 'backfillSince', p_since, 'changed', false);
  end if;
  update content_sources set backfill_since = p_since where id = v_src.id;
  -- A team source is named by its registration, never by its address (#581).
  insert into audit_log (tenant_id, actor_id, actor_type, action, detail)
  values (v_src.tenant_id, v_uid, 'user', 'discovery.mailbox_access_changed',
          jsonb_build_object('change', 'window_set', 'provider', v_src.provider, 'sourceId', v_src.id,
                             'from', v_src.backfill_since, 'to', p_since)
          || case when v_src.team_mailbox_id is null
                  then jsonb_build_object('address', lower(v_src.address))
                  else jsonb_build_object('teamMailboxId', v_src.team_mailbox_id) end);
  return jsonb_build_object('id', v_src.id, 'backfillSince', p_since, 'changed', true);
end;
$$;

revoke all on function discovery_set_mailbox_source_window(uuid, date) from public, anon;
grant execute on function discovery_set_mailbox_source_window(uuid, date) to authenticated, service_role;
