do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000101';
  v_draft uuid;
begin
  perform probe_seed_deal(v_deal);
  v_draft := probe_draft(probe_author_a(), v_deal);
  perform probe_assert(
    (skill_authoring_browser_draft(v_draft) -> 'publication') = jsonb_build_object('available', false),
    'a draft with no publication operation did not project available false');
end;
$$;
\echo ok: publication projection shows unavailable when a draft has no operation

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000102';
  v_setup jsonb;
  v_draft uuid;
  v_failed skill_publication_operations;
  v_live skill_publication_operations;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_draft := (v_setup ->> 'draft_id')::uuid;
  v_failed := probe_insert_operation(v_deal, v_draft, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint, p_state => 'failed');
  update skill_publication_operations set created_at = now() - interval '1 hour' where id = v_failed.id;
  v_live := probe_insert_operation(v_deal, v_draft, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint, p_state => 'preparing');
  perform probe_assert(
    (skill_authoring_browser_draft(v_draft) -> 'publication') = skill_publication_browser_view(v_live),
    'the non-failed operation did not win over an older failed one');
end;
$$;
\echo ok: publication projection prefers a non-failed operation over an older failed one

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000105';
  v_setup jsonb;
  v_draft uuid;
  v_live skill_publication_operations;
  v_failed skill_publication_operations;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_draft := (v_setup ->> 'draft_id')::uuid;
  v_live := probe_insert_operation(v_deal, v_draft, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint, p_state => 'preparing');
  v_failed := probe_insert_operation(v_deal, v_draft, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint, p_state => 'failed');
  update skill_publication_operations set created_at = now() + interval '1 hour' where id = v_failed.id;
  perform probe_assert(
    (skill_authoring_browser_draft(v_draft) -> 'publication') = skill_publication_browser_view(v_live),
    'a non-failed operation did not win over a newer failed one');
end;
$$;
\echo ok: publication projection prefers a non-failed operation over a newer failed one

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000103';
  v_setup jsonb;
  v_draft uuid;
  v_older skill_publication_operations;
  v_newer skill_publication_operations;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_draft := (v_setup ->> 'draft_id')::uuid;
  v_older := probe_insert_operation(v_deal, v_draft, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint, p_state => 'failed');
  update skill_publication_operations set created_at = now() - interval '1 hour' where id = v_older.id;
  v_newer := probe_insert_operation(v_deal, v_draft, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint, p_state => 'failed');
  perform probe_assert(
    (skill_authoring_browser_draft(v_draft) -> 'publication') = skill_publication_browser_view(v_newer),
    'the latest failed operation was not the one shown');
end;
$$;
\echo ok: publication projection shows the latest operation when only failed operations exist

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000104';
  v_setup jsonb;
  v_draft uuid;
  v_step uuid := gen_random_uuid();
  v_op skill_publication_operations;
  v_pub_text text;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_draft := (v_setup ->> 'draft_id')::uuid;
  perform probe_skill_step(v_step, v_deal, 'Buyer screen');
  v_op := probe_insert_operation(v_deal, v_draft, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint,
    p_state => 'published', p_published_skill_id => gen_random_uuid(), p_published_version_id => gen_random_uuid(),
    p_published_digest => repeat('a', 64), p_resulting_deal_step_id => v_step);
  v_pub_text := (skill_authoring_browser_draft(v_draft) -> 'publication')::text;
  perform probe_assert(v_pub_text not ilike '%artifact%',
    'the publication projection leaked a key or value containing artifact');
  perform probe_assert(v_pub_text not ilike '%provider%',
    'the publication projection leaked a key or value containing provider');
end;
$$;
\echo ok: publication projection never emits a key containing artifact or provider

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000106';
  v_setup jsonb;
  v_draft uuid;
  v_digest text := repeat('d', 64);
  v_confirming skill_publication_operations;
  v_preparing skill_publication_operations;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_draft := (v_setup ->> 'draft_id')::uuid;
  v_confirming := probe_insert_operation(v_deal, v_draft, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint,
    p_state => 'confirmation_required', p_assessment_digest => v_digest);
  perform probe_assert(
    (skill_authoring_browser_draft(v_draft) -> 'publication' ->> 'assessmentDigest') = v_digest,
    'a confirmation_required publication did not project its assessment digest');
  update skill_publication_operations set state = 'preparing' where id = v_confirming.id
    returning * into v_preparing;
  perform probe_assert(
    (skill_authoring_browser_draft(v_draft) -> 'publication' -> 'assessmentDigest') = 'null'::jsonb,
    'a preparing publication with a stored digest still projected it');
end;
$$;
\echo ok: publication projection exposes the assessment digest only while confirmation_required

do $$
declare
  v_deal uuid := 'e2000000-0000-4000-8000-000000000107';
  v_setup jsonb;
  v_draft uuid;
  v_step uuid := gen_random_uuid();
  v_op skill_publication_operations;
  v_failed skill_publication_operations;
  v_matches jsonb := jsonb_build_array(jsonb_build_object(
    'dealStepId', v_step, 'name', 'Buyer screen', 'classification', 'similar', 'reasonCode', 'name_match'));
  v_view jsonb;
begin
  v_setup := probe_publication_setup(v_deal, probe_author_a());
  v_draft := (v_setup ->> 'draft_id')::uuid;
  perform probe_deal_step(v_step, v_deal);
  v_op := probe_insert_operation(v_deal, v_draft, probe_author_a(), gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint, p_state => 'preparing');
  update skill_publication_operations set
    state = 'failed', status_code = 'duplicate_active', status_deal_step_id = v_step, duplicate_matches = v_matches
  where id = v_op.id
  returning * into v_failed;
  v_view := (skill_authoring_browser_draft(v_draft) -> 'publication');
  perform probe_assert(
    v_view = skill_publication_browser_view(v_failed),
    'a failed operation with a status code and matches did not project the browser view exactly');
  perform probe_assert(
    (v_view -> 'error' ->> 'code') = 'duplicate_active',
    'a failed operation did not project its status code as the error code');
  perform probe_assert(
    (v_view -> 'error' ->> 'dealStepId') = v_step::text,
    'a failed operation did not project its status deal step id');
  perform probe_assert(
    (v_view -> 'matches') = v_matches,
    'a failed operation did not project its duplicate matches');
end;
$$;
\echo ok: publication projection exposes the status code, deal step id and matches for a failed operation
