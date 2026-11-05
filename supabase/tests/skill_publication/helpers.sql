create function probe_publication_candidate(p_actor uuid, p_deal uuid, p_draft uuid)
returns skill_authoring_candidates language plpgsql as $$
declare
  v_client uuid := gen_random_uuid();
  v_receipt jsonb;
  v_attempt uuid;
  v_provider uuid := gen_random_uuid();
  v_candidate skill_authoring_candidates%rowtype;
begin
  v_receipt := probe_submit(p_actor, p_deal, p_draft, v_client, 'draft a buyer screen');
  v_attempt := (v_receipt #>> '{attempt,id}')::uuid;
  perform skill_authoring_complete_attempt(v_attempt, 'here is the buyer screen', jsonb_build_object(
    'providerCandidateId', v_provider, 'contentDigest', repeat('a', 64),
    'preview', jsonb_build_object('name', 'Buyer screen', 'purpose', 'Screen buyers',
      'expectedInput', 'Deal context', 'expectedOutput', 'Ranked buyers')));
  select * into v_candidate from skill_authoring_candidates
  where draft_id = p_draft and provider_candidate_id = v_provider;
  return v_candidate;
end;
$$;

create function probe_publication_setup(p_deal uuid, p_actor uuid, p_seed_deal boolean default true)
returns jsonb language plpgsql as $$
declare
  v_draft uuid;
  v_candidate skill_authoring_candidates%rowtype;
begin
  if p_seed_deal then
    perform probe_seed_deal(p_deal);
  end if;
  v_draft := probe_draft(p_actor, p_deal);
  perform skill_authoring_patch_draft(p_actor, p_deal, v_draft, 0, 'Buyer screen', 1, 'phase_end', null,
    'draft a buyer screen', probe_correlation());
  v_candidate := probe_publication_candidate(p_actor, p_deal, v_draft);
  return jsonb_build_object(
    'draft_id', v_draft,
    'candidate_id', v_candidate.id,
    'provider_candidate_id', v_candidate.provider_candidate_id,
    'candidate_digest', v_candidate.content_digest,
    'draft_edit_revision', probe_revision(v_draft)
  );
end;
$$;

create function probe_insert_operation(
  p_deal uuid, p_draft uuid, p_actor uuid, p_client uuid,
  p_candidate uuid, p_provider_candidate uuid, p_digest text, p_draft_revision bigint,
  p_reserved_skill uuid default gen_random_uuid(),
  p_reserved_step_key text default null,
  p_name text default 'Buyer screen',
  p_phase_index integer default 1,
  p_placement_kind text default 'phase_end',
  p_anchor uuid default null,
  p_state text default 'preparing',
  p_comparison_set_digest text default null,
  p_assessment_digest text default null,
  p_published_skill_id uuid default null,
  p_published_version_id uuid default null,
  p_published_digest text default null,
  p_resulting_deal_step_id uuid default null
) returns skill_publication_operations language plpgsql as $$
declare v_op skill_publication_operations%rowtype;
begin
  insert into skill_publication_operations (
    deal_id, draft_id, actor_id, client_request_id, state,
    candidate_id, provider_candidate_id, candidate_digest, draft_edit_revision,
    name, phase_index, placement_kind, anchor_deal_step_id,
    reserved_skill_id, reserved_step_key, capability_contract,
    comparison_set_digest, assessment_digest,
    published_skill_id, published_version_id, published_digest,
    resulting_deal_step_id
  ) values (
    p_deal, p_draft, p_actor, p_client, p_state,
    p_candidate, p_provider_candidate, p_digest, p_draft_revision,
    p_name, p_phase_index, p_placement_kind, p_anchor,
    p_reserved_skill, coalesce(p_reserved_step_key, 'custom:' || gen_random_uuid()::text),
    jsonb_build_object('purpose', 'Screen buyers', 'expectedInput', 'Deal context', 'expectedOutput', 'Ranked buyers'),
    p_comparison_set_digest, p_assessment_digest,
    p_published_skill_id, p_published_version_id, p_published_digest,
    p_resulting_deal_step_id
  ) returning * into v_op;
  return v_op;
end;
$$;

create function probe_deal_step(p_step uuid, p_deal uuid) returns void language plpgsql as $$
begin
  insert into deal_steps (id, deal_id, step_id, seq, status)
  values (p_step, p_deal, 'catalog:' || p_step::text, null, 'pending');
end;
$$;
