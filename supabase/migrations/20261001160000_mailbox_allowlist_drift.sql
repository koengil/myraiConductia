-- Provider group drift (#262, R16). The provider group (Google Group or
-- Exchange group) only mirrors allowed_mailboxes. Each pass records the
-- difference; the worker reads the intersection. A change is audited, and a
-- change to drift or unavailable notifies the tenant's admins and CCO.
-- It also redefines discovery_ingestion_health() for the firm's own admin and CCO (C5),
-- and for a tenant whose registration names no firm yet (item 3 of the PR #300 follow-up).

create table if not exists mailbox_allowlist_drift (
  tenant_id         uuid not null,
  provider          text not null check (provider in ('microsoft', 'google')),
  status            text not null check (status in ('in_sync', 'drift', 'unavailable')),
  missing_in_group  text[] not null default '{}',
  extra_in_group    text[] not null default '{}',
  checked_at        timestamptz not null default now(),
  changed_at        timestamptz not null default now(),
  primary key (tenant_id, provider)
);
alter table mailbox_allowlist_drift enable row level security;
revoke all on mailbox_allowlist_drift from public, anon, authenticated, service_role;
grant select, insert, update, delete on mailbox_allowlist_drift to service_role;

alter table notifications drop constraint if exists notifications_event_type_check;
alter table notifications add constraint notifications_event_type_check
  check (event_type in (
    'deal_created','compliance_hold','nda_pending','nda_signed',
    'phase_promoted','expense_approved','member_added',
    'step_assigned','step_completed',
    'access_requested','access_approved','access_denied',
    'mailbox_allowlist_drift',
    -- A2: a member's one-click opt-in bound a mailbox source; sent to the firm's admins and its CCO
    'mailbox_connected'
  ))
  not valid;

create or replace function discovery_record_allowlist_drift(
  p_tenant_id uuid, p_provider text, p_status text, p_missing text[], p_extra text[]
)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_missing text[] := (select coalesce(array_agg(distinct lower(m) order by lower(m)), '{}') from unnest(coalesce(p_missing, '{}')) m);
  v_extra   text[] := (select coalesce(array_agg(distinct lower(e) order by lower(e)), '{}') from unnest(coalesce(p_extra, '{}')) e);
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
revoke all on function discovery_record_allowlist_drift(uuid, text, text, text[], text[]) from public, anon, authenticated;
grant execute on function discovery_record_allowlist_drift(uuid, text, text, text[], text[]) to service_role;

-- The firm company's admin and CCO read their tenant's drift state; anyone else 42501.
create or replace function discovery_allowlist_health()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_user users%rowtype;
begin
  select * into v_user from users where id = auth.uid() and status = 'active' and is_external = false;
  -- `is not true`, not `not (…)`: with a null company_id the comparison is
  -- null, and `if … or null` would let an unseated admin through (review round 4).
  if not found or v_user.firm_role is null or v_user.firm_role not in ('admin', 'cco')
     or (v_user.company_id = any (firm_company_ids(v_user.tenant_id))) is not true then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'provider', d.provider, 'status', d.status, 'missingInGroup', to_jsonb(d.missing_in_group),
      'extraInGroup', to_jsonb(d.extra_in_group), 'checkedAt', d.checked_at, 'changedAt', d.changed_at)
      order by d.provider)
    from mailbox_allowlist_drift d where d.tenant_id = v_user.tenant_id
  ), '[]'::jsonb);
end;
$$;
revoke all on function discovery_allowlist_health() from public, anon;
grant execute on function discovery_allowlist_health() to authenticated;

-- ── Ingestion health: the firm's own admin and CCO only (C5) ──────────────────
-- discovery_ingestion_health() (20260925150000) admitted any tenant user whose
-- firm_role was admin or cco, seated or not, at any bank. That is not the
-- standing this migration's other control-room functions require, so it is
-- redefined here with the same conditions as discovery_allowlist_health():
-- active, internal, and seated in a company firm_company_ids(tenant) names. The
-- return shape is unchanged, and so is the grant (authenticated, service_role;
-- 20260929180000_discovery_health_grant.sql), restated below. Anything else
-- still gets 42501, which the route answers as 404.
--
-- One exception, for a tenant whose registration names no firm (no registration
-- yet, or one written before the firm was set): there is no seated firm to judge
-- anyone by, and answering 42501 would hide the panel (the route answers 404 and
-- the component renders nothing) from the very admin who has to finish
-- registering. An active, internal admin or CCO of that tenant, develop's
-- predicate plus active and internal, gets develop's no-registration shape:
-- registration null, no sources, zero totals. Nothing of the tenant is shown, so
-- it reveals no more than the 42501 did. Once a firm is named the seated rule
-- above applies and nobody else is admitted.
create or replace function discovery_ingestion_health()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_tenant  uuid;
  v_role    text;
  v_company uuid;
  v_firms   uuid[];
  v_sources jsonb;
begin
  -- An active, internal admin or CCO of the tenant, and, once the registration
  -- names a firm, seated in it (C5), the same standing
  -- discovery_allowlist_health() requires. Any registration status counts, so
  -- disabling the reader does not strip the CCO of the metadata Q1 = B keeps.
  -- `is not true`, not `not (...)`: with no company the comparison is null, and
  -- a null must refuse.
  select tenant_id, firm_role, company_id into v_tenant, v_role, v_company
  from users
  where id = v_uid and status = 'active' and is_external = false;
  if v_uid is null or v_tenant is null or v_role is null or v_role not in ('admin', 'cco') then
    raise exception 'discovery_ingestion_health: not available to this user'
      using errcode = '42501';
  end if;
  v_firms := firm_company_ids(v_tenant);
  if cardinality(v_firms) = 0 then
    -- No firm is named: the no-registration shape, and nothing of the tenant.
    return jsonb_build_object(
      'registration', null,
      'sources', '[]'::jsonb,
      'totals', jsonb_build_object('sources', 0, 'itemsLedgered', 0, 'itemsRouted', 0, 'itemsSkipped', 0,
                                   'itemsStored', 0, 'candidatesProposed', 0));
  end if;
  if (v_company = any (v_firms)) is not true then
    raise exception 'discovery_ingestion_health: not available to this user'
      using errcode = '42501';
  end if;

  with ledger as (
    select l.source_id,
           count(*)                                      as ledgered,
           count(*) filter (where l.decision = 'routed')  as routed,
           count(*) filter (where l.decision = 'skipped') as skipped
    from routing_ledger l
    join content_sources c on c.id = l.source_id
    where c.tenant_id = v_tenant
    group by l.source_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id,
           'kind', c.kind,
           'address', c.address,
           'status', c.status,
           'ownerAssigned', c.owner_user_id is not null,
           'checkpointState', case
             when c.backfill_completed_at is not null then 'incremental'
             when c.delta_checkpoint is not null then 'backfilling'
             else 'not_started'
           end,
           'backfillCompletedAt', c.backfill_completed_at,
           'checkpointUpdatedAt', c.checkpoint_updated_at,
           'lastSyncedAt', c.last_synced_at,
           'lastError', c.last_error,
           'lastErrorAt', c.last_error_at,
           'itemsLedgered', coalesce(l.ledgered, 0),
           'itemsRouted', coalesce(l.routed, 0),
           'itemsSkipped', coalesce(l.skipped, 0)
         ) order by c.kind, lower(c.address)), '[]'::jsonb)
  into v_sources
  from content_sources c
  left join ledger l on l.source_id = c.id
  where c.tenant_id = v_tenant;

  return jsonb_build_object(
    'registration', (
      select jsonb_build_object('status', r.status, 'consentedAt', r.consented_at)
      from graph_reader_registrations r
      where r.tenant_id = v_tenant
    ),
    'sources', v_sources,
    'totals', jsonb_build_object(
      'sources', jsonb_array_length(v_sources),
      'itemsLedgered', coalesce((select sum((s->>'itemsLedgered')::bigint) from jsonb_array_elements(v_sources) s), 0),
      'itemsRouted', coalesce((select sum((s->>'itemsRouted')::bigint) from jsonb_array_elements(v_sources) s), 0),
      'itemsSkipped', coalesce((select sum((s->>'itemsSkipped')::bigint) from jsonb_array_elements(v_sources) s), 0),
      'itemsStored', (select count(*) from source_items si where si.tenant_id = v_tenant),
      'candidatesProposed', (
        select count(*) from deal_candidates dc
        where dc.tenant_id = v_tenant and dc.discovery_state = 'proposed'
      )
    )
  );
end;
$$;
revoke all on function discovery_ingestion_health() from public, anon;
grant execute on function discovery_ingestion_health() to authenticated, service_role;
