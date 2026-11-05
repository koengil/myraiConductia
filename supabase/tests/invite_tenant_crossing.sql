-- Transactional probe for the firm-admin tenant crossing (#248). An admin may
-- send the owner invite into a brand-new organization's tenant, and nothing
-- else: never a deal invite, never into a tenant someone has already joined.
-- Run with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/invite_tenant_crossing.sql

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

do $$
declare
  v_tenant_a uuid := gen_random_uuid();
  v_tenant_b uuid := gen_random_uuid();
  v_tenant_new uuid := gen_random_uuid();
  v_bank_a uuid := gen_random_uuid();
  v_bank_b uuid := gen_random_uuid();
  v_bank_new uuid := gen_random_uuid();
  v_deal_b uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_staff_b uuid := gen_random_uuid();
  v_confirmation uuid;
  v_result jsonb;
  v_blocked boolean;
  v_digest text := repeat('a', 64);
begin
  insert into companies (id, tenant_id, name, type) values
    (v_bank_a, v_tenant_a, 'Crossing Bank A ' || v_bank_a::text, 'bank'),
    (v_bank_b, v_tenant_b, 'Crossing Bank B ' || v_bank_b::text, 'bank'),
    (v_bank_new, v_tenant_new, 'Crossing Bank New ' || v_bank_new::text, 'bank');
  insert into auth.users (id, email, raw_user_meta_data) values
    (v_admin, 'crossing-admin-' || v_admin::text || '@a.example.test',
      jsonb_build_object('full_name','Crossing Admin','department','ib','tenant_id',v_tenant_a)),
    (v_staff_b, 'crossing-staff-' || v_staff_b::text || '@b.example.test',
      jsonb_build_object('full_name','Crossing Staff','department','ib','tenant_id',v_tenant_b));
  -- No company_id, so the company director invariant stays out of the way.
  update users set tenant_id = v_tenant_a, firm_role = 'admin', status = 'active'
   where id = v_admin;
  update users set tenant_id = v_tenant_b, company_id = v_bank_b, company_role = 'director', status = 'active'
   where id = v_staff_b;
  insert into deals (id, tenant_id, code, codename, bank_id, mandate_owner_id)
    values (v_deal_b, v_tenant_b, 'XT-' || left(v_deal_b::text, 8), 'Project Crossing', v_bank_b, v_staff_b);

  -- 1. An admin of firm A cannot invite onto firm B's deal.
  v_blocked := false;
  begin
    perform create_invite(
      p_actor => v_admin, p_email => 'mole@a.example.test', p_company_id => v_bank_b,
      p_company_role => 'member', p_challenge_digest => v_digest,
      p_deal_id => v_deal_b, p_deal_role => 'deal_team'
    );
  exception when others then v_blocked := sqlerrm = 'tenant_mismatch';
  end;
  if not v_blocked then raise exception 'FAIL: admin invited across tenants onto a deal'; end if;

  v_blocked := false;
  begin
    insert into invite_domain_confirmations (actor_id, email, company_id, company_role, classification, deal_id)
      values (v_admin, 'mole@a.example.test', v_bank_b, 'member', 'mismatch', v_deal_b);
  exception when others then v_blocked := sqlerrm = 'tenant_mismatch';
  end;
  if not v_blocked then raise exception 'FAIL: admin prepared a cross-tenant deal confirmation'; end if;

  -- 2. Nor into firm B at company level: firm B already has members.
  v_blocked := false;
  begin
    perform create_invite(
      p_actor => v_admin, p_email => 'mole@a.example.test', p_company_id => v_bank_b,
      p_company_role => 'member', p_challenge_digest => v_digest
    );
  exception when others then v_blocked := sqlerrm = 'tenant_mismatch';
  end;
  if not v_blocked then raise exception 'FAIL: admin invited into a provisioned tenant'; end if;

  -- 3. The owner invite into a brand-new organization still works.
  insert into invite_domain_confirmations (actor_id, email, company_id, company_role, classification)
    values (v_admin, 'owner@new.example.test', v_bank_new, 'director', 'mismatch')
    returning id into v_confirmation;
  v_result := create_invite(
    p_actor => v_admin, p_email => 'owner@new.example.test', p_company_id => v_bank_new,
    p_company_role => 'director', p_challenge_digest => v_digest,
    p_domain_confirmation_id => v_confirmation
  );
  if (v_result->>'tenant_id')::uuid is distinct from v_tenant_new then
    raise exception 'FAIL: provisioning invite did not land in the new tenant';
  end if;
end;
$$;

rollback;
