do $$
declare
  v_deal uuid := 'e4000000-0000-4000-8000-000000000001';
  v_op skill_publication_operations%rowtype;
  v_before skill_publication_operations%rowtype;
  v_view jsonb;
begin
  perform probe_seed_deal(v_deal);
  v_op := probe_attaching_operation(v_deal, probe_author_a());
  update skill_publication_operations set state = 'publishing' where id = v_op.id;
  select * into v_before from skill_publication_operations where id = v_op.id;
  v_view := skill_publication_attach(v_op.id);
  perform probe_assert(v_view = skill_publication_browser_view(v_before),
    'a non-attaching state was not returned unchanged');
  perform probe_assert(not exists (select 1 from deal_steps where request_id = v_op.id::text),
    'a no-op attach call created a step');
end;
$$;
\echo ok: only attaching is accepted; other nonterminal states are a no-op

do $$
declare
  v_state text;
  v_deal uuid;
  v_setup jsonb;
  v_op skill_publication_operations%rowtype;
  v_before skill_publication_operations%rowtype;
  v_view jsonb;
begin
  foreach v_state in array array['reconciling', 'needs_placement'] loop
    v_deal := gen_random_uuid();
    perform probe_seed_deal(v_deal);
    v_op := probe_attaching_operation(v_deal, probe_author_a());
    update skill_publication_operations set state = v_state where id = v_op.id;
    select * into v_before from skill_publication_operations where id = v_op.id;
    v_view := skill_publication_attach(v_op.id);
    perform probe_assert(v_view = skill_publication_browser_view(v_before),
      format('a %s state was not returned unchanged by attach', v_state));
    perform probe_assert(not exists (select 1 from deal_steps where request_id = v_op.id::text),
      format('a no-op attach call from %s created a step', v_state));
  end loop;

  v_deal := gen_random_uuid();
  perform probe_seed_deal(v_deal);
  v_setup := probe_publication_setup(v_deal, probe_author_a(), false);
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint, p_state => 'failed');
  select * into v_before from skill_publication_operations where id = v_op.id;
  v_view := skill_publication_attach(v_op.id);
  perform probe_assert(v_view = skill_publication_browser_view(v_before),
    'a failed state was not returned unchanged by attach');
  perform probe_assert(not exists (select 1 from deal_steps where request_id = v_op.id::text),
    'a no-op attach call from failed created a step');
end;
$$;
\echo ok: attach is a no-op for reconciling, needs_placement and failed

do $$
declare
  v_deal uuid := 'e4000000-0000-4000-8000-000000000002';
  v_setup jsonb;
  v_reserved uuid := gen_random_uuid();
  v_op skill_publication_operations%rowtype;
  v_view jsonb;
begin
  perform probe_seed_deal(v_deal);
  v_setup := probe_publication_setup(v_deal, probe_author_a(), false);
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint,
    p_reserved_skill => v_reserved, p_state => 'attaching',
    p_published_skill_id => gen_random_uuid(), p_published_version_id => gen_random_uuid(),
    p_published_digest => v_setup ->> 'candidate_digest');

  v_view := skill_publication_attach(v_op.id);

  perform probe_assert(v_view ->> 'state' = 'reconciling',
    'a mismatched published skill id did not move to reconciling');
  perform probe_assert(v_view -> 'error' ->> 'code' = 'receipt_conflict',
    'a mismatched published skill id was not reported as receipt_conflict');
  perform probe_assert(not exists (select 1 from deal_steps where request_id = v_op.id::text),
    'a receipt conflict still created a step');
end;
$$;
\echo ok: a mismatched published skill id fails receipt verification into reconciling

do $$
declare
  v_deal uuid := 'e4000000-0000-4000-8000-000000000012';
  v_setup jsonb;
  v_op skill_publication_operations%rowtype;
  v_view jsonb;
begin
  perform probe_seed_deal(v_deal);
  v_setup := probe_publication_setup(v_deal, probe_author_a(), false);
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint, p_state => 'attaching');

  v_view := skill_publication_attach(v_op.id);

  perform probe_assert(v_view -> 'error' ->> 'code' = 'receipt_conflict',
    'an operation with no receipt at all was not reported as receipt_conflict');
end;
$$;
\echo ok: attaching without a published receipt fails verification into reconciling

do $$
declare
  v_deal uuid := 'e4000000-0000-4000-8000-000000000013';
  v_setup jsonb;
  v_reserved uuid := gen_random_uuid();
  v_op skill_publication_operations%rowtype;
  v_view jsonb;
begin
  perform probe_seed_deal(v_deal);
  v_setup := probe_publication_setup(v_deal, probe_author_a(), false);
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint,
    p_reserved_skill => v_reserved, p_state => 'attaching', p_published_skill_id => v_reserved,
    p_published_version_id => gen_random_uuid(), p_published_digest => repeat('9', 64));

  v_view := skill_publication_attach(v_op.id);

  perform probe_assert(v_view ->> 'state' = 'reconciling',
    'a published digest that does not match the candidate digest did not move to reconciling');
  perform probe_assert(v_view -> 'error' ->> 'code' = 'receipt_conflict',
    'a published digest mismatch was not reported as receipt_conflict');
end;
$$;
\echo ok: R57 requires the published digest to equal the candidate digest

do $$
declare
  v_deal uuid := 'e4000000-0000-4000-8000-000000000014';
  v_setup jsonb;
  v_reserved uuid := gen_random_uuid();
  v_op skill_publication_operations%rowtype;
  v_view jsonb;
begin
  perform probe_seed_deal(v_deal);
  v_setup := probe_publication_setup(v_deal, probe_author_a(), false);
  perform skill_authoring_discard_draft(probe_author_a(), v_deal, (v_setup ->> 'draft_id')::uuid,
    probe_revision((v_setup ->> 'draft_id')::uuid), probe_correlation());
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint,
    p_reserved_skill => v_reserved, p_state => 'attaching', p_published_skill_id => v_reserved,
    p_published_version_id => gen_random_uuid(), p_published_digest => v_setup ->> 'candidate_digest');

  v_view := skill_publication_attach(v_op.id);

  perform probe_assert(v_view -> 'error' ->> 'code' = 'receipt_conflict',
    'a non-active draft was not reported as receipt_conflict');
end;
$$;
\echo ok: attaching against a non-active draft fails verification into reconciling

do $$
declare
  v_deal uuid := 'e4000000-0000-4000-8000-000000000015';
  v_setup jsonb;
  v_reserved uuid := gen_random_uuid();
  v_op skill_publication_operations%rowtype;
  v_view jsonb;
begin
  perform probe_seed_deal(v_deal);
  v_setup := probe_publication_setup(v_deal, probe_author_a(), false);
  update skill_authoring_drafts set current_candidate_id = gen_random_uuid()
  where id = (v_setup ->> 'draft_id')::uuid;
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint,
    p_reserved_skill => v_reserved, p_state => 'attaching', p_published_skill_id => v_reserved,
    p_published_version_id => gen_random_uuid(), p_published_digest => v_setup ->> 'candidate_digest');

  v_view := skill_publication_attach(v_op.id);

  perform probe_assert(v_view -> 'error' ->> 'code' = 'receipt_conflict',
    'a stale current candidate was not reported as receipt_conflict');
end;
$$;
\echo ok: a draft that moved to a different candidate fails verification into reconciling

do $$
declare
  v_deal uuid := 'e4000000-0000-4000-8000-000000000016';
  v_setup jsonb;
  v_reserved uuid := gen_random_uuid();
  v_op skill_publication_operations%rowtype;
  v_view jsonb;
begin
  perform probe_seed_deal(v_deal);
  v_setup := probe_publication_setup(v_deal, probe_author_a(), false);
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint + 1,
    p_reserved_skill => v_reserved, p_state => 'attaching', p_published_skill_id => v_reserved,
    p_published_version_id => gen_random_uuid(), p_published_digest => v_setup ->> 'candidate_digest');

  v_view := skill_publication_attach(v_op.id);

  perform probe_assert(v_view -> 'error' ->> 'code' = 'receipt_conflict',
    'a stale frozen edit revision was not reported as receipt_conflict');
end;
$$;
\echo ok: a frozen draft edit revision that no longer matches the draft fails verification into reconciling

do $$
declare
  v_deal uuid := 'e4000000-0000-4000-8000-000000000003';
  v_op skill_publication_operations%rowtype;
  v_view jsonb;
  v_step deal_steps%rowtype;
  v_expected_definition jsonb;
  v_draft skill_authoring_drafts%rowtype;
  v_current_after uuid;
  v_audit audit_log%rowtype;
begin
  perform probe_seed_deal(v_deal);
  v_op := probe_attaching_operation(v_deal, probe_author_a());

  v_view := skill_publication_attach(v_op.id);

  select * into v_step from deal_steps where request_id = v_op.id::text;
  perform probe_assert(v_step.id is not null, 'attach did not create a step for the reserved request id');
  perform probe_assert(v_step.step_id = v_op.reserved_step_key,
    'the created step did not carry the reserved step key');
  perform probe_assert((select count(*) from deal_steps where deal_id = v_deal) = 1,
    'attach created more than one step');
  perform probe_assert(v_step.status = 'pending', 'the created step was not pending');

  v_expected_definition := probe_expected_definition(v_op);
  perform probe_assert(v_step.definition = v_expected_definition,
    'the created step definition did not match the pinned jsonb_build_object exactly');

  select * into v_draft from skill_authoring_drafts where id = v_op.draft_id;
  perform probe_assert(v_draft.status = 'published' and v_draft.published_at is not null,
    'the draft was not published together with published_at');

  perform probe_assert(v_view ->> 'state' = 'published', 'the operation did not report published');
  perform probe_assert((v_view -> 'result' ->> 'stepId') = v_step.id::text,
    'the browser view result did not carry the resulting step id');
  perform probe_assert((v_view -> 'result' -> 'skillBinding') = jsonb_build_object(
    'skillId', v_op.published_skill_id, 'versionId', v_op.published_version_id, 'digest', v_op.published_digest),
    'the browser view result did not carry the pinned skill binding');

  select current_deal_step_id into v_current_after from deals where id = v_deal;
  perform probe_assert(v_current_after is null, 'inserting a pending step moved deals.current_deal_step_id');

  select * into v_audit from audit_log
  where action = 'skill_publication.transition' and detail ->> 'publicationId' = v_op.id::text
    and detail ->> 'toState' = 'published'
  order by ts desc limit 1;
  perform probe_assert(v_audit.id is not null, 'no success audit row was written');
  perform probe_assert(v_audit.actor_id is null and v_audit.service_identity = 'conductia',
    'the success audit row did not carry the conductia service principal');
  perform probe_assert(v_audit.detail ->> 'operationActorId' = v_op.actor_id::text,
    'the success audit row did not carry the original operation actor id');
  perform probe_assert(v_audit.detail ->> 'toState' = 'published',
    'the success audit row did not report toState published');
end;
$$;
\echo ok: a successful attach pins the request id, step key and exact definition, publishes the draft and operation, and audits

do $$
declare
  v_deal uuid := 'e4000000-0000-4000-8000-000000000004';
  v_anchor uuid := gen_random_uuid();
  v_current uuid := gen_random_uuid();
  v_op skill_publication_operations%rowtype;
  v_current_after uuid;
  v_current_status text;
begin
  perform probe_seed_deal(v_deal);
  insert into deal_steps (id, deal_id, step_id, seq, status, phase_index, display_order)
    values (v_anchor, v_deal, 'catalog:anchor', 1, 'complete', 1, 1);
  insert into deal_steps (id, deal_id, step_id, seq, status, phase_index, display_order)
    values (v_current, v_deal, 'catalog:current', 2, 'current', 1, 2);
  update deals set current_deal_step_id = v_current where id = v_deal;

  v_op := probe_attaching_operation(v_deal, probe_author_a(), 1, 'after', v_anchor);
  perform skill_publication_attach(v_op.id);

  select current_deal_step_id into v_current_after from deals where id = v_deal;
  select status into v_current_status from deal_steps where id = v_current;
  perform probe_assert(v_current_after = v_current,
    'inserting before the current step moved deals.current_deal_step_id');
  perform probe_assert(v_current_status = 'current',
    'inserting before the current step changed its status');
end;
$$;
\echo ok: inserting before the current position never moves the current step

do $$
declare
  v_deal uuid := 'e4000000-0000-4000-8000-000000000005';
  v_op skill_publication_operations%rowtype;
  v_view1 jsonb;
  v_view2 jsonb;
begin
  perform probe_seed_deal(v_deal);
  v_op := probe_attaching_operation(v_deal, probe_author_a());
  v_view1 := skill_publication_attach(v_op.id);
  v_view2 := skill_publication_attach(v_op.id);
  perform probe_assert(v_view1 = v_view2, 'a replayed attach call did not return the same view');
  perform probe_assert((select count(*) from deal_steps where deal_id = v_deal) = 1,
    'a replayed attach call created a second step row');
end;
$$;
\echo ok: replay after success returns the same view with one step row total

do $$
declare
  v_deal uuid := 'e4000000-0000-4000-8000-000000000006';
  v_op skill_publication_operations%rowtype;
  v_pre jsonb;
  v_view jsonb;
  v_step_count int;
begin
  perform probe_seed_deal(v_deal);
  v_op := probe_attaching_operation(v_deal, probe_author_a());
  v_pre := rail_insert_step(v_deal, probe_author_a(), v_op.phase_index, v_op.placement_kind, v_op.anchor_deal_step_id,
    probe_expected_definition(v_op), v_op.reserved_step_key, v_op.id::text);
  perform probe_assert((v_pre ->> 'created')::boolean, 'the pre-existing setup insert was not itself a fresh create');

  v_view := skill_publication_attach(v_op.id);

  select count(*) into v_step_count from deal_steps where request_id = v_op.id::text;
  perform probe_assert(v_step_count = 1, 'attach on top of a pre-existing Part A row created a second row');
  perform probe_assert((v_view -> 'result' ->> 'stepId') = (v_pre ->> 'stepId'),
    'attach did not finalize with the pre-existing step id');
  perform probe_assert(v_view ->> 'state' = 'published', 'attach did not finalize a pre-existing insert');
end;
$$;
\echo ok: a pre-existing Part A row with the exact pinned definition finalizes with created false

do $$
declare
  v_deal uuid := 'e4000000-0000-4000-8000-000000000017';
  v_op skill_publication_operations%rowtype;
  v_view jsonb;
begin
  perform probe_seed_deal(v_deal);
  v_op := probe_attaching_operation(v_deal, probe_author_a());
  perform rail_insert_step(v_deal, probe_author_a(), v_op.phase_index, v_op.placement_kind, v_op.anchor_deal_step_id,
    jsonb_build_object('type', 'skill', 'title', 'a stale placeholder'), v_op.reserved_step_key, v_op.id::text);

  v_view := skill_publication_attach(v_op.id);

  perform probe_assert(v_view ->> 'state' = 'reconciling',
    'a mismatched pre-existing definition did not move to reconciling');
  perform probe_assert(v_view -> 'error' ->> 'code' = 'receipt_conflict',
    'a mismatched pre-existing definition was not reported as receipt_conflict');
  perform probe_assert((select count(*) from deal_steps where request_id = v_op.id::text) = 1,
    'a mismatched pre-existing definition created a second row instead of reconciling');
  perform probe_assert((select status from skill_authoring_drafts where id = v_op.draft_id) = 'active',
    'a mismatched pre-existing definition still published the draft');
end;
$$;
\echo ok: a pre-existing Part A row with a mismatched definition fails receipt verification into reconciling

do $$
declare
  v_deal uuid := 'e4000000-0000-4000-8000-000000000026';
  v_op skill_publication_operations%rowtype;
  v_view jsonb;
begin
  perform probe_seed_deal(v_deal);
  v_op := probe_attaching_operation(v_deal, probe_author_a());
  perform rail_insert_step(v_deal, probe_author_a(), v_op.phase_index, v_op.placement_kind, v_op.anchor_deal_step_id,
    probe_expected_definition(v_op), 'custom:' || gen_random_uuid()::text, v_op.id::text);

  v_view := skill_publication_attach(v_op.id);

  perform probe_assert(v_view ->> 'state' = 'reconciling',
    'a pre-existing row with a different step_id did not move to reconciling');
  perform probe_assert(v_view -> 'error' ->> 'code' = 'receipt_conflict',
    'a pre-existing row with a different step_id was not reported as receipt_conflict');
  perform probe_assert((select count(*) from deal_steps where request_id = v_op.id::text) = 1,
    'a pre-existing row with a mismatched step_id created a second row');
  perform probe_assert((select status from skill_authoring_drafts where id = v_op.draft_id) = 'active',
    'a pre-existing row with a mismatched step_id still published the draft');
end;
$$;
\echo ok: a pre-existing Part A row with a different step_id fails receipt verification into reconciling

do $$
declare
  v_deal uuid := 'e4000000-0000-4000-8000-000000000007';
  v_step uuid := gen_random_uuid();
  v_op skill_publication_operations%rowtype;
  v_view jsonb;
begin
  perform probe_seed_deal(v_deal);
  perform probe_deal_step(v_step, v_deal);
  v_op := probe_attaching_operation(v_deal, probe_author_a(), 1, 'after', v_step);
  update deal_steps set removed_at = now() where id = v_step;

  v_view := skill_publication_attach(v_op.id);

  perform probe_assert(v_view ->> 'state' = 'needs_placement', 'a removed anchor did not move to needs_placement');
  perform probe_assert(v_view -> 'error' ->> 'code' = 'anchor_removed',
    'a removed anchor was not reported as anchor_removed');
  perform probe_assert(not exists (select 1 from deal_steps where request_id = v_op.id::text),
    'a removed anchor still created a step');
  perform probe_assert((select published_version_id from skill_publication_operations where id = v_op.id)
    = v_op.published_version_id, 'a removed anchor changed the live receipt');
end;
$$;
\echo ok: a removed anchor moves to needs_placement with the receipt unchanged

create function probe_force_attach_failure() returns trigger language plpgsql as $$
begin
  raise exception 'probe_forced_attach_failure' using errcode = 'PT500';
end;
$$;

create trigger probe_force_attach_failure_trg
  before update on skill_publication_operations
  for each row when (new.state = 'published')
  execute function probe_force_attach_failure();

do $$
declare
  v_deal uuid := 'e4000000-0000-4000-8000-000000000009';
  v_op skill_publication_operations%rowtype;
begin
  perform probe_seed_deal(v_deal);
  v_op := probe_attaching_operation(v_deal, probe_author_a());
  perform set_config('probe.force_attach_op', v_op.id::text, true);
  perform probe_expect_sqlstate(format('select skill_publication_attach(%L)', v_op.id), 'PT500');
end;
$$;

drop trigger probe_force_attach_failure_trg on skill_publication_operations;
drop function probe_force_attach_failure();

do $$
declare
  v_op_id uuid := current_setting('probe.force_attach_op')::uuid;
begin
  perform probe_assert(not exists (select 1 from deal_steps where request_id = v_op_id::text),
    'a forced failure after insert left a step row behind');
  perform probe_assert((select status from skill_authoring_drafts
    where id = (select draft_id from skill_publication_operations where id = v_op_id)) = 'active',
    'a forced failure after insert left the draft published');
  perform probe_assert((select state from skill_publication_operations where id = v_op_id) = 'attaching',
    'a forced failure after insert changed the operation state');
end;
$$;
\echo ok: a forced failure after the insert leaves no step row and no published draft

do $$
declare
  v_deal uuid := 'e4000000-0000-4000-8000-000000000008';
  v_existing uuid := gen_random_uuid();
  v_op_start skill_publication_operations%rowtype;
  v_op_end skill_publication_operations%rowtype;
  v_start_order int;
  v_existing_order int;
  v_end_order int;
begin
  perform probe_seed_deal(v_deal);
  insert into deal_steps (id, deal_id, step_id, seq, status, phase_index, display_order)
    values (v_existing, v_deal, 'catalog:existing', 1, 'pending', 1, 1);

  v_op_start := probe_attaching_operation(v_deal, probe_author_a(), 1, 'phase_start');
  perform skill_publication_attach(v_op_start.id);

  v_op_end := probe_attaching_operation(v_deal, probe_author_b(), 1, 'phase_end', p_seed_deal => false);
  perform skill_publication_attach(v_op_end.id);

  select display_order into v_start_order from deal_steps where step_id = v_op_start.reserved_step_key;
  select display_order into v_existing_order from deal_steps where id = v_existing;
  select display_order into v_end_order from deal_steps where step_id = v_op_end.reserved_step_key;

  perform probe_assert(v_start_order < v_existing_order,
    'a phase_start placement did not rebase ahead of the existing step');
  perform probe_assert(v_end_order > v_existing_order,
    'a phase_end placement did not rebase after the existing step');
end;
$$;
\echo ok: phase_start and phase_end placements insert through Part A rebasing

do $$
declare
  v_deal uuid := 'e4000000-0000-4000-8000-000000000011';
  v_actor uuid := probe_author_a();
  v_setup jsonb;
  v_draft uuid;
  v_message_id uuid;
  v_op skill_publication_operations%rowtype;
  v_client uuid := gen_random_uuid();
begin
  v_setup := probe_publication_setup(v_deal, v_actor);
  v_draft := (v_setup ->> 'draft_id')::uuid;

  perform probe_submit(v_actor, v_deal, v_draft, v_client, 'first attempt');
  update skill_authoring_attempts set status = 'failed' where draft_id = v_draft and attempt_number = 1;
  select id into v_message_id from skill_authoring_messages where draft_id = v_draft limit 1;

  v_op := probe_insert_operation(v_deal, v_draft, v_actor, gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', probe_revision(v_draft), p_state => 'attaching');

  perform probe_expect_sqlstate(format('select skill_authoring_patch_draft(%L,%L,%L,%L,%L,%L,%L,%L,%L,%L)',
    v_actor, v_deal, v_draft, probe_revision(v_draft), 'Renamed', 1, 'phase_end', null,
    'edited text', probe_correlation()), '40001');

  perform probe_expect_sqlstate(format('select skill_authoring_submit_message(%L,%L,%L,%L,%L,%L,%L)',
    v_actor, v_deal, v_draft, probe_revision(v_draft), gen_random_uuid(), 'second message', probe_correlation()),
    '40001');

  perform probe_expect_sqlstate(format('select skill_authoring_retry_message(%L,%L,%L,%L,%L,%L)',
    v_actor, v_deal, v_draft, v_message_id, gen_random_uuid(), probe_correlation()), '40001');

  perform probe_expect_sqlstate(format('select skill_authoring_discard_draft(%L,%L,%L,%L,%L)',
    v_actor, v_deal, v_draft, probe_revision(v_draft), probe_correlation()), '40001');

  update skill_publication_operations set state = 'failed' where id = v_op.id;

  perform skill_authoring_patch_draft(v_actor, v_deal, v_draft, probe_revision(v_draft), 'Renamed', 1, 'phase_end',
    null, 'edited text', probe_correlation());
  perform skill_authoring_submit_message(v_actor, v_deal, v_draft, probe_revision(v_draft), gen_random_uuid(),
    'second message', probe_correlation());
  update skill_authoring_attempts set status = 'failed'
  where draft_id = v_draft and status = 'running';
  perform skill_authoring_retry_message(v_actor, v_deal, v_draft, v_message_id, gen_random_uuid(), probe_correlation());
  perform skill_authoring_discard_draft(v_actor, v_deal, v_draft, probe_revision(v_draft), probe_correlation());
end;
$$;
\echo ok: nonterminal publication freezes draft patch, message submit, attempt retry and discard, unfrozen once failed

do $$
declare
  v_deal uuid := 'e4000000-0000-4000-8000-000000000018';
  v_actor uuid := probe_author_a();
  v_setup jsonb;
  v_draft uuid;
  v_op skill_publication_operations%rowtype;
begin
  v_setup := probe_publication_setup(v_deal, v_actor);
  v_draft := (v_setup ->> 'draft_id')::uuid;
  v_op := probe_insert_operation(v_deal, v_draft, v_actor, gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', probe_revision(v_draft), p_state => 'attaching');

  perform probe_expect_sqlstate(format(
    'insert into skill_authoring_messages (draft_id, author_id, ordinal, text, client_message_id, admitted_edit_revision) values (%L,%L,%L,%L,%L,%L)',
    v_draft, v_actor, 2, 'direct insert', gen_random_uuid(), 0), '40001');
end;
$$;
\echo ok: a direct insert into skill_authoring_messages is frozen without going through submit_message

do $$
declare
  v_deal uuid := 'e4000000-0000-4000-8000-000000000019';
  v_op skill_publication_operations%rowtype;
begin
  perform probe_seed_deal(v_deal);
  v_op := probe_attaching_operation(v_deal, probe_author_a());
  perform rail_insert_step(v_deal, probe_author_a(), v_op.phase_index, v_op.placement_kind, v_op.anchor_deal_step_id,
    probe_expected_definition(v_op), v_op.reserved_step_key, v_op.id::text);

  perform probe_expect_sqlstate(format(
    'update skill_authoring_drafts set status = %L, published_at = now(), name = %L where id = %L',
    'published', 'Changed name', v_op.draft_id), '40001');
end;
$$;
\echo ok: publishing the draft with any other column change while attaching is still frozen

do $$
declare
  v_deal uuid := 'e4000000-0000-4000-8000-000000000020';
  v_op skill_publication_operations%rowtype;
begin
  perform probe_seed_deal(v_deal);
  v_op := probe_attaching_operation(v_deal, probe_author_a());

  perform probe_expect_sqlstate(format(
    'update skill_authoring_drafts set status = %L, published_at = now() where id = %L',
    'published', v_op.draft_id), '40001');
end;
$$;
\echo ok: publishing the draft before Part A has inserted its step is still frozen
