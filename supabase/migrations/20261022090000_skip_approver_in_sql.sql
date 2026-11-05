-- #312 (leftover of #542 review finding 3): the database refuses a step skip whose
-- approver is not an active md, deal_team or legal seat on the deal.
--
-- The route checks the approver in TypeScript (resolveSkipApprover), but the
-- function that records the skip accepted any user id, so a caller that skips the
-- route, or a seat lost between the check and the write, produced an approval by
-- someone with no authority on the deal. This migration adds the second line:
--
-- 1. rail_skip_approver(deal, approver) is the one SQL rule. It is a security
--    invoker, called only by the definers that record a skip (they run as the
--    owner), so nobody else gets EXECUTE. It returns the approver's name and deal
--    role from its own read, and raises 42501 skip_approver_ineligible for anyone
--    outside the rule. The approver's user row must also be in the deal's tenant:
--    a seat alone is not a tenant boundary, because tenant_id can change without a
--    company change (a tenant split). The role list mirrors SKIP_APPROVER_DEAL_ROLES
--    (src/lib/constants/dealSteps.ts); tests/skip-approver-schema-sync.test.ts
--    fails on drift.
--
--    It locks the approver's user row FOR SHARE and then the seat FOR SHARE, in two
--    statements. A removal, suspension or company move that commits first makes the
--    read find nothing (READ COMMITTED re-checks the updated row) and the skip is
--    refused; one that arrives later waits until the skip commits. The order is the
--    company-move cascade's: UPDATE users (user row), then the AFTER trigger
--    cascade_revoke_on_company_removal deletes the user's seats. No writer takes a
--    seat and then the user row, so the skip cannot form a wait cycle with any of
--    them. A single joined FOR SHARE OF m, u leaves the order to the planner and
--    could deadlock against a company move, hence two statements.
--
--    The whole skip's order is user -> seat -> audit chain: the skip's audit row,
--    written last, takes the tenant's chain lock (zz_audit_log_chain_append). Writers
--    that lock the user row before they audit (accept_invite and
--    accept_work_identity_invite FOR UPDATE, a company move or suspension whose
--    seat-loss triggers audit) agree with it. The one writer that audited between a
--    share lock and an UPDATE of the user, replace_company_member_access, formed a
--    cycle with a skip on the same user; #703 ([312 3/3]) removes it by locking its
--    target FOR NO KEY UPDATE before any audit row. The routes answer a 40P01 with a
--    retryable 409 in any case.
--
-- 2. rail_skip_step calls the helper instead of reading the approver left-joined
--    for display only, and records approverId in work.skip beside the name, so the
--    two skip paths (this one and deal_step_save, next) write the same record.
--
-- rail_skip_step is re-declared from 20261001110000_rail_skip_closed_state.sql
-- with only those two changes and the pinned search_path (public, pg_temp).
--
-- 3. deal_step_save (the logged skip, project_rail_model off) calls the same
--    helper when the patch sets status = 'skipped', and builds the skip record
--    itself instead of copying the caller's patch and audits:
--    - the reason comes from skip_reason or completion_note and is required
--      (P0001, the code and text rail_skip_step uses), checked before any lock;
--    - the approver id comes from skip_approver_id, or from work.skip.approverId,
--      which is all today's route sends, so the function works while the app and
--      the migration deploy in either order. A value that is not a uuid is an
--      ineligible approver (42501), never a 22P02 cast error;
--    - work.skip, skipped_at/by, skip_approver_id, skip_reason, completed_by/at and
--      completion_note are written from the function's own read (the actor, now(),
--      the helper's name and role, the reason), whatever the patch carried, so both
--      skip paths leave the same record;
--    - outside a skip transition work.skip is the stored value, and a caller audit
--      in either skip shape (detail.kind = 'skip' or detail.rail = 'skip', any
--      action) is refused with 42501 skip_audit_without_skip; on a skip it is
--      dropped and the function inserts its own advance/kind:'skip' row, whose
--      stepTitle is the definition title or the step key, never caller text;
--    - a non-object work is normalised to {} only on a skip. A non-skip save keeps
--      today's value, except that a stored work.skip is carried over.
--    Everything else is re-declared from 20261001100000_deal_step_save.sql, with
--    the search_path pinned to public, pg_temp.

create or replace function rail_skip_approver(
  p_deal_id     uuid,
  p_approver_id uuid
) returns table (approver text, approver_role text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_tenant uuid;
  v_name   text;
  v_role   text;
begin
  if p_approver_id is null then
    raise exception 'skip_approver_ineligible' using errcode = '42501';
  end if;

  -- The deal's tenant. Both callers already hold the deal row FOR UPDATE.
  select d.tenant_id into v_tenant from deals d where d.id = p_deal_id;

  -- 1. The user row first, in the deal's tenant. Same display-name fallback as
  --    rail_skip_step used to carry (TypeScript resolveSkipApprover ends at
  --    'Banker' where this ends at the email).
  select coalesce(nullif(btrim(u.display_name), ''), nullif(btrim(u.full_name), ''), u.email)
    into v_name
    from users u
   where u.id = p_approver_id and u.status = 'active' and u.tenant_id = v_tenant
     for share;
  if not found then
    raise exception 'skip_approver_ineligible' using errcode = '42501';
  end if;

  -- 2. Then the seat.
  select m.deal_role
    into v_role
    from deal_memberships m
   where m.deal_id = p_deal_id and m.user_id = p_approver_id
     and m.deal_role in ('md', 'deal_team', 'legal')
     for share;
  if not found then
    raise exception 'skip_approver_ineligible' using errcode = '42501';
  end if;

  return query select v_name, v_role;
end;
$$;

-- No grant: the two definers that record a skip run as the owner. A browser role,
-- service_role or PUBLIC calling it directly would only learn who holds a seat.
revoke all on function rail_skip_approver(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function rail_skip_step(
  p_deal_id     uuid,
  p_actor_id    uuid,
  p_step_id     uuid,
  p_approver_id uuid,
  p_reason      text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_step     deal_steps;
  v_current  uuid;
  v_approver text;
  v_role     text;
begin
  perform 1 from deals where id = p_deal_id for update;
  if not found then
    raise exception 'deal % not found', p_deal_id using errcode = 'P0001';
  end if;

  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'a skip reason is required' using errcode = 'P0001';
  end if;

  select * into v_step from deal_steps where id = p_step_id and deal_id = p_deal_id;
  if v_step.id is null or v_step.removed_at is not null then
    raise exception 'step % not available on deal %', p_step_id, p_deal_id using errcode = 'P0001';
  end if;
  -- A step that is already closed stays closed: a completion that won the
  -- deal lock first is not overwritten into a skip, and a second skip does
  -- not stack a second record.
  if v_step.status in ('complete', 'skipped', 'skipped_entry') then
    raise exception 'step_closed' using errcode = 'P0003';
  end if;

  -- The approver must hold an active md, deal_team or legal seat on this deal
  -- (42501 otherwise). The helper's locks stay until this transaction commits.
  -- Its name and deal role, not only the id: `work.skip` carries the text the
  -- readers render (skipOf in /api/v1/deals/{dealId}/step-records), in the shape
  -- develop's PATCH /steps { skip } writes.
  select s.approver, s.approver_role
    into v_approver, v_role
    from rail_skip_approver(p_deal_id, p_approver_id) s;

  update deal_steps
     set status = 'skipped', skipped_at = now(), skipped_by = p_actor_id,
         skip_approver_id = p_approver_id, skip_reason = btrim(p_reason),
         completed_by = p_actor_id, completed_at = now(), completion_note = btrim(p_reason),
         updated_at = now(),
         work = coalesce(work, '{}'::jsonb) || jsonb_build_object('skip', jsonb_build_object(
           'approverId', p_approver_id,
           'approver', coalesce(v_approver, ''), 'approverRole', coalesce(v_role, ''),
           'reason', btrim(p_reason),
           'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
   where id = p_step_id;

  select current_deal_step_id into v_current from deals where id = p_deal_id;
  if v_current = p_step_id then
    v_current := rail_reselect_current(p_deal_id, p_actor_id, v_step);
  end if;

  insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor_id, 'update', p_deal_id,
            jsonb_build_object('rail', 'skip', 'stepId', p_step_id,
                               'stepKey', v_step.step_id, 'title', v_step.definition->>'title',
                               'approver', p_approver_id, 'reason', btrim(p_reason)));

  return jsonb_build_object('currentStepId', v_current);
end;
$$;

revoke all on function rail_skip_step(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function rail_skip_step(uuid, uuid, uuid, uuid, text) to service_role;

create or replace function deal_step_save(
  p_deal_id             uuid,
  p_step_id             uuid,
  p_actor_id            uuid,
  p_patch               jsonb,
  p_expected_updated_at timestamptz,
  p_audits              jsonb,
  p_advance             boolean
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_step  deal_steps;
  v_new   deal_steps;
  v_next  deal_steps;
  v_audit jsonb;
  v_from  int;
  v_cursor uuid;
  v_patch jsonb;
  v_skipping    boolean;
  v_reason      text;
  v_raw         text;
  v_approver_id uuid;
  v_approver    text;
  v_role        text;
  v_at          text;
begin
  v_skipping := coalesce(p_patch->>'status' = 'skipped', false);
  if v_skipping then
    -- The reason first, before any lock: the same rule and code as rail_skip_step.
    v_reason := coalesce(nullif(btrim(p_patch->>'skip_reason'), ''),
                         nullif(btrim(p_patch->>'completion_note'), ''));
    if v_reason is null then
      raise exception 'a skip reason is required' using errcode = 'P0001';
    end if;
    -- skip_approver_id when the route sends it, else work.skip.approverId, which
    -- is all the route sent before the explicit columns. Anything that is not a
    -- uuid becomes null, and the helper refuses it with 42501 (a bare cast would
    -- raise 22P02 and reach the route as a 500).
    v_raw := coalesce(p_patch->>'skip_approver_id', p_patch#>>'{work,skip,approverId}');
    v_approver_id := case
      when v_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v_raw::uuid
    end;
  end if;

  -- The same per-deal lock the structural rail writes take.
  select current_deal_step_id into v_cursor from deals where id = p_deal_id for update;
  if not found then
    raise exception 'deal % not found', p_deal_id using errcode = 'P0001';
  end if;

  select * into v_step from deal_steps where id = p_step_id and deal_id = p_deal_id for update;
  if v_step.id is null then
    raise exception 'step % not found on deal %', p_step_id, p_deal_id using errcode = 'P0001';
  end if;
  -- Closed steps intentionally still accept work and assignment edits. Only
  -- another status transition is refused.
  if v_step.removed_at is not null
     or (p_expected_updated_at is not null and v_step.updated_at is distinct from p_expected_updated_at)
     or (p_patch ? 'status' and v_step.status in ('complete', 'skipped', 'skipped_entry')) then
    raise exception 'step_changed' using errcode = 'P0409';
  end if;

  -- The skip columns are never taken from the patch: on a skip they are built
  -- below, and otherwise they keep their value. Dropping the keys also keeps a
  -- malformed one from failing the record cast.
  v_patch := p_patch - 'skip_approver_id' - 'skip_reason' - 'skipped_at' - 'skipped_by';
  v_new := jsonb_populate_record(v_step, v_patch);

  if v_skipping then
    -- The approver must hold an active md, deal_team or legal seat on this deal
    -- (42501 otherwise); the helper's locks stay until this transaction commits.
    select s.approver, s.approver_role
      into v_approver, v_role
      from rail_skip_approver(p_deal_id, v_approver_id) s;
    v_at := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    -- Who closed the step is the actor, not the caller's patch.
    v_new.completed_by := p_actor_id;
    v_new.completed_at := now();
    v_new.completion_note := v_reason;
    v_new.skipped_at := now();
    v_new.skipped_by := p_actor_id;
    v_new.skip_approver_id := v_approver_id;
    v_new.skip_reason := v_reason;
  end if;

  -- work.skip is SQL-owned: built here on a skip (from the helper's read, never
  -- the caller's text), otherwise the stored value, whatever the patch carried.
  if v_skipping then
    v_new.work := ((case when jsonb_typeof(v_new.work) = 'object' then v_new.work else '{}'::jsonb end) - 'skip')
      || jsonb_build_object('skip', jsonb_build_object(
           'approverId', v_approver_id,
           'approver', coalesce(v_approver, ''), 'approverRole', coalesce(v_role, ''),
           'reason', v_reason, 'at', v_at));
  elsif jsonb_typeof(v_new.work) = 'object' then
    v_new.work := (v_new.work - 'skip')
      || case when v_step.work ? 'skip' then jsonb_build_object('skip', v_step.work->'skip')
              else '{}'::jsonb end;
  elsif v_step.work ? 'skip' then
    -- A non-object work (a reset) on a step with a stored skip keeps the record.
    v_new.work := jsonb_build_object('skip', v_step.work->'skip');
  end if;
  -- Otherwise a non-skip save keeps the patch's work as it is, as before #312.

  update deal_steps
     set assigned_to = v_new.assigned_to, assigned_by = v_new.assigned_by,
         assigned_at = v_new.assigned_at, work = v_new.work, status = v_new.status,
         completed_by = v_new.completed_by, completed_at = v_new.completed_at,
         completion_note = v_new.completion_note,
         skipped_at = v_new.skipped_at, skipped_by = v_new.skipped_by,
         skip_approver_id = v_new.skip_approver_id, skip_reason = v_new.skip_reason,
         bench_conversation_id = v_new.bench_conversation_id, bench_run_id = v_new.bench_run_id,
         bench_run_status = v_new.bench_run_status, bench_run_started_at = v_new.bench_run_started_at,
         updated_at = v_new.updated_at
   where id = v_step.id
  returning * into v_new;

  for v_audit in select * from jsonb_array_elements(coalesce(p_audits, '[]'::jsonb)) loop
    -- Both skip audit shapes (advance/kind and update/rail), under any action: a
    -- skip row is written only by the skip below, never copied from the caller.
    if v_audit->'detail'->>'kind' = 'skip' or v_audit->'detail'->>'rail' = 'skip' then
      if not v_skipping then
        raise exception 'skip_audit_without_skip' using errcode = '42501';
      end if;
      continue;
    end if;
    insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor_id, v_audit->>'action', p_deal_id, coalesce(v_audit->'detail', '{}'::jsonb));
  end loop;

  if v_skipping then
    -- The audit action list is a CHECK: a skip is the rail advancing past a
    -- station, recorded under `advance` with the skip as its detail.
    insert into audit_log (actor_id, action, deal_id, detail)
    values (p_actor_id, 'advance', p_deal_id,
            jsonb_build_object('kind', 'skip', 'stepId', v_step.step_id,
                               -- The definition title, else the step key (catalog steps carry no
                               -- definition title). Never the caller's text.
                               'stepTitle', coalesce(nullif(v_step.definition->>'title', ''), v_step.step_id),
                               'seq', v_step.seq,
                               'approverId', v_approver_id,
                               'approver', coalesce(v_approver, ''), 'approverRole', coalesce(v_role, ''),
                               'reason', v_reason));
  end if;

  -- Only completing the deal's current step moves the cursor: finishing a
  -- later step out of order must not drag the position past the current one.
  -- A deal with no recorded cursor falls back to the step's own status.
  if p_advance
     and (v_cursor = v_step.id or (v_cursor is null and v_step.status = 'current')) then
    -- The next unfinished step after this one: by display_order on the
    -- project rail, by seq on a deal whose rows carry none. Removed steps are
    -- never current; with nothing left the position stays where it is.
    select * into v_next from deal_steps
     where deal_id = p_deal_id
       and removed_at is null
       and status in ('pending', 'current')
       and case when v_step.display_order is not null then display_order > v_step.display_order
                else seq > v_step.seq end
     order by case when v_step.display_order is not null then display_order else seq end
     limit 1;

    if v_next.id is not null then
      select current_step_seq into v_from from deals where id = p_deal_id;
      update deal_steps set status = 'current', updated_at = now() where id = v_next.id;
      update deals
         set current_deal_step_id = v_next.id,
             current_step_seq = coalesce(v_next.seq, current_step_seq)
       where id = p_deal_id;

      insert into audit_log (actor_id, action, deal_id, detail)
      values (p_actor_id, 'advance', p_deal_id,
              jsonb_build_object('from', v_from, 'to', coalesce(v_next.seq, v_from),
                                 'fromStepId', v_step.id, 'toStepId', v_next.id));
    end if;
  end if;

  select current_deal_step_id into v_cursor from deals where id = p_deal_id;
  return jsonb_build_object('step', to_jsonb(v_new), 'currentStepId', v_cursor);
end;
$$;

revoke all on function deal_step_save(uuid, uuid, uuid, jsonb, timestamptz, jsonb, boolean) from public, anon, authenticated;
grant execute on function deal_step_save(uuid, uuid, uuid, jsonb, timestamptz, jsonb, boolean) to service_role;
