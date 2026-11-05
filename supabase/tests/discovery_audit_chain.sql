-- supabase/tests/discovery_audit_chain.sql
-- Verifies the per-tenant audit_log hash chain (20260925100000_audit_hash_chain.sql).
-- Run via psql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/discovery_audit_chain.sql
-- Wrapped in a transaction that always ROLLBACKs: leaves no test data behind.
-- Raises (and, with ON_ERROR_STOP, exits non-zero) if any guarantee is violated.

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
  v_system  constant uuid := '00000000-0000-0000-0000-000000000000';
  v_t1      uuid := gen_random_uuid();
  v_t2      uuid := gen_random_uuid();
  v_actor   uuid := gen_random_uuid();
  v_company uuid := gen_random_uuid();
  v_deal    uuid := gen_random_uuid();
  v_actor_tenant uuid;
  v_row     audit_log%rowtype;
  v_prev    audit_log%rowtype;
  v_id      uuid;
  v_cnt     int;
  v_seq     bigint;
  v_tail    bytea;
  v_blocked boolean;
  v_state   text;
begin
  insert into auth.users (id, email) values (v_actor, 'audit-chain-test@example.com');
  select tenant_id into v_actor_tenant from users where id = v_actor;

  insert into companies (id, tenant_id, name, type) values (v_company, v_t1, 'Audit Chain Test Bank', 'bank');
  insert into deals (id, tenant_id, code, codename, bank_id)
    values (v_deal, v_t1, 'CHAIN-' || left(v_deal::text, 8), 'Project Chain Test', v_company);

  -- 1. Continuity. Three rows on the deal chain under the deal's tenant (not
  --    the actor's), from genesis, each linked to the one before.
  insert into audit_log (actor_id, action, deal_id, detail) values (v_actor, 'view', v_deal, '{"n": 1}');
  insert into audit_log (actor_id, action, deal_id, detail)
    values (v_actor, 'update', v_deal, '{"n": 2}'), (v_actor, 'advance', v_deal, '{"n": 3}');

  select count(*) into v_cnt from audit_log where tenant_id = v_t1;
  if v_cnt <> 3 then raise exception 'FAIL: expected 3 rows in the deal tenant, found %', v_cnt; end if;

  for v_row in select * from audit_log where tenant_id = v_t1 order by chain_seq loop
    if v_row.actor_type <> 'user' then
      raise exception 'FAIL: actor row got actor_type %', v_row.actor_type;
    end if;
    if v_row.chain_seq = 1 then
      if v_row.prev_hash is not null then raise exception 'FAIL: genesis row has a prev_hash'; end if;
    else
      if v_row.chain_seq <> v_prev.chain_seq + 1 then
        raise exception 'FAIL: chain_seq % follows %', v_row.chain_seq, v_prev.chain_seq;
      end if;
      if v_row.prev_hash is distinct from v_prev.hash then
        raise exception 'FAIL: chain_seq % does not link to its predecessor', v_row.chain_seq;
      end if;
    end if;
    if v_row.hash is distinct from
       sha256(coalesce(v_row.prev_hash, ''::bytea) || convert_to(audit_canonical_row(v_row), 'UTF8')) then
      raise exception 'FAIL: chain_seq % hash does not recompute', v_row.chain_seq;
    end if;
    v_prev := v_row;
  end loop;
  if v_prev.chain_seq <> 3 then raise exception 'FAIL: chain ends at %, expected 3', v_prev.chain_seq; end if;

  -- 2. Genesis per tenant: an explicit second tenant starts its own chain.
  insert into audit_log (service_identity, action, tenant_id, detail)
    values ('conductia', 'view', v_t2, '{}') returning * into v_row;
  if v_row.chain_seq <> 1 or v_row.prev_hash is not null or v_row.actor_type <> 'service' then
    raise exception 'FAIL: second tenant did not start at genesis (seq %, service %)', v_row.chain_seq, v_row.actor_type;
  end if;
  select max(chain_seq) into v_seq from audit_log where tenant_id = v_t1;
  if v_seq <> 3 then raise exception 'FAIL: another tenant''s insert moved the deal tenant''s chain'; end if;

  -- 3. No deal: the actor's tenant, continuing that tenant's tail.
  select max(chain_seq), (array_agg(hash order by chain_seq desc))[1]
    into v_seq, v_tail from audit_log where tenant_id = v_actor_tenant and chain_seq is not null;
  insert into audit_log (actor_id, action) values (v_actor, 'mfa_enrolled') returning * into v_row;
  if v_row.tenant_id <> v_actor_tenant then
    raise exception 'FAIL: actor-only row resolved to %, expected the actor tenant %', v_row.tenant_id, v_actor_tenant;
  end if;
  if v_row.chain_seq <> coalesce(v_seq, 0) + 1 or v_row.prev_hash is distinct from v_tail then
    raise exception 'FAIL: actor-only row does not continue its tenant chain';
  end if;

  -- 4. Legacy shape (a service row with neither actor nor deal, as
  --    skill_publication.admission_denied writes): the nil-UUID system tenant.
  select max(chain_seq), (array_agg(hash order by chain_seq desc))[1]
    into v_seq, v_tail from audit_log where tenant_id = v_system and chain_seq is not null;
  insert into audit_log (service_identity, action, detail)
    values ('conductia', 'skill_publication.admission_denied', '{"reasonCode": "test"}') returning * into v_row;
  if v_row.tenant_id <> v_system then
    raise exception 'FAIL: unresolvable row went to %, expected the system tenant', v_row.tenant_id;
  end if;
  if v_row.chain_seq <> coalesce(v_seq, 0) + 1 or v_row.prev_hash is distinct from v_tail then
    raise exception 'FAIL: system-tenant row does not continue the system chain';
  end if;

  -- An existing SQL writer is unchanged and chained: skill_authoring_write_audit
  -- with no actor writes a service row, and the deal gives it its tenant.
  perform skill_authoring_write_audit(null, 'rail.step_rebound', v_deal, '{"source": "test"}');
  select * into v_row from audit_log where tenant_id = v_t1 order by chain_seq desc limit 1;
  if v_row.chain_seq <> 4 or v_row.action <> 'rail.step_rebound' or v_row.actor_type <> 'service' then
    raise exception 'FAIL: skill_authoring_write_audit row not chained under the deal tenant';
  end if;

  -- 5. A discovery row without tenant_id raises, even when its deal would
  --    resolve one. With tenant_id it is accepted.
  v_blocked := false;
  begin
    insert into audit_log (actor_id, action, deal_id) values (v_actor, 'discovery.correction', v_deal);
  exception when not_null_violation then
    v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL: discovery row without tenant_id was accepted'; end if;

  insert into audit_log (service_identity, action, tenant_id, detail)
    values ('conductia', 'discovery.candidate_proposed', v_t1, '{"candidateId": "c1"}') returning * into v_row;
  if v_row.chain_seq <> 5 then raise exception 'FAIL: discovery row chain_seq %, expected 5', v_row.chain_seq; end if;

  -- 6. A tenant_id that contradicts the deal's tenant raises.
  v_blocked := false;
  begin
    insert into audit_log (actor_id, action, deal_id, tenant_id) values (v_actor, 'view', v_deal, v_t2);
  exception when check_violation then
    v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL: a tenant_id contradicting the deal was accepted'; end if;

  --    The deal wins over the actor: the deal's tenant is accepted although
  --    the actor belongs to another tenant, and the actor is not checked.
  if v_actor_tenant = v_t1 then raise exception 'FAIL: fixture actor shares the deal tenant'; end if;
  insert into audit_log (actor_id, action, deal_id, tenant_id)
    values (v_actor, 'view', v_deal, v_t1) returning * into v_row;
  if v_row.tenant_id <> v_t1 or v_row.chain_seq <> 6 then
    raise exception 'FAIL: deal tenant over a foreign actor not accepted (tenant %, seq %)', v_row.tenant_id, v_row.chain_seq;
  end if;

  --    With no deal, a supplied tenant_id must be the actor's own tenant.
  v_blocked := false;
  begin
    insert into audit_log (actor_id, action, tenant_id) values (v_actor, 'view', v_t2);
  exception when check_violation then
    v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL: a tenant_id contradicting the actor was accepted'; end if;

  insert into audit_log (actor_id, action, tenant_id) values (v_actor, 'view', v_actor_tenant)
    returning * into v_row;
  if v_row.tenant_id <> v_actor_tenant then
    raise exception 'FAIL: the actor''s own tenant was not accepted';
  end if;

  -- 7. Actor types. A model row needs the model gateway identity.
  insert into audit_log (service_identity, action, tenant_id, actor_type, detail)
    values ('model-gateway', 'discovery.milestone_extracted', v_t1, 'model', '{"modelCallId": "m1"}')
    returning * into v_row;
  if v_row.actor_type <> 'model' or v_row.chain_seq <> 7 then
    raise exception 'FAIL: model row not accepted as written';
  end if;

  v_blocked := false;
  begin
    insert into audit_log (service_identity, action, tenant_id, actor_type)
      values ('conductia', 'discovery.stage_assessed', v_t1, 'model');
  exception when check_violation then
    v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL: a model row without the model gateway identity was accepted'; end if;

  v_blocked := false;
  begin
    insert into audit_log (service_identity, action, tenant_id, actor_type)
      values ('conductia', 'view', v_t1, 'robot');
  exception when check_violation then
    v_blocked := true;
  end;
  if not v_blocked then raise exception 'FAIL: an unknown actor_type was accepted'; end if;

  --    actor_type agrees with the actor columns: a user row names its user,
  --    a service or model row names none.
  v_cnt := 0;
  begin
    insert into audit_log (service_identity, action, tenant_id, actor_type)
      values ('conductia', 'view', v_t1, 'user');
  exception when check_violation then v_cnt := v_cnt + 1;
  end;
  begin
    insert into audit_log (actor_id, service_identity, action, deal_id, actor_type)
      values (v_actor, 'conductia', 'view', v_deal, 'service');
  exception when check_violation then v_cnt := v_cnt + 1;
  end;
  begin
    insert into audit_log (actor_id, service_identity, action, deal_id, actor_type)
      values (v_actor, 'model-gateway', 'view', v_deal, 'model');
  exception when check_violation then v_cnt := v_cnt + 1;
  end;
  if v_cnt <> 3 then
    raise exception 'FAIL: actor_type shape check refused % of 3 mismatched rows', v_cnt;
  end if;

  -- Every discovery action is in the CHECK.
  insert into audit_log (service_identity, action, tenant_id) values
    ('conductia', 'discovery.candidate_promoted', v_t2),
    ('conductia', 'discovery.stage_assessed', v_t2);

  -- 8. Writers cannot forge the chain: supplied chain fields are replaced.
  insert into audit_log (service_identity, action, tenant_id, chain_seq, prev_hash, hash)
    values ('conductia', 'view', v_t2, 999, '\x00'::bytea, '\x00'::bytea) returning * into v_row;
  if v_row.chain_seq <> 4 or v_row.hash = '\x00'::bytea or v_row.prev_hash is null then
    raise exception 'FAIL: writer-supplied chain fields survived (seq %)', v_row.chain_seq;
  end if;

  -- 9. The trigger fires for a non-owner writer (service_role inserts directly).
  set local role service_role;
  insert into audit_log (service_identity, action, tenant_id) values ('conductia', 'view', v_t2)
    returning id into v_id;
  reset role;
  select * into v_row from audit_log where id = v_id;
  if v_row.chain_seq <> 5 or v_row.hash is null then
    raise exception 'FAIL: service_role insert was not chained';
  end if;

  -- 10. Fork backstop: with the trigger off (owner only), a second row at an
  --     existing (tenant_id, chain_seq) is refused by the unique index.
  alter table audit_log disable trigger zz_audit_log_chain_append;
  v_state := null;
  begin
    insert into audit_log (service_identity, action, tenant_id, actor_type, chain_seq, prev_hash, hash)
      values ('conductia', 'view', v_t2, 'service', 5, '\x01'::bytea, '\x01'::bytea);
  exception when unique_violation then
    v_state := 'refused';
  end;
  alter table audit_log enable trigger zz_audit_log_chain_append;
  if v_state is distinct from 'refused' then raise exception 'FAIL: a forked chain_seq was accepted'; end if;

  -- 11. Chain shape: a row with chain_seq is complete (tenant, actor_type,
  --     hash, chain_seq > 0), and only the genesis row lacks a prev_hash. A
  --     pre-migration row (chain_seq null) is exempt. The trigger is off
  --     (owner only) so the constraint is the only guard.
  alter table audit_log disable trigger zz_audit_log_chain_append;
  insert into audit_log (service_identity, action) values ('conductia', 'view') returning * into v_row;
  if v_row.chain_seq is not null or v_row.hash is not null then
    raise exception 'FAIL: an unchained legacy-shape row was altered';
  end if;

  v_cnt := 0;
  begin
    insert into audit_log (service_identity, action, tenant_id, actor_type, chain_seq)
      values ('conductia', 'view', v_t2, 'service', 100);
  exception when check_violation then v_cnt := v_cnt + 1;
  end;
  begin
    insert into audit_log (service_identity, action, actor_type, chain_seq, hash)
      values ('conductia', 'view', 'service', 101, '\x01'::bytea);
  exception when check_violation then v_cnt := v_cnt + 1;
  end;
  begin
    insert into audit_log (service_identity, action, tenant_id, chain_seq, hash)
      values ('conductia', 'view', v_t2, 102, '\x01'::bytea);
  exception when check_violation then v_cnt := v_cnt + 1;
  end;
  begin
    insert into audit_log (service_identity, action, tenant_id, actor_type, chain_seq, hash)
      values ('conductia', 'view', v_t2, 'service', 0, '\x01'::bytea);
  exception when check_violation then v_cnt := v_cnt + 1;
  end;
  begin
    insert into audit_log (service_identity, action, tenant_id, actor_type, chain_seq, hash)
      values ('conductia', 'view', v_t2, 'service', 103, '\x01'::bytea);
  exception when check_violation then v_cnt := v_cnt + 1;
  end;
  begin
    insert into audit_log (service_identity, action, tenant_id, actor_type, chain_seq, prev_hash, hash)
      values ('conductia', 'view', gen_random_uuid(), 'service', 1, '\x01'::bytea, '\x01'::bytea);
  exception when check_violation then v_cnt := v_cnt + 1;
  end;
  alter table audit_log enable trigger zz_audit_log_chain_append;
  if v_cnt <> 6 then
    raise exception 'FAIL: chain shape check refused % of 6 incomplete chained rows', v_cnt;
  end if;

  raise notice 'PASS: audit_log chains per tenant (continuity, genesis, tenant resolution, system tenant, discovery tenant rule, tenant agreement with deal and actor, model actor, actor_type shape, no forgery, fork backstop, chain shape)';
end $$;

rollback;
