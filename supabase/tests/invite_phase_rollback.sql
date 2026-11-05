-- Rollback containment.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/invite_phase_rollback.sql
--
-- The down script expires pending invitations carrying a nonzero phase before
-- dropping the column, because dropping it would let acceptance silently grant
-- phase 0 -- the exact failure the forward migration exists to prevent.
--
-- What a single session can prove is asserted here: only the right rows are
-- expired, only rows actually expired are audited, phase-0 and already-accepted
-- rows are left alone, and acceptance of a contained invitation fails rather
-- than granting an invisible phase. The two-session interleaving (containment
-- and acceptance racing on the same row lock) needs two connections and is NOT
-- covered here; the row-level `for update` it relies on is the same one
-- accept_invite already takes.
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
  v_tenant uuid := gen_random_uuid();
  v_bank uuid := gen_random_uuid();
  v_seller uuid := gen_random_uuid();
  v_deal uuid := gen_random_uuid();
  v_md uuid := gen_random_uuid();
  v_dir uuid := gen_random_uuid();
  v_hi uuid;
  v_zero uuid;
  v_done uuid;
  v_expired int;
  v_audited int;
begin
  insert into companies (id, tenant_id, name, type) values
    (v_bank, v_tenant, 'Advisory Bank', 'bank'),
    (v_seller, v_tenant, 'Target Co', 'target');
  insert into deals (id, tenant_id, code, codename, status, bank_id)
    values (v_deal, v_tenant, 'ROLLBK-1', 'Rollback', 'active', v_bank);
  insert into deal_parties (deal_id, company_id, party_role) values (v_deal, v_seller, 'target');

  insert into auth.users (id, email) values (v_md, 'md@bank.dev'), (v_dir, 'dir@target.dev');
  update users set tenant_id = v_tenant, company_id = v_bank, company_role = 'director',
    is_external = false, status = 'active' where id = v_md;
  update users set tenant_id = v_tenant, company_id = v_seller, company_role = 'director',
    is_external = true, status = 'active' where id = v_dir;

  -- Three pending invitations: one carrying a confirmed nonzero phase, one at
  -- phase 0, and one already accepted at a nonzero phase.
  insert into invites (tenant_id, email, invited_by, company_id, company_role, deal_id, deal_role, phase, challenge_digest, challenge_version, challenge_issued_at)
    values (v_tenant, 'hi@target.dev', v_md, v_seller, 'member', v_deal, 'seller', 2, repeat('a', 64), 1, now())
    returning id into v_hi;
  insert into invites (tenant_id, email, invited_by, company_id, company_role, deal_id, deal_role, phase, challenge_digest, challenge_version, challenge_issued_at)
    values (v_tenant, 'zero@target.dev', v_md, v_seller, 'member', v_deal, 'seller', 0, repeat('b', 64), 1, now())
    returning id into v_zero;
  insert into invites (tenant_id, email, invited_by, company_id, company_role, deal_id, deal_role, phase, status, challenge_digest, challenge_version, challenge_issued_at)
    values (v_tenant, 'done@target.dev', v_md, v_seller, 'member', v_deal, 'seller', 3, 'accepted', repeat('c', 64), 1, now())
    returning id into v_done;

  -- The containment step of supabase/rollback/20260808120000_invite_phase_down.sql.
  with withdrawn as (
    update invites set status = 'expired'
    where status = 'pending' and phase > 0
    returning id, invited_by, deal_id, company_id, email, phase
  )
  insert into audit_log (actor_id, action, deal_id, detail)
  select w.invited_by, 'revoke', w.deal_id,
         jsonb_build_object('reason', 'invite_phase_rollback', 'invite_id', w.id,
                            'company_id', w.company_id, 'email', w.email, 'phase', w.phase)
  from withdrawn w;

  if (select status from invites where id = v_hi) <> 'expired' then
    raise exception 'FAIL 1: a pending invitation carrying phase 2 was not contained';
  end if;
  if (select status from invites where id = v_zero) <> 'pending' then
    raise exception 'FAIL 2: a phase 0 invitation was contained, but it loses nothing';
  end if;
  if (select status from invites where id = v_done) <> 'accepted' then
    raise exception 'FAIL 3: an already accepted invitation was altered';
  end if;

  select count(*) into v_expired from invites where status = 'expired';
  select count(*) into v_audited from audit_log
    where detail->>'reason' = 'invite_phase_rollback';
  if v_expired <> 1 or v_audited <> 1 then
    raise exception 'FAIL 4: expired % rows but audited % — audit must come from the returned rows only', v_expired, v_audited;
  end if;
  if (select detail->>'phase' from audit_log where detail->>'reason' = 'invite_phase_rollback') <> '2' then
    raise exception 'FAIL 5: the withdrawn phase was not recorded, so the decision is unrecoverable';
  end if;

  -- A contained invitation must not still be acceptable.
  perform set_config('request.jwt.claims', json_build_object('sub', v_dir, 'session_id', v_dir)::text, true);
  begin
    perform accept_invite(v_hi, (select credential_nonce from invites where id = v_hi), 'fixture-password-1', 'tos-test', null);
    raise exception 'FAIL 6: a contained invitation was still accepted';
  exception
    when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      if sqlerrm not like '%invite_not_pending%' then
        raise exception 'FAIL 6: expected invite_not_pending, got %', sqlerrm;
      end if;
  end;

  raise notice 'PASS: rollback containment expires, audits, and blocks acceptance';
end $$;

rollback;
