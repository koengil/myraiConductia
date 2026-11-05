do $$
declare
  v_deal uuid := 'e1000000-0000-4000-8000-000000000012';
  v_setup jsonb;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  perform probe_expect_sqlstate(format('select probe_insert_operation(%L,%L,%L,%L,%L,%L,%L,%L)',
    v_deal, v_setup ->> 'draft_id', probe_author_a(), gen_random_uuid(),
    v_setup ->> 'candidate_id', gen_random_uuid(), v_setup ->> 'candidate_digest',
    (v_setup ->> 'draft_edit_revision')::text), '23503');
  perform probe_expect_sqlstate(format('select probe_insert_operation(%L,%L,%L,%L,%L,%L,%L,%L)',
    v_deal, v_setup ->> 'draft_id', probe_author_a(), gen_random_uuid(),
    v_setup ->> 'candidate_id', v_setup ->> 'provider_candidate_id', repeat('f', 64),
    (v_setup ->> 'draft_edit_revision')::text), '23503');
end;
$$;
\echo ok: candidate identity binding rejects a mismatched provider id or digest

do $$
declare
  v_deal uuid := 'e1000000-0000-4000-8000-000000000013';
  v_setup jsonb;
  v_op skill_publication_operations;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint);
  perform probe_expect_sqlstate(format('update skill_publication_operations set id = %L where id = %L',
    gen_random_uuid(), v_op.id), 'P0001');
  perform probe_expect_sqlstate(format('update skill_publication_operations set deal_id = %L where id = %L',
    gen_random_uuid(), v_op.id), 'P0001');
  perform probe_expect_sqlstate(format('update skill_publication_operations set draft_id = %L where id = %L',
    gen_random_uuid(), v_op.id), 'P0001');
  perform probe_expect_sqlstate(format('update skill_publication_operations set actor_id = %L where id = %L',
    gen_random_uuid(), v_op.id), 'P0001');
  perform probe_expect_sqlstate(format('update skill_publication_operations set client_request_id = %L where id = %L',
    gen_random_uuid(), v_op.id), 'P0001');
end;
$$;
\echo ok: core identity fields are frozen after admission

do $$
declare
  v_deal uuid := 'e1000000-0000-4000-8000-000000000014';
  v_setup jsonb;
  v_op skill_publication_operations;
  v_skill uuid := gen_random_uuid();
  v_version uuid := gen_random_uuid();
  v_digest text := repeat('a', 64);
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint);
  update skill_publication_operations
  set published_skill_id = v_skill, published_version_id = v_version, published_digest = v_digest, state = 'attaching'
  where id = v_op.id;
  perform probe_expect_sqlstate(format('update skill_publication_operations set state = %L where id = %L',
    'failed', v_op.id), '23514');
end;
$$;
\echo ok: a failed operation cannot carry a live publication receipt

do $$
declare
  v_deal uuid := 'e1000000-0000-4000-8000-000000000015';
  v_setup jsonb;
  v_skill uuid := gen_random_uuid();
  v_version uuid := gen_random_uuid();
  v_digest text := repeat('a', 64);
  v_step uuid := gen_random_uuid();
  v_op skill_publication_operations;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  perform probe_expect_sqlstate(format('select probe_insert_operation(%L,%L,%L,%L,%L,%L,%L,%L,p_state=>%L)',
    v_deal, v_setup ->> 'draft_id', probe_author_a(), gen_random_uuid(),
    v_setup ->> 'candidate_id', v_setup ->> 'provider_candidate_id', v_setup ->> 'candidate_digest',
    (v_setup ->> 'draft_edit_revision')::text, 'published'), '23514');
  perform probe_expect_sqlstate(
    format('select probe_insert_operation(%L,%L,%L,%L,%L,%L,%L,%L,p_state=>%L,p_published_skill_id=>%L,p_published_version_id=>%L,p_published_digest=>%L)',
    v_deal, v_setup ->> 'draft_id', probe_author_a(), gen_random_uuid(),
    v_setup ->> 'candidate_id', v_setup ->> 'provider_candidate_id', v_setup ->> 'candidate_digest',
    (v_setup ->> 'draft_edit_revision')::text, 'published', v_skill, v_version, v_digest), '23514');
  perform probe_deal_step(v_step, v_deal);
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint,
    p_state => 'published', p_published_skill_id => v_skill, p_published_version_id => v_version,
    p_published_digest => v_digest, p_resulting_deal_step_id => v_step);
  perform probe_assert(v_op.state = 'published', 'a complete published admission with a live receipt and a resulting step was rejected');
end;
$$;
\echo ok: published state requires a live receipt and a resulting step

do $$
declare
  v_deal uuid := 'e1000000-0000-4000-8000-000000000016';
  v_setup jsonb;
  v_op skill_publication_operations;
  v_step uuid := gen_random_uuid();
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint);
  perform probe_expect_sqlstate(format('update skill_publication_operations set phase_index = %L where id = %L',
    2, v_op.id), 'P0001');
  perform probe_deal_step(v_step, v_deal);
  update skill_publication_operations set state = 'needs_placement' where id = v_op.id;
  update skill_publication_operations
  set phase_index = 2, placement_kind = 'after', anchor_deal_step_id = v_step
  where id = v_op.id;
  perform probe_assert((select phase_index = 2 and placement_kind = 'after' and anchor_deal_step_id = v_step
    from skill_publication_operations where id = v_op.id),
    'a placement replacement while needs_placement was rejected');
end;
$$;
\echo ok: placement is frozen except while needs_placement

do $$
declare
  v_deal uuid := 'e1000000-0000-4000-8000-000000000031';
  v_setup jsonb;
  v_op skill_publication_operations;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  insert into skill_publication_operations (
    deal_id, draft_id, actor_id, client_request_id,
    candidate_id, provider_candidate_id, candidate_digest, draft_edit_revision,
    name, phase_index, placement_kind, reserved_skill_id, reserved_step_key, capability_contract
  ) values (
    v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint,
    'Buyer screen', 1, 'phase_end', gen_random_uuid(), 'custom:' || gen_random_uuid()::text,
    jsonb_build_object('purpose', 'Screen buyers', 'expectedInput', 'Deal context', 'expectedOutput', 'Ranked buyers')
  ) returning * into v_op;
  perform probe_assert(v_op.state = 'preparing', 'omitting state on insert did not default to preparing');
end;
$$;
\echo ok: state defaults to preparing when omitted on insert

do $$
declare
  v_deal uuid := 'e1000000-0000-4000-8000-000000000032';
  v_setup jsonb;
  v_op skill_publication_operations;
  v_skill uuid := gen_random_uuid();
  v_version uuid := gen_random_uuid();
  v_digest text := repeat('a', 64);
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint);
  update skill_publication_operations
  set published_skill_id = v_skill, published_version_id = v_version, published_digest = v_digest, state = 'attaching'
  where id = v_op.id;
  perform probe_expect_sqlstate(format(
    'update skill_publication_operations set published_version_id = %L where id = %L',
    gen_random_uuid(), v_op.id), 'P0001');
  perform probe_expect_sqlstate(format(
    'update skill_publication_operations set published_version_id = null, published_skill_id = null, published_digest = null where id = %L',
    v_op.id), 'P0001');
end;
$$;
\echo ok: a live publication receipt cannot be changed or cleared once attached

do $$
declare
  v_deal uuid := 'e1000000-0000-4000-8000-000000000033';
  v_setup jsonb;
  v_op skill_publication_operations;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint, p_state => 'attaching');
  perform probe_expect_sqlstate(format(
    'update skill_publication_operations set published_skill_id = %L, published_version_id = %L, published_digest = %L where id = %L',
    gen_random_uuid(), gen_random_uuid(), repeat('A', 64), v_op.id), '23514');
end;
$$;
\echo ok: published_digest rejects uppercase hex
