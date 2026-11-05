do $$
declare
  v_deal uuid := 'e1000000-0000-4000-8000-000000000001';
  v_setup jsonb;
  v_op skill_publication_operations;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint);
  perform probe_assert(v_op.state = 'preparing', 'default state was not preparing');
  perform probe_assert(v_op.revision = 0, 'default revision was not 0');
  perform probe_assert(v_op.attempt_count = 0, 'default attempt_count was not 0');
  perform probe_assert(v_op.created_at is not null and v_op.updated_at is not null, 'timestamps were not defaulted');
  perform probe_assert(v_op.published_skill_id is null and v_op.published_version_id is null
    and v_op.published_digest is null, 'published receipt was not null by default');
  perform probe_assert(v_op.resulting_deal_step_id is null, 'resulting_deal_step_id was not null by default');
  perform probe_assert(v_op.comparison_set_digest is null and v_op.preparation_id is null
    and v_op.assessment_digest is null and v_op.duplicate_matches is null, 'preparation outcome was not null by default');
  perform probe_assert(v_op.duplicate_confirmed_at is null and v_op.duplicate_confirmed_by is null,
    'duplicate confirmation was not null by default');
  perform probe_assert(v_op.status_code is null and v_op.status_message is null and v_op.result is null
    and v_op.next_retry_at is null, 'operational metadata was not null by default');
  perform probe_assert(v_op.name = 'Buyer screen' and v_op.phase_index = 1 and v_op.placement_kind = 'phase_end'
    and v_op.anchor_deal_step_id is null, 'frozen step metadata did not match the admitted values');
  perform probe_assert(v_op.candidate_id = (v_setup ->> 'candidate_id')::uuid
    and v_op.provider_candidate_id = (v_setup ->> 'provider_candidate_id')::uuid,
    'admitted candidate identity was not recorded');
end;
$$;
\echo ok: defaults on admission

do $$
declare
  v_deal uuid := 'e1000000-0000-4000-8000-000000000002';
  v_setup jsonb;
  v_client uuid := gen_random_uuid();
  v_op skill_publication_operations;
  v_detail text;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), v_client,
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint);
  update skill_publication_operations set state = 'failed' where id = v_op.id;
  v_detail := probe_expect_sqlstate(format('select probe_insert_operation(%L,%L,%L,%L,%L,%L,%L,%L)',
    v_deal, v_setup ->> 'draft_id', probe_author_a(), v_client,
    v_setup ->> 'candidate_id', v_setup ->> 'provider_candidate_id', v_setup ->> 'candidate_digest',
    (v_setup ->> 'draft_edit_revision')::text), '23505');
  perform probe_assert(v_detail like 'Key (draft_id, client_request_id)=%',
    'replayed client_request_id on a failed operation was not rejected by the unique constraint');
end;
$$;
\echo ok: idempotent client request key

do $$
declare
  v_deal uuid := 'e1000000-0000-4000-8000-000000000003';
  v_setup jsonb;
  v_draft uuid;
  v_op1 skill_publication_operations;
  v_op3 skill_publication_operations;
  v_detail text;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_draft := (v_setup ->> 'draft_id')::uuid;
  v_op1 := probe_insert_operation(v_deal, v_draft, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint);
  v_detail := probe_expect_sqlstate(format('select probe_insert_operation(%L,%L,%L,%L,%L,%L,%L,%L)',
    v_deal, v_draft, probe_author_a(), gen_random_uuid(),
    v_setup ->> 'candidate_id', v_setup ->> 'provider_candidate_id', v_setup ->> 'candidate_digest',
    (v_setup ->> 'draft_edit_revision')::text), '23505');
  perform probe_assert(v_detail like 'Key (draft_id)=%',
    'a second non-failed operation for the draft was not rejected by the partial unique index');
  update skill_publication_operations set state = 'failed' where id = v_op1.id;
  v_op3 := probe_insert_operation(v_deal, v_draft, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint);
  perform probe_assert(v_op3.state = 'preparing', 'a corrected operation after a failed one was not admitted');
  perform probe_assert((select count(*) from skill_publication_operations
    where draft_id = v_draft and state <> 'failed') = 1, 'more than one live operation exists for the draft');
end;
$$;
\echo ok: one non-failed operation per draft, corrected after a failure

do $$
declare
  v_deal_a uuid := 'e1000000-0000-4000-8000-000000000004';
  v_deal_b uuid := 'e1000000-0000-4000-8000-000000000005';
  v_setup_a jsonb;
  v_setup_b jsonb;
  v_reserved uuid := gen_random_uuid();
begin
  v_setup_a := probe_publication_setup(v_deal_a, probe_author_a());
  v_setup_b := probe_publication_setup(v_deal_b, probe_author_a());
  perform probe_insert_operation(v_deal_a, (v_setup_a ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup_a ->> 'candidate_id')::uuid, (v_setup_a ->> 'provider_candidate_id')::uuid,
    v_setup_a ->> 'candidate_digest', (v_setup_a ->> 'draft_edit_revision')::bigint,
    p_reserved_skill => v_reserved);
  perform probe_expect_sqlstate(format('select probe_insert_operation(%L,%L,%L,%L,%L,%L,%L,%L,p_reserved_skill=>%L)',
    v_deal_b, v_setup_b ->> 'draft_id', probe_author_a(), gen_random_uuid(),
    v_setup_b ->> 'candidate_id', v_setup_b ->> 'provider_candidate_id', v_setup_b ->> 'candidate_digest',
    (v_setup_b ->> 'draft_edit_revision')::text, v_reserved), '23505');
end;
$$;
\echo ok: unique reserved_skill_id

do $$
declare
  v_deal uuid := 'e1000000-0000-4000-8000-000000000006';
  v_published_deal uuid := 'e1000000-0000-4000-8000-000000000017';
  v_setup_a jsonb;
  v_setup_b jsonb;
  v_setup_c jsonb;
  v_setup_d jsonb;
  v_step uuid := gen_random_uuid();
  v_published_step uuid := gen_random_uuid();
  v_skill uuid := gen_random_uuid();
begin
  v_setup_a := probe_publication_setup(v_deal, probe_author_a());
  v_setup_b := probe_publication_setup(v_deal, probe_author_b(), false);
  perform probe_deal_step(v_step, v_deal);
  perform probe_insert_operation(v_deal, (v_setup_a ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup_a ->> 'candidate_id')::uuid, (v_setup_a ->> 'provider_candidate_id')::uuid,
    v_setup_a ->> 'candidate_digest', (v_setup_a ->> 'draft_edit_revision')::bigint,
    p_state => 'attaching', p_published_skill_id => gen_random_uuid(), p_published_version_id => gen_random_uuid(),
    p_published_digest => repeat('e', 64), p_resulting_deal_step_id => v_step);
  perform probe_expect_sqlstate(format('select probe_insert_operation(%L,%L,%L,%L,%L,%L,%L,%L,p_resulting_deal_step_id=>%L)',
    v_deal, v_setup_b ->> 'draft_id', probe_author_b(), gen_random_uuid(),
    v_setup_b ->> 'candidate_id', v_setup_b ->> 'provider_candidate_id', v_setup_b ->> 'candidate_digest',
    (v_setup_b ->> 'draft_edit_revision')::text, v_step), '23505');
  perform probe_insert_operation(v_deal, (v_setup_b ->> 'draft_id')::uuid, probe_author_b(), gen_random_uuid(),
    (v_setup_b ->> 'candidate_id')::uuid, (v_setup_b ->> 'provider_candidate_id')::uuid,
    v_setup_b ->> 'candidate_digest', (v_setup_b ->> 'draft_edit_revision')::bigint);

  v_setup_c := probe_publication_setup(v_published_deal, probe_author_a());
  v_setup_d := probe_publication_setup(v_published_deal, probe_author_b(), false);
  perform probe_deal_step(v_published_step, v_published_deal);
  perform probe_insert_operation(v_published_deal, (v_setup_c ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup_c ->> 'candidate_id')::uuid, (v_setup_c ->> 'provider_candidate_id')::uuid,
    v_setup_c ->> 'candidate_digest', (v_setup_c ->> 'draft_edit_revision')::bigint,
    p_reserved_skill => v_skill,
    p_state => 'published', p_published_skill_id => v_skill, p_published_version_id => gen_random_uuid(),
    p_published_digest => repeat('e', 64), p_resulting_deal_step_id => v_published_step);
  perform probe_insert_operation(v_published_deal, (v_setup_d ->> 'draft_id')::uuid, probe_author_b(), gen_random_uuid(),
    (v_setup_d ->> 'candidate_id')::uuid, (v_setup_d ->> 'provider_candidate_id')::uuid,
    v_setup_d ->> 'candidate_digest', (v_setup_d ->> 'draft_edit_revision')::bigint,
    p_reserved_skill => v_skill,
    p_state => 'attaching', p_published_skill_id => v_skill, p_published_version_id => gen_random_uuid(),
    p_published_digest => repeat('f', 64), p_resulting_deal_step_id => v_published_step);
  perform probe_assert(
    (select count(*) from skill_publication_operations where resulting_deal_step_id = v_published_step) = 2,
    'a published operation on a step did not admit the next version onto that step');
end;
$$;
\echo ok: unique resulting_deal_step_id only while in flight

do $$
declare
  v_deal uuid := 'e1000000-0000-4000-8000-000000000007';
  v_setup jsonb;
  v_step uuid := gen_random_uuid();
  v_op skill_publication_operations;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  perform probe_expect_sqlstate(format('select probe_insert_operation(%L,%L,%L,%L,%L,%L,%L,%L,p_placement_kind=>%L,p_anchor=>null)',
    v_deal, v_setup ->> 'draft_id', probe_author_a(), gen_random_uuid(),
    v_setup ->> 'candidate_id', v_setup ->> 'provider_candidate_id', v_setup ->> 'candidate_digest',
    (v_setup ->> 'draft_edit_revision')::text, 'after'), '23514');
  perform probe_deal_step(v_step, v_deal);
  perform probe_expect_sqlstate(format('select probe_insert_operation(%L,%L,%L,%L,%L,%L,%L,%L,p_placement_kind=>%L,p_anchor=>%L)',
    v_deal, v_setup ->> 'draft_id', probe_author_a(), gen_random_uuid(),
    v_setup ->> 'candidate_id', v_setup ->> 'provider_candidate_id', v_setup ->> 'candidate_digest',
    (v_setup ->> 'draft_edit_revision')::text, 'phase_start', v_step), '23514');
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint,
    p_placement_kind => 'after', p_anchor => v_step);
  perform probe_assert(v_op.placement_kind = 'after' and v_op.anchor_deal_step_id = v_step,
    'a valid after placement with its anchor was rejected');
end;
$$;
\echo ok: placement kind and anchor pairing

do $$
declare
  v_deal uuid := 'e1000000-0000-4000-8000-000000000008';
  v_setup jsonb;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  perform probe_expect_sqlstate(format('select probe_insert_operation(%L,%L,%L,%L,%L,%L,%L,%L)',
    v_deal, v_setup ->> 'draft_id', probe_author_a(), gen_random_uuid(),
    v_setup ->> 'candidate_id', v_setup ->> 'provider_candidate_id', 'not-a-digest',
    (v_setup ->> 'draft_edit_revision')::text), '23514');
  perform probe_expect_sqlstate(format('select probe_insert_operation(%L,%L,%L,%L,%L,%L,%L,%L,p_reserved_step_key=>%L)',
    v_deal, v_setup ->> 'draft_id', probe_author_a(), gen_random_uuid(),
    v_setup ->> 'candidate_id', v_setup ->> 'provider_candidate_id', v_setup ->> 'candidate_digest',
    (v_setup ->> 'draft_edit_revision')::text, 'custom:not-a-uuid'), '23514');
  perform probe_expect_sqlstate(format('select probe_insert_operation(%L,%L,%L,%L,%L,%L,%L,%L,p_state=>%L)',
    v_deal, v_setup ->> 'draft_id', probe_author_a(), gen_random_uuid(),
    v_setup ->> 'candidate_id', v_setup ->> 'provider_candidate_id', v_setup ->> 'candidate_digest',
    (v_setup ->> 'draft_edit_revision')::text, 'bogus'), '23514');
  perform probe_expect_sqlstate(format('select probe_insert_operation(%L,%L,%L,%L,%L,%L,%L,%L,p_comparison_set_digest=>%L)',
    v_deal, v_setup ->> 'draft_id', probe_author_a(), gen_random_uuid(),
    v_setup ->> 'candidate_id', v_setup ->> 'provider_candidate_id', v_setup ->> 'candidate_digest',
    (v_setup ->> 'draft_edit_revision')::text, 'short'), '23514');
  perform probe_expect_sqlstate(format('select probe_insert_operation(%L,%L,%L,%L,%L,%L,%L,%L,p_assessment_digest=>%L)',
    v_deal, v_setup ->> 'draft_id', probe_author_a(), gen_random_uuid(),
    v_setup ->> 'candidate_id', v_setup ->> 'provider_candidate_id', v_setup ->> 'candidate_digest',
    (v_setup ->> 'draft_edit_revision')::text, 'short'), '23514');
end;
$$;
\echo ok: identifier and digest shape checks

do $$
declare
  v_deal uuid := 'e1000000-0000-4000-8000-000000000009';
  v_setup jsonb;
  v_skill uuid := gen_random_uuid();
  v_version uuid := gen_random_uuid();
  v_digest text := repeat('a', 64);
  v_op skill_publication_operations;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  perform probe_expect_sqlstate(format('select probe_insert_operation(%L,%L,%L,%L,%L,%L,%L,%L,p_published_skill_id=>%L)',
    v_deal, v_setup ->> 'draft_id', probe_author_a(), gen_random_uuid(),
    v_setup ->> 'candidate_id', v_setup ->> 'provider_candidate_id', v_setup ->> 'candidate_digest',
    (v_setup ->> 'draft_edit_revision')::text, v_skill), '23514');
  perform probe_expect_sqlstate(
    format('select probe_insert_operation(%L,%L,%L,%L,%L,%L,%L,%L,p_published_skill_id=>%L,p_published_version_id=>%L)',
    v_deal, v_setup ->> 'draft_id', probe_author_a(), gen_random_uuid(),
    v_setup ->> 'candidate_id', v_setup ->> 'provider_candidate_id', v_setup ->> 'candidate_digest',
    (v_setup ->> 'draft_edit_revision')::text, v_skill, v_version), '23514');
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint,
    p_published_skill_id => v_skill, p_published_version_id => v_version, p_published_digest => v_digest);
  perform probe_assert(v_op.published_skill_id = v_skill and v_op.published_version_id = v_version
    and v_op.published_digest = v_digest, 'a complete published receipt was rejected');
end;
$$;
\echo ok: published receipt all-or-nothing

do $$
declare
  v_deal uuid := 'e1000000-0000-4000-8000-000000000010';
  v_setup jsonb;
  v_op skill_publication_operations;
  v_revision bigint;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_revision := (v_setup ->> 'draft_edit_revision')::bigint;
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', v_revision);
  perform probe_expect_sqlstate(format('update skill_publication_operations set candidate_id = %L where id = %L',
    gen_random_uuid(), v_op.id), 'P0001');
  perform probe_expect_sqlstate(format('update skill_publication_operations set provider_candidate_id = %L where id = %L',
    gen_random_uuid(), v_op.id), 'P0001');
  perform probe_expect_sqlstate(format('update skill_publication_operations set candidate_digest = %L where id = %L',
    repeat('b', 64), v_op.id), 'P0001');
  perform probe_expect_sqlstate(format('update skill_publication_operations set draft_edit_revision = %L where id = %L',
    v_revision + 1, v_op.id), 'P0001');
  perform probe_expect_sqlstate(format('update skill_publication_operations set name = %L where id = %L',
    'Changed step', v_op.id), 'P0001');
  perform probe_expect_sqlstate(format('update skill_publication_operations set reserved_skill_id = %L where id = %L',
    gen_random_uuid(), v_op.id), 'P0001');
  perform probe_expect_sqlstate(format('update skill_publication_operations set reserved_step_key = %L where id = %L',
    'custom:' || gen_random_uuid()::text, v_op.id), 'P0001');
  perform probe_expect_sqlstate(
    format('update skill_publication_operations set capability_contract = %L where id = %L',
    jsonb_build_object('purpose', 'x', 'expectedInput', 'y', 'expectedOutput', 'z'), v_op.id), 'P0001');
  update skill_publication_operations
  set state = 'confirmation_required', revision = revision + 1, status_code = 'candidate_stale', next_retry_at = now()
  where id = v_op.id;
  perform probe_assert((select state = 'confirmation_required' and revision = 1
    from skill_publication_operations where id = v_op.id), 'mutable fields were rejected by the frozen-field trigger');
end;
$$;
\echo ok: immutable frozen fields after admission

do $$
declare
  v_deal uuid := 'e1000000-0000-4000-8000-000000000011';
  v_setup jsonb;
  v_op skill_publication_operations;
  v_skill uuid := gen_random_uuid();
  v_version uuid := gen_random_uuid();
  v_digest text := repeat('c', 64);
  v_step uuid := gen_random_uuid();
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint);
  update skill_publication_operations
  set published_skill_id = v_skill, published_version_id = v_version, published_digest = v_digest, state = 'attaching'
  where id = v_op.id;
  perform probe_expect_sqlstate(format('update skill_publication_operations set published_digest = %L where id = %L',
    repeat('d', 64), v_op.id), 'P0001');
  perform probe_expect_sqlstate(format('update skill_publication_operations set published_skill_id = %L where id = %L',
    gen_random_uuid(), v_op.id), 'P0001');
  perform probe_deal_step(v_step, v_deal);
  update skill_publication_operations set state = 'published', resulting_deal_step_id = v_step where id = v_op.id;
  perform probe_assert((select state = 'published' and resulting_deal_step_id = v_step and published_digest = v_digest
    from skill_publication_operations where id = v_op.id),
    'state and the resulting step were not updatable after the published receipt was recorded');
end;
$$;
\echo ok: immutable published receipt once populated

do $$
declare
  v_rls boolean;
  v_policy_count int;
  v_indexdef text;
begin
  select relrowsecurity into v_rls from pg_class where oid = 'skill_publication_operations'::regclass;
  perform probe_assert(v_rls, 'row level security was not enabled on skill_publication_operations');
  select count(*) into v_policy_count from pg_policies
  where schemaname = current_schema() and tablename = 'skill_publication_operations';
  perform probe_assert(v_policy_count = 0, 'skill_publication_operations exposes a browser-facing row policy');
  perform probe_assert(not has_table_privilege('public', 'skill_publication_operations', 'select'),
    'public retains a privilege on skill_publication_operations');
  perform probe_assert(not (has_table_privilege('anon', 'skill_publication_operations', 'select')
    or has_table_privilege('anon', 'skill_publication_operations', 'insert')
    or has_table_privilege('anon', 'skill_publication_operations', 'update')
    or has_table_privilege('anon', 'skill_publication_operations', 'delete')),
    'anon retains a DML privilege on skill_publication_operations');
  perform probe_assert(not (has_table_privilege('authenticated', 'skill_publication_operations', 'select')
    or has_table_privilege('authenticated', 'skill_publication_operations', 'insert')
    or has_table_privilege('authenticated', 'skill_publication_operations', 'update')
    or has_table_privilege('authenticated', 'skill_publication_operations', 'delete')),
    'authenticated retains a DML privilege on skill_publication_operations');
  perform probe_assert(has_table_privilege('service_role', 'skill_publication_operations', 'select')
    and has_table_privilege('service_role', 'skill_publication_operations', 'insert')
    and has_table_privilege('service_role', 'skill_publication_operations', 'update'),
    'service_role lacks the expected privileges');
  perform probe_assert(not has_table_privilege('service_role', 'skill_publication_operations', 'delete'),
    'service_role retains delete on skill_publication_operations');
  select indexdef into v_indexdef from pg_indexes
  where schemaname = current_schema() and indexname = 'skill_publication_one_live_per_draft_idx';
  perform probe_assert(v_indexdef ilike '%unique%' and v_indexdef ilike '%state <> ''failed''%',
    'skill_publication_one_live_per_draft_idx is not the expected unique partial index');
end;
$$;
\echo ok: access protection and catalog checks

do $$
declare
  v_rls          boolean;
  v_policy_count int;
begin
  select relrowsecurity into v_rls from pg_class where oid = 'deal_step_skill_bindings'::regclass;
  perform probe_assert(v_rls, 'row level security was not enabled on deal_step_skill_bindings');

  select count(*) into v_policy_count from pg_policies
  where schemaname = current_schema() and tablename = 'deal_step_skill_bindings';
  perform probe_assert(v_policy_count = 0,
    'deal_step_skill_bindings exposes a browser-facing row policy, which app_is_overseer would read across tenants');

  perform probe_assert(not (has_table_privilege('authenticated', 'deal_step_skill_bindings', 'select')
    or has_table_privilege('authenticated', 'deal_step_skill_bindings', 'insert')
    or has_table_privilege('authenticated', 'deal_step_skill_bindings', 'update')
    or has_table_privilege('authenticated', 'deal_step_skill_bindings', 'delete')),
    'authenticated retains a privilege on deal_step_skill_bindings, so another firm''s admin could read it over REST');
  perform probe_assert(not (has_table_privilege('anon', 'deal_step_skill_bindings', 'select')
    or has_table_privilege('anon', 'deal_step_skill_bindings', 'insert')
    or has_table_privilege('anon', 'deal_step_skill_bindings', 'update')
    or has_table_privilege('anon', 'deal_step_skill_bindings', 'delete')),
    'anon retains a privilege on deal_step_skill_bindings');
  perform probe_assert(not has_table_privilege('public', 'deal_step_skill_bindings', 'select'),
    'public retains select on deal_step_skill_bindings');

  perform probe_assert(has_table_privilege('service_role', 'deal_step_skill_bindings', 'select')
    and has_table_privilege('service_role', 'deal_step_skill_bindings', 'insert')
    and has_table_privilege('service_role', 'deal_step_skill_bindings', 'update')
    and has_table_privilege('service_role', 'deal_step_skill_bindings', 'delete'),
    'service_role lacks the privileges the API routes need on deal_step_skill_bindings');
end;
$$;
\echo ok: deal_step_skill_bindings is reachable only on the service role
