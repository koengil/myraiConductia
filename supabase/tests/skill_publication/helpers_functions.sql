create function probe_skill_step(
  p_step uuid, p_deal uuid, p_title text, p_removed boolean default false
) returns void language plpgsql as $$
begin
  insert into deal_steps (id, deal_id, step_id, seq, status, definition, removed_at) values (
    p_step, p_deal, 'custom:' || p_step::text, null, 'pending',
    jsonb_build_object('type', 'skill', 'title', p_title),
    case when p_removed then now() else null end
  );
end;
$$;

create function probe_attaching_operation(
  p_deal uuid, p_actor uuid, p_phase_index integer default 1, p_placement_kind text default 'phase_end',
  p_anchor uuid default null, p_reserved_skill uuid default gen_random_uuid(), p_seed_deal boolean default false,
  p_published_digest text default null
) returns skill_publication_operations language plpgsql as $$
declare
  v_setup jsonb;
  v_version uuid := gen_random_uuid();
  v_digest text;
  v_op skill_publication_operations%rowtype;
begin
  v_setup := probe_publication_setup(p_deal, p_actor, p_seed_deal);
  v_digest := coalesce(p_published_digest, v_setup ->> 'candidate_digest');
  v_op := probe_insert_operation(p_deal, (v_setup ->> 'draft_id')::uuid, p_actor, gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint,
    p_reserved_skill => p_reserved_skill, p_phase_index => p_phase_index, p_placement_kind => p_placement_kind,
    p_anchor => p_anchor, p_state => 'attaching', p_published_skill_id => p_reserved_skill,
    p_published_version_id => v_version, p_published_digest => v_digest);
  return v_op;
end;
$$;

create function probe_expected_definition(p_op skill_publication_operations) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'schemaVersion', 1, 'type', 'skill', 'title', p_op.name,
    'description', p_op.capability_contract ->> 'purpose',
    'inputs', jsonb_build_array(jsonb_build_object(
      'key', 'primary', 'kind', 'text', 'label', 'Input',
      'helperText', p_op.capability_contract ->> 'expectedInput', 'required', true)),
    'skillBinding', jsonb_build_object(
      'skillId', p_op.published_skill_id, 'versionId', p_op.published_version_id, 'digest', p_op.published_digest))
$$;

create function probe_published_step(p_step uuid, p_deal uuid, p_title text, p_actor uuid)
returns uuid language plpgsql as $$
declare
  v_setup jsonb;
  v_op skill_publication_operations;
begin
  perform probe_skill_step(p_step, p_deal, p_title);
  v_setup := probe_publication_setup(p_deal, p_actor, false);
  v_op := probe_insert_operation(p_deal, (v_setup ->> 'draft_id')::uuid, p_actor, gen_random_uuid(),
    (v_setup ->> 'candidate_id')::uuid, (v_setup ->> 'provider_candidate_id')::uuid,
    v_setup ->> 'candidate_digest', (v_setup ->> 'draft_edit_revision')::bigint,
    p_state => 'published', p_published_skill_id => gen_random_uuid(), p_published_version_id => gen_random_uuid(),
    p_published_digest => repeat('b', 64), p_resulting_deal_step_id => p_step);
  return v_op.id;
end;
$$;

create function probe_publication_candidate_with(
  p_actor uuid, p_deal uuid, p_draft uuid, p_purpose text, p_expected_input text, p_expected_output text
) returns skill_authoring_candidates language plpgsql as $$
declare
  v_client uuid := gen_random_uuid();
  v_receipt jsonb;
  v_attempt uuid;
  v_provider uuid := gen_random_uuid();
  v_candidate skill_authoring_candidates%rowtype;
begin
  v_receipt := probe_submit(p_actor, p_deal, p_draft, v_client, 'draft another buyer screen');
  v_attempt := (v_receipt #>> '{attempt,id}')::uuid;
  perform skill_authoring_complete_attempt(v_attempt, 'here is another buyer screen', jsonb_build_object(
    'providerCandidateId', v_provider, 'contentDigest', repeat('c', 64),
    'preview', jsonb_build_object('name', 'Buyer screen',
      'purpose', p_purpose, 'expectedInput', p_expected_input, 'expectedOutput', p_expected_output)));
  select * into v_candidate from skill_authoring_candidates
  where draft_id = p_draft and provider_candidate_id = v_provider;
  return v_candidate;
end;
$$;

create function probe_publication_setup_with(
  p_deal uuid, p_actor uuid, p_purpose text, p_expected_input text, p_expected_output text
) returns jsonb language plpgsql as $$
declare
  v_draft uuid;
  v_candidate skill_authoring_candidates%rowtype;
begin
  perform probe_seed_deal(p_deal);
  v_draft := probe_draft(p_actor, p_deal);
  perform skill_authoring_patch_draft(p_actor, p_deal, v_draft, 0, 'Buyer screen', 1, 'phase_end', null,
    'draft a buyer screen', probe_correlation());
  v_candidate := probe_publication_candidate_with(p_actor, p_deal, v_draft, p_purpose, p_expected_input, p_expected_output);
  return jsonb_build_object(
    'draft_id', v_draft,
    'candidate_id', v_candidate.id,
    'provider_candidate_id', v_candidate.provider_candidate_id,
    'candidate_digest', v_candidate.content_digest,
    'draft_edit_revision', probe_revision(v_draft)
  );
end;
$$;

create function probe_admit(
  p_actor uuid, p_deal uuid, p_setup jsonb, p_client uuid default null
) returns jsonb language plpgsql as $$
begin
  return skill_publication_admit(p_actor, p_deal, (p_setup ->> 'draft_id')::uuid,
    coalesce(p_client, gen_random_uuid()), (p_setup ->> 'draft_edit_revision')::bigint,
    (p_setup ->> 'candidate_id')::uuid, p_setup ->> 'candidate_digest', probe_correlation());
end;
$$;

create function probe_expect_message(p_statement text, p_sqlstate text, p_message text) returns void language plpgsql as $$
declare
  v_message text;
begin
  begin
    execute p_statement;
  exception when others then
    if sqlstate <> p_sqlstate then
      raise;
    end if;
    get stacked diagnostics v_message = message_text;
    perform probe_assert(v_message = p_message,
      format('expected message %L but got %L from: %s', p_message, v_message, p_statement));
    return;
  end;
  raise exception 'probe expected sqlstate % from: %', p_sqlstate, p_statement;
end;
$$;
