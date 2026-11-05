-- supabase/tests/create_deal_gate0.sql
-- Verifies the G5 transactional Gate 0 create (Issue #71). Run via psql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/create_deal_gate0.sql
-- Wrapped in a transaction that always ROLLBACKs: leaves no test data behind.

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

-- The app calls create_deal_gate0 through the service-role admin client. The
-- company-access helpers it relies on (app_company_is_access_root,
-- app_company_effective_permissions) check auth.role()/auth.uid(), which are
-- null in a plain psql session, so mirror the real caller for this transaction.
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  v_tenant   uuid := '00000000-0000-4000-8000-000000000005';
  v_bank     uuid := gen_random_uuid();
  v_md       uuid := gen_random_uuid();
  v_member   uuid := gen_random_uuid();
  v_cco      uuid := gen_random_uuid();
  v_research uuid := gen_random_uuid();
  v_target1  uuid;
  v_target2  uuid;
  v_res      jsonb;
  v_deal     uuid;
  v_cnt      int;
  v_blocked  boolean;
begin
  -- Actors (mirrored into public.users by the auth trigger via raw_user_meta_data).
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_md,       'g5-md@example.com',       jsonb_build_object('full_name','Storm Duncan','department','ib','tenant_id',v_tenant)),
    (v_member,   'g5-member@example.com',   jsonb_build_object('full_name','James Watt','department','ib','tenant_id',v_tenant)),
    (v_cco,      'g5-cco@example.com',      jsonb_build_object('full_name','Cora Vance','firm_role','cco','department','compliance','tenant_id',v_tenant)),
    (v_research, 'g5-research@example.com', jsonb_build_object('full_name','Rhea Search','department','research','tenant_id',v_tenant));

  insert into companies (id, tenant_id, name, type)
    values (v_bank, v_tenant, 'G5 Test Bank', 'bank');

  -- Finding 14: create_deal_gate0 requires company:deals:create on the bank.
  -- The MD actor is the bank's director: an access root (holds every key) and
  -- the director the company invariant demands before any member can join.
  update users set company_id = v_bank, company_role = 'director', is_external = false, status = 'active'
    where id = v_md;

  -- ── Happy path ────────────────────────────────────────────────────────────
  v_res := create_deal_gate0(
    p_tenant_id      => v_tenant,
    p_actor_id       => v_md,
    p_bank_id        => v_bank,
    p_codename       => 'Project Falcon',
    p_target_name    => 'Canva',
    p_codename_theme => 'birds',
    p_entry_step_seq => 12,
    p_entry_phase    => 2,
    p_members        => jsonb_build_array(jsonb_build_object('userId', v_member, 'dealRole', 'deal_team')),
    p_screening      => jsonb_build_object('verdict', 'clear', 'reasons', '[]'::jsonb),
    p_conflicts      => jsonb_build_object('approvedBy', 'Avery Lindqvist', 'approvedOn', '2026-07-20')
  );
  v_deal := (v_res->'deal'->>'id')::uuid;

  -- Conflicts attestation persisted on the deal (approver + date, not a boolean).
  select count(*) into v_cnt from deals
    where id = v_deal
      and conflicts_approved_by = 'Avery Lindqvist'
      and conflicts_approved_on = date '2026-07-20';
  if v_cnt <> 1 then raise exception 'FAIL: conflicts attestation not persisted on the deal'; end if;

  if (v_res->'deal'->>'currentStepSeq')::int <> 12 then
    raise exception 'FAIL: current step seq not seeded from entry (got %)', v_res->'deal'->>'currentStepSeq';
  end if;

  -- Target created once.
  select count(*) into v_cnt from deal_parties where deal_id = v_deal and party_role = 'target';
  if v_cnt <> 1 then raise exception 'FAIL: expected 1 target party, found %', v_cnt; end if;
  select company_id into v_target1 from deal_parties where deal_id = v_deal and party_role = 'target';

  -- Two memberships: MD + member, both at the entering phase.
  select count(*) into v_cnt from deal_memberships where deal_id = v_deal;
  if v_cnt <> 2 then raise exception 'FAIL: expected 2 memberships, found %', v_cnt; end if;
  select count(*) into v_cnt from deal_memberships where deal_id = v_deal and phase = 2;
  if v_cnt <> 2 then raise exception 'FAIL: expected both seats at phase 2, found %', v_cnt; end if;
  select count(*) into v_cnt from deal_memberships where deal_id = v_deal and deal_role = 'md';
  if v_cnt <> 1 then raise exception 'FAIL: expected exactly 1 MD seat, found %', v_cnt; end if;

  -- One CCO notification; payload masks the target (code name only, no "Canva").
  select count(*) into v_cnt from notifications
    where deal_id = v_deal and event_type = 'deal_created' and recipient_id = v_cco;
  if v_cnt <> 1 then raise exception 'FAIL: expected 1 CCO notification, found %', v_cnt; end if;
  select count(*) into v_cnt from notifications
    where deal_id = v_deal and payload::text ilike '%canva%';
  if v_cnt <> 0 then raise exception 'FAIL: COMPLIANCE — target name leaked into a notification payload'; end if;

  -- Audit rows: 1 create + 2 grant + 2 notify + 1 attest. Two notify rows
  -- because the bank now has two recipients: the CCO and the director (the MD
  -- actor, who directors-as-recipients includes even when they created the deal).
  select count(*) into v_cnt from audit_log where deal_id = v_deal and action = 'create';
  if v_cnt <> 1 then raise exception 'FAIL: expected 1 create audit row, found %', v_cnt; end if;
  select count(*) into v_cnt from audit_log where deal_id = v_deal and action = 'grant';
  if v_cnt <> 2 then raise exception 'FAIL: expected 2 grant audit rows, found %', v_cnt; end if;
  select count(*) into v_cnt from audit_log where deal_id = v_deal and action = 'notify';
  if v_cnt <> 2 then raise exception 'FAIL: expected 2 notify audit rows (CCO + director), found %', v_cnt; end if;
  select count(*) into v_cnt from audit_log
    where deal_id = v_deal and action = 'attest'
      and detail->>'checklist' = 'conflicts'
      and detail->>'approved_by' = 'Avery Lindqvist';
  if v_cnt <> 1 then raise exception 'FAIL: expected 1 attest audit row, found %', v_cnt; end if;

  -- ── Target dedupe: a second deal on the same target reuses the company row ──
  v_res := create_deal_gate0(
    p_tenant_id   => v_tenant,
    p_actor_id    => v_md,
    p_bank_id     => v_bank,
    p_codename    => 'Project Osprey',
    p_target_name => 'canva',  -- different case, same target
    p_conflicts   => jsonb_build_object('approvedBy', 'Avery Lindqvist', 'approvedOn', '2026-07-20')
  );
  select company_id into v_target2
    from deal_parties where deal_id = (v_res->'deal'->>'id')::uuid and party_role = 'target';
  if v_target1 <> v_target2 then
    raise exception 'FAIL: target was duplicated instead of deduped (% vs %)', v_target1, v_target2;
  end if;

  -- ── Atomicity: a research-dept member must abort the whole create ───────────
  v_blocked := false;
  begin
    perform create_deal_gate0(
      p_tenant_id   => v_tenant,
      p_actor_id    => v_md,
      p_bank_id     => v_bank,
      p_codename    => 'Project Raven',
      p_target_name => 'Notion',
      p_members     => jsonb_build_array(jsonb_build_object('userId', v_research, 'dealRole', 'deal_team')),
      p_conflicts   => jsonb_build_object('approvedBy', 'Avery Lindqvist', 'approvedOn', '2026-07-20')
    );
  exception when others then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL: wall-breach member did not abort the create';
  end if;
  -- Nothing from the aborted create persisted (all-or-nothing).
  select count(*) into v_cnt from deals where tenant_id = v_tenant and codename = 'Project Raven';
  if v_cnt <> 0 then raise exception 'FAIL: partial deal persisted after wall-breach rollback (% rows)', v_cnt; end if;

  -- ── G19: a target company id from ANOTHER tenant must be rejected ───────────
  -- v_target1 belongs to v_tenant; attempting to use it from a different tenant
  -- must raise (never silently attach a cross-tenant target).
  v_blocked := false;
  begin
    perform create_deal_gate0(
      p_tenant_id        => '00000000-0000-4000-8000-0000000000ff',
      p_actor_id         => v_md,
      p_bank_id          => v_bank,
      p_codename         => 'Project Osprey X',
      p_target_company_id => v_target1,
      p_conflicts        => jsonb_build_object('approvedBy', 'Avery Lindqvist', 'approvedOn', '2026-07-20')
    );
  exception when others then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL: cross-tenant targetCompanyId was accepted';
  end if;

  -- ── Conflicts gate: a create WITHOUT the attestation must not exist ─────────
  v_blocked := false;
  begin
    perform create_deal_gate0(
      p_tenant_id   => v_tenant,
      p_actor_id    => v_md,
      p_bank_id     => v_bank,
      p_codename    => 'Project Kestrel',
      p_target_name => 'Figma'
    );
  exception when others then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'FAIL: create without a conflicts attestation was accepted';
  end if;
  select count(*) into v_cnt from deals where tenant_id = v_tenant and codename = 'Project Kestrel';
  if v_cnt <> 0 then raise exception 'FAIL: unattested deal persisted (% rows)', v_cnt; end if;

  -- ── Empty notify set: no CCO/admin/director/grant must fail create ─────────
  declare
    v_empty_tenant uuid := '00000000-0000-4000-8000-0000000000aa';
    v_empty_bank   uuid := gen_random_uuid();
    v_lonely       uuid := gen_random_uuid();
  begin
    insert into auth.users (id, email, raw_user_meta_data) values
      (v_lonely, 'g5-lonely@example.com',
        jsonb_build_object('full_name','Lonely Member','department','ib','tenant_id',v_empty_tenant));
    insert into companies (id, tenant_id, name, type)
      values (v_empty_bank, v_empty_tenant, 'Empty Notify Bank', 'bank');
    -- Unattached to the bank on purpose: the company invariant (an active
    -- member implies an active director) makes "a member of a bank with no
    -- notify recipient" impossible, and a director would itself be a recipient.
    -- The notify gate runs before the Create deals gate, so this still proves it.
    update users
      set tenant_id = v_empty_tenant, company_id = null,
          company_role = null, firm_role = null, is_external = false, status = 'active'
      where id = v_lonely;

    v_blocked := false;
    begin
      perform create_deal_gate0(
        p_tenant_id   => v_empty_tenant,
        p_actor_id    => v_lonely,
        p_bank_id     => v_empty_bank,
        p_codename    => 'Project Empty',
        p_target_name => 'Notion',
        p_conflicts   => jsonb_build_object('approvedBy', 'Avery Lindqvist', 'approvedOn', '2026-07-20')
      );
    exception when others then
      if sqlerrm not ilike '%no gate0 notify recipient%' then
        raise exception 'FAIL: expected empty-recipient error, got %', sqlerrm;
      end if;
      v_blocked := true;
    end;
    if not v_blocked then
      raise exception 'FAIL: create with no notify recipient was accepted';
    end if;
    select count(*) into v_cnt from deals where tenant_id = v_empty_tenant and codename = 'Project Empty';
    if v_cnt <> 0 then raise exception 'FAIL: unnotifiable deal persisted (% rows)', v_cnt; end if;
  end;

  -- ── Finding 14: a bank member WITHOUT Create deals is refused ─────────────
  declare
    v_plain uuid := gen_random_uuid();
  begin
    insert into auth.users (id, email, raw_user_meta_data) values
      (v_plain, 'g5-plain@example.com',
        jsonb_build_object('full_name','Plain Member','department','ib','tenant_id',v_tenant));
    update users
      set company_id = v_bank, company_role = 'member', firm_role = null, is_external = false, status = 'active'
      where id = v_plain;

    v_blocked := false;
    begin
      perform create_deal_gate0(
        p_tenant_id   => v_tenant,
        p_actor_id    => v_plain,
        p_bank_id     => v_bank,
        p_codename    => 'Project Unpermitted',
        p_target_name => 'Vercel',
        p_conflicts   => jsonb_build_object('approvedBy', 'Avery Lindqvist', 'approvedOn', '2026-07-20')
      );
    exception when others then
      if sqlerrm not ilike '%not permitted to create deals%' then
        raise exception 'FAIL: expected the Create deals refusal, got %', sqlerrm;
      end if;
      v_blocked := true;
    end;
    if not v_blocked then
      raise exception 'FAIL: a member without Create deals opened a mandate';
    end if;
    select count(*) into v_cnt from deals where tenant_id = v_tenant and codename = 'Project Unpermitted';
    if v_cnt <> 0 then raise exception 'FAIL: unpermitted deal persisted (% rows)', v_cnt; end if;

    -- A direct grant is enough: the same member now creates. Direct grants hang
    -- off the member's access seat (company_member_access), which the app's
    -- replace_company_member_access creates on the first assignment.
    insert into company_member_access (company_id, user_id) values (v_bank, v_plain);
    insert into company_member_permissions (company_id, user_id, permission_key, granted_by)
      values (v_bank, v_plain, 'company:deals:create', v_md);
    v_res := create_deal_gate0(
      p_tenant_id   => v_tenant,
      p_actor_id    => v_plain,
      p_bank_id     => v_bank,
      p_codename    => 'Project Permitted',
      p_target_name => 'Vercel',
      p_conflicts   => jsonb_build_object('approvedBy', 'Avery Lindqvist', 'approvedOn', '2026-07-20')
    );
    if (v_res->'deal'->>'codename') <> 'Project Permitted' then
      raise exception 'FAIL: granted member could not create (got %)', v_res->'deal'->>'codename';
    end if;
  end;

  -- ── Director-only bank (no CCO): the director receives the notice ──────────
  declare
    v_dir_tenant uuid := '00000000-0000-4000-8000-0000000000bb';
    v_dir_bank   uuid := gen_random_uuid();
    v_director   uuid := gen_random_uuid();
    v_dir_deal   uuid;
  begin
    insert into auth.users (id, email, raw_user_meta_data) values
      (v_director, 'g5-director@example.com',
        jsonb_build_object('full_name','Drew Director','department','ib','tenant_id',v_dir_tenant));
    insert into companies (id, tenant_id, name, type)
      values (v_dir_bank, v_dir_tenant, 'Director Notify Bank', 'bank');
    update users
      set tenant_id = v_dir_tenant, company_id = v_dir_bank,
          company_role = 'director', firm_role = null, is_external = false, status = 'active'
      where id = v_director;

    v_res := create_deal_gate0(
      p_tenant_id   => v_dir_tenant,
      p_actor_id    => v_director,
      p_bank_id     => v_dir_bank,
      p_codename    => 'Project Director',
      p_target_name => 'Linear',
      p_conflicts   => jsonb_build_object('approvedBy', 'Avery Lindqvist', 'approvedOn', '2026-07-20')
    );
    v_dir_deal := (v_res->'deal'->>'id')::uuid;
    select count(*) into v_cnt from notifications
      where deal_id = v_dir_deal and event_type = 'deal_created' and recipient_id = v_director;
    if v_cnt <> 1 then
      raise exception 'FAIL: expected the bank director to be notified, found %', v_cnt;
    end if;
  end;

  raise notice 'PASS: gate0 create is transactional — dedupes target, seats MD + members at entry phase, notifies eligible recipients (masked), audits create/grant/notify/attest, persists the conflicts attestation, rejects a cross-tenant target, an unattested create, an empty notify set, and an actor without Create deals (Finding 14), and rolls back wholesale on a wall breach';
end $$;

rollback;
