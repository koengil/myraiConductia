-- The reader pass record (#370): every discovery reader attempt leaves two
-- chained audit events joined by detail.passId:
--   discovery.reader_pass_started    written before any flag, registration or
--                                    provider call; if it cannot be written,
--                                    nothing is read
--   discovery.reader_pass_finished   written in a finally, with the outcome,
--                                    the counts, the provider, the registration
--                                    and the worker identity
-- Content-free (#331): ids, codes, counts and UTC times only. Never a subject,
-- an address, a filename, a body, a token or a checkpoint.
--
-- discovery_record_reader_pass() is the writer for honest workers: it accepts
-- ids, codes, counts and UTC times only. It is not the only door: service_role
-- keeps direct INSERT on audit_log, so the chain proves that no row was altered
-- or removed, not who wrote it (thread T3). Health reads only rows that pass
-- discovery_reader_pass_consistent(): the writer's shape checks and time bounds
-- against the row's own ts (R2-M5).
--
-- 1. audit_log_action_check restated in full from
--    20261005100000_rail_catalog_publish.sql (develop's latest list), plus
--    the two pass actions.
-- 2. The shape and consistency checks, shared by the writer and by health.
-- 3. Two indexes: one event of each kind per pass, and the latest pass of a
--    source by server time.
-- 4. The writer.

-- ── 1. Two new audit actions ───────────────────────────────────────────────
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
  'discovery.reader_pass_started', 'discovery.reader_pass_finished'
])) not valid;

-- ── 2. Shape and consistency checks (shared by the writer and by health) ──
-- Every check is an explicit if-block: jsonb_object_keys only ever sees an
-- object, and an outer handler turns any surprise into false (R2-m6). None of
-- these raises, so a malformed row written past the writer is ignored, never
-- fatal (R1-M7).

-- The registration a reader authenticated with: null, or exactly {clientId, certThumbprint},
-- each null or code-shaped (a lowercase 40- or 64-hex thumbprint).
create or replace function discovery_reader_pass_registration_ok(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  v_type text := coalesce(jsonb_typeof(p), 'missing');
begin
  if v_type = 'null' then return true; end if;
  if v_type <> 'object' then return false; end if;
  if (select array_agg(k order by k) from jsonb_object_keys(p) k) is distinct from array['certThumbprint', 'clientId'] then
    return false;
  end if;
  if jsonb_typeof(p->'clientId') = 'string' then
    if (p->>'clientId') !~ '^[A-Za-z0-9_.-]{1,64}$' then return false; end if;
  elsif jsonb_typeof(p->'clientId') <> 'null' then
    return false;
  end if;
  if jsonb_typeof(p->'certThumbprint') = 'string' then
    if (p->>'certThumbprint') !~ '^([0-9a-f]{40}|[0-9a-f]{64})$' then return false; end if;
  elsif jsonb_typeof(p->'certThumbprint') <> 'null' then
    return false;
  end if;
  return true;
exception when others then
  return false;
end;
$$;

-- True when the detail has the exact key set and every field health casts or shows is well formed.
create or replace function discovery_reader_pass_valid(p_action text, p_detail jsonb)
returns boolean
language plpgsql
stable
set search_path = public
as $$
declare
  c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  c_code constant text := '^[A-Za-z0-9_.-]{1,64}$';            -- #331 codeShaped
  c_time constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$';
  v_keys text[];
  v_w    jsonb;
  v_f    text;
begin
  if coalesce(jsonb_typeof(p_detail), 'missing') <> 'object' then return false; end if;
  select array_agg(k order by k) into v_keys from jsonb_object_keys(p_detail) k;
  if p_action = 'discovery.reader_pass_started' then
    if v_keys is distinct from array['jobId', 'passId', 'runId', 'sourceId', 'startedAt', 'v', 'worker'] then return false; end if;
  elsif p_action = 'discovery.reader_pass_finished' then
    if v_keys is distinct from array['checkpointAdvanced', 'endedAt', 'excluded', 'fetched', 'jobId', 'pages', 'passId',
                                     'provider', 'reason', 'registration', 'runId', 'sourceId', 'startedAt', 'status',
                                     'stored', 'v', 'worker'] then return false; end if;
  else
    return false;
  end if;
  -- Every key is present from here on, so jsonb_typeof is never SQL null.
  if p_detail->'v' <> '1'::jsonb then return false; end if;
  foreach v_f in array array['passId', 'runId', 'sourceId'] loop
    if jsonb_typeof(p_detail->v_f) <> 'string' or (p_detail->>v_f) !~ c_uuid then return false; end if;
  end loop;
  if jsonb_typeof(p_detail->'jobId') = 'string' then
    if (p_detail->>'jobId') !~ c_uuid then return false; end if;
  elsif jsonb_typeof(p_detail->'jobId') <> 'null' then
    return false;
  end if;
  if jsonb_typeof(p_detail->'startedAt') <> 'string' or (p_detail->>'startedAt') !~ c_time then return false; end if;
  perform (p_detail->>'startedAt')::timestamptz;               -- an impossible date raises → false below
  v_w := p_detail->'worker';
  if jsonb_typeof(v_w) <> 'object' then return false; end if;
  if (select array_agg(k order by k) from jsonb_object_keys(v_w) k) is distinct from array['deployment', 'revision'] then
    return false;
  end if;
  if jsonb_typeof(v_w->'deployment') <> 'string' or (v_w->>'deployment') !~ c_code then return false; end if;
  if jsonb_typeof(v_w->'revision') = 'string' then
    if (v_w->>'revision') !~ '^[0-9a-f]{40}$' then return false; end if;
  elsif jsonb_typeof(v_w->'revision') <> 'null' then
    return false;
  end if;
  if p_action = 'discovery.reader_pass_started' then return true; end if;

  if jsonb_typeof(p_detail->'endedAt') <> 'string' or (p_detail->>'endedAt') !~ c_time then return false; end if;
  perform (p_detail->>'endedAt')::timestamptz;
  if jsonb_typeof(p_detail->'provider') = 'string' then
    if (p_detail->>'provider') not in ('microsoft', 'google') then return false; end if;
  elsif jsonb_typeof(p_detail->'provider') <> 'null' then
    return false;
  end if;
  if not discovery_reader_pass_registration_ok(p_detail->'registration') then return false; end if;
  if jsonb_typeof(p_detail->'status') <> 'string'
     or (p_detail->>'status') not in ('complete', 'page_limit', 'reset', 'paused', 'halted',
                                      'disabled', 'skipped', 'refused', 'failed') then
    return false;
  end if;
  if jsonb_typeof(p_detail->'reason') = 'string' then
    if (p_detail->>'reason') !~ c_code then return false; end if;
  elsif jsonb_typeof(p_detail->'reason') <> 'null' then
    return false;
  end if;
  if jsonb_typeof(p_detail->'checkpointAdvanced') <> 'boolean' then return false; end if;
  foreach v_f in array array['pages', 'fetched', 'excluded', 'stored'] loop
    if jsonb_typeof(p_detail->v_f) <> 'number' or (p_detail->>v_f) !~ '^[0-9]{1,9}$' then return false; end if;
  end loop;
  return true;
exception when others then
  return false;
end;
$$;

-- R2-M5: valid, and inside the writer's time bounds measured against the row's own
-- server ts, so a row written past the writer with impossible times is ignored too.
create or replace function discovery_reader_pass_consistent(p_action text, p_detail jsonb, p_ts timestamptz)
returns boolean
language plpgsql
stable
set search_path = public
as $$
declare
  v_started timestamptz;
  v_ended   timestamptz;
begin
  if p_ts is null or not discovery_reader_pass_valid(p_action, p_detail) then return false; end if;
  v_started := (p_detail->>'startedAt')::timestamptz;
  if p_action = 'discovery.reader_pass_started' then
    return abs(extract(epoch from (p_ts - v_started))) <= 600;
  end if;
  v_ended := (p_detail->>'endedAt')::timestamptz;
  return v_started <= v_ended
     and v_ended <= p_ts + interval '5 minutes'
     and v_started <= p_ts + interval '10 minutes';
exception when others then
  return false;
end;
$$;

revoke all on function discovery_reader_pass_registration_ok(jsonb) from public, anon, authenticated;
revoke all on function discovery_reader_pass_valid(text, jsonb) from public, anon, authenticated;
revoke all on function discovery_reader_pass_consistent(text, jsonb, timestamptz) from public, anon, authenticated;
-- The writer is security invoker and runs as service_role, so the helpers need an explicit grant
-- (new functions carry no PUBLIC execute, #233). Health is security definer and needs none.
grant execute on function discovery_reader_pass_registration_ok(jsonb), discovery_reader_pass_valid(text, jsonb)
  to service_role;

-- ── 3. Indexes ─────────────────────────────────────────────────────────────
-- One event of each kind per pass: a replayed append is a no-op, a second end impossible.
-- One index over both actions, because ON CONFLICT inference over a partial index needs
-- a literal predicate.
create unique index if not exists audit_log_reader_pass_once
  on audit_log (tenant_id, action, (detail->>'passId'))
  where action in ('discovery.reader_pass_started', 'discovery.reader_pass_finished');
-- The latest pass of a source and its last 24 h, by server time (R1-M5); also serves the window (R1-m7).
create index if not exists audit_log_reader_pass_source
  on audit_log (tenant_id, (detail->>'sourceId'), ts desc)
  where action in ('discovery.reader_pass_started', 'discovery.reader_pass_finished');

-- ── 4. The writer ──────────────────────────────────────────────────────────
-- security invoker, service_role only. Shape faults raise 22023. A clock
-- refusal raises P0001 reader_pass_clock_skew and a mismatch P0001
-- reader_pass_mismatch: dbFailure keeps those tokens, so the job error names the
-- cause (R2-m9). A malformed registration is cleaned to null instead (R1-M4), so
-- a completed pass never reads "No end recorded" over a non-outcome field. The
-- source is not looked up: a source deleted since the tick must still get its
-- 'skipped' pass, not a failing start.
create or replace function discovery_record_reader_pass(p_event text, p_tenant_id uuid, p_detail jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_action  text;
  v_other   text;
  v_prior   jsonb;
  v_started timestamptz;
begin
  if p_event = 'started' then
    v_action := 'discovery.reader_pass_started';
    v_other := 'discovery.reader_pass_finished';
  elsif p_event = 'finished' then
    v_action := 'discovery.reader_pass_finished';
    v_other := 'discovery.reader_pass_started';
  else
    raise exception 'discovery_record_reader_pass: unknown event' using errcode = '22023';
  end if;
  if p_tenant_id is null then
    raise exception 'discovery_record_reader_pass: tenant required' using errcode = '22023';
  end if;

  -- R2-M3: the chain trigger's own key (20260925100000_audit_hash_chain.sql), taken
  -- before reading the counterpart, so a start and its end arriving together are judged
  -- against each other. Transaction-level advisory locks are re-entrant: the trigger's
  -- own lock on insert costs nothing more. If audit_chain_append ever changes its key,
  -- change this one with it.
  perform pg_advisory_xact_lock(hashtextextended('audit_log:' || p_tenant_id::text, 0));

  -- R1-M4: clean, never reject, the one non-outcome field.
  if p_event = 'finished' and jsonb_typeof(p_detail) = 'object' and p_detail ? 'registration'
     and not discovery_reader_pass_registration_ok(p_detail->'registration') then
    p_detail := jsonb_set(p_detail, '{registration}', 'null'::jsonb);
  end if;
  if not discovery_reader_pass_valid(v_action, p_detail) then
    raise exception 'discovery_record_reader_pass: invalid % event', p_event using errcode = '22023';
  end if;
  v_started := (p_detail->>'startedAt')::timestamptz;

  -- R2-M4: the same event for this passId already written. Identical → success (a
  -- start committed but acknowledged late, an outbox redelivery), with no age check;
  -- different → a mismatch. Only a NEW event meets the clock bounds below.
  select a.detail into v_prior
  from audit_log a
  where a.tenant_id = p_tenant_id and a.action = v_action and a.detail->>'passId' = p_detail->>'passId';
  if found then
    if v_prior is distinct from p_detail then
      raise exception 'reader_pass_mismatch' using errcode = 'P0001';
    end if;
    return;
  end if;

  -- R1-M5: the worker's clock is bounded against the database's, for a new event only.
  if p_event = 'started' and abs(extract(epoch from (now() - v_started))) > 600 then
    raise exception 'reader_pass_clock_skew' using errcode = 'P0001';
  end if;
  if p_event = 'finished' and (
       v_started > now() + interval '10 minutes'
       or (p_detail->>'endedAt')::timestamptz < v_started
       or (p_detail->>'endedAt')::timestamptz > now() + interval '5 minutes') then
    raise exception 'reader_pass_clock_skew' using errcode = 'P0001';
  end if;

  -- R1-M6: an end belongs to its start, whichever arrives first (serialized by the lock above).
  select a.detail into v_prior
  from audit_log a
  where a.tenant_id = p_tenant_id and a.action = v_other and a.detail->>'passId' = p_detail->>'passId';
  if found and (v_prior->'sourceId', v_prior->'runId', v_prior->'jobId', v_prior->'startedAt', v_prior->'worker')
               is distinct from
               (p_detail->'sourceId', p_detail->'runId', p_detail->'jobId', p_detail->'startedAt', p_detail->'worker') then
    raise exception 'reader_pass_mismatch' using errcode = 'P0001';
  end if;

  insert into audit_log (action, tenant_id, actor_type, service_identity, detail)
  values (v_action, p_tenant_id, 'service', 'discovery-worker', p_detail)
  on conflict (tenant_id, action, (detail->>'passId'))
    where action in ('discovery.reader_pass_started', 'discovery.reader_pass_finished')
  do nothing;   -- unreachable under the lock; kept as the backstop
end;
$$;
revoke all on function discovery_record_reader_pass(text, uuid, jsonb) from public, anon, authenticated;
grant execute on function discovery_record_reader_pass(text, uuid, jsonb) to service_role;
