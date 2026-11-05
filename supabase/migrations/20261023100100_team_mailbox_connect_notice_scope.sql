-- supabase/migrations/20261023100100_team_mailbox_connect_notice_scope.sql
-- #173 G-04 2/2: the team connect notice reaches only the inbox's own firm.
--
-- discovery_connect_team_mailbox told the admins and CCOs seated in every bank company
-- firm_company_ids() names for the tenant, that is the companies of both the Google and the Graph
-- reader registrations. A team inbox belongs to one firm (team_mailboxes.firm_company_id), so in a
-- tenant with two bank companies the other bank's admin and CCO were told of this firm's inbox,
-- address included. That was a cross-company leak, found in review round 1 of #173.
--
-- The function is restated whole from its only definition (20261019100000_team_mailboxes.sql). The
-- one change is the recipient predicate of the mailbox_connected insert: u.company_id is now the new
-- registration's firm_company_id (the connecting admin's company, which the insert just wrote),
-- not any company of firm_company_ids(). Recipients are otherwise as before: active, internal
-- admins and CCOs of the tenant. The refusal notice (20261023100000) uses the same predicate. With
-- nobody seated nobody is told, and the discovery.team_mailbox_connected row is the record.
--
-- Unchanged: the gate, the provider resolution, the registry and source writes, the audit rows, the
-- payload {address, outcome:'team_connected', provider, sourceId, teamMailboxId}, the "first open
-- registration only" rule (a repeat connect tells no one) and the return value.
--
-- create or replace keeps the owner and the grants: revoked from public, anon and authenticated in
-- 20261019100000, then granted to authenticated in 20261019120000_team_mailbox_list.sql. The
-- signature is unchanged, so this file has no grant or revoke.
--
-- Reverse: restate the function from 20261019100000_team_mailboxes.sql.

-- ── The connect RPC, its connect notice scoped to the inbox's firm ─────────
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
      and u.company_id = v_tm.firm_company_id;   -- the inbox's own firm only (#173 G-04), never firm_company_ids()
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
