-- Bank and user setup walkthroughs (#125).
--
-- Product guidance is versioned so changing the content creates a new record
-- instead of rewriting a prior completion. Completion is an immutable
-- attestation. The service-only RPC owns authorization, optimistic concurrency,
-- exact step validation, and the audit row in one transaction.

create table setup_walkthrough_progress (
  user_id uuid not null references users (id) on delete cascade,
  track text not null,
  content_version integer not null check (content_version > 0),
  revision bigint not null default 1 check (revision > 0),
  completed_steps text[] not null default array[]::text[],
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, track, content_version),
  constraint setup_walkthrough_progress_track_check
    check (track in ('user', 'administrator')),
  constraint setup_walkthrough_progress_current_content_check
    check (
      content_version = 1
      and (
        (
          track = 'user'
          and completed_steps <@ array[
            'communications_screening',
            'data_room_boundaries',
            'data_security'
          ]::text[]
          and (completed_at is not null) = (
            completed_steps @> array[
              'communications_screening',
              'data_room_boundaries',
              'data_security'
            ]::text[]
          )
        )
        or (
          track = 'administrator'
          and completed_steps <@ array[
            'access_governance',
            'audit_accountability',
            'invitation_controls'
          ]::text[]
          and (completed_at is not null) = (
            completed_steps @> array[
              'access_governance',
              'audit_accountability',
              'invitation_controls'
            ]::text[]
          )
        )
      )
    )
);

comment on table setup_walkthrough_progress is
  'Versioned Conductia product walkthrough progress. This is product guidance, not a substitute for employer or regulatory training.';

alter table setup_walkthrough_progress enable row level security;
grant select, insert, update on setup_walkthrough_progress to service_role;

create or replace function update_setup_walkthrough_progress(
  p_actor_id uuid,
  p_track text,
  p_content_version integer,
  p_expected_revision bigint,
  p_completed_steps text[] default array[]::text[]
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor users%rowtype;
  v_row setup_walkthrough_progress%rowtype;
  v_steps text[];
  v_required_steps text[];
  v_completed_at timestamptz;
  v_action text;
  v_before_steps text[] := array[]::text[];
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service_role_required';
  end if;
  if p_content_version <> 1 or p_expected_revision < 0 then
    raise exception 'invalid_walkthrough_input';
  end if;

  select * into v_actor from users where id = p_actor_id for update;
  if not found or v_actor.status <> 'active' then
    raise exception 'actor_not_eligible';
  end if;

  if p_track = 'user' then
    v_required_steps := array[
      'communications_screening',
      'data_room_boundaries',
      'data_security'
    ]::text[];
  elsif p_track = 'administrator' then
    v_required_steps := array[
      'access_governance',
      'audit_accountability',
      'invitation_controls'
    ]::text[];
    if v_actor.is_external or not (
      v_actor.firm_role = 'admin'
      or (
        v_actor.company_id is not null
        and v_actor.company_role = 'director'
      )
      or (
        v_actor.company_id is not null
        and exists (
          select 1
          from app_company_effective_permissions(p_actor_id, v_actor.company_id) permission
          where permission.permission_key = 'company:access:assign'
        )
      )
    ) then
      raise exception 'administrator_track_not_permitted';
    end if;
  else
    raise exception 'invalid_walkthrough_input';
  end if;

  select coalesce(array_agg(step order by step), array[]::text[])
    into v_steps
    from (
      select distinct unnest(coalesce(p_completed_steps, array[]::text[])) as step
    ) normalized;
  if not v_steps <@ v_required_steps then
    raise exception 'invalid_walkthrough_step';
  end if;

  select * into v_row
    from setup_walkthrough_progress
    where user_id = p_actor_id
      and track = p_track
      and content_version = p_content_version
    for update;

  if not found then
    if p_expected_revision <> 0 then raise exception 'stale_revision'; end if;
    v_completed_at := case
      when v_steps @> v_required_steps then now()
      else null
    end;
    insert into setup_walkthrough_progress (
      user_id, track, content_version, revision, completed_steps, completed_at
    ) values (
      p_actor_id, p_track, p_content_version, 1, v_steps, v_completed_at
    ) returning * into v_row;
  else
    if v_row.revision <> p_expected_revision then raise exception 'stale_revision'; end if;
    if v_row.completed_steps = v_steps then
      return jsonb_build_object(
        'track', v_row.track,
        'content_version', v_row.content_version,
        'revision', v_row.revision,
        'completed_steps', to_jsonb(v_row.completed_steps),
        'completed_at', v_row.completed_at
      );
    end if;
    if v_row.completed_at is not null then
      raise exception 'walkthrough_already_completed';
    end if;
    v_before_steps := v_row.completed_steps;
    v_completed_at := case
      when v_steps @> v_required_steps then now()
      else null
    end;
    update setup_walkthrough_progress set
      revision = revision + 1,
      completed_steps = v_steps,
      completed_at = v_completed_at,
      updated_at = now()
    where user_id = p_actor_id
      and track = p_track
      and content_version = p_content_version
    returning * into v_row;
  end if;

  v_action := case when v_row.completed_at is null then 'update' else 'attest' end;
  insert into audit_log (actor_id, action, detail) values (
    p_actor_id,
    v_action,
    jsonb_build_object(
      'reason', case
        when v_row.completed_at is null then 'setup_walkthrough_progress_updated'
        else 'setup_walkthrough_completed'
      end,
      'track', v_row.track,
      'content_version', v_row.content_version,
      'before_completed_steps', to_jsonb(v_before_steps),
      'completed_steps', to_jsonb(v_row.completed_steps),
      'revision', v_row.revision,
      'completed_at', v_row.completed_at
    )
  );

  return jsonb_build_object(
    'track', v_row.track,
    'content_version', v_row.content_version,
    'revision', v_row.revision,
    'completed_steps', to_jsonb(v_row.completed_steps),
    'completed_at', v_row.completed_at
  );
end;
$$;

revoke all on function update_setup_walkthrough_progress(uuid, text, integer, bigint, text[]) from public;
grant execute on function update_setup_walkthrough_progress(uuid, text, integer, bigint, text[]) to service_role;
