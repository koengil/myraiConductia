-- #461 slice 7: retention is a per-tenant policy, not hard-coded pilot
-- behaviour (owner decision 2026-10-14, design entry 21). Builds on
-- 20261014150000_discovery_message_index.sql and
-- 20261014151000_discovery_message_index_export.sql.
--
-- One validated row per tenant; a missing row means the pilot values, which
-- are the G0 commitment: content deleted at disconnect, the index deleted at
-- disconnect, the index exported into the tenant purge's report then deleted.
-- Moving a tenant to production is a reviewed policy write, not a migration.
--
-- 1. audit_log_action_check restated in full, plus discovery.retention_policy_set
--    and discovery.mailbox_retained.
-- 2. tenant_retention_policies, read by service_role, written only through
--    tenant_retention_policy_set() (operator identity and reason required),
--    each write audited with both. The pilot values live in one function.
-- 3. tenant_retention_policy(): the effective row, pilot values when missing.
-- 4. discovery_message_index.orphaned_by: why a row outlived its mailbox source
--    (the backstop's bounded work list), and discovery_purge_identifiers
--    restated: a mailbox's index rows go only when index_on_disconnect =
--    'delete'; the rows that stay are marked.
-- 5. discovery_purge_mailbox restated: content_on_disconnect = 'keep' deletes
--    nothing, archives the source (closed to the readers and the index writer)
--    and audits discovery.mailbox_retained.
-- 6. discovery_collect_orphans_all restated: it also deletes marked index rows
--    whose deletion is owed (a hold kept them, or the policy now deletes the
--    index on disconnect); a row kept at tenant end is never its to delete.
-- 7. discovery_purge_tenant restated: the index is deleted only when
--    index_at_tenant_end = 'export_then_delete'; the result carries the policy
--    and counts the rows the policy keeps apart from those legal hold keeps.

-- ── 1. One new audit action ────────────────────────────────────────────────
alter table audit_log drop constraint if exists audit_log_action_check;
alter table audit_log add constraint audit_log_action_check check (action = any (array[
  'view', 'download', 'upload', 'export', 'grant', 'revoke', 'hold_placed', 'hold_lifted', 'create', 'notify',
  'advance', 'attest', 'screen', 'send', 'release', 'invite_sent', 'invite_accepted', 'invite_revoked', 'reject',
  'invite_domain_override', 'invite_challenge_issued', 'invite_challenge_rotated', 'invite_verification_succeeded',
  'invite_verification_locked', 'mfa_enrolled', 'mfa_challenged', 'assign_step', 'complete_step', 'step_work',
  'update', 'skill_authoring.draft_created', 'skill_authoring.draft_archived', 'skill_authoring.message_admitted',
  'skill_authoring.attempt_transitioned', 'skill_authoring.candidate_selected', 'skill_authoring.access_denied',
  'skill_publication.admitted', 'skill_publication.admission_denied', 'skill_publication.duplicate_confirmed',
  'skill_publication.duplicate_declined', 'skill_publication.placement_replaced', 'skill_publication.transition',
  'rail.step_rebound', 'rail.template_created', 'rail.template_replaced', 'rail.template_applied',
  'discovery.candidate_proposed', 'discovery.candidate_promoted', 'discovery.correction',
  'discovery.milestone_extracted', 'discovery.stage_assessed', 'discovery.mailbox_consented',
  'discovery.mailbox_consent_withdrawn', 'discovery.mailbox_refused', 'discovery.allowlist_drift',
  'discovery.site_registered', 'discovery.site_unregistered', 'discovery.site_refused',
  'discovery.mailbox_source_archived', 'discovery.mailbox_sources_unified', 'profile_provisioned',
  'identity_provider_configured', 'identity_provider_removed', 'work_identity_released', 'work_identity_connected',
  'discovery.mailbox_access_changed', 'discovery.exclusion_policy_changed', 'rail.template_published',
  'discovery.reader_pass_started', 'discovery.reader_pass_finished', 'discovery.mailbox_purged',
  'discovery.content_collected', 'discovery.group_removal_held', 'discovery.tenant_purged', 'discovery.retention_policy_set',
  'discovery.mailbox_retained'
])) not valid;

-- ── 2. The policy ──────────────────────────────────────────────────────────
-- The pilot values, stated once: the column defaults and the effective policy
-- of a tenant with no row both read them, so the two cannot drift apart.
create or replace function tenant_retention_pilot_policy()
returns jsonb language sql immutable set search_path = public, pg_temp as $$
  select '{"lifecycle": "pilot", "content_on_disconnect": "delete", "index_on_disconnect": "delete",
           "index_at_tenant_end": "export_then_delete"}'::jsonb;
$$;
revoke all on function tenant_retention_pilot_policy() from public, anon, authenticated;
grant execute on function tenant_retention_pilot_policy() to service_role;

-- Closed choices as checked columns, so the database refuses a bad value and a
-- review diff reads plainly. lifecycle drives no code: it is shown in the purge
-- report, and set to decommissioning before a tenant purge (runbook).
create table if not exists tenant_retention_policies (
  tenant_id             uuid primary key,
  lifecycle             text not null default (tenant_retention_pilot_policy()->>'lifecycle')
                          check (lifecycle in ('pilot', 'production', 'decommissioning')),
  content_on_disconnect text not null default (tenant_retention_pilot_policy()->>'content_on_disconnect')
                          check (content_on_disconnect in ('delete', 'keep')),
  -- Read only when content_on_disconnect = 'delete': a 'keep' withdrawal deletes
  -- nothing, its index included, whatever this says (no CHECK ties the two).
  index_on_disconnect   text not null default (tenant_retention_pilot_policy()->>'index_on_disconnect')
                          check (index_on_disconnect in ('delete', 'keep')),
  index_at_tenant_end   text not null default (tenant_retention_pilot_policy()->>'index_at_tenant_end')
                          check (index_at_tenant_end in ('export_then_delete', 'keep')),
  -- The operator who made the change (tenant_retention_policy_set). Never a secret.
  updated_by            text not null check (btrim(updated_by) <> ''),
  updated_at            timestamptz not null default now()
);
alter table tenant_retention_policies enable row level security;
-- Reads only: every write goes through tenant_retention_policy_set below.
revoke all on tenant_retention_policies from public, anon, authenticated, service_role;
grant select on tenant_retention_policies to service_role;

-- Every write stamps updated_at and writes one audit row: the operator as the
-- actor (service_identity, as discovery_purge_tenant records its operator), the
-- operator and the reason, and the old and new values. The reason comes from
-- tenant_retention_policy_set; a write without one is refused (fail closed),
-- whoever the writer. BEFORE, so the stamp lands; a refused value (CHECK)
-- fails the statement and takes the audit row with it. The reason GUC is a
-- gate only because no API role can write the table (revoked above): granting
-- INSERT or UPDATE to one would let it set the GUC itself and skip the setter.
create or replace function tenant_retention_policies_audit()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_reason text := nullif(btrim(current_setting('conductia.retention_policy_reason', true)), '');
begin
  if v_reason is null then
    raise exception 'tenant_retention_policies: write through tenant_retention_policy_set, with a reason'
      using errcode = '42501';
  end if;
  new.updated_at := now();
  insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
  values (new.tenant_id, 'service', new.updated_by, 'discovery.retention_policy_set',
          jsonb_build_object(
            'operator', new.updated_by,
            'reason', v_reason,
            'old', case when tg_op = 'UPDATE' then to_jsonb(old) - 'tenant_id' - 'updated_at' end,
            'new', to_jsonb(new) - 'tenant_id' - 'updated_at'));
  return new;
end;
$$;
revoke all on function tenant_retention_policies_audit() from public, anon, authenticated, service_role;
drop trigger if exists tenant_retention_policies_audit on tenant_retention_policies;
create trigger tenant_retention_policies_audit before insert or update on tenant_retention_policies
  for each row execute function tenant_retention_policies_audit();

-- ── 3. The effective policy ────────────────────────────────────────────────
-- The tenant's row, or the pilot values when it has none, so every reader
-- agrees on the default.
create or replace function tenant_retention_policy(p_tenant uuid)
returns tenant_retention_policies
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v tenant_retention_policies;
begin
  select * into v from tenant_retention_policies where tenant_id = p_tenant;
  if not found then
    v := jsonb_populate_record(null::tenant_retention_policies,
           tenant_retention_pilot_policy() || jsonb_build_object('tenant_id', p_tenant, 'updated_by', 'default'));
  end if;
  return v;
end;
$$;
revoke all on function tenant_retention_policy(uuid) from public, anon, authenticated;
grant execute on function tenant_retention_policy(uuid) to service_role;

-- The one writer: the reviewed operator write. The operator identity and the
-- reason are required and recorded in the audit row. A null choice keeps the
-- tenant's effective value (the pilot value when it has no row). The tenant's
-- discovery lock orders the write against a purge reading the policy. Update,
-- then insert: an upsert would fire the audit trigger for both.
create or replace function tenant_retention_policy_set(
  p_tenant                uuid,
  p_operator              text,
  p_reason                text,
  p_lifecycle             text default null,
  p_content_on_disconnect text default null,
  p_index_on_disconnect   text default null,
  p_index_at_tenant_end   text default null)
returns tenant_retention_policies
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cur tenant_retention_policies;
  v_row tenant_retention_policies;
begin
  if p_tenant is null then
    raise exception 'tenant_retention_policy_set: tenant is required' using errcode = '22023';
  end if;
  if p_operator is null or btrim(p_operator) = '' then
    raise exception 'tenant_retention_policy_set: operator identity is required' using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'tenant_retention_policy_set: reason is required' using errcode = '22023';
  end if;
  perform discovery_lock_tenant(p_tenant);
  v_cur := tenant_retention_policy(p_tenant);
  perform set_config('conductia.retention_policy_reason', btrim(p_reason), true);
  update tenant_retention_policies set
    lifecycle             = coalesce(p_lifecycle, v_cur.lifecycle),
    content_on_disconnect = coalesce(p_content_on_disconnect, v_cur.content_on_disconnect),
    index_on_disconnect   = coalesce(p_index_on_disconnect, v_cur.index_on_disconnect),
    index_at_tenant_end   = coalesce(p_index_at_tenant_end, v_cur.index_at_tenant_end),
    updated_by            = btrim(p_operator)
  where tenant_id = p_tenant
  returning * into v_row;
  if not found then
    insert into tenant_retention_policies (tenant_id, lifecycle, content_on_disconnect, index_on_disconnect,
                                           index_at_tenant_end, updated_by)
    values (p_tenant, coalesce(p_lifecycle, v_cur.lifecycle), coalesce(p_content_on_disconnect, v_cur.content_on_disconnect),
            coalesce(p_index_on_disconnect, v_cur.index_on_disconnect),
            coalesce(p_index_at_tenant_end, v_cur.index_at_tenant_end), btrim(p_operator))
    returning * into v_row;
  end if;
  perform set_config('conductia.retention_policy_reason', '', true);
  return v_row;
end;
$$;
revoke all on function tenant_retention_policy_set(uuid, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function tenant_retention_policy_set(uuid, text, text, text, text, text, text) to service_role;

-- ── 4. A mailbox's identifiers, the index per the policy ──────────────────
-- orphaned_by is null while the row's mailbox source exists. When a purge
-- deletes the source and the row stays, it says why, so the backstop reads a
-- bounded list (the partial index) instead of anti-joining the whole index:
--   disconnect         a banker's purge kept it: legal hold, or
--                      index_on_disconnect = 'keep'. It goes once unheld while
--                      the tenant's index_on_disconnect is 'delete'.
--   tenant_end_delete  a tenant purge under 'export_then_delete' kept it for a
--                      hold: it goes once unheld, whatever the policy.
--   tenant_end_keep    a tenant purge under index_at_tenant_end = 'keep' kept
--                      it: the backstop never deletes it (a later tenant purge
--                      under 'export_then_delete' does).
-- Rows already without a source were left by a purge before this slice, under
-- the pilot values: marked disconnect.
alter table discovery_message_index
  add column if not exists orphaned_by text
    check (orphaned_by in ('disconnect', 'tenant_end_delete', 'tenant_end_keep'));
create index if not exists discovery_message_index_orphaned_idx
  on discovery_message_index (tenant_id, orphaned_by) where orphaned_by is not null;
update discovery_message_index x set orphaned_by = 'disconnect'
where x.orphaned_by is null and not exists (select 1 from content_sources s where s.id = x.content_source_id);

-- As in 20261014150000_discovery_message_index.sql, except (marked #461 slice
-- 7) the index rows go only when index_on_disconnect is 'delete', and the rows
-- that stay are marked disconnect. p_policy is the policy to apply (the tenant
-- purge passes its own end-of-tenant choice, then marks the rows itself); null
-- reads the tenant's. The link is refreshed either way, so a kept row names its
-- candidate and deal as they were when the mailbox went.
create or replace function discovery_purge_identifiers(p_tenant uuid, p_source uuid, p_policy jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prov   integer;
  v_ledger integer;
  v_taints integer;
  v_index  integer := 0;
begin
  if not exists (select 1 from content_sources
                 where id = p_source and tenant_id = p_tenant and kind = 'mailbox') then
    raise exception 'discovery_purge_identifiers: not a mailbox source of the tenant' using errcode = '22023';
  end if;
  perform discovery_message_index_link(p_tenant, p_source);
  if coalesce(p_policy, to_jsonb(tenant_retention_policy(p_tenant)))->>'index_on_disconnect' = 'delete' then  -- #461 slice 7
    with gone as (
      delete from discovery_message_index x
      where x.tenant_id = p_tenant and x.content_source_id = p_source
        and (x.deal_id is null or not deal_is_under_hold(x.deal_id))
      returning 1)
    select count(*) into v_index from gone;
  end if;
  update discovery_message_index set orphaned_by = 'disconnect'  -- #461 slice 7
  where tenant_id = p_tenant and content_source_id = p_source;
  select count(*) into v_prov from source_item_sources where content_source_id = p_source;
  select count(*) into v_ledger from routing_ledger where source_id = p_source;
  select count(*) into v_taints from discovery_thread_taints where source_id = p_source;
  delete from content_sources where id = p_source;
  return jsonb_build_object('provenance', v_prov, 'ledger', v_ledger, 'taints', v_taints, 'indexRows', v_index);
end;
$$;
revoke all on function discovery_purge_identifiers(uuid, uuid, jsonb) from public, anon, authenticated, service_role;

-- ── 5. One consent's purge, per the policy ─────────────────────────────────
-- As in 20261014130000_discovery_purge_wiring.sql, except (marked #461 slice 7)
-- content_on_disconnect = 'keep' deletes nothing: the source is archived as
-- mailbox_consent_grant archives one (renamed <address>~xyz, paused, stamped),
-- so the readers, the provenance trigger and the index writer refuse it
-- (source_archived) and a later opt-in gets a fresh source; its content and its
-- index stay with it. One discovery.mailbox_retained row records the consent,
-- the source, the reason and the policy applied. The withdraw RPC reports
-- purged null. The address's group absence rows go either way: they are
-- judged against open consents, and this one has ended.
create or replace function discovery_purge_mailbox(p_consent_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_consent  mailbox_consents%rowtype;
  v_source   uuid;
  v_items    uuid[];
  v_touched  uuid[];
  v_counts   jsonb;
  v_prev     jsonb;
  v_reason   text;
  v_by_owner boolean;
  v_cand     uuid;
  v_policy   tenant_retention_policies;
  v_archive  text;
  v_done     boolean := false;
begin
  select * into v_consent from mailbox_consents where id = p_consent_id;
  if not found or v_consent.withdrawn_at is null then
    return null;
  end if;
  -- Lock order: the tenant's discovery lock, then the source row (the BEFORE
  -- trigger has taken both already; taking them again is a no-op).
  perform discovery_lock_tenant(v_consent.tenant_id);
  select cs.id into v_source from content_sources cs
  where cs.tenant_id = v_consent.tenant_id and cs.kind = 'mailbox'
    and lower(cs.address) = v_consent.address and cs.owner_user_id = v_consent.user_id
  for update;
  if exists (select 1 from mailbox_consents o
             where o.tenant_id = v_consent.tenant_id and o.user_id = v_consent.user_id
               and o.address = v_consent.address and o.withdrawn_at is null) then
    return null;
  end if;
  -- The consent has ended: its address is no longer anyone's to judge in the group.
  delete from mailbox_group_absence where tenant_id = v_consent.tenant_id and address = v_consent.address;
  if v_source is null then
    return null;
  end if;

  -- The reason and the actor, as mailbox_consents_audit states them.
  v_reason := coalesce(nullif(current_setting('conductia.mailbox_withdraw_reason', true), ''),
    case when exists (select 1 from mailbox_seated_invites s where s.invite_id = v_consent.invite_id)
         then 'withdrawn' else 'seat_lost' end);
  v_by_owner := auth.uid() is not null and auth.uid() = v_consent.user_id;

  v_policy := tenant_retention_policy(v_consent.tenant_id);  -- #461 slice 7
  if v_policy.content_on_disconnect = 'keep' then
    -- Archive, never delete; the row lock above is held.
    for v_attempt in 1..20 loop
      v_archive := v_consent.address || '~' || (
        select string_agg(substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + floor(random() * 36)::integer, 1), '')
        from generate_series(1, 3));
      begin
        update content_sources
           set address = v_archive, status = 'paused', archived_at = now(), archived_from_address = address
         where id = v_source;
        v_done := true;
        exit;
      exception when unique_violation then
        null;   -- that suffix is taken: draw another
      end;
    end loop;
    if not v_done then
      raise exception 'mailbox_source_archive_failed' using errcode = 'P0001';
    end if;
    insert into audit_log (tenant_id, actor_id, actor_type, service_identity, action, detail)
    values (v_consent.tenant_id,
            case when v_by_owner then v_consent.user_id end,
            case when v_by_owner then 'user' else 'service' end,
            case when v_by_owner then null else 'mailbox-consent' end,
            'discovery.mailbox_retained',
            jsonb_build_object('sourceId', v_source, 'consentId', v_consent.id, 'reason', v_reason,
                               'policy', jsonb_build_object('lifecycle', v_policy.lifecycle,
                                                            'contentOnDisconnect', v_policy.content_on_disconnect,
                                                            'indexOnDisconnect', v_policy.index_on_disconnect)));
    return null;
  end if;

  select coalesce(array_agg(distinct l.candidate_id) filter (where l.candidate_id is not null), '{}'::uuid[])
    into v_touched
  from evidence_links l
  where l.source_item_id in (select s.source_item_id from source_item_sources s where s.content_source_id = v_source);
  select coalesce(array_agg(s.source_item_id), '{}'::uuid[]) into v_items
  from source_item_sources s where s.content_source_id = v_source;

  -- Detach: provenance, ledger and taints cascade.
  v_counts := discovery_purge_identifiers(v_consent.tenant_id, v_source);

  -- Collect: this source's items are orphans at once; anyone else's keep the
  -- in-flight guard.
  v_counts := v_counts || discovery_collect_orphans(v_consent.tenant_id, interval '15 minutes', v_items);

  -- The owner no longer sees the candidates their mailbox backed.
  foreach v_cand in array v_touched loop
    if exists (select 1 from deal_candidates where id = v_cand) then
      perform discovery_refresh_candidate_visibility(v_cand);
    end if;
  end loop;

  insert into audit_log (tenant_id, actor_id, actor_type, service_identity, action, detail)
  values (v_consent.tenant_id,
          case when v_by_owner then v_consent.user_id end,
          case when v_by_owner then 'user' else 'service' end,
          case when v_by_owner then null else 'mailbox-consent' end,
          'discovery.mailbox_purged',
          jsonb_build_object('sourceId', v_source, 'consentId', v_consent.id, 'reason', v_reason) || v_counts);

  -- For mailbox_consent_withdraw: this transaction's purge counts so far.
  v_prev := nullif(current_setting('conductia.mailbox_purged', true), '')::jsonb;
  perform set_config('conductia.mailbox_purged', (
    select jsonb_object_agg(k.key, coalesce((v_prev->>k.key)::bigint, 0) + (k.value)::bigint)
    from jsonb_each_text(v_counts - 'runId') k)::text, true);
  return v_counts;
end;
$$;
revoke all on function discovery_purge_mailbox(uuid) from public, anon, authenticated, service_role;

-- ── 6. The backstop, index rows included ───────────────────────────────────
-- As in 20261014130000_discovery_purge_wiring.sql, plus (marked #461 slice 7)
-- the index rows a purge marked (§4) whose deletion is now owed and no hold
-- keeps: tenant_end_delete always, disconnect while the tenant's
-- index_on_disconnect is 'delete'. tenant_end_keep is never deleted here. The
-- marked rows are found through the partial index, not a scan of the whole
-- index. Counted as indexRows, in the per-tenant discovery.content_collected
-- row and the total.
create or replace function discovery_collect_orphans_all(p_min_age interval default '15 minutes')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant     uuid;
  v_counts     jsonb;
  v_index      integer;
  v_index_del  boolean;
  v_tenants    integer := 0;
  v_items      bigint := 0;
  v_candidates bigint := 0;
  v_held       bigint := 0;
  v_index_all  bigint := 0;
begin
  if p_min_age is null or p_min_age < interval '0' then
    raise exception 'discovery_collect_orphans_all: min age must be zero or more' using errcode = '22023';
  end if;
  for v_tenant in
    select i.tenant_id from source_items i
    where i.kind = 'message' and i.created_at <= now() - p_min_age
      and not exists (select 1 from source_item_sources s where s.source_item_id = i.id)
    union
    select g.tenant_id from (
      select distinct x.tenant_id, x.orphaned_by from discovery_message_index x
      where x.orphaned_by in ('disconnect', 'tenant_end_delete')
        and (x.deal_id is null or not deal_is_under_hold(x.deal_id))) g
    where g.orphaned_by = 'tenant_end_delete'
       or (tenant_retention_policy(g.tenant_id)).index_on_disconnect = 'delete'
    order by 1
  loop
    v_counts := discovery_collect_orphans(v_tenant, p_min_age, '{}'::uuid[]);
    v_index_del := (tenant_retention_policy(v_tenant)).index_on_disconnect = 'delete';
    with gone as (
      delete from discovery_message_index x
      where x.tenant_id = v_tenant
        and (x.orphaned_by = 'tenant_end_delete' or (x.orphaned_by = 'disconnect' and v_index_del))
        and (x.deal_id is null or not deal_is_under_hold(x.deal_id))
      returning 1)
    select count(*) into v_index from gone;
    v_counts := v_counts || jsonb_build_object('indexRows', v_index);
    v_tenants := v_tenants + 1;
    v_items := v_items + (v_counts->>'items')::bigint;
    v_candidates := v_candidates + (v_counts->>'candidates')::bigint;
    v_held := v_held + (v_counts->>'heldSkipped')::bigint;
    v_index_all := v_index_all + v_index;
    if (v_counts->>'items')::bigint + (v_counts->>'candidates')::bigint + (v_counts->>'corrections')::bigint
       + v_index > 0 then
      insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
      values (v_tenant, 'service', 'discovery-worker', 'discovery.content_collected', v_counts);
    end if;
  end loop;
  return jsonb_build_object('tenants', v_tenants, 'items', v_items, 'candidates', v_candidates, 'heldSkipped', v_held,
                            'indexRows', v_index_all);
end;
$$;
revoke all on function discovery_collect_orphans_all(interval) from public, anon, authenticated;
grant execute on function discovery_collect_orphans_all(interval) to service_role;

-- ── 7. The tenant purge, per the policy ────────────────────────────────────
-- As in 20261014151000_discovery_message_index_export.sql, except (marked #461
-- slice 7): the index is exported either way, and deleted only when
-- index_at_tenant_end is 'export_then_delete' (each mailbox's rows through
-- discovery_purge_identifiers, then those an earlier purge left). Every row
-- left is then marked (§4): tenant_end_keep under 'keep', so the backstop
-- never deletes what the policy keeps; tenant_end_delete otherwise (only held
-- rows are left), so it goes once the hold lifts. heldResidueCounts counts
-- the index rows legal hold keeps; policyKeptCounts the rows the retention
-- policy keeps besides, so the operator script's check accepts their sum. The
-- result carries the policy. As in 20261014151000_discovery_message_index_export.sql
-- (#520), it takes the tenant lock, then locks the registration rows before
-- reading their status, and no role holds EXECUTE, the service role included.
create or replace function discovery_purge_tenant(p_tenant uuid, p_actor_identity text default 'purge-tenant')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_policy      tenant_retention_policies;
  v_site_before jsonb;
  v_sources     uuid[];
  v_prov        integer;
  v_ledger      integer;
  v_taints      integer;
  v_index       integer;
  v_export      jsonb;
  v_orphans     uuid[];
  v_counts      jsonb;
  v_source      uuid;
  v_ids         jsonb;
  v_guard       integer;
  v_drift       integer;
  v_absence     integer;
  v_held        uuid[];
  v_held_items  uuid[];
  v_bare_held   uuid[];
  v_residue     jsonb;
  v_residue_n   jsonb;
  v_kept_n      jsonb;
  v_deleted     jsonb;
  v_audit       uuid;
begin
  if p_tenant is null then
    raise exception 'discovery_purge_tenant: tenant is required' using errcode = '22023';
  end if;
  if p_actor_identity is null or btrim(p_actor_identity) = '' then
    raise exception 'discovery_purge_tenant: actor identity is required' using errcode = '22023';
  end if;

  -- Lock order as every other writer: the tenant's discovery lock, then rows.
  -- The registration rows are locked before their status is read, so an
  -- activation cannot land between the check and the purge: it waits for this
  -- transaction, or committed first and is seen here (a fresh snapshot per
  -- statement under READ COMMITTED).
  perform discovery_lock_tenant(p_tenant);
  perform 1 from graph_reader_registrations r where r.tenant_id = p_tenant for update;
  perform 1 from google_reader_registrations g where g.tenant_id = p_tenant for update;
  if exists (select 1 from graph_reader_registrations r where r.tenant_id = p_tenant and r.status = 'active')
     or exists (select 1 from google_reader_registrations g where g.tenant_id = p_tenant and g.status = 'active') then
    raise exception 'discovery_purge_tenant: a reader registration of the tenant is active' using errcode = '55000';
  end if;
  v_policy := tenant_retention_policy(p_tenant);  -- #461 slice 7
  v_site_before := discovery_tenant_site_counts(p_tenant);

  -- The mailboxes, locked before the export: the index writer takes FOR KEY SHARE
  -- on its source, so a page in flight commits before this lock is granted, and
  -- the export (a later statement, a fresh snapshot) sees it. What is exported
  -- is then exactly what is deleted.
  select coalesce(array_agg(s.id order by s.id), '{}'::uuid[]) into v_sources
  from content_sources s where s.tenant_id = p_tenant and s.kind = 'mailbox';
  perform 1 from content_sources s where s.id = any (v_sources) for update;

  -- The index for the bank, its links current, before any delete.
  perform discovery_message_index_link(p_tenant);
  select coalesce(jsonb_agg(jsonb_build_object(
           'messageKey', x.message_key,
           'providerItemIds', to_jsonb(x.provider_item_ids),
           'sourceId', x.content_source_id, 'sentAt', x.sent_at, 'dealId', x.deal_id, 'tags', to_jsonb(x.tags),
           'rulesVersion', x.rules_version, 'model', x.model, 'promptVersion', x.prompt_version,
           'processedAt', x.processed_at)
         order by x.content_source_id, x.message_key), '[]'::jsonb)
    into v_export
  from discovery_message_index x
  where x.tenant_id = p_tenant and (x.deal_id is null or not deal_is_under_hold(x.deal_id));

  -- Detach every mailbox, archived ones included, through the one identifier
  -- delete a per-banker purge uses: provenance, ledger and taints cascade, and
  -- the index rows when the policy deletes the index at tenant end.
  v_prov := 0; v_ledger := 0; v_taints := 0; v_index := 0;
  foreach v_source in array v_sources loop
    v_ids := discovery_purge_identifiers(p_tenant, v_source, jsonb_build_object(
               'index_on_disconnect', case v_policy.index_at_tenant_end when 'keep' then 'keep' else 'delete' end));
    v_prov := v_prov + (v_ids->>'provenance')::integer;
    v_ledger := v_ledger + (v_ids->>'ledger')::integer;
    v_taints := v_taints + (v_ids->>'taints')::integer;
    v_index := v_index + (v_ids->>'indexRows')::integer;
  end loop;
  -- Index rows whose source an earlier purge deleted.
  if v_policy.index_at_tenant_end = 'export_then_delete' then
    with gone as (
      delete from discovery_message_index x
      where x.tenant_id = p_tenant and (x.deal_id is null or not deal_is_under_hold(x.deal_id))
      returning 1)
    select v_index + count(*) into v_index from gone;
  end if;
  update discovery_message_index
     set orphaned_by = case v_policy.index_at_tenant_end when 'keep' then 'tenant_end_keep' else 'tenant_end_delete' end
   where tenant_id = p_tenant;

  -- Collect: every message of the tenant no mailbox holds is an orphan now,
  -- whatever its age.
  select coalesce(array_agg(i.id), '{}'::uuid[]) into v_orphans
  from source_items i
  where i.tenant_id = p_tenant and i.kind = 'message'
    and not exists (select 1 from source_item_sources s where s.source_item_id = i.id);
  v_counts := discovery_collect_orphans(p_tenant, interval '0', v_orphans);

  -- The mail-address caches. A guard row keyed by a site id (no '@') is site state and stays.
  with gone as (delete from mailbox_guard_state where tenant_id = p_tenant and position('@' in address) > 0 returning 1)
  select count(*) into v_guard from gone;
  with gone as (delete from mailbox_allowlist_drift where tenant_id = p_tenant returning 1)
  select count(*) into v_drift from gone;
  with gone as (delete from mailbox_group_absence where tenant_id = p_tenant returning 1)
  select count(*) into v_absence from gone;

  -- What legal hold keeps, per table: the messages evidencing a held candidate
  -- (with what hangs off them), and a held candidate the collector could not
  -- delete for want of evidence (with its own rows).
  select coalesce(array_agg(c.id), '{}'::uuid[]) into v_held
  from deal_candidates c
  where c.tenant_id = p_tenant and c.promoted_deal_id is not null and deal_is_under_hold(c.promoted_deal_id);
  select coalesce(array_agg(distinct i.id), '{}'::uuid[]) into v_held_items
  from source_items i join evidence_links l on l.source_item_id = i.id
  where i.tenant_id = p_tenant and i.kind = 'message' and l.candidate_id = any (v_held);
  select coalesce(array_agg(c), '{}'::uuid[]) into v_bare_held
  from unnest(v_held) c where not exists (select 1 from evidence_links l where l.candidate_id = c);
  v_residue_n := jsonb_build_object(
    'source_items', cardinality(v_held_items),
    'source_item_texts', (select count(*) from source_item_texts where source_item_id = any (v_held_items)),
    'evidence_links', (select count(*) from evidence_links where source_item_id = any (v_held_items)),
    'milestone_events', (select count(*) from milestone_events where source_item_id = any (v_held_items)),
    'model_calls', (select count(*) from model_calls where source_item_id = any (v_held_items)),
    'stage_assessments', (select count(*) from stage_assessments sa
                          where sa.candidate_id = any (v_held)
                            and exists (select 1 from unnest(sa.evidence_event_ids) e
                                        where not exists (select 1 from milestone_events m where m.id = e))),
    'deal_candidates', cardinality(v_bare_held),
    'candidate_visibility', (select count(*) from candidate_visibility where candidate_id = any (v_bare_held)),
    'discovery_recompute_requests', (select count(*) from discovery_recompute_requests where candidate_id = any (v_bare_held)),
    'corrections', (select count(*) from corrections where candidate_id = any (v_bare_held)),
    'discovery_message_index', (select count(*) from discovery_message_index
                                where tenant_id = p_tenant and deal_id is not null and deal_is_under_hold(deal_id)));
  v_kept_n := jsonb_build_object(
    'discovery_message_index', (select count(*) from discovery_message_index
                                where tenant_id = p_tenant and (deal_id is null or not deal_is_under_hold(deal_id))));
  select coalesce(jsonb_agg(jsonb_build_object(
           'candidateId', c.id, 'dealId', c.promoted_deal_id,
           'messages', (select count(distinct l.source_item_id) from evidence_links l
                        where l.candidate_id = c.id and l.source_item_id = any (v_held_items))) order by c.id), '[]'::jsonb)
    into v_residue
  from deal_candidates c where c.id = any (v_held);

  v_deleted := jsonb_build_object('sources', cardinality(v_sources), 'provenance', v_prov, 'ledger', v_ledger,
                                  'taints', v_taints, 'indexRows', v_index)
            || (v_counts - 'runId')
            || jsonb_build_object('guardRows', v_guard, 'driftRows', v_drift, 'absenceRows', v_absence);

  insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
  values (p_tenant, 'service', p_actor_identity, 'discovery.tenant_purged',
          jsonb_build_object('runId', v_counts->'runId') || v_deleted)
  returning id into v_audit;

  return jsonb_build_object(
    'runId', v_counts->'runId',
    'auditId', v_audit,
    'policy', jsonb_build_object('lifecycle', v_policy.lifecycle,
                                 'contentOnDisconnect', v_policy.content_on_disconnect,
                                 'indexOnDisconnect', v_policy.index_on_disconnect,
                                 'indexAtTenantEnd', v_policy.index_at_tenant_end),
    'deleted', v_deleted,
    'site', jsonb_build_object('before', v_site_before, 'after', discovery_tenant_site_counts(p_tenant)),
    'heldResidue', v_residue,
    'heldResidueCounts', v_residue_n,
    'policyKeptCounts', v_kept_n,
    'messageIndex', v_export);
end;
$$;
revoke all on function discovery_purge_tenant(uuid, text) from public, anon, authenticated, service_role;
