-- supabase/migrations/20260916140000_skill_enhancement_and_version_selection.sql
-- Which skill version a step runs, for catalog and custom steps alike.
--
-- Part C wrote the binding into deal_steps.definition, which only custom steps
-- carry. A catalog step has origin 'catalog' and a null definition, so version
-- selection needs a home that both kinds share. Absence is meaningful: no row
-- means the step resolves the way it does today.

create table if not exists deal_step_skill_bindings (
  deal_step_id  uuid primary key references deal_steps (id) on delete cascade,
  deal_id       uuid not null references deals (id) on delete cascade,
  kind          text not null check (kind in ('publication', 'mount')),
  skill_id      uuid,
  version_id    uuid,
  mount_name    text,
  mount_version integer check (mount_version is null or mount_version > 0),
  digest        text not null check (digest ~ '^[0-9a-f]{64}$'),
  bound_by      uuid not null references users (id),
  bound_at      timestamptz not null default now(),
  source        text not null check (source in ('publication', 'selection')),
  constraint deal_step_skill_bindings_publication_shape_check check (
    kind <> 'publication'
    or (skill_id is not null and version_id is not null and mount_name is null and mount_version is null)
  ),
  constraint deal_step_skill_bindings_mount_shape_check check (
    kind <> 'mount'
    or (mount_name is not null and mount_version is not null and skill_id is null and version_id is null)
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
  'skill_publication.duplicate_declined', 'skill_publication.placement_replaced', 'skill_publication.transition',
  'rail.step_rebound'
])) not valid;

alter table deal_step_skill_bindings enable row level security;

grant select, insert, update, delete on deal_step_skill_bindings to service_role;

-- No authenticated grant and no select policy: every read of this table goes
-- through an API route on the service role. A direct grant would expose it
-- over the Supabase REST API, where app_is_overseer alone does not compare
-- tenants and would let any firm's admin read another firm's bindings.
revoke select on deal_step_skill_bindings from authenticated;
drop policy if exists deal_step_skill_bindings_select on deal_step_skill_bindings;

create or replace function rail_rebind_step(
  p_deal_id uuid, p_actor_id uuid, p_deal_step_id uuid, p_reference jsonb, p_source text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_step     deal_steps%rowtype;
  v_previous jsonb;
  v_bound    jsonb;
  v_kind     text := p_reference ->> 'kind';
begin
  perform 1 from deals where id = p_deal_id for update;

  select * into v_step from deal_steps
   where id = p_deal_step_id and deal_id = p_deal_id for update;
  if not found then
    raise exception 'step_not_found' using errcode = 'P0002';
  end if;
  if v_step.removed_at is not null then
    raise exception 'step_removed' using errcode = 'P0002';
  end if;
  if v_kind not in ('publication', 'mount') then
    raise exception 'unknown_reference_kind' using errcode = 'P0001';
  end if;

  select to_jsonb(binding) into v_previous
    from deal_step_skill_bindings binding where binding.deal_step_id = p_deal_step_id;

  insert into deal_step_skill_bindings as target (
    deal_step_id, deal_id, kind, skill_id, version_id, mount_name, mount_version,
    digest, bound_by, bound_at, source
  ) values (
    p_deal_step_id, p_deal_id, v_kind,
    nullif(p_reference ->> 'skillId', '')::uuid,
    nullif(p_reference ->> 'versionId', '')::uuid,
    nullif(p_reference ->> 'name', ''),
    nullif(p_reference ->> 'version', '')::integer,
    p_reference ->> 'digest', p_actor_id, now(), p_source
  )
  on conflict (deal_step_id) do update set
    kind = excluded.kind, skill_id = excluded.skill_id, version_id = excluded.version_id,
    mount_name = excluded.mount_name, mount_version = excluded.mount_version,
    digest = excluded.digest, bound_by = excluded.bound_by, bound_at = excluded.bound_at,
    source = excluded.source
  returning to_jsonb(target) into v_bound;

  perform skill_authoring_write_audit(null, 'rail.step_rebound', p_deal_id,
    jsonb_strip_nulls(jsonb_build_object(
      'service', 'conductia', 'dealStepId', p_deal_step_id, 'actorId', p_actor_id,
      'source', p_source, 'reference', p_reference,
      'previousReference', case when v_previous is null then null else referenceOf(v_previous) end
    )));

  return v_bound;
end;
$$;

revoke all on function rail_rebind_step(uuid, uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function rail_rebind_step(uuid, uuid, uuid, jsonb, text) to service_role;

-- A skill identity gains a lineage, a draft gains a basis, and a run gains a
-- firm-catalog shape.
--
-- The three uniqueness rules relaxed here all encoded the same assumption: one
-- version per skill, written once. Each keeps its real guarantee as a partial
-- index over the states that are still in flight.

alter table skill_publication_operations drop constraint if exists skill_publication_operations_reserved_skill_id_key;
create unique index if not exists skill_publication_one_live_per_skill_idx
  on skill_publication_operations (reserved_skill_id)
  where state not in ('published', 'failed');

alter table skill_publication_operations drop constraint if exists skill_publication_operations_resulting_deal_step_id_key;
create unique index if not exists skill_publication_one_live_per_step_idx
  on skill_publication_operations (resulting_deal_step_id)
  where resulting_deal_step_id is not null and state not in ('published', 'failed');

alter table skill_authoring_drafts
  add column if not exists basis              jsonb,
  add column if not exists basis_deal_step_id uuid references deal_steps (id),
  add column if not exists seed_run_id        uuid references deal_step_skill_runs (id);

alter table skill_authoring_drafts drop constraint if exists skill_authoring_drafts_basis_check;
alter table skill_authoring_drafts add constraint skill_authoring_drafts_basis_check
  check ((basis is null) = (basis_deal_step_id is null));

alter table skill_authoring_drafts drop constraint if exists skill_authoring_drafts_basis_placement_check;
alter table skill_authoring_drafts add constraint skill_authoring_drafts_basis_placement_check
  check (basis_deal_step_id is null or (phase_index is null and placement_kind is null));

drop index if exists skill_authoring_one_active_draft;
drop index if exists skill_authoring_drafts_one_active_idx;
create unique index if not exists skill_authoring_drafts_one_active_idx
  on skill_authoring_drafts (
    deal_id, author_id, coalesce(basis_deal_step_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  where status = 'active';

alter table deal_step_skill_runs
  add column if not exists mount_name    text,
  add column if not exists mount_version integer,
  add column if not exists model         text,
  add column if not exists clamped_from  text,
  add column if not exists source        text not null default 'execution';

alter table deal_step_skill_runs alter column skill_id   drop not null;
alter table deal_step_skill_runs alter column version_id drop not null;
alter table deal_step_skill_runs alter column digest     drop not null;
alter table deal_step_skill_runs alter column actor_id   drop not null;

alter table deal_step_skill_runs drop constraint if exists deal_step_skill_runs_source_check;
alter table deal_step_skill_runs add constraint deal_step_skill_runs_source_check
  check (source in ('execution', 'imported'));

-- The nullability dropped above is given back as a rule keyed on source: an
-- executed run always names exactly one reference, a digest and an actor; an
-- imported bench reply names none of them, because the bench path recorded
-- neither a version nor who ran it.
alter table deal_step_skill_runs drop constraint if exists deal_step_skill_runs_reference_check;
alter table deal_step_skill_runs add constraint deal_step_skill_runs_reference_check
  check (
    (source = 'execution'
      and digest is not null and actor_id is not null
      and ((skill_id is not null and version_id is not null
            and mount_name is null and mount_version is null)
        or (mount_name is not null and mount_version is not null
            and skill_id is null and version_id is null)))
    or
    (source = 'imported'
      and digest is null and actor_id is null and skill_id is null and version_id is null
      and mount_name is null and mount_version is null)
  );

-- Task C7: an enhancement draft carries a basis (the resolved skill reference
-- of the version it improves), the deal_step it belongs to, and optionally a
-- seed run (the recorded run whose disappointing result prompted the
-- improvement). skill_authoring_get_or_create_draft gains three params to
-- write and resume on that basis. The storage itself -- the basis/
-- basis_deal_step_id/seed_run_id columns, the basis check, and the
-- (deal_id, author_id, coalesce(basis_deal_step_id, zero-uuid)) active-draft
-- index -- is added above (Task C2); this section only widens the RPC to
-- populate and query it.
--
-- The three new params change the function's argument signature, so
-- CREATE OR REPLACE would otherwise ADD an overload, leaving the old 3-arg
-- version callable and ambiguous with any 3-positional-arg call. Drop the
-- prior signature first so this stays the single
-- skill_authoring_get_or_create_draft, following the precedent commented in
-- 20260716180000_deal_steps.sql. Every existing caller (the route and the
-- probe/test suites under supabase/tests) calls it with exactly 3 positional
-- args, so they all keep resolving to the new signature with the three
-- trailing defaults applied.

drop function if exists skill_authoring_get_or_create_draft(uuid, uuid, uuid);

create or replace function skill_authoring_get_or_create_draft(
  p_actor_id uuid, p_deal_id uuid, p_correlation_id uuid,
  p_basis_deal_step_id uuid default null, p_basis jsonb default null, p_seed_run_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_draft skill_authoring_drafts%rowtype;
begin
  perform skill_authoring_lock_author(p_actor_id, p_deal_id);
  select * into v_draft from skill_authoring_drafts
  where deal_id = p_deal_id and author_id = p_actor_id and status = 'active'
    and coalesce(basis_deal_step_id, '00000000-0000-0000-0000-000000000000'::uuid)
      = coalesce(p_basis_deal_step_id, '00000000-0000-0000-0000-000000000000'::uuid);
  if found then return skill_authoring_receipt(v_draft); end if;
  insert into skill_authoring_drafts (deal_id, author_id, basis_deal_step_id, basis, seed_run_id)
  values (p_deal_id, p_actor_id, p_basis_deal_step_id, p_basis, p_seed_run_id)
  returning * into v_draft;
  perform skill_authoring_write_audit(p_actor_id, 'skill_authoring.draft_created', p_deal_id,
    jsonb_build_object('draftId', v_draft.id, 'actorId', p_actor_id, 'toState', v_draft.status, 'correlationId', p_correlation_id));
  return skill_authoring_receipt(v_draft);
end;
$$;

-- Task C8: an enhancement draft publishes onto the same rail step its basis
-- was resolved from, rather than inserting a new one. Same receipts, same
-- states -- only the terminal act changes, from rail_insert_step to
-- rail_rebind_step. A publication basis extends the same skill lineage; a
-- mount basis mints a fresh project skill identity, which is the catalog
-- fork -- neither of those is decided here, only whether the draft carries
-- a basis_deal_step_id at all.
--
-- A based publication is the one case where the step underneath the draft
-- can have moved since the draft's basis was captured (someone else rebound
-- it while the draft was open), so one more receipt check runs immediately
-- before the rebind: it reconciles rather than silently discarding that
-- other rebind. referenceOf(jsonb) projects a deal_step_skill_bindings row's
-- jsonb onto the {kind, skillId, versionId, digest} / {kind, name, version,
-- digest} reference shape the draft's basis column stores, so the
-- comparison is against a like shape. jsonb equality is structural, so key
-- order does not matter.
--
-- The rebind branch can report a new terminal status_code, 'step_removed',
-- symmetric to the existing 'anchor_removed' on the insert branch, so the
-- status_code check constraint widens to allow it.

alter table skill_publication_operations drop constraint if exists skill_publication_operations_status_code_check;
alter table skill_publication_operations add constraint skill_publication_operations_status_code_check check (
  status_code is null or status_code = any (array[
    'candidate_invalid', 'candidate_stale', 'duplicate_active', 'duplicate_removed', 'duplicate_declined',
    'access_lost', 'feature_disabled', 'anchor_removed', 'receipt_conflict', 'step_removed'
  ])
);

create or replace function referenceOf(p_binding jsonb) returns jsonb
language sql immutable as $$
  select case p_binding ->> 'kind'
    when 'publication' then jsonb_build_object(
      'kind', 'publication',
      'skillId', p_binding ->> 'skill_id',
      'versionId', p_binding ->> 'version_id',
      'digest', p_binding ->> 'digest'
    )
    when 'mount' then jsonb_build_object(
      'kind', 'mount',
      'name', p_binding ->> 'mount_name',
      'version', (p_binding ->> 'mount_version')::integer,
      'digest', p_binding ->> 'digest'
    )
    else null
  end;
$$;

revoke all on function referenceOf(jsonb) from public, anon, authenticated;
grant execute on function referenceOf(jsonb) to service_role;

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
  v_binding       jsonb;
  v_reference     jsonb;
  v_current       jsonb;
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

  v_binding := jsonb_build_object(
    'skillId', v_op.published_skill_id,
    'versionId', v_op.published_version_id,
    'digest', v_op.published_digest
  );
  v_reference := v_binding || jsonb_build_object('kind', 'publication');

  if v_draft.basis_deal_step_id is not null then
    select to_jsonb(binding) into v_current
      from deal_step_skill_bindings binding
     where binding.deal_step_id = v_draft.basis_deal_step_id;

    -- The ancestor is what this candidate was built on. If somebody rebound the
    -- step while the draft was open, publishing would silently discard their
    -- choice, so this reconciles rather than overwrites.
    if v_current is not null and referenceOf(v_current) is distinct from v_draft.basis then
      return skill_publication_transition(p_publication_id, array['attaching'], 'reconciling',
        jsonb_build_object('statusCode', 'receipt_conflict'));
    end if;

    begin
      perform rail_rebind_step(
        v_op.deal_id, v_op.actor_id, v_draft.basis_deal_step_id, v_reference, 'publication'
      );
    exception when sqlstate 'P0002' then
      if sqlerrm = 'step_removed' then
        return skill_publication_transition(p_publication_id, array['attaching'], 'needs_placement',
          jsonb_build_object('statusCode', 'step_removed'));
      end if;
      raise;
    end;

    v_step_id := v_draft.basis_deal_step_id;
  else
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
      'skillBinding', v_binding
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
      'skillBinding', v_binding
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

-- skill_publication_freeze_guard's proof-of-attach clause only ever looked for
-- a deal_steps row stamped with the live operation's id as request_id, which
-- is how rail_insert_step marks the step it created or reused. A based
-- publication never inserts a step and never stamps request_id -- it rebinds
-- the basis step's deal_step_skill_bindings row instead -- so the original
-- clause would raise a conflict on every based publish. The widened clause
-- accepts either proof: a stamped deal_steps row (creation), or a
-- deal_step_skill_bindings row on the draft's basis step whose kind and
-- reference match what this operation just published (based publication).
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
      and (
        exists (select 1 from deal_steps where request_id = v_live_op_id::text)
        or (
          old.basis_deal_step_id is not null
          and exists (
            select 1 from deal_step_skill_bindings binding
            join skill_publication_operations op on op.id = v_live_op_id
            where binding.deal_step_id = old.basis_deal_step_id
              and binding.kind = 'publication'
              and binding.skill_id = op.published_skill_id
              and binding.version_id = op.published_version_id
              and binding.digest = op.published_digest
              and binding.source = 'publication'
          )
        )
      )
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

-- The conversation half of the same task: send the basis to the turn. The
-- Ignatious authoring turn request needs the draft's basis reference (so the
-- generator can load the ancestor's instructions) and the seed run's text
-- (the failing run that prompted the enhancement), alongside the draft the
-- turn already carries. Conductia never holds skill text itself, only the
-- reference and the run text it already owns.
--
-- The seed run's output falls back to its error message, then to the empty
-- string, because deal_step_skill_runs pairs the verdict with its payload:
-- result_text is null on every failed run by constraint. Enhancing from a
-- failing run is the case this exists for, so it is the case the payload has
-- to survive.
create or replace function skill_authoring_run_context(p_attempt_id uuid)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare
  v_attempt  skill_authoring_attempts%rowtype;
  v_draft    skill_authoring_drafts%rowtype;
  v_message  skill_authoring_messages%rowtype;
  v_seed_run deal_step_skill_runs%rowtype;
begin
  select * into v_attempt from skill_authoring_attempts where id = p_attempt_id and status = 'running';
  if not found then return null; end if;
  select * into v_draft from skill_authoring_drafts where id = v_attempt.draft_id;
  select * into v_message from skill_authoring_messages where id = v_attempt.message_id;
  if v_draft.seed_run_id is not null then
    select * into v_seed_run from deal_step_skill_runs where id = v_draft.seed_run_id;
  end if;
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
    'currentCandidate', (select c.preview from skill_authoring_candidates c where c.id = v_draft.current_candidate_id),
    'basis', v_draft.basis,
    'seedRun', case when v_draft.seed_run_id is not null then
      jsonb_build_object('input', v_seed_run.input,
        'output', coalesce(v_seed_run.result_text, v_seed_run.error_message, ''))
    else null end
  );
end;
$$;

-- One-time import of historical bench replies into deal_step_skill_runs, so an
-- old draft becomes a usable enhancement seed under the single skill-run
-- runner (Task C11). Importing without converging leaves history nothing
-- renders; converging without importing empties every catalog step's history.
--
-- stepSkillIo.ts's IO_BY_STEP table is the only place that names, with
-- certainty, which `work` jsonb key on deal_steps holds a step's bench input
-- and which holds its reply. Only p1-s10 qualifies: its `source` is 'work'
-- (p1-s8's is 'lead-maps' -- its input is fetched live from the target
-- company and stakeholders and never lives in `work` at all, so no input key
-- can be named for it), and its single input key ('meeting_notes') and its
-- always-written output key ('next_actions', the outputs.actions /
-- outputs.fallback destination) are both literal, unconditional field names.
-- Every step outside IO_BY_STEP falls back to firstTextarea(stepId), a
-- mapping computed in TypeScript from generated rail data that this SQL
-- migration cannot reproduce for an arbitrary step id -- those steps are
-- deliberately skipped rather than guessed at.
--
-- Guarded by `where not exists (... source = 'imported')` so re-running is
-- always safe.

insert into deal_step_skill_runs (
  id, deal_id, deal_step_id, source, input, outcome, result_text, started_at, created_at
)
select
  gen_random_uuid(),
  deal_steps.deal_id,
  deal_steps.id,
  'imported',
  deal_steps.work ->> 'meeting_notes',
  'succeeded',
  deal_steps.work ->> 'next_actions',
  deal_steps.bench_run_started_at,
  coalesce(deal_steps.bench_run_started_at, now())
from deal_steps
where deal_steps.origin = 'catalog'
  and deal_steps.step_id = 'p1-s10'
  and deal_steps.work ->> 'meeting_notes' is not null
  and deal_steps.work ->> 'next_actions' is not null
  and not exists (
    select 1 from deal_step_skill_runs existing
    where existing.deal_step_id = deal_steps.id
      and existing.source = 'imported'
  );

-- skill_publication_admit learns the basis.
--
-- The lineage section above forces an enhancement draft to carry a null
-- phase_index and a null placement_kind, and the rebind section makes a based
-- publication rebind its step rather than insert one. Admission is reconciled
-- with both here: otherwise it raises skill_publication_blank_name and
-- skill_publication_incomplete_placement on exactly the drafts those sections
-- require to be blank, and mints a fresh reserved_skill_id unconditionally,
-- which forks the lineage on every publish and leaves a project skill with one
-- version forever.
--
-- Four branches on v_draft.basis_deal_step_id, and nothing else changes:
--
--   name              the basis step's title. A catalog step carries no
--                     definition, so the candidate's name and then the step key
--                     answer for it. The step's title never moves.
--   placement         the basis step's phase, anchored on the step itself. The
--                     rebind branch of skill_publication_attach reads none of
--                     it; the columns are not null and this is the position the
--                     published version lands at.
--   reserved_skill_id the ancestor's skill id for a publication basis, which is
--                     what extends one lineage, and a fresh id for a mount
--                     basis, which is the catalog fork.
--   duplicates        the basis step is exempt. An enhancement keeping its own
--                     skill's name and contract matches its own step by
--                     definition, and Ignatious already exempts the same
--                     identity through ancestorSkillId.
--
-- The second duplicate probe, over skill_publication_operations, means
-- in-flight: state not in ('published', 'failed'). A published operation's
-- name is the title rail_insert_step stamped on the step it created, which is
-- the same title the enhancement branch derives its own name from, so matching
-- 'published' failed a publication-basis enhancement of a builder-created step
-- terminally with duplicate_active. A published operation always carries a
-- resulting_deal_step_id, so the first probe already covers it; the second
-- probe exists only to catch a name another operation has claimed but not yet
-- landed.

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
  v_basis_step deal_steps%rowtype;
  v_capability jsonb;
  v_name text;
  v_phase_index integer;
  v_placement_kind text;
  v_anchor_deal_step_id uuid;
  v_reserved_skill_id uuid;
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

  if v_draft.basis_deal_step_id is null then
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

    v_name := v_draft.name;
    v_phase_index := v_draft.phase_index;
    v_placement_kind := v_draft.placement_kind;
    v_anchor_deal_step_id := v_draft.anchor_deal_step_id;
    v_reserved_skill_id := gen_random_uuid();
  else
    select * into v_basis_step from deal_steps
    where id = v_draft.basis_deal_step_id and deal_id = p_deal_id;
    if not found or v_basis_step.removed_at is not null then
      perform skill_publication_raise('skill_publication_basis_step_removed', '22023');
    end if;

    v_name := left(btrim(coalesce(
      nullif(btrim(v_basis_step.definition ->> 'title'), ''),
      nullif(btrim(v_candidate.preview ->> 'name'), ''),
      v_basis_step.step_id
    )), 100);
    if coalesce(v_name, '') = '' then
      perform skill_publication_raise('skill_publication_blank_name', '22023');
    end if;

    v_phase_index := coalesce(v_basis_step.phase_index, 0);
    v_placement_kind := 'after';
    v_anchor_deal_step_id := v_basis_step.id;
    v_reserved_skill_id := case
      when v_draft.basis ->> 'kind' = 'publication' then (v_draft.basis ->> 'skillId')::uuid
      else gen_random_uuid()
    end;
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

  v_normalized_name := skill_publication_normalize_name(v_name);

  select ds.id, ds.removed_at is not null into v_dup_step_id, v_dup_removed
  from deal_steps ds
  left join skill_publication_operations pubop
    on pubop.resulting_deal_step_id = ds.id and pubop.state = 'published'
  where ds.deal_id = p_deal_id
    and ds.definition ->> 'type' = 'skill'
    and (v_draft.basis_deal_step_id is null or ds.id <> v_draft.basis_deal_step_id)
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
    where deal_id = p_deal_id and draft_id <> p_draft_id
      and state not in ('published', 'failed')
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
    v_name, v_phase_index, v_placement_kind, v_anchor_deal_step_id,
    v_reserved_skill_id, 'custom:' || gen_random_uuid()::text, v_capability,
    v_status_code, v_status_step
  ) returning * into v_op;

  perform skill_authoring_write_audit(p_actor_id, 'skill_publication.admitted', p_deal_id,
    jsonb_strip_nulls(jsonb_build_object(
      'publicationId', v_op.id, 'draftId', v_draft.id, 'candidateId', v_candidate.id, 'actorId', p_actor_id,
      'toState', v_op.state, 'statusCode', v_status_code, 'dealStepId', v_status_step,
      'basisDealStepId', v_draft.basis_deal_step_id, 'reservedSkillId', v_op.reserved_skill_id,
      'correlationId', p_correlation_id
    )));

  return skill_publication_browser_view(v_op);
end;
$$;

revoke all on function skill_publication_admit(uuid, uuid, uuid, uuid, bigint, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function skill_publication_admit(uuid, uuid, uuid, uuid, bigint, uuid, text, uuid)
  to service_role;
