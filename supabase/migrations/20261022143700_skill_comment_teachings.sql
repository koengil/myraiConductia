create table if not exists skill_comment_teachings (
  id              uuid primary key default gen_random_uuid(),
  deal_id         uuid not null references deals (id),
  revision_run_id uuid not null references deal_step_skill_runs (id),
  edit_id         uuid not null,
  draft_id        uuid not null references skill_authoring_drafts (id),
  kind            text not null check (kind in ('waiting','sent')),
  message_id      uuid references skill_authoring_messages (id),
  actor_id        uuid not null references users (id),
  created_at      timestamptz not null default now(),
  check ((kind = 'sent') = (message_id is not null))
);

create unique index if not exists skill_comment_teachings_sent_edit_idx
  on skill_comment_teachings (edit_id) where kind = 'sent';
create unique index if not exists skill_comment_teachings_waiting_edit_idx
  on skill_comment_teachings (draft_id, edit_id) where kind = 'waiting';
create index if not exists skill_comment_teachings_revision_idx
  on skill_comment_teachings (revision_run_id);

alter table skill_comment_teachings enable row level security;

grant select, insert on skill_comment_teachings to service_role;
revoke all on skill_comment_teachings from public, anon, authenticated;

create or replace function skill_comment_teachings_immutable() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'skill_comment_teachings rows are immutable';
end $$;

drop trigger if exists skill_comment_teachings_no_update on skill_comment_teachings;
create trigger skill_comment_teachings_no_update
  before update on skill_comment_teachings
  for each row execute function skill_comment_teachings_immutable();

drop trigger if exists skill_comment_teachings_no_delete on skill_comment_teachings;
create trigger skill_comment_teachings_no_delete
  before delete on skill_comment_teachings
  for each row execute function skill_comment_teachings_immutable();

create or replace function skill_teaching_offer(
  p_actor_id uuid, p_deal_id uuid, p_draft_id uuid, p_edits jsonb, p_prompt text, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_draft skill_authoring_drafts%rowtype;
  v_edit jsonb;
  v_text text;
begin
  perform skill_authoring_lock_author(p_actor_id, p_deal_id);
  select * into v_draft from skill_authoring_drafts
  where id = p_draft_id and deal_id = p_deal_id and author_id = p_actor_id for update;
  if not found then raise exception 'skill_authoring_draft_not_found' using errcode = 'P0002'; end if;
  if v_draft.status <> 'active' then perform skill_authoring_raise_conflict(v_draft.id); end if;

  if p_edits is null or jsonb_typeof(p_edits) <> 'array' or jsonb_array_length(p_edits) = 0 then
    raise exception 'skill_teaching_invalid_edit' using errcode = 'P0001';
  end if;
  for v_edit in select * from jsonb_array_elements(p_edits) loop
    if jsonb_typeof(v_edit) <> 'object'
      or v_edit ->> 'runId' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      or v_edit ->> 'editId' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      or not exists (
        select 1 from deal_step_skill_runs run, jsonb_array_elements(run.inputs -> 'edits') recorded
        where run.id = (v_edit ->> 'runId')::uuid
          and run.source = 'revision' and run.outcome = 'succeeded'
          and run.deal_id = p_deal_id and run.deal_step_id = v_draft.basis_deal_step_id
          and jsonb_typeof(run.inputs -> 'edits') = 'array'
          and recorded ->> 'id' = v_edit ->> 'editId'
          and recorded ->> 'kind' = 'comment' and recorded ->> 'status' = 'applied'
          and recorded -> 'teach' = 'true'::jsonb
      ) then
      raise exception 'skill_teaching_invalid_edit' using errcode = 'P0001';
    end if;
  end loop;

  if exists (
    select 1 from jsonb_array_elements(p_edits) named
    join skill_comment_teachings t on t.edit_id = (named ->> 'editId')::uuid
    where t.kind = 'sent' or (t.kind = 'waiting' and t.draft_id = v_draft.id)
  ) then
    return skill_authoring_receipt(v_draft) || jsonb_build_object('offered', false);
  end if;

  v_text := case when v_draft.composer_text = '' then p_prompt else v_draft.composer_text || E'\n\n' || p_prompt end;
  if v_text is null or char_length(v_text) > 20000 then
    return skill_authoring_receipt(v_draft) || jsonb_build_object('offered', false);
  end if;

  update skill_authoring_drafts set composer_text = v_text, edit_revision = edit_revision + 1, updated_at = now()
  where id = v_draft.id returning * into v_draft;
  insert into skill_comment_teachings (deal_id, revision_run_id, edit_id, draft_id, kind, actor_id)
  select p_deal_id, (named ->> 'runId')::uuid, (named ->> 'editId')::uuid, v_draft.id, 'waiting', p_actor_id
  from jsonb_array_elements(p_edits) named;

  return skill_authoring_receipt(v_draft) || jsonb_build_object('offered', true);
end;
$$;

revoke all on function skill_teaching_offer(uuid, uuid, uuid, jsonb, text, uuid) from public, anon, authenticated;
grant execute on function skill_teaching_offer(uuid, uuid, uuid, jsonb, text, uuid) to service_role;

create or replace function skill_authoring_submit_message(
  p_actor_id uuid, p_deal_id uuid, p_draft_id uuid, p_expected_revision bigint,
  p_client_message_id uuid, p_text text, p_correlation_id uuid
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_draft skill_authoring_drafts%rowtype;
  v_message skill_authoring_messages%rowtype;
  v_attempt skill_authoring_attempts%rowtype;
  v_ordinal bigint;
  v_taught integer;
begin
  perform skill_authoring_lock_author(p_actor_id, p_deal_id);
  select * into v_draft from skill_authoring_drafts
  where id = p_draft_id and deal_id = p_deal_id and author_id = p_actor_id for update;
  if not found then raise exception 'skill_authoring_draft_not_found' using errcode = 'P0002'; end if;
  if v_draft.status <> 'active' then perform skill_authoring_raise_conflict(v_draft.id); end if;

  update skill_authoring_attempts set status = 'failed', error_code = 'generation_interrupted',
    error_message = 'Generation was interrupted. Try again.', completed_at = now()
  where draft_id = v_draft.id and status = 'running' and not skill_authoring_attempt_live(status, last_progress_at);

  select * into v_message from skill_authoring_messages
  where draft_id = p_draft_id and client_message_id = p_client_message_id for update;
  if found then
    if v_message.text is distinct from p_text then perform skill_authoring_raise_conflict(v_draft.id); end if;
    select * into v_attempt from skill_authoring_attempts where message_id = v_message.id and attempt_number = 1;
    if not found then raise exception 'skill_authoring_message_receipt_missing' using errcode = 'P0001'; end if;
    return skill_authoring_receipt(v_draft, v_message, v_attempt) || jsonb_build_object('created', false);
  end if;

  if v_draft.edit_revision <> p_expected_revision or p_client_message_id is null
    or p_text is null or char_length(p_text) not between 1 and 20000 then
    perform skill_authoring_raise_conflict(v_draft.id);
  end if;
  if exists (select 1 from skill_authoring_attempts where draft_id = p_draft_id and status = 'running') then
    perform skill_authoring_raise_conflict(v_draft.id);
  end if;

  select coalesce(max(ordinal), 0) + 1 into v_ordinal from skill_authoring_messages where draft_id = p_draft_id;
  insert into skill_authoring_messages (draft_id, author_id, ordinal, text, client_message_id, admitted_edit_revision)
  values (p_draft_id, p_actor_id, v_ordinal, p_text, p_client_message_id, v_draft.edit_revision + 1)
  returning * into v_message;
  insert into skill_comment_teachings (deal_id, revision_run_id, edit_id, draft_id, kind, message_id, actor_id)
  select w.deal_id, w.revision_run_id, w.edit_id, w.draft_id, 'sent', v_message.id, p_actor_id
  from skill_comment_teachings w
  where w.draft_id = v_draft.id and w.kind = 'waiting'
    and not exists (select 1 from skill_comment_teachings s where s.edit_id = w.edit_id and s.kind = 'sent');
  get diagnostics v_taught = row_count;
  insert into skill_authoring_attempts (draft_id, message_id, attempt_number)
  values (p_draft_id, v_message.id, 1) returning * into v_attempt;
  update skill_authoring_drafts set composer_text = case when composer_text = p_text then '' else composer_text end,
    edit_revision = edit_revision + 1, updated_at = now() where id = v_draft.id returning * into v_draft;

  perform skill_authoring_write_audit(p_actor_id, 'skill_authoring.message_admitted', p_deal_id,
    jsonb_build_object('draftId', v_draft.id, 'messageId', v_message.id, 'attemptId', v_attempt.id,
      'actorId', p_actor_id, 'taughtComments', v_taught, 'correlationId', p_correlation_id));
  perform skill_authoring_write_audit(p_actor_id, 'skill_authoring.attempt_transitioned', p_deal_id,
    jsonb_build_object('draftId', v_draft.id, 'messageId', v_message.id, 'attemptId', v_attempt.id,
      'actorId', p_actor_id, 'toState', 'running', 'correlationId', p_correlation_id));

  return skill_authoring_receipt(v_draft, v_message, v_attempt) || jsonb_build_object('created', true);
end;
$$;

revoke all on function skill_authoring_submit_message(uuid, uuid, uuid, bigint, uuid, text, uuid) from public, anon, authenticated;
grant execute on function skill_authoring_submit_message(uuid, uuid, uuid, bigint, uuid, text, uuid) to service_role;
