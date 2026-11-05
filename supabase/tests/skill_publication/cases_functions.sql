do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000001';
  v_setup jsonb;
  v_view jsonb;
  v_op skill_publication_operations;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_view := probe_admit(probe_author_a(), v_deal, v_setup);
  select * into v_op from skill_publication_operations where id = (v_view ->> 'id')::uuid;
  perform probe_assert(v_op.state = 'preparing', 'a valid admission did not enter preparing');
  perform probe_assert(v_op.revision = 0, 'a fresh admission did not start at revision 0');
  perform probe_assert(v_op.candidate_id = (v_setup ->> 'candidate_id')::uuid, 'admitted candidate id mismatch');
  perform probe_assert(v_op.capability_contract = jsonb_build_object(
    'purpose', 'Screen buyers', 'expectedInput', 'Deal context', 'expectedOutput', 'Ranked buyers'),
    'derived capability contract did not match the candidate preview');
  perform probe_assert(v_op.reserved_step_key ~ '^custom:[0-9a-f-]{36}$', 'reserved step key was not a custom uuid key');
  perform probe_assert(v_view = jsonb_build_object('available', true, 'id', v_op.id, 'state', 'preparing',
    'revision', 0, 'matches', '[]'::jsonb, 'error', null, 'result', null, 'assessmentDigest', null),
    'browser view shape did not match the contract');
end;
$$;
\echo ok: admission derives name, placement, capability contract and reserved identities

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000002';
  v_setup jsonb;
  v_client uuid := gen_random_uuid();
  v_view1 jsonb;
  v_view2 jsonb;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_view1 := probe_admit(probe_author_a(), v_deal, v_setup, v_client);
  v_view2 := probe_admit(probe_author_a(), v_deal, v_setup, v_client);
  perform probe_assert(v_view1 = v_view2, 'an identical replay did not return the same operation view');
  perform probe_assert((select count(*) from skill_publication_operations
    where draft_id = (v_setup ->> 'draft_id')::uuid) = 1, 'an identical replay created a second row');
end;
$$;
\echo ok: identical replay is idempotent

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000003';
  v_setup jsonb;
  v_client uuid := gen_random_uuid();
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  perform probe_admit(probe_author_a(), v_deal, v_setup, v_client);
  perform probe_expect_message(format(
    'select skill_publication_admit(%L, %L, %L, %L, %L, %L, %L, %L)',
    probe_author_a(), v_deal, v_setup ->> 'draft_id', v_client, 999,
    v_setup ->> 'candidate_id', v_setup ->> 'candidate_digest', probe_correlation()),
    '40001', 'idempotency_conflict');
end;
$$;
\echo ok: reusing a request id with a different payload raises idempotency_conflict

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000004';
  v_setup jsonb;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  perform probe_expect_message(format(
    'select skill_publication_admit(%L, %L, %L, %L, %L, %L, %L, %L)',
    probe_author_a(), v_deal, v_setup ->> 'draft_id', gen_random_uuid(), 999,
    v_setup ->> 'candidate_id', v_setup ->> 'candidate_digest', probe_correlation()),
    '40001', 'stale_edit_revision');
end;
$$;
\echo ok: a stale expected edit revision raises stale_edit_revision

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000005';
  v_setup jsonb;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  perform probe_expect_message(format(
    'select skill_publication_admit(%L, %L, %L, %L, %L, %L, %L, %L)',
    probe_author_a(), v_deal, v_setup ->> 'draft_id', gen_random_uuid(), (v_setup ->> 'draft_edit_revision')::text,
    v_setup ->> 'candidate_id', repeat('9', 64), probe_correlation()),
    '40001', 'stale_candidate');
end;
$$;
\echo ok: a stale candidate digest raises stale_candidate

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000006';
  v_setup jsonb;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  perform probe_submit(probe_author_a(), v_deal, (v_setup ->> 'draft_id')::uuid, gen_random_uuid(), 'a second message');
  v_setup := v_setup || jsonb_build_object('draft_edit_revision', probe_revision((v_setup ->> 'draft_id')::uuid));
  perform probe_expect_message(format(
    'select probe_admit(%L, %L, %L)', probe_author_a(), v_deal, v_setup),
    '40001', 'generation_active');
end;
$$;
\echo ok: an active generation attempt raises generation_active

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000007';
  v_draft uuid;
  v_candidate skill_authoring_candidates%rowtype;
  v_setup jsonb;
begin
  perform probe_seed_deal(v_deal);
  v_draft := probe_draft(probe_author_a(), v_deal);
  v_candidate := probe_publication_candidate(probe_author_a(), v_deal, v_draft);
  perform skill_authoring_patch_draft(probe_author_a(), v_deal, v_draft, probe_revision(v_draft), '', 1, 'phase_end',
    null, 'draft a buyer screen', probe_correlation());
  v_setup := jsonb_build_object('draft_id', v_draft, 'candidate_id', v_candidate.id,
    'candidate_digest', v_candidate.content_digest, 'draft_edit_revision', probe_revision(v_draft));
  perform probe_expect_message(format('select probe_admit(%L, %L, %L)', probe_author_a(), v_deal, v_setup),
    '22023', 'skill_publication_blank_name');
end;
$$;
\echo ok: a blank draft name raises skill_publication_blank_name

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000008';
  v_draft uuid;
  v_candidate skill_authoring_candidates%rowtype;
  v_setup jsonb;
begin
  perform probe_seed_deal(v_deal);
  v_draft := probe_draft(probe_author_a(), v_deal);
  perform skill_authoring_patch_draft(probe_author_a(), v_deal, v_draft, 0, 'Buyer screen', null, null, null,
    'draft a buyer screen', probe_correlation());
  v_candidate := probe_publication_candidate(probe_author_a(), v_deal, v_draft);
  v_setup := jsonb_build_object('draft_id', v_draft, 'candidate_id', v_candidate.id,
    'candidate_digest', v_candidate.content_digest, 'draft_edit_revision', probe_revision(v_draft));
  perform probe_expect_message(format('select probe_admit(%L, %L, %L)', probe_author_a(), v_deal, v_setup),
    '22023', 'skill_publication_incomplete_placement');
end;
$$;
\echo ok: an incomplete placement raises skill_publication_incomplete_placement

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000009';
  v_step uuid := gen_random_uuid();
  v_draft uuid;
  v_candidate skill_authoring_candidates%rowtype;
  v_setup jsonb;
begin
  perform probe_seed_deal(v_deal);
  perform probe_deal_step(v_step, v_deal);
  v_draft := probe_draft(probe_author_a(), v_deal);
  perform skill_authoring_patch_draft(probe_author_a(), v_deal, v_draft, 0, 'Buyer screen', 1, 'after', v_step,
    'draft a buyer screen', probe_correlation());
  v_candidate := probe_publication_candidate(probe_author_a(), v_deal, v_draft);
  update deal_steps set removed_at = now() where id = v_step;
  v_setup := jsonb_build_object('draft_id', v_draft, 'candidate_id', v_candidate.id,
    'candidate_digest', v_candidate.content_digest, 'draft_edit_revision', probe_revision(v_draft));
  perform probe_expect_message(format('select probe_admit(%L, %L, %L)', probe_author_a(), v_deal, v_setup),
    '22023', 'skill_publication_anchor_removed');
end;
$$;
\echo ok: a removed anchor raises skill_publication_anchor_removed

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000010';
  v_setup jsonb;
begin
  v_setup := probe_publication_setup_with(v_deal, probe_author_a(), '', 'Deal context', 'Ranked buyers');
  perform probe_expect_message(format('select probe_admit(%L, %L, %L)', probe_author_a(), v_deal, v_setup),
    '22023', 'skill_publication_incomplete_capability_contract');
end;
$$;
\echo ok: a blank capability contract field raises skill_publication_incomplete_capability_contract

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000011';
  v_step uuid := gen_random_uuid();
  v_setup jsonb;
  v_client uuid := gen_random_uuid();
  v_view jsonb;
  v_op skill_publication_operations;
begin
  perform probe_seed_deal(v_deal);
  perform probe_skill_step(v_step, v_deal, '  Buyer   screen ');
  v_setup := probe_publication_setup(v_deal, probe_author_a(), false);
  v_view := probe_admit(probe_author_a(), v_deal, v_setup, v_client);
  select * into v_op from skill_publication_operations where id = (v_view ->> 'id')::uuid;
  perform probe_assert(v_op.state = 'failed', 'a duplicate active name admission was not failed');
  perform probe_assert(v_op.status_code = 'duplicate_active', 'a duplicate active name did not set duplicate_active');
  perform probe_assert(v_op.status_deal_step_id = v_step, 'a duplicate active name did not record the matching step');
  perform probe_assert(v_view -> 'error' = jsonb_build_object('code', 'duplicate_active', 'dealStepId', v_step),
    'the safe error view did not expose the matching step');
  v_view := probe_admit(probe_author_a(), v_deal, v_setup, v_client);
  perform probe_assert((v_view ->> 'id')::uuid = v_op.id, 'a repeated duplicate request did not replay idempotently');
end;
$$;
\echo ok: normalized name collision with an active skill-backed step fails as duplicate_active

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000012';
  v_step uuid := gen_random_uuid();
  v_setup jsonb;
  v_view jsonb;
begin
  perform probe_seed_deal(v_deal);
  perform probe_published_step(v_step, v_deal, 'Legacy vendor screen', probe_author_b());
  v_setup := probe_publication_setup(v_deal, probe_author_a(), false);
  v_view := probe_admit(probe_author_a(), v_deal, v_setup);
  perform probe_assert(v_view ->> 'state' = 'failed', 'an identical capability contract was not rejected');
  perform probe_assert(v_view -> 'error' = jsonb_build_object('code', 'duplicate_active', 'dealStepId', v_step),
    'an identical capability contract did not report the matching step');
end;
$$;
\echo ok: an identical capability contract on an active step fails as duplicate_active

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000013';
  v_step uuid := gen_random_uuid();
  v_setup jsonb;
  v_view jsonb;
begin
  perform probe_seed_deal(v_deal);
  perform probe_skill_step(v_step, v_deal, 'Buyer screen', true);
  v_setup := probe_publication_setup(v_deal, probe_author_a(), false);
  v_view := probe_admit(probe_author_a(), v_deal, v_setup);
  perform probe_assert(v_view -> 'error' = jsonb_build_object('code', 'duplicate_removed', 'dealStepId', v_step),
    'a removed skill-backed step name collision was not reported as duplicate_removed');
end;
$$;
\echo ok: normalized name collision with a removed skill-backed step fails as duplicate_removed

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000014';
  v_setup_b jsonb;
  v_setup_a jsonb;
  v_view jsonb;
begin
  perform probe_seed_deal(v_deal);
  v_setup_b := probe_publication_setup(v_deal, probe_author_b(), false);
  perform probe_admit(probe_author_b(), v_deal, v_setup_b);
  v_setup_a := probe_publication_setup(v_deal, probe_author_a(), false);
  v_view := probe_admit(probe_author_a(), v_deal, v_setup_a);
  perform probe_assert(v_view -> 'error' = jsonb_build_object('code', 'duplicate_active', 'dealStepId', null),
    'a name collision with another admitted operation did not report a null deal step');
end;
$$;
\echo ok: normalized name collision with another non-failed admitted operation fails with a null deal step

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000015';
  v_setup jsonb;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  perform probe_admit(probe_author_a(), v_deal, v_setup);
  perform probe_expect_message(format(
    'select skill_publication_admit(%L, %L, %L, %L, %L, %L, %L, %L)',
    probe_author_a(), v_deal, v_setup ->> 'draft_id', gen_random_uuid(), (v_setup ->> 'draft_edit_revision')::text,
    v_setup ->> 'candidate_id', v_setup ->> 'candidate_digest', probe_correlation()),
    '40001', 'publication_exists');
end;
$$;
\echo ok: another non-failed operation for the draft raises publication_exists

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000016';
  v_setup jsonb;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_b());
  delete from company_permission_grants
  where user_id = probe_author_b() and company_id = probe_bank()
    and permission_key = 'company:deals:steps:structure';
  perform probe_expect_message(format('select probe_admit(%L, %L, %L)', probe_author_b(), v_deal, v_setup),
    '42501', 'skill_authoring_forbidden');
  insert into company_permission_grants (user_id, company_id, permission_key)
  values (probe_author_b(), probe_bank(), 'company:deals:steps:structure');
end;
$$;
\echo ok: losing structure permission forbids admission

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000025';
  v_setup jsonb;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  delete from deal_memberships where deal_id = v_deal and user_id = probe_author_b();
  perform probe_expect_message(format('select probe_admit(%L, %L, %L)', probe_author_b(), v_deal, v_setup),
    '42501', 'skill_authoring_forbidden');
  insert into deal_memberships (deal_id, user_id) values (v_deal, probe_author_b());
end;
$$;
\echo ok: losing deal membership forbids admission, distinct from permission loss

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000026';
  v_setup jsonb;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  perform probe_expect_message(format('select probe_admit(%L, %L, %L)', probe_author_b(), v_deal, v_setup),
    'P0002', 'skill_publication_draft_not_found');
end;
$$;
\echo ok: admitting against a draft owned by another author is rejected as not found

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000027';
  v_setup jsonb;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  perform skill_authoring_discard_draft(probe_author_a(), v_deal, (v_setup ->> 'draft_id')::uuid,
    probe_revision((v_setup ->> 'draft_id')::uuid), probe_correlation());
  perform probe_expect_message(format('select probe_admit(%L, %L, %L)', probe_author_a(), v_deal, v_setup),
    '22023', 'skill_publication_draft_not_active');
end;
$$;
\echo ok: an archived draft is rejected as not active

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000017';
  v_setup jsonb;
  v_op skill_publication_operations;
  v_due uuid[];
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint, p_state => 'needs_placement');
  select array_agg(v) into v_due from skill_publication_due(25) v;
  perform probe_assert(not (v_op.id = any(v_due)), 'needs_placement was returned by the due selector');
end;
$$;
\echo ok: skill_publication_due excludes needs_placement

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000018';
  v_setup_1 jsonb;
  v_setup_2 jsonb;
  v_op1 skill_publication_operations;
  v_op2 skill_publication_operations;
  v_due uuid[];
begin
  v_setup_1 := probe_publication_setup(v_deal, probe_author_a());
  v_op1 := probe_insert_operation(v_deal, (v_setup_1 ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup_1 ->> 'candidate_id')::uuid, (v_setup_1 ->> 'provider_candidate_id')::uuid,
    v_setup_1 ->> 'candidate_digest', (v_setup_1 ->> 'draft_edit_revision')::bigint, p_state => 'publishing');
  update skill_publication_operations set next_retry_at = now() - interval '5 minutes' where id = v_op1.id;
  v_setup_2 := probe_publication_setup(v_deal, probe_author_b(), false);
  v_op2 := probe_insert_operation(v_deal, (v_setup_2 ->> 'draft_id')::uuid, probe_author_b(), gen_random_uuid(),
    (v_setup_2 ->> 'candidate_id')::uuid, (v_setup_2 ->> 'provider_candidate_id')::uuid,
    v_setup_2 ->> 'candidate_digest', (v_setup_2 ->> 'draft_edit_revision')::bigint, p_state => 'attaching');
  update skill_publication_operations set next_retry_at = now() - interval '1 hour' where id = v_op2.id;
  select array_agg(v) into v_due from skill_publication_due(10000) v;
  perform probe_assert(array_position(v_due, v_op2.id) < array_position(v_due, v_op1.id),
    'due ordering did not favor the earlier retry time');
end;
$$;
\echo ok: skill_publication_due orders eligible rows by retry time then id

do $$
begin
  perform probe_assert(
    skill_publication_normalize_name('Buyer Screen') = skill_publication_normalize_name('BUYER   screen'),
    'skill_publication_normalize_name did not fold case and collapse whitespace to the same value');
  perform probe_assert(
    skill_publication_normalize_name('  Buyer Screen  ') = 'buyer screen',
    'skill_publication_normalize_name did not trim and lowercase as expected');
end;
$$;
\echo ok: skill_publication_normalize_name folds case and collapses whitespace

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000031';
  v_setup jsonb;
  v_op skill_publication_operations;
  v_due uuid[];
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint, p_state => 'publishing');
  update skill_publication_operations set next_retry_at = now() + interval '1 hour' where id = v_op.id;
  select array_agg(v) into v_due from skill_publication_due(25) v;
  perform probe_assert(not (v_op.id = any(v_due)),
    'a row whose next_retry_at is in the future was returned by the due selector');
end;
$$;
\echo ok: skill_publication_due excludes a row whose next_retry_at is in the future

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000019';
  v_setup jsonb;
  v_op skill_publication_operations;
  v_view jsonb;
  v_audit_before int;
  v_audit_after int;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint, p_state => 'preparing');
  select count(*) into v_audit_before from audit_log where detail ->> 'publicationId' = v_op.id::text;
  v_view := skill_publication_transition(v_op.id, array['reconciling'], 'publishing', '{}'::jsonb);
  perform probe_assert(v_view is null, 'a lost predicate did not return null');
  select count(*) into v_audit_after from audit_log where detail ->> 'publicationId' = v_op.id::text;
  perform probe_assert(v_audit_after = v_audit_before, 'a lost predicate wrote an audit row');
end;
$$;
\echo ok: skill_publication_transition writes no audit row when the predicate is lost

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000020';
  v_setup jsonb;
  v_op skill_publication_operations;
  v_view jsonb;
  v_other_step uuid := gen_random_uuid();
  v_audit audit_log%rowtype;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  perform probe_deal_step(v_other_step, v_deal);
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint, p_state => 'preparing');
  v_view := skill_publication_transition(v_op.id, array['preparing'], 'publishing',
    jsonb_build_object(
      'statusCode', 'candidate_stale', 'nextRetryAt', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'phaseIndex', 9, 'placementKind', 'phase_start', 'anchorDealStepId', v_other_step,
      'duplicateConfirmedAt', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'duplicateConfirmedBy', probe_author_b()
    ));
  perform probe_assert(v_view ->> 'state' = 'publishing' and v_view ->> 'revision' = '1',
    'a valid transition did not move state and bump revision');
  select * into v_op from skill_publication_operations where id = v_op.id;
  perform probe_assert(v_op.status_code = 'candidate_stale' and v_op.next_retry_at is not null,
    'the allow-listed patch was not applied');
  perform probe_assert(v_op.phase_index = 1 and v_op.placement_kind = 'phase_end' and v_op.anchor_deal_step_id is null,
    'a disallowed placement patch key was not ignored');
  perform probe_assert(v_op.duplicate_confirmed_at is null and v_op.duplicate_confirmed_by is null,
    'a disallowed confirmation patch key was not ignored');
  select * into v_audit from audit_log
  where action = 'skill_publication.transition' and detail ->> 'publicationId' = v_op.id::text
  order by ts desc limit 1;
  perform probe_assert(v_audit.id is not null, 'no transition audit row was written');
  perform probe_assert(v_audit.actor_id is null and v_audit.service_identity = 'conductia',
    'the transition audit row did not carry the conductia service principal');
  perform probe_assert(v_audit.detail ->> 'operationActorId' = probe_author_a()::text,
    'the transition audit row did not carry the operation''s original actor');
  perform probe_assert(v_audit.detail ->> 'fromState' = 'preparing' and v_audit.detail ->> 'toState' = 'publishing',
    'the transition audit row did not carry the correct from/to state');
  perform probe_assert(v_audit.detail ->> 'statusCode' = 'candidate_stale', 'the transition audit row missed statusCode');
end;
$$;
\echo ok: skill_publication_transition narrows the patch allow-list and audits with the conductia principal

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000021';
  v_setup jsonb;
  v_op skill_publication_operations;
  v_view jsonb;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint, p_state => 'attaching');
  update skill_publication_operations
  set published_skill_id = gen_random_uuid(), published_version_id = gen_random_uuid(), published_digest = repeat('a', 64)
  where id = v_op.id;
  v_view := skill_publication_transition(v_op.id, array['attaching'], 'failed', '{}'::jsonb);
  perform probe_assert(v_view is null, 'a receipted row was allowed to transition to failed');
end;
$$;
\echo ok: skill_publication_transition never fails a row with an existing live receipt

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000028';
  v_setup jsonb;
  v_op skill_publication_operations;
  v_view jsonb;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint, p_state => 'publishing');
  v_view := skill_publication_transition(v_op.id, array['publishing'], 'failed',
    jsonb_build_object('publishedVersionId', gen_random_uuid()));
  perform probe_assert(v_view is null, 'a transition that would attach a receipt while failing was allowed');
end;
$$;
\echo ok: skill_publication_transition never fails a row whose patch would attach a receipt

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000029';
  v_setup jsonb;
  v_op skill_publication_operations;
  v_step uuid := gen_random_uuid();
  v_view jsonb;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint, p_state => 'preparing');
  perform probe_expect_sqlstate(format(
    'update skill_publication_operations set status_code = %L where id = %L', 'not_a_real_code', v_op.id), '23514');
  v_view := skill_publication_transition(v_op.id, array['preparing'], 'confirmation_required',
    jsonb_build_object('statusCode', 'candidate_stale', 'statusDealStepId', v_step));
  perform probe_assert(v_view -> 'error' = jsonb_build_object('code', 'candidate_stale', 'dealStepId', null),
    'a transition without a step-carrying status code exposed a deal step');
  select * into v_op from skill_publication_operations where id = v_op.id;
  perform probe_assert(v_op.status_code = 'candidate_stale', 'status_code was not applied by the transition');
  perform probe_assert(v_op.status_deal_step_id is null,
    'status_deal_step_id was not cleared when the code does not carry a step');
end;
$$;
\echo ok: status_code is constrained to the frozen contract and status_deal_step_id clears without a step-carrying code

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000032';
  v_setup jsonb;
  v_op skill_publication_operations;
  v_step uuid := gen_random_uuid();
  v_view jsonb;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  perform probe_deal_step(v_step, v_deal);
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint, p_state => 'failed');
  update skill_publication_operations set status_code = 'duplicate_active', status_deal_step_id = v_step
  where id = v_op.id;
  v_view := skill_publication_transition(v_op.id, array['failed'], 'preparing',
    jsonb_build_object('statusCode', null));
  perform probe_assert(v_view -> 'error' = 'null'::jsonb,
    'a transition explicitly clearing the status code still projected an error');
  select * into v_op from skill_publication_operations where id = v_op.id;
  perform probe_assert(v_op.status_code is null, 'status_code was not cleared by the transition');
  perform probe_assert(v_op.status_deal_step_id is null,
    'status_deal_step_id survived a transition that explicitly cleared a null status code');
end;
$$;
\echo ok: status_deal_step_id clears when a transition explicitly sets status_code to null

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000022';
  v_setup jsonb;
  v_op skill_publication_operations;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint,
    p_state => 'confirmation_required', p_assessment_digest => repeat('a', 64));
  perform probe_expect_message(format('select skill_publication_decide_duplicate(%L,%L,%L,%L,%L,%L,%L)',
    probe_author_b(), v_deal, v_op.id, 0, repeat('a', 64), 'confirm', probe_correlation()),
    '42501', 'skill_authoring_forbidden');
  perform probe_expect_message(format('select skill_publication_decide_duplicate(%L,%L,%L,%L,%L,%L,%L)',
    probe_author_a(), v_deal, v_op.id, 1, repeat('a', 64), 'confirm', probe_correlation()),
    '40001', 'stale_publication_revision');
  perform probe_expect_message(format('select skill_publication_decide_duplicate(%L,%L,%L,%L,%L,%L,%L)',
    probe_author_a(), v_deal, v_op.id, 0, repeat('b', 64), 'confirm', probe_correlation()),
    '40001', 'assessment_mismatch');
  perform skill_publication_decide_duplicate(probe_author_a(), v_deal, v_op.id, 0, repeat('a', 64),
    'confirm', probe_correlation());
  select * into v_op from skill_publication_operations where id = v_op.id;
  perform probe_assert(v_op.state = 'publishing' and v_op.revision = 1,
    'confirming a weak match did not move the operation to publishing');
  perform probe_assert(v_op.duplicate_confirmed_by = probe_author_a(),
    'confirmation did not record the confirming actor');
end;
$$;
\echo ok: decide_duplicate enforces actor, revision and assessment digest before confirming

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000023';
  v_setup jsonb;
  v_op skill_publication_operations;
  v_view jsonb;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint,
    p_state => 'confirmation_required', p_assessment_digest => repeat('a', 64));
  v_view := skill_publication_decide_duplicate(probe_author_a(), v_deal, v_op.id, 0, repeat('a', 64),
    'decline', probe_correlation());
  perform probe_assert(v_view ->> 'state' = 'failed' and v_view -> 'error' ->> 'code' = 'duplicate_declined',
    'declining a weak match did not fail with duplicate_declined');
end;
$$;
\echo ok: declining a weak match fails the operation with duplicate_declined

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000024';
  v_setup jsonb;
  v_op skill_publication_operations;
  v_step uuid := gen_random_uuid();
  v_view jsonb;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  perform probe_deal_step(v_step, v_deal);
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint, p_state => 'attaching');
  perform probe_expect_message(format('select skill_publication_replace_placement(%L,%L,%L,%L,%L,%L,%L,%L)',
    probe_author_a(), v_deal, v_op.id, 0, 1, 'phase_end', null, probe_correlation()),
    '40001', 'placement_not_allowed');
  update skill_publication_operations set state = 'needs_placement' where id = v_op.id;
  perform probe_expect_message(format('select skill_publication_replace_placement(%L,%L,%L,%L,%L,%L,%L,%L)',
    probe_author_a(), v_deal, v_op.id, 5, 1, 'phase_end', null, probe_correlation()),
    '40001', 'stale_publication_revision');
  perform probe_expect_message(format('select skill_publication_replace_placement(%L,%L,%L,%L,%L,%L,%L,%L)',
    probe_author_a(), v_deal, v_op.id, 0, 1, 'after', null, probe_correlation()),
    '22023', 'skill_publication_incomplete_placement');
  update deal_steps set removed_at = now() where id = v_step;
  perform probe_expect_message(format('select skill_publication_replace_placement(%L,%L,%L,%L,%L,%L,%L,%L)',
    probe_author_a(), v_deal, v_op.id, 0, 2, 'after', v_step, probe_correlation()),
    '22023', 'skill_publication_anchor_removed');
  update deal_steps set removed_at = null where id = v_step;
  v_view := skill_publication_replace_placement(probe_author_a(), v_deal, v_op.id, 0, 2, 'after', v_step, probe_correlation());
  perform probe_assert(v_view ->> 'state' = 'attaching' and v_view ->> 'revision' = '1',
    'a valid placement replacement did not move to attaching');
end;
$$;
\echo ok: replace_placement validates state, revision and anchor before returning to attaching

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000030';
  v_setup jsonb;
  v_op skill_publication_operations;
  v_view jsonb;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_op := probe_insert_operation(v_deal, (v_setup ->> 'draft_id')::uuid, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint, p_state => 'attaching');
  v_view := skill_publication_read(probe_author_a(), v_deal, v_op.id, probe_correlation());
  perform probe_assert(v_view ->> 'state' = 'attaching', 'a read by the original author did not succeed');
  perform probe_expect_message(format('select skill_publication_read(%L,%L,%L,%L)',
    probe_author_b(), v_deal, v_op.id, probe_correlation()), 'P0002', 'skill_publication_not_found');
end;
$$;
\echo ok: skill_publication_read requires the original author

do $$
declare
  v_function regprocedure;
begin
  foreach v_function in array array[
    'skill_publication_admit(uuid,uuid,uuid,uuid,bigint,uuid,text,uuid)'::regprocedure,
    'skill_publication_decide_duplicate(uuid,uuid,uuid,bigint,text,text,uuid)'::regprocedure,
    'skill_publication_replace_placement(uuid,uuid,uuid,bigint,integer,text,uuid,uuid)'::regprocedure,
    'skill_publication_read(uuid,uuid,uuid,uuid)'::regprocedure,
    'skill_publication_due(integer)'::regprocedure,
    'skill_publication_transition(uuid,text[],text,jsonb)'::regprocedure,
    'skill_authoring_browser_publication(uuid)'::regprocedure,
    'skill_authoring_browser_draft(uuid)'::regprocedure,
    'skill_publication_attach(uuid)'::regprocedure,
    'skill_publication_freeze_guard()'::regprocedure,
    'rail_insert_step(uuid,uuid,int,text,uuid,jsonb,text,text)'::regprocedure,
    'rail_remove_step(uuid,uuid,uuid,text[])'::regprocedure,
    'rail_restore_step(uuid,uuid,uuid)'::regprocedure,
    'rail_skip_step(uuid,uuid,uuid,uuid,text)'::regprocedure,
    'skill_publication_browser_view(skill_publication_operations)'::regprocedure,
    'skill_publication_raise(text,text)'::regprocedure,
    'skill_publication_normalize_name(text)'::regprocedure
  ] loop
    perform probe_assert(not has_function_privilege('public', v_function, 'execute'),
      'public retains execute on ' || v_function::text);
    perform probe_assert(not has_function_privilege('anon', v_function, 'execute'),
      'anon retains execute on ' || v_function::text);
    perform probe_assert(not has_function_privilege('authenticated', v_function, 'execute'),
      'authenticated retains execute on ' || v_function::text);
    perform probe_assert(has_function_privilege('service_role', v_function, 'execute'),
      'service_role lacks execute on ' || v_function::text);
  end loop;
end;
$$;
\echo ok: publication command functions are service_role only, not just public

do $$
declare
  v_before int;
  v_after int;
begin
  select count(*) into v_before from audit_log where action like 'skill_publication.%';
  set local role service_role;
  insert into audit_log (actor_id, action, deal_id, detail) values (
    probe_author_a(), 'skill_publication.admitted', 'e2000000-0000-4000-8000-000000000001'::uuid,
    jsonb_build_object('publicationId', gen_random_uuid(), 'actorId', probe_author_a(),
      'toState', 'preparing', 'correlationId', probe_correlation()));
  reset role;
  select count(*) into v_after from audit_log where action like 'skill_publication.%';
  perform probe_assert(v_after = v_before + 1, 'a service_role audit insert failed against the CHECK constraints');
end;
$$;
\echo ok: a raw skill_publication audit insert as service_role satisfies the actor-or-service CHECK

do $$
declare
  v_authoring_path text[];
  v_admit_path text[];
  v_rail_path text[];
  v_stragglers text[];
begin
  select p.proconfig into v_authoring_path from pg_proc p
  where p.pronamespace = current_schema()::regnamespace and p.proname = 'skill_authoring_complete_attempt';
  perform probe_assert(
    exists (select from unnest(v_authoring_path) as cfg where cfg like 'search_path=%'),
    'skill_authoring_complete_attempt has no declared search_path');
  perform probe_assert(
    not exists (select from unnest(v_authoring_path) as cfg where cfg like 'search_path=%extensions%'),
    'skill_authoring_complete_attempt search path was reinjected with extensions');

  perform probe_assert(
    exists (select from pg_proc p
      where p.pronamespace = current_schema()::regnamespace and p.proname = 'skill_publication_admit'),
    'skill_publication_admit does not exist in the test schema');
  select p.proconfig into v_admit_path from pg_proc p
  where p.pronamespace = current_schema()::regnamespace and p.proname = 'skill_publication_admit';
  perform probe_assert(
    exists (select from unnest(v_admit_path) as cfg where cfg like 'search_path=%'),
    'skill_publication_admit has no declared search_path');
  perform probe_assert(
    not exists (select from unnest(v_admit_path) as cfg where cfg like 'search_path=%extensions%'),
    'skill_publication_admit search path was reinjected with extensions');

  perform probe_assert(
    exists (select from pg_proc p
      where p.pronamespace = current_schema()::regnamespace and p.proname = 'rail_insert_step'),
    'rail_insert_step does not exist in the test schema');
  select p.proconfig into v_rail_path from pg_proc p
  where p.pronamespace = current_schema()::regnamespace and p.proname = 'rail_insert_step';
  perform probe_assert(
    exists (select from unnest(v_rail_path) as cfg where cfg like 'search_path=%'),
    'rail_insert_step has no declared search_path');
  perform probe_assert(
    not exists (select from unnest(v_rail_path) as cfg where cfg like 'search_path=%extensions%'),
    'rail_insert_step search path was reinjected with extensions');

  select array_agg(p.proname) into v_stragglers from pg_proc p
  where p.pronamespace = current_schema()::regnamespace
    and (p.proname like 'skill_publication_%' or p.proname like 'skill_authoring_%' or p.proname like 'rail_%')
    and exists (
      select from unnest(p.proconfig) as cfg,
        unnest(string_to_array(split_part(cfg, '=', 2), ',')) as entry
      where cfg like 'search_path=%' and btrim(entry) = 'public');
  perform probe_assert(v_stragglers is null,
    'a skill_publication/skill_authoring/rail function still declares public in its search path: ' || array_to_string(coalesce(v_stragglers, '{}'::text[]), ', '));
end;
$$;
\echo ok: search_path fixups preserve the search path each function declares
