alter table deal_steps
  add column if not exists request_id text;

create unique index if not exists deal_steps_deal_request_idx
  on deal_steps (deal_id, request_id) where request_id is not null;

create or replace function rail_insert_step(
  p_deal_id      uuid,
  p_actor_id     uuid,
  p_phase_index  int,
  p_position     text,
  p_after_step_id uuid,
  p_definition   jsonb,
  p_step_id      text default null,
  p_request_id   text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing uuid;
  v_step_id  text;
  v_new      uuid;
  v_after    int;
  v_anchor   uuid;
begin
  perform 1 from deals where id = p_deal_id for update;
  if not found then
    raise exception 'deal % not found', p_deal_id using errcode = 'P0001';
  end if;

  if p_position not in ('phase_start', 'phase_end', 'after') then
    raise exception 'invalid position "%"', p_position using errcode = 'P0001';
  end if;

  if p_request_id is not null then
    select id into v_existing from deal_steps
      where deal_id = p_deal_id and request_id = p_request_id;
    if v_existing is not null then
      return jsonb_build_object('stepId', v_existing, 'created', false);
    end if;
  end if;

  if p_position = 'after' then
    select id into v_anchor from deal_steps
      where id = p_after_step_id and deal_id = p_deal_id and removed_at is null;
    if v_anchor is null then
      raise exception 'anchor_removed' using errcode = 'P0002';
    end if;

    select max(display_order) into v_after
      from deal_steps
      where deal_id = p_deal_id
        and removed_at is null
        and (id = v_anchor or anchor_step_id = v_anchor);
  elsif p_position = 'phase_start' then
    select min(display_order) - 1 into v_after
      from deal_steps
      where deal_id = p_deal_id and removed_at is null and phase_index = p_phase_index;
    if v_after is null then
      select coalesce(max(display_order), 0) into v_after
        from deal_steps
        where deal_id = p_deal_id and removed_at is null and phase_index < p_phase_index;
    end if;
  else
    select coalesce(max(display_order), 0) into v_after
      from deal_steps
      where deal_id = p_deal_id and removed_at is null and phase_index = p_phase_index;
  end if;

  v_after := coalesce(v_after, 0);
  v_step_id := coalesce(p_step_id, 'custom:' || gen_random_uuid()::text);

  update deal_steps set display_order = display_order + 1
    where deal_id = p_deal_id and display_order > v_after;

  insert into deal_steps (
    deal_id, step_id, seq, status, phase_index, display_order,
    anchor_step_id, origin, definition, request_id
  ) values (
    p_deal_id, v_step_id, null, 'pending', p_phase_index, v_after + 1,
    case when p_position = 'after' then v_anchor else null end,
    'custom', p_definition, p_request_id
  ) returning id into v_new;

  insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor_id, 'update', p_deal_id,
            jsonb_build_object('rail', 'insert', 'stepId', v_new, 'phase', p_phase_index,
                               'stepKey', v_step_id, 'title', p_definition->>'title'));

  return jsonb_build_object('stepId', v_new, 'created', true);
end;
$$;

revoke all on function rail_insert_step(uuid, uuid, int, text, uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function rail_insert_step(uuid, uuid, int, text, uuid, jsonb, text, text) to service_role;

create table skill_publication_operations (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id),
  draft_id uuid not null references skill_authoring_drafts(id),
  actor_id uuid not null references users(id),
  client_request_id uuid not null,
  state text not null default 'preparing' check (state in (
    'preparing', 'confirmation_required', 'publishing', 'attaching',
    'reconciling', 'needs_placement', 'published', 'failed'
  )),
  revision bigint not null default 0 check (revision >= 0),
  candidate_id uuid not null,
  provider_candidate_id uuid not null,
  candidate_digest text not null check (candidate_digest ~ '^[0-9a-f]{64}$'),
  draft_edit_revision bigint not null check (draft_edit_revision >= 0),
  name text not null check (char_length(name) between 1 and 100),
  phase_index integer not null,
  placement_kind text not null check (placement_kind in ('phase_start', 'phase_end', 'after')),
  anchor_deal_step_id uuid references deal_steps(id),
  reserved_skill_id uuid not null,
  reserved_step_key text not null
    check (reserved_step_key ~ '^custom:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  capability_contract jsonb not null,
  comparison_set_digest text check (comparison_set_digest ~ '^[0-9a-f]{64}$'),
  preparation_id text,
  assessment_digest text check (assessment_digest ~ '^[0-9a-f]{64}$'),
  duplicate_matches jsonb,
  duplicate_confirmed_at timestamptz,
  duplicate_confirmed_by uuid references users(id),
  published_skill_id uuid,
  published_version_id uuid,
  published_digest text check (published_digest ~ '^[0-9a-f]{64}$'),
  resulting_deal_step_id uuid unique references deal_steps(id),
  status_code text,
  status_message text,
  result jsonb,
  next_retry_at timestamptz,
  attempt_count int not null default 0 check (attempt_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((placement_kind = 'after') = (anchor_deal_step_id is not null)),
  check ((published_skill_id is null) = (published_version_id is null)),
  check ((published_version_id is null) = (published_digest is null)),
  check (not (state = 'failed' and published_version_id is not null)),
  check (state <> 'published' or (published_version_id is not null and resulting_deal_step_id is not null)),
  unique (draft_id, client_request_id),
  unique (reserved_skill_id),
  foreign key (draft_id, candidate_id, provider_candidate_id, candidate_digest)
    references skill_authoring_candidates(draft_id, id, provider_candidate_id, content_digest)
);

create unique index skill_publication_one_live_per_draft_idx
  on skill_publication_operations (draft_id)
  where state <> 'failed';

create function skill_publication_protect_frozen_fields()
returns trigger language plpgsql as $$
begin
  if new.id is distinct from old.id
    or new.deal_id is distinct from old.deal_id
    or new.draft_id is distinct from old.draft_id
    or new.actor_id is distinct from old.actor_id
    or new.client_request_id is distinct from old.client_request_id
    or new.candidate_id is distinct from old.candidate_id
    or new.provider_candidate_id is distinct from old.provider_candidate_id
    or new.candidate_digest is distinct from old.candidate_digest
    or new.draft_edit_revision is distinct from old.draft_edit_revision
    or new.name is distinct from old.name
    or new.reserved_skill_id is distinct from old.reserved_skill_id
    or new.reserved_step_key is distinct from old.reserved_step_key
    or new.capability_contract is distinct from old.capability_contract
  then
    raise exception 'skill_publication_operations frozen field changed' using errcode = 'P0001';
  end if;
  if old.state <> 'needs_placement' and (
    new.phase_index is distinct from old.phase_index
    or new.placement_kind is distinct from old.placement_kind
    or new.anchor_deal_step_id is distinct from old.anchor_deal_step_id
  ) then
    raise exception 'skill_publication_operations placement changed outside needs_placement' using errcode = 'P0001';
  end if;
  if old.published_version_id is not null and (
    new.published_skill_id is distinct from old.published_skill_id
    or new.published_version_id is distinct from old.published_version_id
    or new.published_digest is distinct from old.published_digest
  ) then
    raise exception 'skill_publication_operations published receipt changed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger skill_publication_operations_protect_frozen
  before update on skill_publication_operations
  for each row execute function skill_publication_protect_frozen_fields();

alter table skill_publication_operations enable row level security;

revoke all on skill_publication_operations from public, anon, authenticated;
grant select, insert, update on skill_publication_operations to service_role;

alter table skill_publication_operations
  add column if not exists status_deal_step_id uuid references deal_steps(id);

alter table skill_publication_operations drop constraint if exists skill_publication_operations_status_code_check;
alter table skill_publication_operations add constraint skill_publication_operations_status_code_check check (
  status_code is null or status_code in (
    'candidate_invalid', 'candidate_stale', 'duplicate_active', 'duplicate_removed',
    'duplicate_declined', 'access_lost', 'feature_disabled', 'anchor_removed', 'receipt_conflict'
  )
);

alter table audit_log drop constraint if exists audit_log_action_check;
alter table audit_log add constraint audit_log_action_check check (action = any (array[
  'view', 'download', 'upload', 'export', 'grant', 'revoke', 'hold_placed', 'hold_lifted', 'create', 'notify',
  'advance', 'attest', 'screen', 'send', 'release', 'invite_sent', 'invite_accepted', 'invite_revoked', 'reject',
  'invite_domain_override', 'invite_challenge_issued', 'invite_challenge_rotated', 'invite_verification_succeeded',
  'invite_verification_locked', 'mfa_enrolled', 'mfa_challenged', 'assign_step', 'complete_step', 'step_work',
  'update', 'skill_authoring.draft_created', 'skill_authoring.draft_archived', 'skill_authoring.message_admitted',
  'skill_authoring.attempt_transitioned', 'skill_authoring.candidate_selected', 'skill_authoring.access_denied',
  'skill_publication.admitted', 'skill_publication.admission_denied', 'skill_publication.duplicate_confirmed',
  'skill_publication.duplicate_declined', 'skill_publication.placement_replaced', 'skill_publication.transition'
])) not valid;

create or replace function skill_publication_normalize_name(p_name text)
returns text language sql immutable as $$
  select lower(regexp_replace(btrim(p_name), '\s+', ' ', 'g'))
$$;

create or replace function skill_publication_raise(p_code text, p_errcode text)
returns void language plpgsql security definer set search_path = public as $$
begin
  raise exception '%', p_code using errcode = p_errcode;
end;
$$;

create or replace function skill_publication_browser_view(p_op skill_publication_operations)
returns jsonb language sql security definer stable set search_path = public as $$
  select jsonb_build_object(
    'available', true,
    'id', p_op.id,
    'state', p_op.state,
    'revision', p_op.revision,
    'matches', coalesce(p_op.duplicate_matches, '[]'::jsonb),
    'error', case when p_op.status_code is null then null else
      jsonb_build_object('code', p_op.status_code, 'dealStepId', p_op.status_deal_step_id) end,
    'result', case when p_op.state = 'published' then jsonb_build_object(
        'stepId', p_op.resulting_deal_step_id,
        'skillBinding', jsonb_build_object(
          'skillId', p_op.published_skill_id,
          'versionId', p_op.published_version_id,
          'digest', p_op.published_digest
        )
      ) else null end,
    'assessmentDigest', case when p_op.state = 'confirmation_required' then p_op.assessment_digest else null end
  );
$$;

create or replace function skill_publication_admit(
  p_actor_id uuid, p_deal_id uuid, p_draft_id uuid, p_client_request_id uuid,
  p_expected_edit_revision bigint, p_candidate_id uuid, p_candidate_digest text,
  p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_deal deals%rowtype;
  v_draft skill_authoring_drafts%rowtype;
  v_candidate skill_authoring_candidates%rowtype;
  v_existing skill_publication_operations%rowtype;
  v_op skill_publication_operations%rowtype;
  v_capability jsonb;
  v_normalized_name text;
  v_dup_step_id uuid;
  v_dup_removed boolean;
  v_dup_admitted uuid;
  v_status_code text;
  v_status_step uuid;
  v_state text;
begin
  v_deal := skill_authoring_lock_author(p_actor_id, p_deal_id);

  select * into v_draft from skill_authoring_drafts
  where id = p_draft_id and deal_id = p_deal_id and author_id = p_actor_id for update;
  if not found then
    raise exception 'skill_publication_draft_not_found' using errcode = 'P0002';
  end if;

  select * into v_existing from skill_publication_operations
  where draft_id = p_draft_id and client_request_id = p_client_request_id for update;
  if found then
    if v_existing.draft_edit_revision is distinct from p_expected_edit_revision
      or v_existing.candidate_id is distinct from p_candidate_id
      or v_existing.candidate_digest is distinct from p_candidate_digest then
      perform skill_publication_raise('idempotency_conflict', '40001');
    end if;
    return skill_publication_browser_view(v_existing);
  end if;

  if exists (
    select 1 from skill_publication_operations where draft_id = p_draft_id and state <> 'failed'
  ) then
    perform skill_publication_raise('publication_exists', '40001');
  end if;

  if v_draft.status <> 'active' then
    perform skill_publication_raise('skill_publication_draft_not_active', '22023');
  end if;

  if v_draft.edit_revision <> p_expected_edit_revision then
    perform skill_publication_raise('stale_edit_revision', '40001');
  end if;

  if exists (
    select 1 from skill_authoring_attempts
    where draft_id = p_draft_id and skill_authoring_attempt_live(status, last_progress_at)
  ) then
    perform skill_publication_raise('generation_active', '40001');
  end if;

  select * into v_candidate from skill_authoring_candidates
  where draft_id = p_draft_id and id = p_candidate_id;
  if not found
    or v_draft.current_candidate_id is distinct from p_candidate_id
    or v_candidate.content_digest is distinct from p_candidate_digest then
    perform skill_publication_raise('stale_candidate', '40001');
  end if;

  if coalesce(btrim(v_draft.name), '') = '' then
    perform skill_publication_raise('skill_publication_blank_name', '22023');
  end if;

  if v_draft.phase_index is null or v_draft.placement_kind is null
    or (v_draft.placement_kind = 'after' and v_draft.anchor_deal_step_id is null) then
    perform skill_publication_raise('skill_publication_incomplete_placement', '22023');
  end if;

  if v_draft.placement_kind = 'after' and not exists (
    select 1 from deal_steps where id = v_draft.anchor_deal_step_id and deal_id = p_deal_id and removed_at is null
  ) then
    perform skill_publication_raise('skill_publication_anchor_removed', '22023');
  end if;

  v_capability := jsonb_build_object(
    'purpose', v_candidate.preview ->> 'purpose',
    'expectedInput', v_candidate.preview ->> 'expectedInput',
    'expectedOutput', v_candidate.preview ->> 'expectedOutput'
  );
  if coalesce(btrim(v_capability ->> 'purpose'), '') = ''
    or coalesce(btrim(v_capability ->> 'expectedInput'), '') = ''
    or coalesce(btrim(v_capability ->> 'expectedOutput'), '') = '' then
    perform skill_publication_raise('skill_publication_incomplete_capability_contract', '22023');
  end if;

  v_normalized_name := skill_publication_normalize_name(v_draft.name);

  select ds.id, ds.removed_at is not null into v_dup_step_id, v_dup_removed
  from deal_steps ds
  left join skill_publication_operations pubop
    on pubop.resulting_deal_step_id = ds.id and pubop.state = 'published'
  where ds.deal_id = p_deal_id
    and ds.definition ->> 'type' = 'skill'
    and (
      skill_publication_normalize_name(ds.definition ->> 'title') = v_normalized_name
      or pubop.capability_contract = v_capability
    )
  order by (ds.removed_at is not null) asc, ds.id
  limit 1;

  if v_dup_step_id is not null then
    v_status_code := case when v_dup_removed then 'duplicate_removed' else 'duplicate_active' end;
    v_status_step := v_dup_step_id;
    v_state := 'failed';
  else
    select id into v_dup_admitted from skill_publication_operations
    where deal_id = p_deal_id and draft_id <> p_draft_id and state <> 'failed'
      and skill_publication_normalize_name(name) = v_normalized_name
    limit 1;
    if v_dup_admitted is not null then
      v_status_code := 'duplicate_active';
      v_status_step := null;
      v_state := 'failed';
    else
      v_status_code := null;
      v_status_step := null;
      v_state := 'preparing';
    end if;
  end if;

  insert into skill_publication_operations (
    deal_id, draft_id, actor_id, client_request_id, state,
    candidate_id, provider_candidate_id, candidate_digest, draft_edit_revision,
    name, phase_index, placement_kind, anchor_deal_step_id,
    reserved_skill_id, reserved_step_key, capability_contract,
    status_code, status_deal_step_id
  ) values (
    p_deal_id, p_draft_id, p_actor_id, p_client_request_id, v_state,
    v_candidate.id, v_candidate.provider_candidate_id, v_candidate.content_digest, v_draft.edit_revision,
    v_draft.name, v_draft.phase_index, v_draft.placement_kind, v_draft.anchor_deal_step_id,
    gen_random_uuid(), 'custom:' || gen_random_uuid()::text, v_capability,
    v_status_code, v_status_step
  ) returning * into v_op;

  perform skill_authoring_write_audit(p_actor_id, 'skill_publication.admitted', p_deal_id,
    jsonb_strip_nulls(jsonb_build_object(
      'publicationId', v_op.id, 'draftId', v_draft.id, 'candidateId', v_candidate.id, 'actorId', p_actor_id,
      'toState', v_op.state, 'statusCode', v_status_code, 'dealStepId', v_status_step,
      'correlationId', p_correlation_id
    )));

  return skill_publication_browser_view(v_op);
end;
$$;

create or replace function skill_publication_decide_duplicate(
  p_actor_id uuid, p_deal_id uuid, p_publication_id uuid, p_expected_revision bigint,
  p_assessment_digest text, p_decision text, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_deal deals%rowtype;
  v_op skill_publication_operations%rowtype;
begin
  v_deal := skill_authoring_lock_author(p_actor_id, p_deal_id);

  select * into v_op from skill_publication_operations
  where id = p_publication_id and deal_id = p_deal_id for update;
  if not found then
    raise exception 'skill_publication_not_found' using errcode = 'P0002';
  end if;
  if v_op.actor_id <> p_actor_id then
    raise exception 'skill_authoring_forbidden' using errcode = '42501';
  end if;

  if v_op.state <> 'confirmation_required' or v_op.revision <> p_expected_revision then
    perform skill_publication_raise('stale_publication_revision', '40001');
  end if;
  if v_op.assessment_digest is distinct from p_assessment_digest then
    perform skill_publication_raise('assessment_mismatch', '40001');
  end if;

  if p_decision = 'confirm' then
    update skill_publication_operations set
      state = 'publishing', revision = revision + 1, updated_at = now(),
      duplicate_confirmed_at = now(), duplicate_confirmed_by = p_actor_id
    where id = v_op.id returning * into v_op;
    perform skill_authoring_write_audit(p_actor_id, 'skill_publication.duplicate_confirmed', p_deal_id,
      jsonb_strip_nulls(jsonb_build_object('publicationId', v_op.id, 'draftId', v_op.draft_id, 'actorId', p_actor_id,
        'fromState', 'confirmation_required', 'toState', 'publishing', 'correlationId', p_correlation_id)));
  elsif p_decision = 'decline' then
    update skill_publication_operations set
      state = 'failed', revision = revision + 1, updated_at = now(), status_code = 'duplicate_declined', status_deal_step_id = null
    where id = v_op.id returning * into v_op;
    perform skill_authoring_write_audit(p_actor_id, 'skill_publication.duplicate_declined', p_deal_id,
      jsonb_strip_nulls(jsonb_build_object('publicationId', v_op.id, 'draftId', v_op.draft_id, 'actorId', p_actor_id,
        'fromState', 'confirmation_required', 'toState', 'failed', 'statusCode', 'duplicate_declined',
        'correlationId', p_correlation_id)));
  else
    raise exception 'skill_publication_invalid_decision' using errcode = '22023';
  end if;

  return skill_publication_browser_view(v_op);
end;
$$;

create or replace function skill_publication_replace_placement(
  p_actor_id uuid, p_deal_id uuid, p_publication_id uuid, p_expected_revision bigint,
  p_phase_index integer, p_placement_kind text, p_anchor_deal_step_id uuid, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_deal deals%rowtype;
  v_op skill_publication_operations%rowtype;
begin
  v_deal := skill_authoring_lock_author(p_actor_id, p_deal_id);

  select * into v_op from skill_publication_operations
  where id = p_publication_id and deal_id = p_deal_id for update;
  if not found then
    raise exception 'skill_publication_not_found' using errcode = 'P0002';
  end if;
  if v_op.actor_id <> p_actor_id then
    raise exception 'skill_authoring_forbidden' using errcode = '42501';
  end if;

  if v_op.state <> 'needs_placement' then
    perform skill_publication_raise('placement_not_allowed', '40001');
  end if;
  if v_op.revision <> p_expected_revision then
    perform skill_publication_raise('stale_publication_revision', '40001');
  end if;

  if p_placement_kind not in ('phase_start', 'phase_end', 'after') or p_phase_index is null
    or (p_placement_kind = 'after') <> (p_anchor_deal_step_id is not null) then
    raise exception 'skill_publication_incomplete_placement' using errcode = '22023';
  end if;
  if p_placement_kind = 'after' and not exists (
    select 1 from deal_steps where id = p_anchor_deal_step_id and deal_id = p_deal_id and removed_at is null
  ) then
    raise exception 'skill_publication_anchor_removed' using errcode = '22023';
  end if;

  update skill_publication_operations set
    phase_index = p_phase_index, placement_kind = p_placement_kind, anchor_deal_step_id = p_anchor_deal_step_id,
    state = 'attaching', revision = revision + 1, updated_at = now()
  where id = v_op.id and state = 'needs_placement'
  returning * into v_op;

  if not found then
    perform skill_publication_raise('placement_not_allowed', '40001');
  end if;

  perform skill_authoring_write_audit(p_actor_id, 'skill_publication.placement_replaced', p_deal_id,
    jsonb_strip_nulls(jsonb_build_object('publicationId', v_op.id, 'draftId', v_op.draft_id, 'actorId', p_actor_id,
      'fromState', 'needs_placement', 'toState', 'attaching', 'correlationId', p_correlation_id)));

  return skill_publication_browser_view(v_op);
end;
$$;

create or replace function skill_publication_read(
  p_actor_id uuid, p_deal_id uuid, p_publication_id uuid, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_deal deals%rowtype;
  v_op skill_publication_operations%rowtype;
begin
  v_deal := skill_authoring_lock_author(p_actor_id, p_deal_id);

  select * into v_op from skill_publication_operations
  where id = p_publication_id and deal_id = p_deal_id and actor_id = p_actor_id;
  if not found then
    raise exception 'skill_publication_not_found' using errcode = 'P0002';
  end if;

  return skill_publication_browser_view(v_op);
end;
$$;

create or replace function skill_publication_due(p_limit integer)
returns setof uuid language sql security definer stable set search_path = public as $$
  select id from skill_publication_operations
  where state in ('preparing', 'publishing', 'attaching', 'reconciling')
    and (next_retry_at is null or next_retry_at <= now())
  order by coalesce(next_retry_at, created_at), id
  limit p_limit;
$$;

create or replace function skill_publication_transition(
  p_publication_id uuid, p_expected_states text[], p_next_state text, p_patch jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_op skill_publication_operations%rowtype;
  v_from_state text;
  v_next_published_version_id uuid;
  v_next_status_code text;
  v_correlation_id uuid;
begin
  select * into v_op from skill_publication_operations
  where id = p_publication_id and state = any(p_expected_states) for update;
  if not found then
    return null;
  end if;

  v_from_state := v_op.state;
  v_next_published_version_id := case when p_patch ? 'publishedVersionId'
    then (p_patch ->> 'publishedVersionId')::uuid else v_op.published_version_id end;
  if p_next_state = 'failed' and v_next_published_version_id is not null then
    return null;
  end if;

  v_next_status_code := case when p_patch ? 'statusCode' then p_patch ->> 'statusCode' else v_op.status_code end;
  v_correlation_id := coalesce((p_patch ->> 'correlationId')::uuid, gen_random_uuid());

  update skill_publication_operations set
    state = p_next_state,
    revision = revision + 1,
    updated_at = now(),
    status_code = v_next_status_code,
    status_message = case when p_patch ? 'statusMessage' then p_patch ->> 'statusMessage' else status_message end,
    status_deal_step_id = case
      when v_next_status_code is null
        or v_next_status_code not in ('duplicate_active', 'duplicate_removed') then null
      when p_patch ? 'statusDealStepId' then (p_patch ->> 'statusDealStepId')::uuid
      else status_deal_step_id
    end,
    next_retry_at = case when p_patch ? 'nextRetryAt' then (p_patch ->> 'nextRetryAt')::timestamptz else next_retry_at end,
    attempt_count = case when p_patch ? 'attemptCount' then (p_patch ->> 'attemptCount')::int else attempt_count end,
    comparison_set_digest = case when p_patch ? 'comparisonSetDigest'
      then p_patch ->> 'comparisonSetDigest' else comparison_set_digest end,
    preparation_id = case when p_patch ? 'preparationId' then p_patch ->> 'preparationId' else preparation_id end,
    assessment_digest = case when p_patch ? 'assessmentDigest' then p_patch ->> 'assessmentDigest' else assessment_digest end,
    duplicate_matches = case when p_patch ? 'duplicateMatches' then p_patch -> 'duplicateMatches' else duplicate_matches end,
    published_skill_id = case when p_patch ? 'publishedSkillId'
      then (p_patch ->> 'publishedSkillId')::uuid else published_skill_id end,
    published_version_id = v_next_published_version_id,
    published_digest = case when p_patch ? 'publishedDigest' then p_patch ->> 'publishedDigest' else published_digest end,
    resulting_deal_step_id = case when p_patch ? 'resultingDealStepId'
      then (p_patch ->> 'resultingDealStepId')::uuid else resulting_deal_step_id end
  where id = v_op.id
  returning * into v_op;

  perform skill_authoring_write_audit(null, 'skill_publication.transition', v_op.deal_id,
    jsonb_strip_nulls(jsonb_build_object(
      'service', 'conductia', 'publicationId', v_op.id, 'draftId', v_op.draft_id,
      'operationActorId', v_op.actor_id, 'fromState', v_from_state, 'toState', v_op.state,
      'statusCode', v_op.status_code, 'correlationId', v_correlation_id
    )));

  return skill_publication_browser_view(v_op);
end;
$$;

do $$
declare
  v_function regprocedure;
begin
  foreach v_function in array array[
    'skill_publication_normalize_name(text)'::regprocedure,
    'skill_publication_raise(text,text)'::regprocedure,
    'skill_publication_browser_view(skill_publication_operations)'::regprocedure,
    'skill_publication_admit(uuid,uuid,uuid,uuid,bigint,uuid,text,uuid)'::regprocedure,
    'skill_publication_decide_duplicate(uuid,uuid,uuid,bigint,text,text,uuid)'::regprocedure,
    'skill_publication_replace_placement(uuid,uuid,uuid,bigint,integer,text,uuid,uuid)'::regprocedure,
    'skill_publication_read(uuid,uuid,uuid,uuid)'::regprocedure,
    'skill_publication_due(integer)'::regprocedure,
    'skill_publication_transition(uuid,text[],text,jsonb)'::regprocedure
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_function);
    execute format('grant execute on function %s to service_role', v_function);
  end loop;
end;
$$;

create or replace function skill_authoring_browser_publication(p_draft_id uuid)
returns jsonb language sql security definer stable set search_path = public as $$
  select coalesce(
    (select skill_publication_browser_view(op)
     from skill_publication_operations op
     where op.draft_id = p_draft_id
     order by (op.state = 'failed'), op.created_at desc, op.id desc
     limit 1),
    jsonb_build_object('available', false)
  );
$$;

create or replace function skill_authoring_browser_draft(p_draft_id uuid)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare v_draft skill_authoring_drafts%rowtype;
begin
  select * into v_draft from skill_authoring_drafts where id = p_draft_id;
  if not found then raise exception 'skill_authoring_draft_not_found' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', v_draft.id, 'deal_id', v_draft.deal_id, 'status', v_draft.status, 'name', v_draft.name, 'phase_index', v_draft.phase_index, 'placement_kind', v_draft.placement_kind, 'anchor_deal_step_id', v_draft.anchor_deal_step_id, 'composer_text', v_draft.composer_text, 'edit_revision', v_draft.edit_revision, 'messages', skill_authoring_browser_messages(v_draft.id), 'active_attempt', skill_authoring_browser_active_attempt(v_draft.id), 'candidate', skill_authoring_browser_candidate(v_draft.current_candidate_id), 'publication', skill_authoring_browser_publication(v_draft.id));
end;
$$;

revoke all on function skill_authoring_browser_publication(uuid) from public, anon, authenticated;
grant execute on function skill_authoring_browser_publication(uuid) to service_role;

revoke all on function skill_authoring_browser_draft(uuid) from public, anon, authenticated;
grant execute on function skill_authoring_browser_draft(uuid) to service_role;

create or replace function skill_publication_attach(p_publication_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deal_id       uuid;
  v_op            skill_publication_operations%rowtype;
  v_draft         skill_authoring_drafts%rowtype;
  v_definition    jsonb;
  v_rail          jsonb;
  v_step_id       uuid;
  v_existing_step deal_steps%rowtype;
begin
  select deal_id into v_deal_id from skill_publication_operations where id = p_publication_id;
  if not found then
    raise exception 'skill_publication_not_found' using errcode = 'P0002';
  end if;

  perform 1 from deals where id = v_deal_id for update;

  select * into v_op from skill_publication_operations where id = p_publication_id for update;
  if not found then
    raise exception 'skill_publication_not_found' using errcode = 'P0002';
  end if;

  select * into v_draft from skill_authoring_drafts where id = v_op.draft_id for update;
  if not found then
    raise exception 'skill_authoring_draft_not_found' using errcode = 'P0002';
  end if;

  if v_op.state = 'published' then
    return skill_publication_browser_view(v_op);
  end if;

  if v_op.state <> 'attaching' then
    return skill_publication_browser_view(v_op);
  end if;

  if v_op.published_skill_id is distinct from v_op.reserved_skill_id
    or v_op.published_version_id is null
    or v_op.published_digest is null
    or v_op.published_digest is distinct from v_op.candidate_digest
    or v_draft.status <> 'active'
    or v_draft.current_candidate_id is distinct from v_op.candidate_id
    or v_draft.edit_revision is distinct from v_op.draft_edit_revision
  then
    return skill_publication_transition(p_publication_id, array['attaching'], 'reconciling',
      jsonb_build_object('statusCode', 'receipt_conflict'));
  end if;

  v_definition := jsonb_build_object(
    'schemaVersion', 1,
    'type', 'skill',
    'title', v_op.name,
    'description', v_op.capability_contract ->> 'purpose',
    'inputs', jsonb_build_array(jsonb_build_object(
      'key', 'primary',
      'kind', 'text',
      'label', 'Input',
      'helperText', v_op.capability_contract ->> 'expectedInput',
      'required', true
    )),
    'skillBinding', jsonb_build_object(
      'skillId', v_op.published_skill_id,
      'versionId', v_op.published_version_id,
      'digest', v_op.published_digest
    )
  );

  begin
    v_rail := rail_insert_step(
      v_op.deal_id, v_op.actor_id, v_op.phase_index, v_op.placement_kind, v_op.anchor_deal_step_id,
      v_definition, v_op.reserved_step_key, p_publication_id::text
    );
  exception when sqlstate 'P0002' then
    if sqlerrm = 'anchor_removed' then
      return skill_publication_transition(p_publication_id, array['attaching'], 'needs_placement',
        jsonb_build_object('statusCode', 'anchor_removed'));
    end if;
    raise;
  end;

  v_step_id := (v_rail ->> 'stepId')::uuid;

  if not (v_rail ->> 'created')::boolean then
    select * into v_existing_step from deal_steps where id = v_step_id;
    if v_existing_step.step_id is distinct from v_op.reserved_step_key
      or v_existing_step.definition is distinct from v_definition
    then
      return skill_publication_transition(p_publication_id, array['attaching'], 'reconciling',
        jsonb_build_object('statusCode', 'receipt_conflict'));
    end if;
  end if;

  update skill_authoring_drafts set status = 'published', published_at = now()
  where id = v_draft.id and status = 'active';

  update skill_publication_operations set
    state = 'published',
    revision = revision + 1,
    updated_at = now(),
    status_code = null,
    status_message = null,
    status_deal_step_id = null,
    resulting_deal_step_id = v_step_id,
    result = jsonb_build_object(
      'stepId', v_step_id,
      'skillBinding', jsonb_build_object(
        'skillId', v_op.published_skill_id,
        'versionId', v_op.published_version_id,
        'digest', v_op.published_digest
      )
    )
  where id = v_op.id
  returning * into v_op;

  perform skill_authoring_write_audit(null, 'skill_publication.transition', v_op.deal_id,
    jsonb_strip_nulls(jsonb_build_object(
      'service', 'conductia', 'publicationId', v_op.id, 'draftId', v_op.draft_id,
      'operationActorId', v_op.actor_id, 'dealStepId', v_step_id, 'digest', v_op.published_digest,
      'fromState', 'attaching', 'toState', 'published', 'correlationId', gen_random_uuid()
    )));

  return skill_publication_browser_view(v_op);
end;
$$;

revoke all on function skill_publication_attach(uuid) from public, anon, authenticated;
grant execute on function skill_publication_attach(uuid) to service_role;

create or replace function skill_publication_freeze_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_draft_id    uuid;
  v_live_op_id  uuid;
  v_live_state  text;
begin
  if tg_table_name = 'skill_authoring_drafts' then
    v_draft_id := old.id;
  else
    v_draft_id := new.draft_id;
  end if;

  select id, state into v_live_op_id, v_live_state from skill_publication_operations
  where draft_id = v_draft_id
    and state in ('preparing', 'confirmation_required', 'publishing', 'attaching', 'reconciling', 'needs_placement');

  if v_live_state is null then
    return new;
  end if;

  if tg_table_name = 'skill_authoring_drafts' then
    if old.status = 'active' and new.status = 'published' and v_live_state = 'attaching'
      and (to_jsonb(old) - array['status', 'published_at', 'updated_at']::text[])
        = (to_jsonb(new) - array['status', 'published_at', 'updated_at']::text[])
      and exists (select 1 from deal_steps where request_id = v_live_op_id::text)
    then
      return new;
    end if;
  end if;

  perform skill_authoring_raise_conflict(v_draft_id);
  return new;
end;
$$;

revoke all on function skill_publication_freeze_guard() from public, anon, authenticated;
grant execute on function skill_publication_freeze_guard() to service_role;

create trigger skill_publication_freeze_drafts
  before update on skill_authoring_drafts
  for each row execute function skill_publication_freeze_guard();

create trigger skill_publication_freeze_messages
  before insert on skill_authoring_messages
  for each row execute function skill_publication_freeze_guard();

create trigger skill_publication_freeze_attempts
  before insert on skill_authoring_attempts
  for each row execute function skill_publication_freeze_guard();

revoke execute on function rail_insert_step(uuid, uuid, int, text, uuid, jsonb, text, text) from anon, authenticated;
revoke execute on function rail_remove_step(uuid, uuid, uuid, text[]) from anon, authenticated;
revoke execute on function rail_restore_step(uuid, uuid, uuid) from anon, authenticated;
revoke execute on function rail_skip_step(uuid, uuid, uuid, uuid, text) from anon, authenticated;
