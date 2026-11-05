create table if not exists skill_authoring_drafts (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id),
  author_id uuid not null references users(id),
  status text not null default 'active' check (status in ('active','archived','published')),
  name text not null default '' check (char_length(name) <= 100),
  phase_index integer,
  placement_kind text check (placement_kind is null or placement_kind in ('phase_start','phase_end','after')),
  anchor_deal_step_id uuid references deal_steps(id),
  composer_text text not null default '' check (char_length(composer_text) <= 20000),
  edit_revision bigint not null default 0 check (edit_revision >= 0),
  current_candidate_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  published_at timestamptz,
  check ((coalesce(placement_kind = 'after', false)) = (anchor_deal_step_id is not null)),
  check ((status = 'archived') = (archived_at is not null)),
  check ((status = 'published') = (published_at is not null))
);

create unique index if not exists skill_authoring_one_active_draft
  on skill_authoring_drafts(deal_id, author_id) where status = 'active';

create table if not exists skill_authoring_messages (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references skill_authoring_drafts(id),
  author_id uuid not null references users(id),
  ordinal bigint not null check (ordinal >= 1),
  text text not null check (char_length(text) between 1 and 20000),
  client_message_id uuid not null,
  admitted_edit_revision bigint not null check (admitted_edit_revision >= 0),
  created_at timestamptz not null default now(),
  unique (draft_id, client_message_id),
  unique (draft_id, ordinal),
  unique (draft_id, id)
);

create table if not exists skill_authoring_attempts (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references skill_authoring_drafts(id),
  message_id uuid not null,
  attempt_number integer not null check (attempt_number >= 1),
  retry_request_id uuid,
  status text not null default 'running' check (status in ('running','succeeded','failed')),
  response_text text not null default '',
  last_progress_at timestamptz not null default now(),
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (message_id, attempt_number),
  unique (message_id, retry_request_id),
  unique (draft_id, id),
  foreign key (draft_id, message_id) references skill_authoring_messages(draft_id, id)
);

create unique index if not exists skill_authoring_one_running_attempt
  on skill_authoring_attempts(draft_id) where status = 'running';

create table if not exists skill_authoring_candidates (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references skill_authoring_drafts(id),
  attempt_id uuid not null,
  provider_candidate_id uuid not null,
  content_digest text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  schema_version integer not null check (schema_version = 1),
  preview jsonb not null,
  created_at timestamptz not null default now(),
  unique (draft_id, provider_candidate_id),
  unique (draft_id, id),
  constraint skill_authoring_candidates_draft_provider_digest_key unique (draft_id, id, provider_candidate_id, content_digest),
  foreign key (draft_id, attempt_id) references skill_authoring_attempts(draft_id, id)
);

alter table skill_authoring_drafts
  drop constraint if exists skill_authoring_drafts_current_candidate_id_fkey;
alter table skill_authoring_drafts
  add constraint skill_authoring_drafts_current_candidate_id_fkey
  foreign key (id, current_candidate_id)
  references skill_authoring_candidates(draft_id, id)
  deferrable initially deferred;

alter table skill_authoring_drafts enable row level security;
alter table skill_authoring_messages enable row level security;
alter table skill_authoring_attempts enable row level security;
alter table skill_authoring_candidates enable row level security;

grant select, insert, update, delete on skill_authoring_drafts to service_role;
grant select, insert, update, delete on skill_authoring_messages to service_role;
grant select, insert, update, delete on skill_authoring_attempts to service_role;
grant select, insert, update, delete on skill_authoring_candidates to service_role;

alter table audit_log add column if not exists service_identity text;
alter table audit_log alter column actor_id drop not null;
alter table audit_log drop constraint if exists audit_log_actor_or_service_check;
alter table audit_log add constraint audit_log_actor_or_service_check check (
  actor_id is not null or service_identity is not null
);
alter table audit_log drop constraint if exists audit_log_action_check;
alter table audit_log add constraint audit_log_action_check check (action = any (array[
  'view', 'download', 'upload', 'export', 'grant', 'revoke', 'hold_placed', 'hold_lifted', 'create', 'notify',
  'advance', 'attest', 'screen', 'send', 'release', 'invite_sent', 'invite_accepted', 'invite_revoked', 'reject',
  'invite_domain_override', 'invite_challenge_issued', 'invite_challenge_rotated', 'invite_verification_succeeded',
  'invite_verification_locked', 'mfa_enrolled', 'mfa_challenged', 'assign_step', 'complete_step', 'step_work',
  'update', 'skill_authoring.draft_created', 'skill_authoring.draft_archived', 'skill_authoring.message_admitted',
  'skill_authoring.attempt_transitioned', 'skill_authoring.candidate_selected', 'skill_authoring.access_denied'
])) not valid;

create or replace function skill_authoring_attempt_live(p_status text, p_last_progress_at timestamptz)
returns boolean language sql stable set search_path = public as $$
  select p_status = 'running' and p_last_progress_at > now() - interval '60 seconds';
$$;

create or replace function skill_authoring_browser_attempt(p_attempt skill_authoring_attempts)
returns jsonb language sql security definer stable set search_path = public as $$
  select case
    when p_attempt.status = 'running' and not skill_authoring_attempt_live(p_attempt.status, p_attempt.last_progress_at)
    then jsonb_build_object(
      'id', p_attempt.id, 'message_id', p_attempt.message_id, 'attempt_number', p_attempt.attempt_number,
      'retry_request_id', p_attempt.retry_request_id, 'status', 'failed',
      'response_text', p_attempt.response_text, 'error_code', 'generation_interrupted',
      'error_message', 'Generation was interrupted. Try again.')
    else jsonb_build_object(
      'id', p_attempt.id, 'message_id', p_attempt.message_id, 'attempt_number', p_attempt.attempt_number,
      'retry_request_id', p_attempt.retry_request_id, 'status', p_attempt.status,
      'response_text', p_attempt.response_text, 'error_code', p_attempt.error_code,
      'error_message', p_attempt.error_message)
  end;
$$;

create or replace function skill_authoring_browser_messages(p_draft_id uuid)
returns jsonb language sql security definer stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', message.id, 'ordinal', message.ordinal, 'text', message.text,
    'attempts', coalesce((
      select jsonb_agg(skill_authoring_browser_attempt(attempt) order by attempt.attempt_number)
      from skill_authoring_attempts attempt where attempt.message_id = message.id
    ), '[]'::jsonb)
  ) order by message.ordinal), '[]'::jsonb)
  from skill_authoring_messages message where message.draft_id = p_draft_id;
$$;

create or replace function skill_authoring_browser_active_attempt(p_draft_id uuid)
returns jsonb language sql security definer stable set search_path = public as $$
  select skill_authoring_browser_attempt(attempt) from skill_authoring_attempts attempt
  where attempt.draft_id = p_draft_id and attempt.status = 'running'
    and skill_authoring_attempt_live(attempt.status, attempt.last_progress_at)
  order by attempt.created_at desc limit 1;
$$;

create or replace function skill_authoring_browser_candidate(p_candidate_id uuid)
returns jsonb language sql security definer stable set search_path = public as $$
  select jsonb_build_object(
    'id', candidate.id, 'content_digest', candidate.content_digest, 'schema_version', candidate.schema_version,
    'preview', jsonb_build_object(
      'name', candidate.preview ->> 'name', 'purpose', candidate.preview ->> 'purpose',
      'expected_input', candidate.preview ->> 'expectedInput', 'expected_output', candidate.preview ->> 'expectedOutput'
    )
  )
  from skill_authoring_candidates candidate where candidate.id = p_candidate_id;
$$;

create or replace function skill_authoring_browser_draft(p_draft_id uuid)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare v_draft skill_authoring_drafts%rowtype;
begin
  select * into v_draft from skill_authoring_drafts where id = p_draft_id;
  if not found then raise exception 'skill_authoring_draft_not_found' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'id', v_draft.id, 'deal_id', v_draft.deal_id, 'status', v_draft.status, 'name', v_draft.name,
    'phase_index', v_draft.phase_index, 'placement_kind', v_draft.placement_kind,
    'anchor_deal_step_id', v_draft.anchor_deal_step_id, 'composer_text', v_draft.composer_text,
    'edit_revision', v_draft.edit_revision, 'messages', skill_authoring_browser_messages(v_draft.id),
    'active_attempt', skill_authoring_browser_active_attempt(v_draft.id),
    'candidate', skill_authoring_browser_candidate(v_draft.current_candidate_id)
  );
end;
$$;

create or replace function skill_authoring_receipt(
  p_draft skill_authoring_drafts,
  p_message skill_authoring_messages default null,
  p_attempt skill_authoring_attempts default null
) returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object('draft', skill_authoring_browser_draft(p_draft.id))
    || case when p_message is null then '{}'::jsonb else jsonb_build_object('message', to_jsonb(p_message)) end
    || case when p_attempt is null then '{}'::jsonb else jsonb_build_object('attempt', skill_authoring_browser_attempt(p_attempt)) end;
$$;

create or replace function skill_authoring_lock_author(p_actor_id uuid, p_deal_id uuid, p_lock boolean default true)
returns deals language plpgsql security definer set search_path = public as $$
declare v_deal deals%rowtype;
begin
  if p_lock then
    select * into v_deal from deals where id = p_deal_id for update;
  else
    select * into v_deal from deals where id = p_deal_id;
  end if;
  if not found then raise exception 'skill_authoring_deal_not_found' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from deal_memberships membership
    join users actor on actor.id = membership.user_id
    where membership.deal_id = p_deal_id and membership.user_id = p_actor_id
      and actor.status = 'active' and not actor.is_external
  ) or not app_has_company_permission(p_actor_id, v_deal.bank_id, 'company:deals:steps:structure') then
    raise exception 'skill_authoring_forbidden' using errcode = '42501';
  end if;
  return v_deal;
end;
$$;

create or replace function skill_authoring_raise_conflict(p_draft_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_draft jsonb;
begin
  v_draft := skill_authoring_browser_draft(p_draft_id);
  raise exception 'skill_authoring_conflict' using errcode = '40001',
    detail = jsonb_build_object('draft', v_draft, 'active_attempt', v_draft -> 'active_attempt')::text;
end;
$$;

create or replace function skill_authoring_write_audit(
  p_actor_id uuid, p_action text, p_deal_id uuid, p_detail jsonb
) returns void language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log (actor_id, service_identity, action, deal_id, detail)
  values (p_actor_id, case when p_actor_id is null then 'conductia' end, p_action, p_deal_id, p_detail);
end;
$$;

create or replace function skill_authoring_get_or_create_draft(
  p_actor_id uuid, p_deal_id uuid, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_draft skill_authoring_drafts%rowtype;
begin
  perform skill_authoring_lock_author(p_actor_id, p_deal_id);
  select * into v_draft from skill_authoring_drafts
  where deal_id = p_deal_id and author_id = p_actor_id and status = 'active';
  if found then return skill_authoring_receipt(v_draft); end if;
  insert into skill_authoring_drafts (deal_id, author_id) values (p_deal_id, p_actor_id) returning * into v_draft;
  perform skill_authoring_write_audit(p_actor_id, 'skill_authoring.draft_created', p_deal_id,
    jsonb_build_object('draftId', v_draft.id, 'actorId', p_actor_id, 'toState', v_draft.status, 'correlationId', p_correlation_id));
  return skill_authoring_receipt(v_draft);
end;
$$;

create or replace function skill_authoring_patch_draft(
  p_actor_id uuid, p_deal_id uuid, p_draft_id uuid, p_expected_revision bigint,
  p_name text, p_phase_index integer, p_placement_kind text, p_anchor_step_id uuid,
  p_composer_text text, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_draft skill_authoring_drafts%rowtype;
begin
  perform skill_authoring_lock_author(p_actor_id, p_deal_id);
  select * into v_draft from skill_authoring_drafts
  where id = p_draft_id and deal_id = p_deal_id and author_id = p_actor_id for update;
  if not found then raise exception 'skill_authoring_draft_not_found' using errcode = 'P0002'; end if;
  if v_draft.status <> 'active' or v_draft.edit_revision <> p_expected_revision then
    perform skill_authoring_raise_conflict(v_draft.id);
  end if;
  if p_name is null or p_composer_text is null
    or char_length(p_name) > 0 and btrim(p_name) = ''
    or char_length(p_name) > 100 or char_length(p_composer_text) > 20000
    or p_phase_index is not null and p_phase_index < 0
    or p_placement_kind not in ('phase_start', 'phase_end', 'after')
    or (p_placement_kind = 'after' and (
      p_phase_index is null or p_anchor_step_id is null or not exists (
        select 1 from deal_steps where id = p_anchor_step_id and deal_id = p_deal_id
      )
    ))
    or (p_placement_kind in ('phase_start', 'phase_end') and (
      p_phase_index is null or p_anchor_step_id is not null
    ))
    or (p_placement_kind is null and (p_phase_index is not null or p_anchor_step_id is not null))
  then raise exception 'skill_authoring_invalid_draft_patch' using errcode = '22023'; end if;
  update skill_authoring_drafts set
    name = p_name, phase_index = p_phase_index, placement_kind = p_placement_kind,
    anchor_deal_step_id = p_anchor_step_id, composer_text = p_composer_text,
    edit_revision = edit_revision + 1, updated_at = now()
  where id = v_draft.id returning * into v_draft;
  return skill_authoring_receipt(v_draft);
end;
$$;

create or replace function skill_authoring_discard_draft(
  p_actor_id uuid, p_deal_id uuid, p_draft_id uuid, p_expected_revision bigint, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_draft skill_authoring_drafts%rowtype;
begin
  perform skill_authoring_lock_author(p_actor_id, p_deal_id);
  select * into v_draft from skill_authoring_drafts
  where id = p_draft_id and deal_id = p_deal_id and author_id = p_actor_id for update;
  if not found then raise exception 'skill_authoring_draft_not_found' using errcode = 'P0002'; end if;
  if v_draft.status <> 'active' or v_draft.edit_revision <> p_expected_revision then
    perform skill_authoring_raise_conflict(v_draft.id);
  end if;
  update skill_authoring_drafts set status = 'archived', archived_at = now(), updated_at = now()
  where id = v_draft.id returning * into v_draft;
  perform skill_authoring_write_audit(p_actor_id, 'skill_authoring.draft_archived', p_deal_id,
    jsonb_build_object('draftId', v_draft.id, 'actorId', p_actor_id, 'fromState', 'active', 'toState', 'archived', 'correlationId', p_correlation_id));
  return skill_authoring_receipt(v_draft);
end;
$$;

create or replace function skill_authoring_read_draft(
  p_actor_id uuid, p_deal_id uuid, p_draft_id uuid, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_draft skill_authoring_drafts%rowtype;
begin
  perform skill_authoring_lock_author(p_actor_id, p_deal_id, false);
  select * into v_draft from skill_authoring_drafts
  where id = p_draft_id and deal_id = p_deal_id and author_id = p_actor_id;
  if not found then raise exception 'skill_authoring_draft_not_found' using errcode = 'P0002'; end if;
  return jsonb_build_object('draft', skill_authoring_browser_draft(v_draft.id));
end;
$$;

create or replace function skill_authoring_submit_message(
  p_actor_id uuid, p_deal_id uuid, p_draft_id uuid, p_expected_revision bigint,
  p_client_message_id uuid, p_text text, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_draft skill_authoring_drafts%rowtype;
  v_message skill_authoring_messages%rowtype;
  v_attempt skill_authoring_attempts%rowtype;
  v_ordinal bigint;
begin
  perform skill_authoring_lock_author(p_actor_id, p_deal_id);
  select * into v_draft from skill_authoring_drafts
  where id = p_draft_id and deal_id = p_deal_id and author_id = p_actor_id for update;
  if not found then raise exception 'skill_authoring_draft_not_found' using errcode = 'P0002'; end if;
  if v_draft.status <> 'active' then perform skill_authoring_raise_conflict(v_draft.id); end if;

  update skill_authoring_attempts set status = 'failed', error_code = 'generation_interrupted',
    error_message = 'Generation was interrupted. Try again.', completed_at = now()
  where draft_id = v_draft.id and status = 'running' and not skill_authoring_attempt_live(status, last_progress_at);

  select * into v_message from skill_authoring_messages
  where draft_id = p_draft_id and client_message_id = p_client_message_id for update;
  if found then
    if v_message.text is distinct from p_text then perform skill_authoring_raise_conflict(v_draft.id); end if;
    select * into v_attempt from skill_authoring_attempts where message_id = v_message.id and attempt_number = 1;
    if not found then raise exception 'skill_authoring_message_receipt_missing' using errcode = 'P0001'; end if;
    return skill_authoring_receipt(v_draft, v_message, v_attempt) || jsonb_build_object('created', false);
  end if;

  if v_draft.edit_revision <> p_expected_revision or p_client_message_id is null
    or p_text is null or char_length(p_text) not between 1 and 20000 then
    perform skill_authoring_raise_conflict(v_draft.id);
  end if;
  if exists (select 1 from skill_authoring_attempts where draft_id = p_draft_id and status = 'running') then
    perform skill_authoring_raise_conflict(v_draft.id);
  end if;

  select coalesce(max(ordinal), 0) + 1 into v_ordinal from skill_authoring_messages where draft_id = p_draft_id;
  insert into skill_authoring_messages (draft_id, author_id, ordinal, text, client_message_id, admitted_edit_revision)
  values (p_draft_id, p_actor_id, v_ordinal, p_text, p_client_message_id, v_draft.edit_revision + 1)
  returning * into v_message;
  insert into skill_authoring_attempts (draft_id, message_id, attempt_number)
  values (p_draft_id, v_message.id, 1) returning * into v_attempt;
  update skill_authoring_drafts set composer_text = case when composer_text = p_text then '' else composer_text end,
    edit_revision = edit_revision + 1, updated_at = now() where id = v_draft.id returning * into v_draft;

  perform skill_authoring_write_audit(p_actor_id, 'skill_authoring.message_admitted', p_deal_id,
    jsonb_build_object('draftId', v_draft.id, 'messageId', v_message.id, 'attemptId', v_attempt.id,
      'actorId', p_actor_id, 'correlationId', p_correlation_id));
  perform skill_authoring_write_audit(p_actor_id, 'skill_authoring.attempt_transitioned', p_deal_id,
    jsonb_build_object('draftId', v_draft.id, 'messageId', v_message.id, 'attemptId', v_attempt.id,
      'actorId', p_actor_id, 'toState', 'running', 'correlationId', p_correlation_id));

  return skill_authoring_receipt(v_draft, v_message, v_attempt) || jsonb_build_object('created', true);
end;
$$;

create or replace function skill_authoring_retry_message(
  p_actor_id uuid, p_deal_id uuid, p_draft_id uuid, p_message_id uuid,
  p_retry_request_id uuid, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_draft skill_authoring_drafts%rowtype;
  v_message skill_authoring_messages%rowtype;
  v_attempt skill_authoring_attempts%rowtype;
  v_previous_attempt skill_authoring_attempts%rowtype;
begin
  perform skill_authoring_lock_author(p_actor_id, p_deal_id);
  select * into v_draft from skill_authoring_drafts
  where id = p_draft_id and deal_id = p_deal_id and author_id = p_actor_id for update;
  if not found then raise exception 'skill_authoring_draft_not_found' using errcode = 'P0002'; end if;
  if v_draft.status <> 'active' then perform skill_authoring_raise_conflict(v_draft.id); end if;

  update skill_authoring_attempts set status = 'failed', error_code = 'generation_interrupted',
    error_message = 'Generation was interrupted. Try again.', completed_at = now()
  where draft_id = v_draft.id and status = 'running' and not skill_authoring_attempt_live(status, last_progress_at);

  select * into v_message from skill_authoring_messages
  where id = p_message_id and draft_id = p_draft_id and author_id = p_actor_id for update;
  if not found then raise exception 'skill_authoring_message_not_found' using errcode = 'P0002'; end if;
  if p_retry_request_id is null then
    raise exception 'skill_authoring_invalid_retry_request' using errcode = '22023';
  end if;

  select * into v_attempt from skill_authoring_attempts
  where message_id = v_message.id and retry_request_id = p_retry_request_id for update;
  if found then
    return skill_authoring_receipt(v_draft, v_message, v_attempt) || jsonb_build_object('created', false);
  end if;

  if exists (select 1 from skill_authoring_attempts where draft_id = p_draft_id and status = 'running') then
    perform skill_authoring_raise_conflict(v_draft.id);
  end if;

  select * into v_previous_attempt from skill_authoring_attempts
  where message_id = p_message_id order by attempt_number desc limit 1 for update;
  if not found or v_previous_attempt.status <> 'failed' then
    perform skill_authoring_raise_conflict(v_draft.id);
  end if;

  insert into skill_authoring_attempts (draft_id, message_id, attempt_number, retry_request_id)
  values (p_draft_id, p_message_id, v_previous_attempt.attempt_number + 1, p_retry_request_id)
  returning * into v_attempt;

  perform skill_authoring_write_audit(p_actor_id, 'skill_authoring.attempt_transitioned', p_deal_id,
    jsonb_build_object('draftId', v_draft.id, 'attemptId', v_attempt.id, 'actorId', p_actor_id,
      'fromState', 'failed', 'toState', 'running', 'correlationId', p_correlation_id));

  return skill_authoring_receipt(v_draft, v_message, v_attempt) || jsonb_build_object('created', true);
end;
$$;

create or replace function skill_authoring_run_context(p_attempt_id uuid)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare v_attempt skill_authoring_attempts%rowtype; v_draft skill_authoring_drafts%rowtype; v_message skill_authoring_messages%rowtype;
begin
  select * into v_attempt from skill_authoring_attempts where id = p_attempt_id and status = 'running';
  if not found then return null; end if;
  select * into v_draft from skill_authoring_drafts where id = v_attempt.draft_id;
  select * into v_message from skill_authoring_messages where id = v_attempt.message_id;
  return jsonb_build_object(
    'attemptId', v_attempt.id,
    'message', v_message.text,
    'history', coalesce((
      select jsonb_agg(turn order by ordinal, position)
      from (
        select m.ordinal, 1 as position, jsonb_build_object('role', 'user', 'content', m.text) as turn
        from skill_authoring_messages m
        where m.draft_id = v_draft.id and m.ordinal < v_message.ordinal
        union all
        select m.ordinal, 2, jsonb_build_object('role', 'assistant', 'content', a.response_text)
        from skill_authoring_messages m
        join lateral (
          select response_text from skill_authoring_attempts
          where message_id = m.id and status = 'succeeded' and response_text <> ''
          order by attempt_number desc limit 1
        ) a on true
        where m.draft_id = v_draft.id and m.ordinal < v_message.ordinal
      ) turns
    ), '[]'::jsonb),
    'currentCandidate', (select c.preview from skill_authoring_candidates c where c.id = v_draft.current_candidate_id)
  );
end;
$$;

create or replace function skill_authoring_record_progress(p_attempt_id uuid, p_text text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update skill_authoring_attempts set response_text = p_text, last_progress_at = now()
  where id = p_attempt_id and status = 'running';
  return found;
end;
$$;

create or replace function skill_authoring_complete_attempt(p_attempt_id uuid, p_text text, p_candidate jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_draft skill_authoring_drafts%rowtype; v_attempt skill_authoring_attempts%rowtype; v_candidate_id uuid;
begin
  select d.* into v_draft from skill_authoring_drafts d
    join skill_authoring_attempts a on a.draft_id = d.id where a.id = p_attempt_id for update of d;
  if not found then return false; end if;
  select * into v_attempt from skill_authoring_attempts where id = p_attempt_id and status = 'running' for update;
  if not found then return false; end if;
  if p_candidate is not null then
    insert into skill_authoring_candidates (draft_id, attempt_id, provider_candidate_id, content_digest, schema_version, preview)
    values (v_draft.id, v_attempt.id, (p_candidate ->> 'providerCandidateId')::uuid, p_candidate ->> 'contentDigest', 1, p_candidate -> 'preview')
    on conflict (draft_id, provider_candidate_id) do nothing;
    select id into v_candidate_id from skill_authoring_candidates
      where draft_id = v_draft.id and provider_candidate_id = (p_candidate ->> 'providerCandidateId')::uuid;
    if v_draft.status = 'active' then
      update skill_authoring_drafts set current_candidate_id = v_candidate_id, updated_at = now() where id = v_draft.id;
      perform skill_authoring_write_audit(null, 'skill_authoring.candidate_selected', v_draft.deal_id,
        jsonb_build_object('draftId', v_draft.id, 'attemptId', v_attempt.id, 'candidateId', v_candidate_id));
    end if;
  end if;
  update skill_authoring_attempts set status = 'succeeded', response_text = p_text, completed_at = now(), last_progress_at = now()
    where id = v_attempt.id;
  perform skill_authoring_write_audit(null, 'skill_authoring.attempt_transitioned', v_draft.deal_id,
    jsonb_build_object('draftId', v_draft.id, 'attemptId', v_attempt.id, 'status', 'succeeded'));
  return true;
end;
$$;

create or replace function skill_authoring_fail_attempt(p_attempt_id uuid, p_code text, p_message text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_deal_id uuid; v_draft_id uuid;
begin
  update skill_authoring_attempts a set status = 'failed', error_code = p_code, error_message = p_message, completed_at = now()
    from skill_authoring_drafts d
    where a.id = p_attempt_id and a.status = 'running' and d.id = a.draft_id
    returning d.deal_id, d.id into v_deal_id, v_draft_id;
  if not found then return false; end if;
  perform skill_authoring_write_audit(null, 'skill_authoring.attempt_transitioned', v_deal_id,
    jsonb_build_object('draftId', v_draft_id, 'attemptId', p_attempt_id, 'status', 'failed', 'errorCode', p_code));
  return true;
end;
$$;

do $$
declare fn record;
begin
  for fn in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = current_schema() and p.proname like 'skill_authoring_%' loop
    execute format('revoke all on function %s from public', fn.signature);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', fn.signature);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function %s from authenticated', fn.signature);
    end if;
    execute format('grant execute on function %s to service_role', fn.signature);
  end loop;
end $$;
