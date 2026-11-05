-- supabase/tests/deal_step_save.sql
-- #200 (PL-08): a step write, its audit rows and the rail advance commit
-- together. A stale work save or a rejected audit insert must leave the step,
-- the audit trail and the rail exactly as they were, and a completion and a
-- rail skip can never both close the same step. Run via psql; always
-- ROLLBACKs.

begin;
-- #316: new auth users are contained; promote each fixture the way the seed
-- script does (authorize_provisioned_profile over its metadata) and give it a
-- live session whose id is the user id, so impersonating claims can carry
-- session_id = sub.
create or replace function pg_temp.authorize_fixture() returns trigger language plpgsql as $fx$
begin
  perform public.authorize_provisioned_profile(new.id, new.raw_user_meta_data);
  insert into auth.sessions (id, user_id, created_at, updated_at, aal)
  values (new.id, new.id, now(), now(), 'aal1') on conflict (id) do nothing;
  return new;
end
$fx$;
drop trigger if exists zz_authorize_fixture on auth.users;
create trigger zz_authorize_fixture after insert on auth.users
  for each row execute function pg_temp.authorize_fixture();

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_tenant uuid := '00000000-0000-4000-8000-00000000000c';
  v_bank   uuid := gen_random_uuid();
  v_md     uuid := gen_random_uuid();
  v_deal   uuid;
  v_s1     deal_steps;
  v_s2     deal_steps;
  v_s4     deal_steps;
  v_row    deal_steps;
  v_result jsonb;
  v_seq    int;
  v_cur    uuid;
  v_audits int;
  v_before timestamptz;
begin
  insert into auth.users (id, email, raw_user_meta_data)
    values (v_md, 'step-save-md@example.com', jsonb_build_object('department','ib','tenant_id',v_tenant));
  insert into companies (id, tenant_id, name, type)
    values (v_bank, v_tenant, 'Step Save Bank', 'bank');
  update users set company_id = v_bank, company_role = 'director', is_external = false, status = 'active'
    where id = v_md;

  v_deal := (create_deal_gate0(
    p_tenant_id      => v_tenant,
    p_actor_id       => v_md,
    p_bank_id        => v_bank,
    p_codename       => 'Project Step Save',
    p_target_name    => 'Atlassian',
    p_entry_step_seq => 1,
    p_steps          => jsonb_build_array(
      jsonb_build_object('stepId','v-s1','seq',1,'phaseIndex',1,'displayOrder',1),
      jsonb_build_object('stepId','v-s2','seq',2,'phaseIndex',1,'displayOrder',2),
      jsonb_build_object('stepId','v-s3','seq',3,'phaseIndex',1,'displayOrder',3),
      jsonb_build_object('stepId','v-s4','seq',4,'phaseIndex',1,'displayOrder',4)
    ),
    p_census_version => 'test-1x4',
    p_conflicts      => jsonb_build_object('approvedBy','Avery Lindqvist','approvedOn','2026-09-01')
  )->'deal'->>'id')::uuid;
  select * into v_s1 from deal_steps where deal_id = v_deal and step_id = 'v-s1';
  select * into v_s2 from deal_steps where deal_id = v_deal and step_id = 'v-s2';
  select * into v_s4 from deal_steps where deal_id = v_deal and step_id = 'v-s4';

  -- 1. Completion: the step, both audit rows and the advance land together.
  v_result := deal_step_save(
    v_deal, v_s1.id, v_md,
    jsonb_build_object('status','complete','completed_by',v_md,'completed_at',now(),
                       'work',jsonb_build_object('notes','done'),'updated_at',now()),
    v_s1.updated_at,
    jsonb_build_array(
      jsonb_build_object('action','step_work','detail',jsonb_build_object('stepId','v-s1')),
      jsonb_build_object('action','complete_step','detail',jsonb_build_object('stepId','v-s1'))),
    true);
  v_row := jsonb_populate_record(null::deal_steps, v_result->'step');
  if (v_result->>'currentStepId')::uuid <> v_s2.id then
    raise exception 'FAIL: save returned the wrong cursor';
  end if;
  if v_row.status <> 'complete' or v_row.work->>'notes' <> 'done' or v_row.completed_by <> v_md then
    raise exception 'FAIL: completion did not write the step (%)', to_jsonb(v_row);
  end if;
  select current_step_seq, current_deal_step_id into v_seq, v_cur from deals where id = v_deal;
  if v_seq <> 2 or v_cur <> v_s2.id
     or (select status from deal_steps where id = v_s2.id) <> 'current' then
    raise exception 'FAIL: completion should advance to v-s2 (seq %, current %)', v_seq, v_cur;
  end if;
  select count(*) into v_audits from audit_log
    where deal_id = v_deal and action in ('step_work','complete_step') and detail->>'stepId' = 'v-s1';
  if v_audits <> 2 then
    raise exception 'FAIL: completion should write both audit rows, found %', v_audits;
  end if;
  if not exists (select 1 from audit_log
                  where deal_id = v_deal and action = 'advance' and actor_id = v_md
                    and detail = jsonb_build_object('from', 1, 'to', 2, 'fromStepId', v_s1.id, 'toStepId', v_s2.id)) then
    raise exception 'FAIL: the cursor move should write an advance audit row {from 1, to 2}';
  end if;

  -- 2. A completed step cannot be completed again (no second advance).
  begin
    perform deal_step_save(v_deal, v_s1.id, v_md, jsonb_build_object('status','complete'),
                           null, '[]'::jsonb, true);
    raise exception 'FAIL: completing a completed step must be refused';
  exception when sqlstate 'P0409' then null;
  end;

  -- 3. A stale work save is refused and changes nothing.
  select * into v_s2 from deal_steps where id = v_s2.id;
  begin
    perform deal_step_save(
      v_deal, v_s2.id, v_md, jsonb_build_object('work', jsonb_build_object('notes','stale')),
      v_s2.updated_at - interval '1 second',
      jsonb_build_array(jsonb_build_object('action','step_work','detail',jsonb_build_object('stepId','v-s2'))),
      false);
    raise exception 'FAIL: a stale work save must be refused';
  exception when sqlstate 'P0409' then null;
  end;
  if (select work->>'notes' from deal_steps where id = v_s2.id) is not null
     or exists (select 1 from audit_log where deal_id = v_deal and detail->>'stepId' = 'v-s2') then
    raise exception 'FAIL: a refused save left a trace';
  end if;

  -- 4. The advance skips a step that left the rail.
  update deal_steps set removed_at = now() where deal_id = v_deal and step_id = 'v-s3';
  perform deal_step_save(
    v_deal, v_s2.id, v_md, jsonb_build_object('status','complete','updated_at',now()), null,
    jsonb_build_array(jsonb_build_object('action','complete_step','detail',jsonb_build_object('stepId','v-s2'))),
    true);
  select current_step_seq, current_deal_step_id into v_seq, v_cur from deals where id = v_deal;
  if v_seq <> 4 or v_cur <> v_s4.id then
    raise exception 'FAIL: the advance should pass the removed step (seq %)', v_seq;
  end if;

  -- 5. A rejected audit insert rolls the step write and the advance back.
  create function pg_temp.reject_audit() returns trigger language plpgsql as
    $f$ begin raise exception 'audit rejected' using errcode = 'P0009'; end $f$;
  create trigger reject_audit before insert on audit_log
    for each row execute function pg_temp.reject_audit();
  begin
    perform deal_step_save(
      v_deal, v_s4.id, v_md, jsonb_build_object('status','complete','updated_at',now()), null,
      jsonb_build_array(jsonb_build_object('action','complete_step','detail',jsonb_build_object('stepId','v-s4'))),
      true);
    raise exception 'FAIL: the completion must fail with its audit';
  exception when sqlstate 'P0009' then null;
  end;
  drop trigger reject_audit on audit_log;

  if (select status from deal_steps where id = v_s4.id) <> 'current' then
    raise exception 'FAIL: a rejected audit left v-s4 completed';
  end if;
  select current_step_seq into v_seq from deals where id = v_deal;
  if v_seq <> 4 then
    raise exception 'FAIL: a rejected audit moved the cursor to %', v_seq;
  end if;

  -- 6. A skip closes the step and bumps its version, so a completion that
  --    read the step before the skip (even without a work CAS) is refused.
  --    now() is frozen for the transaction, so age the row first to see the bump.
  update deal_steps set updated_at = now() - interval '1 minute' where id = v_s4.id
    returning updated_at into v_before;
  -- The skip below names v_md as approver (#312): the SQL check accepts that only
  -- while create_deal_gate0 gives the actor an active md seat.
  if not exists (select 1 from deal_memberships m join users u on u.id = m.user_id
                  where m.deal_id = v_deal and m.user_id = v_md and m.deal_role = 'md'
                    and u.status = 'active') then
    raise exception 'FAIL: create_deal_gate0 must give the actor an active md seat';
  end if;
  perform rail_skip_step(v_deal, v_md, v_s4.id, v_md, 'Covered elsewhere');
  if (select updated_at from deal_steps where id = v_s4.id) <= v_before then
    raise exception 'FAIL: rail_skip_step must bump updated_at';
  end if;
  begin
    perform deal_step_save(
      v_deal, v_s4.id, v_md, jsonb_build_object('status','complete','updated_at',now()), null,
      jsonb_build_array(jsonb_build_object('action','complete_step','detail',jsonb_build_object('stepId','v-s4'))),
      true);
    raise exception 'FAIL: completing a skipped step must be refused';
  exception when sqlstate 'P0409' then null;
  end;
  if (select status from deal_steps where id = v_s4.id) <> 'skipped'
     or exists (select 1 from audit_log where deal_id = v_deal and action = 'complete_step'
                                          and detail->>'stepId' = 'v-s4') then
    raise exception 'FAIL: a refused completion changed the skipped step';
  end if;

  -- 7. The reverse order: a closed step (completed or skipped) cannot be skipped.
  begin
    perform rail_skip_step(v_deal, v_md, v_s1.id, v_md, 'Too late');
    raise exception 'FAIL: skipping a completed step must be refused';
  exception when sqlstate 'P0003' then null;
  end;
  begin
    perform rail_skip_step(v_deal, v_md, v_s4.id, v_md, 'Twice');
    raise exception 'FAIL: skipping a skipped step must be refused';
  exception when sqlstate 'P0003' then null;
  end;
  if (select status from deal_steps where id = v_s1.id) <> 'complete' then
    raise exception 'FAIL: a refused skip changed the completed step';
  end if;
end $$;

-- Advance ordering (ported from the deleted tests/api/rail-advance.test.ts)
-- and the current-step gate. Fixtures here make seq and display_order
-- disagree, null them out, and finish steps out of order.
create function pg_temp.complete_step(p_deal uuid, p_step uuid, p_actor uuid) returns void
language sql as $f$
  select deal_step_save(p_deal, p_step, p_actor,
    jsonb_build_object('status','complete','completed_by',p_actor,'updated_at',now()), null,
    jsonb_build_array(jsonb_build_object('action','complete_step','detail',jsonb_build_object('stepId',p_step))),
    true);
$f$;

do $$
declare
  v_tenant uuid := '00000000-0000-4000-8000-00000000000c';
  v_bank   uuid := gen_random_uuid();
  v_md     uuid := gen_random_uuid();
  v_b      uuid;
  v_c      uuid;
  v_seq    int;
  v_cur    uuid;
  v_n      int;
  b1 uuid; b2 uuid; b3 uuid; b4 uuid;
  c1 uuid; c2 uuid; c3 uuid; c4 uuid;
begin
  insert into auth.users (id, email, raw_user_meta_data)
    values (v_md, 'step-advance-md@example.com', jsonb_build_object('department','ib','tenant_id',v_tenant));
  insert into companies (id, tenant_id, name, type)
    values (v_bank, v_tenant, 'Step Advance Bank', 'bank');
  update users set company_id = v_bank, company_role = 'director', is_external = false, status = 'active'
    where id = v_md;

  v_b := (create_deal_gate0(
    p_tenant_id => v_tenant, p_actor_id => v_md, p_bank_id => v_bank,
    p_codename => 'Project Advance Order', p_target_name => 'Atlassian', p_entry_step_seq => 1,
    p_steps => jsonb_build_array(
      jsonb_build_object('stepId','b-s1','seq',1,'phaseIndex',1,'displayOrder',1),
      jsonb_build_object('stepId','b-s2','seq',2,'phaseIndex',1,'displayOrder',2),
      jsonb_build_object('stepId','b-s3','seq',3,'phaseIndex',1,'displayOrder',3),
      jsonb_build_object('stepId','b-s4','seq',4,'phaseIndex',1,'displayOrder',4)),
    p_census_version => 'test-1x4',
    p_conflicts => jsonb_build_object('approvedBy','Avery Lindqvist','approvedOn','2026-09-01')
  )->'deal'->>'id')::uuid;
  select id into b1 from deal_steps where deal_id = v_b and step_id = 'b-s1';
  select id into b2 from deal_steps where deal_id = v_b and step_id = 'b-s2';
  select id into b3 from deal_steps where deal_id = v_b and step_id = 'b-s3';
  select id into b4 from deal_steps where deal_id = v_b and step_id = 'b-s4';

  -- 1. display_order wins over seq: swap the seqs of b-s2 and b-s3, so the
  --    next step by display_order (b-s2) carries seq 3.
  update deal_steps set seq = 100 where id = b2;
  update deal_steps set seq = 2 where id = b3;
  update deal_steps set seq = 3 where id = b2;
  perform pg_temp.complete_step(v_b, b1, v_md);
  select current_step_seq, current_deal_step_id into v_seq, v_cur from deals where id = v_b;
  if v_cur <> b2 or v_seq <> 3 then
    raise exception 'FAIL: the advance should follow display_order to b-s2 (seq %, current %)', v_seq, v_cur;
  end if;

  -- 2. A next step without a canonical seq moves the cursor but leaves
  --    current_step_seq where it was.
  update deal_steps set seq = null where id = b3;
  perform pg_temp.complete_step(v_b, b2, v_md);
  select current_step_seq, current_deal_step_id into v_seq, v_cur from deals where id = v_b;
  if v_cur <> b3 or v_seq <> 3 then
    raise exception 'FAIL: a seq-less next step should keep current_step_seq at 3 (seq %, current %)', v_seq, v_cur;
  end if;

  if not exists (select 1 from audit_log where deal_id = v_b and action = 'advance'
    and detail = jsonb_build_object('from', 3, 'to', 3, 'fromStepId', b2, 'toStepId', b3)) then
    raise exception 'FAIL: a seq-less advance must identify both step ids';
  end if;

  -- 3. With no unfinished step after the completed one, the cursor stays put:
  --    no wraparound onto an earlier pending step.
  perform pg_temp.complete_step(v_b, b3, v_md);
  update deal_steps set status = 'pending' where id = b1;
  select count(*) into v_n from audit_log where deal_id = v_b and action = 'advance';
  perform pg_temp.complete_step(v_b, b4, v_md);
  select current_step_seq, current_deal_step_id into v_seq, v_cur from deals where id = v_b;
  if v_cur <> b4 or v_seq <> 4 or (select status from deal_steps where id = b1) <> 'pending' then
    raise exception 'FAIL: completing the tail must not jump back (seq %, current %)', v_seq, v_cur;
  end if;
  if (select count(*) from audit_log where deal_id = v_b and action = 'advance') <> v_n then
    raise exception 'FAIL: completing the tail must not write an advance row';
  end if;

  v_c := (create_deal_gate0(
    p_tenant_id => v_tenant, p_actor_id => v_md, p_bank_id => v_bank,
    p_codename => 'Project Advance Seq', p_target_name => 'Atlassian', p_entry_step_seq => 1,
    p_steps => jsonb_build_array(
      jsonb_build_object('stepId','c-s1','seq',1,'phaseIndex',1,'displayOrder',1),
      jsonb_build_object('stepId','c-s2','seq',2,'phaseIndex',1,'displayOrder',2),
      jsonb_build_object('stepId','c-s3','seq',3,'phaseIndex',1,'displayOrder',3),
      jsonb_build_object('stepId','c-s4','seq',4,'phaseIndex',1,'displayOrder',4)),
    p_census_version => 'test-1x4',
    p_conflicts => jsonb_build_object('approvedBy','Avery Lindqvist','approvedOn','2026-09-01')
  )->'deal'->>'id')::uuid;
  select id into c1 from deal_steps where deal_id = v_c and step_id = 'c-s1';
  select id into c2 from deal_steps where deal_id = v_c and step_id = 'c-s2';
  select id into c3 from deal_steps where deal_id = v_c and step_id = 'c-s3';
  select id into c4 from deal_steps where deal_id = v_c and step_id = 'c-s4';

  -- 4. Rows without display_order advance by seq.
  update deal_steps set display_order = null where deal_id = v_c;
  perform pg_temp.complete_step(v_c, c1, v_md);
  select current_step_seq, current_deal_step_id into v_seq, v_cur from deals where id = v_c;
  if v_cur <> c2 or v_seq <> 2 then
    raise exception 'FAIL: rows without display_order should advance by seq (seq %, current %)', v_seq, v_cur;
  end if;

  -- 5. Completing a step other than the current one (c-s3 while the cursor is
  --    on c-s2) records the completion but does not move the cursor.
  perform pg_temp.complete_step(v_c, c3, v_md);
  select current_step_seq, current_deal_step_id into v_seq, v_cur from deals where id = v_c;
  if (select status from deal_steps where id = c3) <> 'complete'
     or v_cur <> c2 or v_seq <> 2
     or (select status from deal_steps where id = c4) <> 'pending'
     or (select status from deal_steps where id = c2) <> 'current' then
    raise exception 'FAIL: an out-of-order completion moved the cursor (seq %, current %)', v_seq, v_cur;
  end if;
end $$;

-- #312: the logged skip (project_rail_model off). deal_step_save checks the skip
-- approver in SQL like rail_skip_step does, and builds the skip record itself:
-- work.skip, the skip_* columns, completed_* and the skip audit row come from its
-- own read, never from the caller's patch or audits.
--
-- Refusals are asserted through pg_temp.save_outcome, which returns the SQLSTATE
-- and message of a refused call and null when the call was accepted. An accepted
-- call therefore fails every refusal assertion below, whatever the code (a FAIL
-- raised inside the handler would be caught by it).
create function pg_temp.skip_user(p_email text, p_tenant uuid, p_bank uuid) returns uuid
language plpgsql as $f$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (id, email, raw_user_meta_data)
    values (v_id, p_email, jsonb_build_object('department','ib','tenant_id',p_tenant));
  update users set company_id = p_bank, company_role = 'member', is_external = false, status = 'active'
    where id = v_id;
  return v_id;
end
$f$;
create function pg_temp.skip_seat(p_deal uuid, p_user uuid, p_role text) returns void
language sql as $f$
  insert into deal_memberships (deal_id, user_id, role_id, deal_role)
    select p_deal, p_user, id, p_role from roles where slug = p_role;
$f$;
create function pg_temp.save_outcome(p_deal uuid, p_step uuid, p_actor uuid, p_patch jsonb, p_audits jsonb)
returns text language plpgsql as $f$
begin
  perform deal_step_save(p_deal, p_step, p_actor, p_patch, null, coalesce(p_audits, '[]'::jsonb), false);
  return null;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;

do $$
declare
  v_tenant uuid := '00000000-0000-4000-8000-00000000000c';
  v_bank   uuid := gen_random_uuid();
  v_md     uuid := gen_random_uuid();
  v_dt     uuid;
  v_legal  uuid;
  v_ro     uuid;
  v_buyer  uuid;
  v_susp   uuid;
  v_nobody uuid;
  v_other  uuid;
  v_split  uuid;
  v_deal   uuid;
  v_other_deal uuid;
  k1 uuid; k2 uuid; k3 uuid; k4 uuid; k5 uuid; k6 uuid;
  v_label  text;
  v_id     uuid;
  v_out    text;
  v_name_dt    text;
  v_name_legal text;
  v_before deal_steps;
  v_row    deal_steps;
  v_skip   jsonb;
  v_stored jsonb;
  v_detail jsonb;
  v_ineligible constant text := '42501 skip_approver_ineligible';
  v_no_skip    constant text := '42501 skip_audit_without_skip';
  v_forged_skip constant jsonb :=
    '{"approver":"Forged Name","approverRole":"md","reason":"Forged","at":"1999-01-01T00:00:00.000Z"}';
begin
  insert into auth.users (id, email, raw_user_meta_data)
    values (v_md, 'step-skip-md@example.com', jsonb_build_object('department','ib','tenant_id',v_tenant));
  insert into companies (id, tenant_id, name, type)
    values (v_bank, v_tenant, 'Step Skip Bank', 'bank');
  update users set company_id = v_bank, company_role = 'director', is_external = false, status = 'active'
    where id = v_md;

  v_deal := (create_deal_gate0(
    p_tenant_id      => v_tenant,
    p_actor_id       => v_md,
    p_bank_id        => v_bank,
    p_codename       => 'Project Step Skip',
    p_target_name    => 'Atlassian',
    p_entry_step_seq => 1,
    p_steps          => jsonb_build_array(
      jsonb_build_object('stepId','k-s1','seq',1,'phaseIndex',1,'displayOrder',1),
      jsonb_build_object('stepId','k-s2','seq',2,'phaseIndex',1,'displayOrder',2),
      jsonb_build_object('stepId','k-s3','seq',3,'phaseIndex',1,'displayOrder',3),
      jsonb_build_object('stepId','k-s4','seq',4,'phaseIndex',1,'displayOrder',4),
      jsonb_build_object('stepId','k-s5','seq',5,'phaseIndex',1,'displayOrder',5),
      jsonb_build_object('stepId','k-s6','seq',6,'phaseIndex',1,'displayOrder',6)
    ),
    p_census_version => 'test-1x6',
    p_conflicts      => jsonb_build_object('approvedBy','Avery Lindqvist','approvedOn','2026-09-01')
  )->'deal'->>'id')::uuid;
  select id into k1 from deal_steps where deal_id = v_deal and step_id = 'k-s1';
  select id into k2 from deal_steps where deal_id = v_deal and step_id = 'k-s2';
  select id into k3 from deal_steps where deal_id = v_deal and step_id = 'k-s3';
  select id into k4 from deal_steps where deal_id = v_deal and step_id = 'k-s4';
  select id into k5 from deal_steps where deal_id = v_deal and step_id = 'k-s5';
  select id into k6 from deal_steps where deal_id = v_deal and step_id = 'k-s6';

  -- The actor holds an active md seat from create_deal_gate0: the skips below
  -- name v_md as approver, which the SQL approver check accepts only then.
  if not exists (select 1 from deal_memberships m join users u on u.id = m.user_id
                  where m.deal_id = v_deal and m.user_id = v_md and m.deal_role = 'md'
                    and u.status = 'active') then
    raise exception 'FAIL: create_deal_gate0 must give the actor an active md seat';
  end if;

  v_dt     := pg_temp.skip_user('step-skip-dt@example.com', v_tenant, v_bank);
  v_legal  := pg_temp.skip_user('step-skip-legal@example.com', v_tenant, v_bank);
  v_ro     := pg_temp.skip_user('step-skip-ro@example.com', v_tenant, v_bank);
  v_buyer  := pg_temp.skip_user('step-skip-buyer@example.com', v_tenant, v_bank);
  v_susp   := pg_temp.skip_user('step-skip-susp@example.com', v_tenant, v_bank);
  v_nobody := pg_temp.skip_user('step-skip-nobody@example.com', v_tenant, v_bank);
  v_other  := pg_temp.skip_user('step-skip-other@example.com', v_tenant, v_bank);
  perform pg_temp.skip_seat(v_deal, v_dt, 'deal_team');
  perform pg_temp.skip_seat(v_deal, v_legal, 'legal');
  perform pg_temp.skip_seat(v_deal, v_ro, 'read_only');
  perform pg_temp.skip_seat(v_deal, v_buyer, 'buyer');
  perform pg_temp.skip_seat(v_deal, v_susp, 'deal_team');
  update users set status = 'suspended' where id = v_susp;
  -- A tenant split: the user row moves to another tenant, the company and the seat
  -- stay. The seat alone is not a tenant boundary, so the approver is refused.
  v_split  := pg_temp.skip_user('step-skip-split@example.com', v_tenant, v_bank);
  perform pg_temp.skip_seat(v_deal, v_split, 'deal_team');
  update users set tenant_id = '00000000-0000-4000-8000-0000000000cd' where id = v_split;
  if not exists (select 1 from deal_memberships where deal_id = v_deal and user_id = v_split) then
    raise exception 'FAIL: fixture: a tenant change alone must leave the seat in place';
  end if;
  select coalesce(nullif(btrim(display_name), ''), nullif(btrim(full_name), ''), email)
    into v_name_dt from users where id = v_dt;
  select coalesce(nullif(btrim(display_name), ''), nullif(btrim(full_name), ''), email)
    into v_name_legal from users where id = v_legal;

  -- A seat on another deal of the same bank does not make an approver here.
  v_other_deal := (create_deal_gate0(
    p_tenant_id      => v_tenant,
    p_actor_id       => v_md,
    p_bank_id        => v_bank,
    p_codename       => 'Project Step Skip Other',
    p_target_name    => 'Other Target',
    p_entry_step_seq => 1,
    p_steps          => jsonb_build_array(
      jsonb_build_object('stepId','o-s1','seq',1,'phaseIndex',1,'displayOrder',1),
      jsonb_build_object('stepId','o-s2','seq',2,'phaseIndex',1,'displayOrder',2)
    ),
    p_census_version => 'test-1x2',
    p_conflicts      => jsonb_build_object('approvedBy','Avery Lindqvist','approvedOn','2026-09-01')
  )->'deal'->>'id')::uuid;
  perform pg_temp.skip_seat(v_other_deal, v_other, 'md');

  -- 1. Eligibility: an approver outside the rule is refused with 42501 and the
  --    step is left exactly as it was (no skip columns, no work.skip, no audit).
  select * into v_before from deal_steps where id = k1;
  for v_label, v_id in
    select t.label, t.id from (values
      ('read_only',               v_ro),
      ('buyer',                   v_buyer),
      ('suspended',               v_susp),
      ('no seat',                 v_nobody),
      ('seat on another deal',    v_other),
      ('other tenant',            v_split),
      ('unknown',                 gen_random_uuid()),
      ('null',                    null::uuid)
    ) as t(label, id)
  loop
    v_out := pg_temp.save_outcome(v_deal, k1, v_md,
      jsonb_build_object('status', 'skipped', 'skip_approver_id', v_id,
                         'skip_reason', 'Handled off platform'), null);
    if v_out is distinct from v_ineligible then
      raise exception 'FAIL: a % approver must be refused with "%", got %',
        v_label, v_ineligible, coalesce(v_out, 'an accepted call');
    end if;
  end loop;
  -- No id at all (neither skip_approver_id nor work.skip.approverId).
  v_out := pg_temp.save_outcome(v_deal, k1, v_md,
    jsonb_build_object('status', 'skipped', 'skip_reason', 'Handled off platform'), null);
  if v_out is distinct from v_ineligible then
    raise exception 'FAIL: a skip naming no approver must be refused, got %', coalesce(v_out, 'an accepted call');
  end if;
  -- The id of today's route (work.skip.approverId) is held to the same rule.
  v_out := pg_temp.save_outcome(v_deal, k1, v_md,
    jsonb_build_object('status', 'skipped', 'completion_note', 'Handled off platform',
                       'work', jsonb_build_object('skip', jsonb_build_object('approverId', v_ro))), null);
  if v_out is distinct from v_ineligible then
    raise exception 'FAIL: a read_only work.skip.approverId must be refused, got %', coalesce(v_out, 'an accepted call');
  end if;
  if (select to_jsonb(s) from deal_steps s where s.id = k1) is distinct from to_jsonb(v_before)
     or exists (select 1 from audit_log where deal_id = v_deal and detail->>'stepId' = 'k-s1') then
    raise exception 'FAIL: a refused skip must leave the step and the audit trail untouched';
  end if;

  -- 2. Input rules on a skip.
  --    (1) A blank reason is refused (P0001, rail_skip_step's text).
  v_out := pg_temp.save_outcome(v_deal, k1, v_md,
    jsonb_build_object('status', 'skipped', 'skip_approver_id', v_dt,
                       'skip_reason', '   ', 'completion_note', ''), null);
  if v_out is distinct from 'P0001 a skip reason is required' then
    raise exception 'FAIL: a blank skip reason must be refused with P0001, got %', coalesce(v_out, 'an accepted call');
  end if;
  v_out := pg_temp.save_outcome(v_deal, k1, v_md,
    jsonb_build_object('status', 'skipped', 'skip_approver_id', v_dt), null);
  if v_out is distinct from 'P0001 a skip reason is required' then
    raise exception 'FAIL: a skip with no reason must be refused with P0001, got %', coalesce(v_out, 'an accepted call');
  end if;
  --    (2) An id that is not a uuid is an ineligible approver, never a 22P02 cast error.
  v_out := pg_temp.save_outcome(v_deal, k1, v_md,
    jsonb_build_object('status', 'skipped', 'skip_approver_id', 'not-a-uuid',
                       'skip_reason', 'Handled off platform'), null);
  if v_out is distinct from v_ineligible then
    raise exception 'FAIL: a non-uuid skip_approver_id must be refused with 42501, got %', coalesce(v_out, 'an accepted call');
  end if;
  v_out := pg_temp.save_outcome(v_deal, k1, v_md,
    jsonb_build_object('status', 'skipped', 'completion_note', 'Handled off platform',
                       'work', jsonb_build_object('skip', jsonb_build_object('approverId', 'Free Text'))), null);
  if v_out is distinct from v_ineligible then
    raise exception 'FAIL: a non-uuid work.skip.approverId must be refused with 42501, got %', coalesce(v_out, 'an accepted call');
  end if;

  -- 3. An eligible approver, with everything else in the patch forged: the
  --    identity, the completion fields and the audit row are the database's.
  --    skip_approver_id wins over the forged work.skip.approverId (a read_only seat).
  v_out := pg_temp.save_outcome(v_deal, k2, v_md,
    jsonb_build_object(
      'status', 'skipped', 'updated_at', now(),
      'skip_approver_id', v_dt, 'skip_reason', '  Handled off platform  ',
      'skipped_by', v_dt, 'skipped_at', now() - interval '1 day',
      'completed_by', v_dt, 'completed_at', now() - interval '1 day', 'completion_note', 'Forged note',
      'work', jsonb_build_object('notes', 'kept',
                                 'skip', v_forged_skip || jsonb_build_object('approverId', v_ro))),
    jsonb_build_array(
      jsonb_build_object('action', 'advance', 'detail', jsonb_build_object(
        'kind', 'skip', 'stepId', 'k-s2', 'stepTitle', ' Board sign-off, approved by Someone Else (md) ', 'seq', 99,
        'approverId', v_ro, 'approver', 'Forged Name', 'approverRole', 'md', 'reason', 'Forged')),
      jsonb_build_object('action', 'step_work', 'detail', jsonb_build_object('stepId', 'k-s2'))));
  if v_out is not null then
    raise exception 'FAIL: a skip by an eligible approver was refused: %', v_out;
  end if;
  select * into v_row from deal_steps where id = k2;
  if v_row.status <> 'skipped'
     or v_row.skip_approver_id is distinct from v_dt
     or v_row.skipped_by is distinct from v_md
     or v_row.skipped_at is distinct from now()
     or v_row.skip_reason is distinct from 'Handled off platform' then
    raise exception 'FAIL: the skip_* columns must carry the approver, the actor, now() and the trimmed reason (%)',
      to_jsonb(v_row);
  end if;
  if v_row.completed_by is distinct from v_md
     or v_row.completed_at is distinct from now()
     or v_row.completion_note is distinct from 'Handled off platform' then
    raise exception 'FAIL: a skip must store the actor, now() and the reason as completed_*, not the patch (%)',
      to_jsonb(v_row);
  end if;
  v_skip := v_row.work->'skip';
  if v_row.work->>'notes' is distinct from 'kept'
     or v_skip->>'approverId' is distinct from v_dt::text
     or v_skip->>'approver' is distinct from v_name_dt
     or v_skip->>'approverRole' is distinct from 'deal_team'
     or v_skip->>'reason' is distinct from 'Handled off platform'
     or not coalesce(v_skip->>'at' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$', false)
     or (select count(*) from jsonb_object_keys(v_skip)) <> 5 then
    raise exception 'FAIL: work.skip must be {approverId, approver, approverRole, reason, at} from the SQL read, other work kept (%)',
      v_row.work;
  end if;
  if (select count(*) from audit_log
       where deal_id = v_deal and action = 'advance' and detail->>'kind' = 'skip'
         and detail->>'stepId' = 'k-s2') <> 1 then
    raise exception 'FAIL: a skip must write exactly one advance/kind:skip audit row';
  end if;
  select detail into v_detail from audit_log
   where deal_id = v_deal and action = 'advance' and detail->>'kind' = 'skip' and detail->>'stepId' = 'k-s2';
  if v_detail->>'approverId' is distinct from v_dt::text
     or v_detail->>'approver' is distinct from v_name_dt
     or v_detail->>'approverRole' is distinct from 'deal_team'
     or v_detail->>'reason' is distinct from 'Handled off platform'
     or (v_detail->>'seq')::int is distinct from 2
     -- k-s2 is a catalog step (no definition title): the row names the step key,
     -- never the caller's stepTitle.
     or v_detail->>'stepTitle' is distinct from 'k-s2'
     or (select actor_id from audit_log
          where deal_id = v_deal and detail = v_detail) is distinct from v_md then
    raise exception 'FAIL: the skip audit row must carry the SQL-read approver, the real seq and the actor (%)', v_detail;
  end if;
  if exists (select 1 from audit_log where deal_id = v_deal and detail::text like '%Forged%')
     or exists (select 1 from deal_steps where deal_id = v_deal and work::text like '%Forged%') then
    raise exception 'FAIL: caller-supplied identity must not reach the step or the audit trail';
  end if;
  if (select count(*) from audit_log
       where deal_id = v_deal and action = 'step_work' and detail->>'stepId' = 'k-s2') <> 1 then
    raise exception 'FAIL: the caller''s other audit rows must still be written';
  end if;

  -- 4. Today's route payload (R15): only work.skip.approverId, a completion_note
  --    for the reason, no skip_approver_id or skip_reason, and its own kind:skip
  --    audit row. It still works, with the approver and row built in SQL.
  v_out := pg_temp.save_outcome(v_deal, k3, v_md,
    jsonb_build_object(
      'updated_at', now(), 'status', 'skipped', 'completed_by', v_md, 'completed_at', now(),
      'completion_note', 'Covered by counsel',
      'work', jsonb_build_object('skip', jsonb_build_object(
        'approverId', v_legal, 'approver', 'Priya Mehta', 'approverRole', 'legal',
        'reason', 'Covered by counsel', 'at', now()))),
    jsonb_build_array(
      jsonb_build_object('action', 'advance', 'detail', jsonb_build_object(
        'kind', 'skip', 'stepId', 'k-s3', 'stepTitle', 'Legal review', 'seq', 3,
        'approverId', v_legal, 'approver', 'Priya Mehta', 'approverRole', 'legal',
        'reason', 'Covered by counsel'))));
  if v_out is not null then
    raise exception 'FAIL: the route''s current skip payload was refused: %', v_out;
  end if;
  select * into v_row from deal_steps where id = k3;
  if v_row.status <> 'skipped'
     or v_row.skip_approver_id is distinct from v_legal
     or v_row.skipped_by is distinct from v_md
     or v_row.skipped_at is null
     or v_row.skip_reason is distinct from 'Covered by counsel'
     or v_row.work->'skip'->>'approverId' is distinct from v_legal::text
     or v_row.work->'skip'->>'approver' is distinct from v_name_legal
     or v_row.work->'skip'->>'approverRole' is distinct from 'legal' then
    raise exception 'FAIL: the route''s skip payload must record the legal approver in the columns and work.skip (%)',
      to_jsonb(v_row);
  end if;
  if (select count(*) from audit_log
       where deal_id = v_deal and action = 'advance' and detail->>'kind' = 'skip'
         and detail->>'stepId' = 'k-s3' and detail->>'approverRole' = 'legal'
         and detail->>'approver' = v_name_legal
         and detail->>'approverId' = v_legal::text
         and detail->>'reason' = 'Covered by counsel'
         and detail->>'stepTitle' = 'k-s3') <> 1 then
    -- k-s3 is a catalog step (no definition title): the row names the step key, not
    -- the route's stepTitle, and the approver, role and reason are the SQL read's.
    raise exception 'FAIL: the route''s skip payload must leave one SQL-built advance/kind:skip row titled by the step key';
  end if;

  -- 5. The actor may approve their own skip (no four-eyes rule yet), the reason
  --    may come from completion_note alone, and the id is matched case-insensitively.
  v_out := pg_temp.save_outcome(v_deal, k4, v_md,
    jsonb_build_object('status', 'skipped', 'skip_approver_id', upper(v_md::text),
                       'completion_note', 'Self approved'), null);
  if v_out is not null then
    raise exception 'FAIL: the actor must be accepted as their own approver: %', v_out;
  end if;
  select * into v_row from deal_steps where id = k4;
  if v_row.skip_approver_id is distinct from v_md
     or v_row.skip_reason is distinct from 'Self approved'
     or v_row.completion_note is distinct from 'Self approved'
     or v_row.work->'skip'->>'approverRole' is distinct from 'md'
     or v_row.work->'skip'->>'reason' is distinct from 'Self approved' then
    raise exception 'FAIL: a self-approved skip must record the md seat and the reason (%)', to_jsonb(v_row);
  end if;
  -- No definition title: the row falls back to the step key.
  if (select detail->>'stepTitle' from audit_log
       where deal_id = v_deal and action = 'advance' and detail->>'kind' = 'skip'
         and detail->>'stepId' = 'k-s4') is distinct from 'k-s4' then
    raise exception 'FAIL: a skip without a definition title must fall back to the step key';
  end if;

  -- 6. A skip's audit row is written only by a skip. Outside a skip transition the
  --    skip columns keep their value, work.skip is the stored value, and a caller
  --    audit in either skip shape, under any action, is refused with 42501.
  v_out := pg_temp.save_outcome(v_deal, k5, v_md,
    jsonb_build_object('work', jsonb_build_object('notes', 'x', 'skip', v_forged_skip),
                       'skip_approver_id', 'not-a-uuid', 'skip_reason', 'Forged',
                       'skipped_by', v_dt, 'skipped_at', now()), null);
  if v_out is not null then
    raise exception 'FAIL: a work save carrying skip keys must be accepted and ignore them: %', v_out;
  end if;
  select * into v_row from deal_steps where id = k5;
  if v_row.skip_approver_id is not null or v_row.skipped_by is not null
     or v_row.skipped_at is not null or v_row.skip_reason is not null
     or v_row.work ? 'skip' or v_row.work->>'notes' is distinct from 'x' then
    raise exception 'FAIL: a non-skip patch must not write the skip columns or work.skip (%)', to_jsonb(v_row);
  end if;

  select * into v_before from deal_steps where id = k5;
  v_out := pg_temp.save_outcome(v_deal, k5, v_md,
    jsonb_build_object('work', jsonb_build_object('notes', 'y')),
    jsonb_build_array(jsonb_build_object('action', 'advance', 'detail', jsonb_build_object(
      'kind', 'skip', 'stepId', 'k-s5', 'approver', 'Forged Name', 'reason', 'Forged'))));
  if v_out is distinct from v_no_skip then
    raise exception 'FAIL: an advance/kind:skip audit without a skip must be refused with "%", got %',
      v_no_skip, coalesce(v_out, 'an accepted call');
  end if;
  v_out := pg_temp.save_outcome(v_deal, k5, v_md,
    jsonb_build_object('work', jsonb_build_object('notes', 'y')),
    jsonb_build_array(jsonb_build_object('action', 'update', 'detail', jsonb_build_object(
      'rail', 'skip', 'stepId', 'k-s5', 'approver', v_ro, 'reason', 'Forged'))));
  if v_out is distinct from v_no_skip then
    raise exception 'FAIL: an update/rail:skip audit without a skip must be refused with "%", got %',
      v_no_skip, coalesce(v_out, 'an accepted call');
  end if;
  v_out := pg_temp.save_outcome(v_deal, k5, v_md,
    jsonb_build_object('work', jsonb_build_object('notes', 'y')),
    jsonb_build_array(jsonb_build_object('action', 'step_work', 'detail', jsonb_build_object(
      'kind', 'skip', 'stepId', 'k-s5'))));
  if v_out is distinct from v_no_skip then
    raise exception 'FAIL: a kind:skip audit under another action must be refused with "%", got %',
      v_no_skip, coalesce(v_out, 'an accepted call');
  end if;
  if (select to_jsonb(s) from deal_steps s where s.id = k5) is distinct from to_jsonb(v_before)
     or exists (select 1 from audit_log where deal_id = v_deal and detail->>'stepId' = 'k-s5') then
    raise exception 'FAIL: a refused skip audit must leave the step and the audit trail untouched';
  end if;

  -- 7. A skipped step keeps its record through later work saves, forged or echoed
  --    (closed steps still accept work edits), and through a work reset.
  v_stored := (select work->'skip' from deal_steps where id = k2);
  v_out := pg_temp.save_outcome(v_deal, k2, v_md,
    jsonb_build_object('work', jsonb_build_object('notes', 'later', 'skip', v_forged_skip)), null);
  if v_out is not null then
    raise exception 'FAIL: a work save on a skipped step must be accepted: %', v_out;
  end if;
  select * into v_row from deal_steps where id = k2;
  if v_row.work->'skip' is distinct from v_stored or v_row.work->>'notes' is distinct from 'later' then
    raise exception 'FAIL: a work save must keep the stored work.skip and write the rest (%)', v_row.work;
  end if;
  v_out := pg_temp.save_outcome(v_deal, k2, v_md, '{"work": null}'::jsonb, null);
  if v_out is not null then
    raise exception 'FAIL: a work reset on a skipped step must not fail: %', v_out;
  end if;
  if (select work->'skip' from deal_steps where id = k2) is distinct from v_stored then
    raise exception 'FAIL: a work reset must keep the stored work.skip';
  end if;
  --    A non-skip save on a step with no stored skip keeps a non-object work as it
  --    is, as before #312: only a skip normalises it to an object.
  v_out := pg_temp.save_outcome(v_deal, k1, v_md, '{"work": ["kept"]}'::jsonb, null);
  if v_out is not null then
    raise exception 'FAIL: a non-skip save of a non-object work must be accepted: %', v_out;
  end if;
  if (select work from deal_steps where id = k1) is distinct from '["kept"]'::jsonb then
    raise exception 'FAIL: a non-skip save must keep a non-object work unchanged, got %',
      (select work from deal_steps where id = k1);
  end if;

  -- 8. On a skip a caller's rail-shape audit is dropped too, and the one
  --    SQL-built row is the only skip row.
  v_out := pg_temp.save_outcome(v_deal, k6, v_md,
    jsonb_build_object('status', 'skipped', 'skip_approver_id', v_dt, 'skip_reason', 'Handled off platform'),
    jsonb_build_array(
      jsonb_build_object('action', 'update', 'detail', jsonb_build_object(
        'rail', 'skip', 'stepId', 'k-s6', 'approver', v_ro, 'reason', 'Forged')),
      jsonb_build_object('action', 'advance', 'detail', jsonb_build_object(
        'kind', 'skip', 'stepId', 'k-s6', 'approver', 'Forged Name',
        'stepTitle', repeat('x', 300)))));
  if v_out is not null then
    raise exception 'FAIL: a skip carrying skip-shaped audits was refused: %', v_out;
  end if;
  if exists (select 1 from audit_log where deal_id = v_deal and detail->>'rail' = 'skip')
     or (select count(*) from audit_log
          where deal_id = v_deal and detail->>'stepId' = 'k-s6') <> 1
     or not exists (select 1 from audit_log
                     where deal_id = v_deal and action = 'advance' and detail->>'kind' = 'skip'
                       and detail->>'stepId' = 'k-s6' and detail->>'approverId' = v_dt::text
                       and detail->>'approver' = v_name_dt) then
    raise exception 'FAIL: on a skip the caller''s skip audits must be dropped and one SQL-built row written';
  end if;
  -- The caller's stepTitle (300 characters here) never reaches the row.
  if (select detail->>'stepTitle' from audit_log
       where deal_id = v_deal and action = 'advance' and detail->>'kind' = 'skip'
         and detail->>'stepId' = 'k-s6') is distinct from 'k-s6' then
    raise exception 'FAIL: the skip audit row must name the step key, never the caller''s stepTitle';
  end if;

  -- 9. A closed step is still refused a second skip (P0409), before the approver
  --    check, and nothing stacks a second record.
  v_out := pg_temp.save_outcome(v_deal, k6, v_md,
    jsonb_build_object('status', 'skipped', 'skip_approver_id', v_dt, 'skip_reason', 'Twice'), null);
  if v_out is distinct from 'P0409 step_changed' then
    raise exception 'FAIL: skipping a skipped step must be refused with P0409, got %', coalesce(v_out, 'an accepted call');
  end if;
  if (select count(*) from audit_log
       where deal_id = v_deal and detail->>'kind' = 'skip' and detail->>'stepId' = 'k-s6') <> 1 then
    raise exception 'FAIL: a refused second skip must not stack a second audit row';
  end if;
end $$;

rollback;
