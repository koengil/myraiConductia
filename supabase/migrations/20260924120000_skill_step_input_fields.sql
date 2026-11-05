alter table deal_step_skill_runs
  add column if not exists inputs jsonb not null default '{}'::jsonb;

alter table deal_step_skill_runs
  alter column input drop not null;

alter table deal_step_skill_runs
  add constraint deal_step_skill_runs_inputs_object check (jsonb_typeof(inputs) = 'object');

create or replace function skill_authoring_browser_candidate(p_candidate_id uuid)
returns jsonb language sql security definer stable set search_path = public as $$
  select jsonb_build_object(
    'id', candidate.id, 'content_digest', candidate.content_digest, 'schema_version', candidate.schema_version,
    'preview', jsonb_build_object(
      'name', candidate.preview ->> 'name', 'purpose', candidate.preview ->> 'purpose',
      'expected_input', candidate.preview ->> 'expectedInput', 'expected_output', candidate.preview ->> 'expectedOutput',
      'inputs', coalesce(candidate.preview -> 'inputs', '[]'::jsonb)
    )
  )
  from skill_authoring_candidates candidate where candidate.id = p_candidate_id;
$$;

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
      jsonb_build_object('input', coalesce(v_seed_run.input, ''),
        'inputs', coalesce(v_seed_run.inputs, '{}'::jsonb),
        'output', coalesce(v_seed_run.result_text, v_seed_run.error_message, ''))
    else null end
  );
end;
$$;
