-- #461 slice 2: every way a consent ends purges, a backstop collects what a
-- purge could not, and the banker is told what was deleted. Builds on
-- 20261014120500_discovery_purge.sql (the purge trigger and the collector).
--
-- 1. audit_log_action_check restated in full, plus discovery.content_collected
--    and discovery.group_removal_held.
-- 2. mailbox_group_absence: when a successful provider-group check first saw a
--    consented address IN the group, and, once it has gone missing, when it was
--    first and last seen missing.
-- 3. discovery_record_allowlist_drift maintains it, on a successful check only.
-- 4. discovery_withdraw_group_removed: an address that was seen in the group,
--    then missing for the grace period and still missing on a fresh check, has
--    its consent withdrawn (group_removed). An address never seen in the group
--    (a banker who consented and has not been added yet) is never withdrawn.
-- 5. discovery_purge_mailbox also deletes the address's absence rows, and
--    leaves its counts for mailbox_consent_withdraw to return.
-- 6. discovery_collect_orphans_all: the worker's backstop, every tenant.
-- 7. mailbox_consent_withdraw returns what its purge deleted.

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
  'discovery.content_collected', 'discovery.group_removal_held'
])) not valid;

-- ── 2. Group absence ───────────────────────────────────────────────────────
-- mailbox_guard_state cannot tell how long an address has been out of the
-- group: its decided_at moves only when the reason changes, and a paused or
-- halted source is never read, so its reason goes stale. This table is written
-- only by a group check that succeeded, so its times are evidence.
-- A row exists once a successful check has SEEN the address in its group
-- (first_seen_in_group). Only such an address can be withdrawn for leaving the
-- group: a banker who has consented and not yet been added to the group (the
-- consent card says consent, then join, and the group may take days) has no row
-- and is never withdrawn. While the address is missing, missing_since is the
-- first successful check that saw it missing and last_seen_missing the latest;
-- both are null while it is present. The row goes with the address's purge, so
-- a re-consent needs a fresh sighting.
create table if not exists mailbox_group_absence (
  tenant_id           uuid not null,
  provider            text not null check (provider in ('microsoft', 'google')),
  address             text not null check (address = lower(address)),
  first_seen_in_group timestamptz not null default now(),
  missing_since       timestamptz,
  last_seen_missing   timestamptz,
  primary key (tenant_id, provider, address),
  check ((missing_since is null) = (last_seen_missing is null))
);
alter table mailbox_group_absence enable row level security;
revoke all on mailbox_group_absence from public, anon, authenticated, service_role;
grant select, insert, update, delete on mailbox_group_absence to service_role;

-- ── 3. The drift recorder keeps the absence rows ───────────────────────────
-- Unchanged from 20261001160000_mailbox_allowlist_drift.sql, except the new
-- p_present argument and the block marked #461. p_present is what the worker's
-- check saw IN the group among the allowed addresses (the allowlist it read,
-- intersected with the group's members). It is passed in, not derived here
-- from allowed_mailboxes minus p_missing: a consent granted while the group was
-- being read is in neither list, and would be recorded as seen though the
-- check never saw it. Block: on in_sync or drift, every present address that
-- is still allowed gets a row (a first sighting; a row that was missing goes
-- back to present), and every missing address that already has a row records
-- its absence (missing_since kept, last_seen_missing set to now). A missing
-- address with no row has never been seen in the group and gets none. An
-- unavailable check is no evidence either way and touches no row.
drop function if exists discovery_record_allowlist_drift(uuid, text, text, text[], text[]);
create or replace function discovery_record_allowlist_drift(
  p_tenant_id uuid, p_provider text, p_status text, p_missing text[], p_extra text[], p_present text[] default null
)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_missing text[] := (select coalesce(array_agg(distinct lower(m) order by lower(m)), '{}') from unnest(coalesce(p_missing, '{}')) m);
  v_extra   text[] := (select coalesce(array_agg(distinct lower(e) order by lower(e)), '{}') from unnest(coalesce(p_extra, '{}')) e);
  v_present text[] := (select coalesce(array_agg(distinct lower(p) order by lower(p)), '{}') from unnest(coalesce(p_present, '{}')) p);
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
    else (v_prev.status, v_prev.missing_in_group, v_prev.extra_in_group) is distinct from (p_status, v_missing, v_extra)
  end;

  insert into mailbox_allowlist_drift (tenant_id, provider, status, missing_in_group, extra_in_group)
  values (p_tenant_id, p_provider, p_status, v_missing, v_extra)
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
                               'missingInGroup', to_jsonb(v_missing), 'extraInGroup', to_jsonb(v_extra)));
    -- The notification needs a seated admin or CCO of the firm: with none there
    -- are no recipients, and the audit row above is the record (C25). There is
    -- deliberately no fallback principal, so a tenant with nobody seated is
    -- never notified through a user outside the firm.
    if p_status <> 'in_sync' then
      insert into notifications (tenant_id, recipient_id, event_type, payload)
      select p_tenant_id, u.id, 'mailbox_allowlist_drift',
             jsonb_build_object('provider', p_provider, 'status', p_status,
                                'missingCount', cardinality(v_missing), 'extraCount', cardinality(v_extra))
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

-- ── 4. Group removal ends the consent ──────────────────────────────────────
-- Proposed (#461 design entry 4): an address that a successful check saw in its
-- provider group, then missing from it for p_grace, and seen missing by a
-- successful check within p_fresh, has its open consent withdrawn. The grace
-- lets an admin fix a mistaken group edit (drift already notifies them); the
-- freshness test means a failing mirror, or a worker that stopped checking,
-- withdraws nothing; the sighting means a banker who consented and has not yet
-- been added to the group (it may take days) is never withdrawn for it. The
-- sighting precedes the absence (first_seen_in_group < missing_since). The absence must be
-- under the provider of the banker's own mailbox source, the one the purge
-- deletes: an address registered under both providers is missing from one
-- group without being removed from the other (461-R2-02). The withdrawal runs
-- the same purge and audit triggers as any other, with reason group_removed.
--
-- The breaker (#519 review; owner, 2026-10-17, D93): a listing that succeeds
-- but is wrong (an emptied or mis-targeted group) would end every sighted
-- consent of the tenant at once. So a tenant where at least p_min_due consents
-- are due and they exceed p_max_share of its open consents is held: nothing of
-- it is withdrawn, one discovery.group_removal_held row a day records the
-- counts, and the result names it so the worker logs group_removal_held (a
-- notice, not a failure: the hold is the expected pilot state). A hold the
-- operator has not released 24 hours after its oldest withdrawal fell due is
-- overdue, and the worker logs group_removal_overdue instead (the
-- deletion-stuck alarm), so a hold is never forgotten. The defaults are the pilot rule: every group-triggered withdrawal is
-- held (p_max_share 0, p_min_due 1) until an operator who has checked the group
-- releases it with p_max_share => 1. The general rule is p_max_share => 0.3,
-- p_min_due => 3 (GROUP_REMOVAL_BREAKER in src/lib/constants/discovery.ts).
-- Tenants are visited in id order, one statement each, so two runs take the
-- tenants' discovery locks in the same order. Returns {withdrawn, held,
-- holds}: held counts the held tenants, and holds names each one with its
-- due count and whether it is overdue (ids and counts only).
-- The breaker's rule on its own, so the suite pins its arithmetic (the floor
-- included): hold when at least p_min_due consents are due and they are more
-- than p_max_share of the tenant's open consents.
create or replace function discovery_group_removal_holds(
  p_due integer, p_open integer, p_max_share numeric, p_min_due integer
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_due >= p_min_due and p_due > p_max_share * p_open;
$$;
revoke all on function discovery_group_removal_holds(integer, integer, numeric, integer) from public, anon, authenticated;

create or replace function discovery_withdraw_group_removed(
  p_grace     interval default '72 hours',
  p_fresh     interval default '1 hour',
  p_max_share numeric default 0,
  p_min_due   integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_due       record;
  v_open      integer;
  v_n         integer;
  v_withdrawn integer := 0;
  v_held      integer := 0;
  v_holds     jsonb := '[]'::jsonb;
begin
  if p_grace is null or p_fresh is null or p_grace < interval '0' or p_fresh < interval '0'
     or p_max_share is null or p_max_share < 0 or p_max_share > 1 or p_min_due is null or p_min_due < 1 then
    raise exception 'discovery_withdraw_group_removed: bad arguments' using errcode = '22023';
  end if;
  perform set_config('conductia.mailbox_withdraw_reason', 'group_removed', true);
  for v_due in
    select c.tenant_id, array_agg(distinct c.id) as ids, min(a.missing_since) as since
    from mailbox_consents c
    join mailbox_group_absence a on a.tenant_id = c.tenant_id and a.address = c.address
    join content_sources s
      on s.tenant_id = a.tenant_id and s.kind = 'mailbox' and lower(s.address) = a.address
     and s.provider = a.provider and s.archived_at is null and s.owner_user_id = c.user_id
    where a.first_seen_in_group < a.missing_since
      and a.missing_since < now() - p_grace
      and a.last_seen_missing > now() - p_fresh
      and c.withdrawn_at is null
    group by c.tenant_id
    order by c.tenant_id
  loop
    select count(*) into v_open from mailbox_consents where tenant_id = v_due.tenant_id and withdrawn_at is null;
    if discovery_group_removal_holds(cardinality(v_due.ids), v_open, p_max_share, p_min_due) then
      v_held := v_held + 1;
      v_holds := v_holds || jsonb_build_object('tenant', v_due.tenant_id, 'due', cardinality(v_due.ids),
                                               'overdue', v_due.since < now() - p_grace - interval '24 hours');
      if not exists (select 1 from audit_log where tenant_id = v_due.tenant_id and action = 'discovery.group_removal_held'
                                               and ts > now() - interval '24 hours') then
        insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
        values (v_due.tenant_id, 'service', 'discovery-worker', 'discovery.group_removal_held',
                jsonb_build_object('due', cardinality(v_due.ids), 'open', v_open, 'maxShare', p_max_share,
                                   'minDue', p_min_due));
      end if;
      continue;
    end if;
    update mailbox_consents set withdrawn_at = now() where id = any (v_due.ids) and withdrawn_at is null;
    get diagnostics v_n = row_count;
    v_withdrawn := v_withdrawn + v_n;
  end loop;
  perform set_config('conductia.mailbox_withdraw_reason', '', true);
  return jsonb_build_object('withdrawn', v_withdrawn, 'held', v_held, 'holds', v_holds);
end;
$$;
revoke all on function discovery_withdraw_group_removed(interval, interval, numeric, integer) from public, anon, authenticated;
grant execute on function discovery_withdraw_group_removed(interval, interval, numeric, integer) to service_role;

-- ── 5. One consent's purge, restated ───────────────────────────────────────
-- As in 20261014120500_discovery_purge.sql, plus two things. The address's
-- group absence rows go once no open consent of the user holds it. The counts
-- (without the run id) are added to conductia.mailbox_purged for the rest of
-- the transaction, summed when one statement closes several consents, so the
-- withdraw RPC can return them.
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

-- ── 6. The backstop ────────────────────────────────────────────────────────
-- Run by the worker at the top of every tick, before the flag gate: a kill
-- switch stops reading, never deletion. It collects, in every tenant that has
-- one, a message no mailbox holds that is older than the in-flight guard: a
-- page written for a source purged while it was being read, or an item kept
-- under a legal hold since lifted. One discovery.content_collected row per
-- tenant where something was deleted, with the collector's run id and counts:
-- that row is the backstop's only record of what it deleted.
-- Tenants are visited in id order, so two concurrent runs take the tenants'
-- discovery locks in the same order.
create or replace function discovery_collect_orphans_all(p_min_age interval default '15 minutes')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tenant     uuid;
  v_counts     jsonb;
  v_tenants    integer := 0;
  v_items      bigint := 0;
  v_candidates bigint := 0;
  v_held       bigint := 0;
begin
  if p_min_age is null or p_min_age < interval '0' then
    raise exception 'discovery_collect_orphans_all: min age must be zero or more' using errcode = '22023';
  end if;
  for v_tenant in
    select distinct i.tenant_id from source_items i
    where i.kind = 'message' and i.created_at <= now() - p_min_age
      and not exists (select 1 from source_item_sources s where s.source_item_id = i.id)
    order by 1
  loop
    v_counts := discovery_collect_orphans(v_tenant, p_min_age, '{}'::uuid[]);
    v_tenants := v_tenants + 1;
    v_items := v_items + (v_counts->>'items')::bigint;
    v_candidates := v_candidates + (v_counts->>'candidates')::bigint;
    v_held := v_held + (v_counts->>'heldSkipped')::bigint;
    if (v_counts->>'items')::bigint + (v_counts->>'candidates')::bigint + (v_counts->>'corrections')::bigint > 0 then
      insert into audit_log (tenant_id, actor_type, service_identity, action, detail)
      values (v_tenant, 'service', 'discovery-worker', 'discovery.content_collected', v_counts);
    end if;
  end loop;
  return jsonb_build_object('tenants', v_tenants, 'items', v_items, 'candidates', v_candidates, 'heldSkipped', v_held);
end;
$$;
revoke all on function discovery_collect_orphans_all(interval) from public, anon, authenticated;
grant execute on function discovery_collect_orphans_all(interval) to service_role;

-- ── 7. The withdraw RPC returns what was deleted ───────────────────────────
-- As in 20261001130000_mailbox_allowlist.sql, plus `purged`: the counts the
-- purge trigger left in conductia.mailbox_purged, or null when there was no
-- source of the caller's to purge.
create or replace function mailbox_consent_withdraw()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user   uuid := auth.uid();
  v_purged jsonb;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  -- mailbox_consents_audit records each withdrawal, with this user as the actor.
  -- The reason is stated here, as the invite-delete trigger states its own: left
  -- to the audit trigger it is read from the seat, and while the registration is
  -- paused there is no seat, so a voluntary withdrawal would read seat_lost (C13).
  -- The seat-derived reason stays for the seat-loss trigger path only.
  perform set_config('conductia.mailbox_purged', '', true);
  perform set_config('conductia.mailbox_withdraw_reason', 'withdrawn', true);
  update mailbox_consents set withdrawn_at = now()
  where user_id = v_user and withdrawn_at is null;
  perform set_config('conductia.mailbox_withdraw_reason', '', true);
  v_purged := nullif(current_setting('conductia.mailbox_purged', true), '')::jsonb;
  perform set_config('conductia.mailbox_purged', '', true);
  return jsonb_build_object('consented', false, 'purged', v_purged);
end;
$$;
revoke all on function mailbox_consent_withdraw() from public, anon;
grant execute on function mailbox_consent_withdraw() to authenticated;
