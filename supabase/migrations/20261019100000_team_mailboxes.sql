-- supabase/migrations/20261019100000_team_mailboxes.sql
-- Admin-managed team inbox (#581), phase 1: the registry and the connect RPC.
--
-- A team inbox (deals@) has no person who signs in as it, so it can never pass the
-- invite + opt-in condition of allowed_mailboxes (#262). A firm admin registers it
-- instead, with an attestation that it is a firm mailbox and not a person's. This
-- migration adds only the registry and the way in:
--   1. team_mailboxes, the firm-owned registry. Close-once, one open row per
--      (tenant, address). Written only by the connect RPC (a definer); the check
--      columns are the worker's, from a later phase.
--   2. content_sources.team_mailbox_id, the one source a registration owns. A team
--      source has no owner (owner_user_id stays null) and keeps its address while the
--      registration is open (content_sources_team_fixed).
--   3. discovery_connect_team_mailbox(), the firm admin's connect. Execute is NOT
--      granted to authenticated here: the route that calls it lands in a later phase.
--   4. The five team audit actions, so the audit_log action CHECK is restated once.
--
-- Nothing here lets anything be read. The unchanged guard (mailbox_guard_verdict)
-- finds no allowed_mailboxes row for the ownerless team source and refuses it, and
-- dedupes the refusal, exactly as it refuses any source nobody has opted in. The team
-- branch of the guard, the verification and the visibility rules follow in later phases.
--
-- Audit rows about a team source carry ids and fixed codes only, never the address.
-- (The notification to the firm's admins and CCO does name the address, like
-- mailbox_consent_grant's: it is addressed to them, it is not an audit row.)

-- ── 1. The registry ────────────────────────────────────────────────────────
create table if not exists team_mailboxes (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null,
  -- The bank the registration names as the firm: the connecting admin's company.
  firm_company_id     uuid not null references companies (id),
  -- Gmail only for now; a Microsoft team inbox is refused at connect (provider_unsupported).
  provider            text not null check (provider = 'google'),
  address             text not null
                        check (address = lower(btrim(address)) and length(address) between 3 and 320),
  connected_by        uuid not null references users (id),
  connected_at        timestamptz not null default now(),
  -- The version of the firm-mailbox attestation text the admin ticked.
  attestation_version integer not null check (attestation_version >= 1),
  disconnected_by     uuid references users (id),
  disconnected_at     timestamptz,
  disconnected_reason text check (disconnected_reason in ('never_verified')),
  -- The Google Directory check. Written only by the worker's RPCs.
  check_status        text not null default 'pending' check (check_status in ('pending', 'verified', 'refused')),
  check_reason        text check (check_reason in
                        ('group', 'alias', 'suspended', 'no_mailbox', 'not_found', 'identity_changed', 'directory_denied')),
  checked_at          timestamptz,
  verified_at         timestamptz,
  directory_user_id   text,
  last_check_error    text check (last_check_error in ('directory_error')),
  last_check_error_at timestamptz,
  constraint team_mailboxes_disconnect_pair
    check ((disconnected_at is null) = (disconnected_by is null)
       and (disconnected_at is null) = (disconnected_reason is null)),
  -- A refusal always says why, and nothing else carries a reason.
  constraint team_mailboxes_reason_pair check ((check_status = 'refused') = (check_reason is not null)),
  -- Ready means a check succeeded. A refused row keeps the verified_at it earned.
  constraint team_mailboxes_verified_at check (check_status <> 'verified' or verified_at is not null),
  constraint team_mailboxes_error_pair check ((last_check_error is null) = (last_check_error_at is null))
);
create unique index if not exists team_mailboxes_open
  on team_mailboxes (tenant_id, address) where disconnected_at is null;
create index if not exists team_mailboxes_firm_idx on team_mailboxes (firm_company_id);

-- Who registered it, for which firm, and when never change; a close is written once.
-- The check columns are the only ones left free.
create or replace function team_mailboxes_guard()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if (new.id, new.tenant_id, new.firm_company_id, new.provider, new.address,
      new.connected_by, new.connected_at, new.attestation_version)
       is distinct from
     (old.id, old.tenant_id, old.firm_company_id, old.provider, old.address,
      old.connected_by, old.connected_at, old.attestation_version) then
    raise exception 'team mailbox registrations are append-only' using errcode = 'P0001';
  end if;
  if old.disconnected_at is not null
     and (new.disconnected_at, new.disconnected_by, new.disconnected_reason)
           is distinct from (old.disconnected_at, old.disconnected_by, old.disconnected_reason) then
    raise exception 'a closed team mailbox registration cannot change' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function team_mailboxes_guard() from public, anon, authenticated;
drop trigger if exists team_mailboxes_guard on team_mailboxes;
create trigger team_mailboxes_guard before update on team_mailboxes
  for each row execute function team_mailboxes_guard();

alter table team_mailboxes enable row level security;
-- No policy: deny-all for the signed-in roles. The connect RPC (a definer) is the only
-- writer of a new row; the service role reads, and updates the check columns. Supabase's
-- default privileges give service_role ALL on new tables and a narrower grant does not
-- take one away, so revoke everything first.
revoke all on team_mailboxes from public, anon, authenticated, service_role;
grant select, update on team_mailboxes to service_role;

-- ── 2. The source a registration owns ──────────────────────────────────────
-- restrict: a registration with a source is closed, never deleted.
alter table content_sources
  add column if not exists team_mailbox_id uuid references team_mailboxes (id) on delete restrict;
create unique index if not exists content_sources_team_mailbox_key
  on content_sources (team_mailbox_id) where team_mailbox_id is not null;
-- A team source belongs to the firm: nobody owns it.
alter table content_sources drop constraint if exists content_sources_team_ownerless;
alter table content_sources
  add constraint content_sources_team_ownerless check (team_mailbox_id is null or owner_user_id is null);

-- While the registration is open the source keeps its address and stays ownerless, and
-- it never changes registration. So a personal opt-in cannot adopt or archive a team
-- source (mailbox_consent_grant does both with an update of these columns). Closing the
-- registration is what frees the address to be archived. A definer, so any writer can
-- read the registry whatever its own privileges.
create or replace function content_sources_team_fixed()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.team_mailbox_id is distinct from old.team_mailbox_id then
    raise exception 'team_source_fixed' using errcode = 'P0001';
  end if;
  if (new.owner_user_id is distinct from old.owner_user_id
      or lower(new.address) is distinct from lower(old.address))
     and exists (select 1 from team_mailboxes t where t.id = old.team_mailbox_id and t.disconnected_at is null) then
    raise exception 'team_source_fixed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function content_sources_team_fixed() from public, anon, authenticated;
drop trigger if exists content_sources_team_fixed on content_sources;
create trigger content_sources_team_fixed
  before update of owner_user_id, address, team_mailbox_id on content_sources
  for each row when (old.team_mailbox_id is not null)
  execute function content_sources_team_fixed();

-- ── 3. The connect RPC ─────────────────────────────────────────────────────
-- The firm's admin registers a team inbox. Refusals, each with nothing written:
--   42501 not_authenticated   no session
--   42501 not_eligible        the caller is not an active, internal firm admin
--   P0001 discovery_disabled  the deal_discovery flag is off
--   22023 invalid_address     not a plain address
--   22023 attestation_required  no attestation version
--   22023 provider_unresolved no provider, or more than one, may read the address for the firm
--   22023 provider_unsupported only Microsoft may read it (Gmail only, for now)
--   22023 out_of_range        backfill_since outside today-730 ... today (UTC)
--   23505 person_address      the address is a person's: a user, an invite, or a personal source
-- An open registration for the address is returned as it is: no write, no audit.
-- The source the registration owns is, in this order:
--   - none yet: created, ownerless and active, with the requested window
--   - ownerless with no provenance, and never a team source: adopted, its sync state
--     cleared so it reads from the window
--   - ownerless with provenance, or the source of a closed registration: archived
--     (renamed <address>~xyz, paused, stamped) and a fresh source created, as the opt-in
--     does. The archive audit carries ids only.
-- Audit: discovery.team_mailbox_connected {teamMailboxId, sourceId, attestationVersion}.
-- Notification: the firm's admins and CCO, mailbox_connected.
-- The caller is a session, never a service identity: it reads auth.uid(), so execute is
-- granted to authenticated by the phase that adds its route.
create or replace function discovery_connect_team_mailbox(
  p_address             text,
  p_attestation_version integer,
  p_backfill_since      date default null
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid       uuid := auth.uid();
  v_user      users%rowtype;
  v_address   text := lower(btrim(coalesce(p_address, '')));
  v_today     date := (now() at time zone 'utc')::date;
  v_window    date := coalesce(p_backfill_since, (now() at time zone 'utc')::date - 90);
  v_providers text[];
  v_tm        team_mailboxes%rowtype;
  v_src       content_sources%rowtype;
  v_source    uuid;
  v_since     date;
  v_archived  uuid;
  v_archive_address text;
  v_archive_done    boolean := false;
  v_attempt   integer;
  v_created   boolean := false;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select * into v_user from users where id = v_uid;
  if not found or not app_is_firm_admin(v_user.tenant_id, v_uid) then
    raise exception 'not_eligible' using errcode = '42501';
  end if;
  if not exists (select 1 from feature_flags where key = 'deal_discovery' and enabled) then
    raise exception 'discovery_disabled' using errcode = 'P0001';
  end if;
  if length(v_address) not between 3 and 320 or v_address !~ '^[^@\s~]+@[^@\s~]+\.[^@\s~]+$' then
    raise exception 'invalid_address' using errcode = '22023';
  end if;
  if p_attestation_version is null or p_attestation_version < 1 then
    raise exception 'attestation_required' using errcode = '22023';
  end if;
  -- Gmail only: the address must resolve to exactly one provider for the firm, and it
  -- must be Google.
  v_providers := mailbox_reader_providers(v_user.tenant_id, v_address, v_user.company_id);
  if cardinality(v_providers) <> 1 then
    raise exception 'provider_unresolved' using errcode = '22023';
  end if;
  if v_providers[1] <> 'google' then
    raise exception 'provider_unsupported' using errcode = '22023';
  end if;
  if p_backfill_since is not null and (p_backfill_since > v_today or p_backfill_since < v_today - 730) then
    raise exception 'out_of_range' using errcode = '22023';
  end if;

  -- Two admins connecting one address wait for each other, so the second finds the
  -- first's registration. An advisory lock is not a row lock: the person test below
  -- still runs before any row lock.
  perform pg_advisory_xact_lock(hashtextextended('team_mailbox:' || v_user.tenant_id::text || ':' || v_address, 0));

  select * into v_tm from team_mailboxes t
  where t.tenant_id = v_user.tenant_id and t.address = v_address and t.disconnected_at is null
    and t.firm_company_id = v_user.company_id;
  -- Another firm's open registration of the address is never handed back, nor shadowed by a second one.
  if not found and exists (select 1 from team_mailboxes t
                           where t.tenant_id = v_user.tenant_id and t.address = v_address and t.disconnected_at is null) then
    raise exception 'not_eligible' using errcode = '42501';
  end if;
  if not found then
    -- A person's address is never a team inbox (attestation is a second line, this is the
    -- first): a user, an invite that is pending or accepted, or a source a person owns.
    -- This runs before the source row lock, so the lock order is the opt-in's.
    if exists (select 1 from users u where lower(u.email) = v_address)
       or exists (select 1 from invites i
                  where i.tenant_id = v_user.tenant_id and i.email = v_address and i.status in ('pending', 'accepted'))
       or exists (select 1 from content_sources c
                  where c.tenant_id = v_user.tenant_id and c.kind = 'mailbox' and lower(c.address) = v_address
                    and c.owner_user_id is not null) then
      raise exception 'person_address' using errcode = '23505';
    end if;

    select * into v_src from content_sources cs
    where cs.tenant_id = v_user.tenant_id and cs.kind = 'mailbox' and lower(cs.address) = v_address
    for update;
    -- Someone took the address between the test and the lock.
    if found and v_src.owner_user_id is not null then
      raise exception 'person_address' using errcode = '23505';
    end if;

    -- An earlier holder's mailbox is archived, not handed on: the visibility rule treats
    -- the items attached to a source as its holder's.
    if v_src.id is not null
       and (v_src.team_mailbox_id is not null
            or exists (select 1 from source_item_sources s where s.content_source_id = v_src.id)) then
      v_archived := v_src.id;
      for v_attempt in 1..20 loop
        v_archive_address := v_address || '~' || (
          select string_agg(substr('abcdefghijklmnopqrstuvwxyz0123456789', 1 + floor(random() * 36)::integer, 1), '')
          from generate_series(1, 3));
        begin
          update content_sources
             set address = v_archive_address, status = 'paused',
                 archived_at = now(), archived_from_address = address
           where id = v_archived;
          v_archive_done := true;
          exit;
        exception when unique_violation then
          null;   -- that suffix is taken: draw another
        end;
      end loop;
      if not v_archive_done then
        raise exception 'mailbox_source_archive_failed' using errcode = 'P0001';
      end if;
      -- Whatever the earlier holder's reads were last refused for says nothing of this
      -- registration: left in place, a first refusal for the same reason would be
      -- deduplicated away and never audited.
      delete from mailbox_guard_state where tenant_id = v_user.tenant_id and address = v_address;
      v_src := null;
    end if;

    insert into team_mailboxes (tenant_id, firm_company_id, provider, address, connected_by, attestation_version)
    values (v_user.tenant_id, v_user.company_id, 'google', v_address, v_uid, p_attestation_version)
    returning * into v_tm;
    v_created := true;

    if v_src.id is not null then
      -- Ownerless, nothing attached: adopt it, and start it fresh from the window.
      update content_sources
         set team_mailbox_id = v_tm.id, provider = 'google', status = 'active', backfill_since = v_window,
             delta_checkpoint = null, backfill_completed_at = null, checkpoint_updated_at = null,
             last_synced_at = null, last_error = null, last_error_at = null,
             backfill_started_at = null, history_expiry_streak = 0
       where id = v_src.id;
      v_source := v_src.id;
    else
      insert into content_sources (tenant_id, kind, address, owner_user_id, provider, status, team_mailbox_id, backfill_since)
      values (v_user.tenant_id, 'mailbox', v_address, null, 'google', 'active', v_tm.id, v_window)
      returning id into v_source;
    end if;

    if v_archived is not null then
      insert into audit_log (tenant_id, actor_id, actor_type, action, detail)
      values (v_user.tenant_id, v_uid, 'user', 'discovery.mailbox_source_archived',
              jsonb_build_object('sourceId', v_archived, 'freshSourceId', v_source, 'teamMailboxId', v_tm.id));
    end if;
    insert into audit_log (tenant_id, actor_id, actor_type, action, detail)
    values (v_user.tenant_id, v_uid, 'user', 'discovery.team_mailbox_connected',
            jsonb_build_object('teamMailboxId', v_tm.id, 'sourceId', v_source,
                               'attestationVersion', p_attestation_version));

    -- Tell the firm's admins and its CCO, as the opt-in does: the same recipients (active,
    -- internal, seated in the firm). The payload names the address and the source, no mail.
    insert into notifications (tenant_id, recipient_id, event_type, payload)
    select v_user.tenant_id, u.id, 'mailbox_connected',
           jsonb_build_object('address', v_tm.address, 'outcome', 'team_connected', 'provider', 'google',
                              'sourceId', v_source, 'teamMailboxId', v_tm.id)
    from users u
    where u.tenant_id = v_user.tenant_id and u.status = 'active' and u.firm_role in ('admin', 'cco')
      and u.is_external = false
      and u.company_id = any (firm_company_ids(v_user.tenant_id));
  end if;

  select cs.id, cs.backfill_since into v_source, v_since
  from content_sources cs where cs.team_mailbox_id = v_tm.id;
  return jsonb_build_object(
    'created', v_created,
    'teamMailbox', jsonb_build_object(
      'id', v_tm.id, 'address', v_tm.address, 'provider', v_tm.provider, 'connectedAt', v_tm.connected_at,
      'checkStatus', v_tm.check_status, 'checkReason', v_tm.check_reason, 'checkedAt', v_tm.checked_at,
      'sourceId', v_source, 'backfillSince', v_since));
end;
$$;
-- Closed to every API role until the route that calls it is added.
revoke all on function discovery_connect_team_mailbox(text, integer, date) from public, anon, authenticated;

-- ── 4. Audit actions: #461's list, #490's four, and the five team ones ─────
-- Restated in full from 20261014160000_tenant_retention_policy.sql (the latest on this
-- base), plus the four mailbox.* actions #490 adds (20261017120000_mailbox_connections_google.sql):
-- this version sorts after #490's, so whichever merges first, the CHECK that lands last keeps
-- them. An action nothing writes yet is harmless here.
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
  'discovery.mailbox_retained',
  'mailbox.connected', 'mailbox.connect_refused', 'mailbox.disconnected', 'mailbox.approval_ended',
  'discovery.team_mailbox_connected', 'discovery.team_mailbox_checked', 'discovery.team_mailbox_member_added',
  'discovery.team_mailbox_member_removed', 'discovery.team_mailbox_disconnected'
])) not valid;
