-- Isolated database only; fixtures and trigger roll back.
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
create function pg_temp.reject_affiliation_audit() returns trigger language plpgsql as $$
begin
 if current_setting('zz_test.reject_affiliation_audit',true)='yes' and new.detail->>'kind'='recipient_affiliation' then raise exception 'zz_test_audit_failure'; end if;
 return new;
end $$;
create trigger zz_test_affiliation_audit before insert on public.audit_log for each row execute function pg_temp.reject_affiliation_audit();
do $$
declare t uuid:=gen_random_uuid(); bank uuid:=gen_random_uuid(); client uuid:=gen_random_uuid();
 foreign_company uuid:=gen_random_uuid(); d uuid:=gen_random_uuid(); actor uuid:=gen_random_uuid(); member uuid:=gen_random_uuid();
 result jsonb; caught boolean; invite_id uuid; old_invite_id uuid; other_deal uuid:=gen_random_uuid(); invite_email text;
begin
 insert into companies(id,tenant_id,name,type) values(bank,t,'ZZ TEST Bank','bank'),(client,t,'ZZ TEST Client','client'),(foreign_company,gen_random_uuid(),'ZZ TEST Other','client');
 insert into deals(id,tenant_id,bank_id,code,codename,status) values(d,t,bank,'ZZ-TEST-'||d::text,'ZZ TEST '||d::text,'active');
 insert into deal_parties(deal_id,company_id,party_role) values(d,client,'target');
 insert into auth.users(id,email) values(actor,'zz-test-'||actor::text||'@bank.test'),(member,'zz-test-'||member::text||'@client.test');
 update users set tenant_id=t,company_id=bank,company_role='director',is_external=false,status='active' where id=actor;
 update users set tenant_id=t,company_id=client,company_role='director',is_external=true,status='active' where id=member;
 insert into deal_memberships(deal_id,user_id,role_id,deal_role) values(d,member,(select id from roles where slug='seller'),'seller');
 result:=set_recipient_affiliation(actor,d,'zz-test-'||member::text||'@client.test',client,'client',null,member,null,null);
 if (result->>'revision')::int <> 1 then raise exception 'first revision failed'; end if;
 result:=set_recipient_affiliation(actor,d,'zz-test-'||member::text||'@client.test',client,'counterparty',null,member,null,1);
 if (result->>'revision')::int <> 2 then raise exception 'update failed'; end if;
 caught:=false;
 begin perform set_recipient_affiliation(actor,d,'zz-test-'||member::text||'@client.test',client,'client',null,member,null,1);
 exception when raise_exception then if sqlerrm <> 'affiliation_revision_conflict' then raise; end if; caught:=true; end;
 if not caught then raise exception 'stale revision accepted'; end if;
 caught:=false;
 begin perform set_recipient_affiliation(actor,d,'zz-test-'||member::text||'@client.test',foreign_company,'client',null,member,null,2);
 exception when raise_exception then if sqlerrm <> 'tenant_mismatch' then raise; end if; caught:=true; end;
 if not caught then raise exception 'cross tenant accepted'; end if;
 caught:=false;
 begin perform set_recipient_affiliation(actor,d,'zz-test-'||member::text||'@client.test',client,'client_advisor',null,member,null,2);
 exception when raise_exception then if sqlerrm <> 'invalid_affiliation' then raise; end if; caught:=true; end;
 if not caught then raise exception 'unrepresented advisor accepted'; end if;
 caught:=false;
 begin perform set_recipient_affiliation(member,d,'zz-test-'||member::text||'@client.test',client,'client',null,member,null,2);
 exception when raise_exception then if sqlerrm <> 'forbidden' then raise; end if; caught:=true; end;
 if not caught then raise exception 'external manager accepted'; end if;
 if (select count(*) from audit_log where deal_id=d and detail->>'kind'='recipient_affiliation')<>2 then raise exception 'audit mismatch'; end if;
 -- A failing administrative audit must roll back the affiliation itself.
 perform set_config('zz_test.reject_affiliation_audit','yes',true);
 caught:=false;
 begin perform set_recipient_affiliation(actor,d,'zz-test-'||member::text||'@client.test',client,'client',null,member,null,2);
 exception when raise_exception then if sqlerrm <> 'zz_test_audit_failure' then raise; end if; caught:=true; end;
 if not caught or (select revision from deal_recipient_affiliations where deal_id=d and user_id=member)<>2 then raise exception 'audit failure did not roll back update'; end if;
 perform set_config('zz_test.reject_affiliation_audit','no',true);
 caught:=false;
 begin perform set_recipient_affiliation(actor,d,'zz-test-'||member::text||'@client.test',client,'bank_team',null,member,null,2);
 exception when raise_exception then if sqlerrm <> 'invalid_affiliation' then raise; end if; caught:=true; end;
 if not caught then raise exception 'invalid enum accepted'; end if;
 -- Regrant to a removed member replaces the old reference without elevating access.
 delete from deal_memberships where deal_id=d and user_id=member;
 result:=grant_existing_account_with_affiliation(actor,'zz-test-'||member::text||'@client.test',client,d,'seller',0,'client',null);
 if not (result->>'access_granted')::boolean or (select revision from deal_recipient_affiliations where deal_id=d and user_id=member)<>3 then raise exception 'regrant failed'; end if;
 -- Repeating a grant cannot silently relabel a current member.
 result:=grant_existing_account_with_affiliation(actor,'zz-test-'||member::text||'@client.test',client,d,'seller',0,'counterparty',null);
 if (result->>'access_granted')::boolean or (select affiliation from deal_recipient_affiliations where deal_id=d and user_id=member)<>'client' then raise exception 'duplicate grant changed affiliation'; end if;
 insert into company_verified_domains(tenant_id,company_id,domain,source) values(t,client,'client.test','ZZ TEST');
 invite_email:='zz-test-invite-'||d::text||'@client.test';
 result:=create_invite_with_affiliation(actor,invite_email,client,'member',repeat('a',64),null,d,'seller',0,'counterparty',null);
 old_invite_id:=(result->>'id')::uuid;
 update invites set status='revoked' where id=old_invite_id;
 result:=create_invite_with_affiliation(actor,invite_email,client,'member',repeat('b',64),null,d,'seller',0,'client',null);
 invite_id:=(result->>'id')::uuid;
 if invite_id=old_invite_id or (select revision from deal_recipient_affiliations where deal_id=d and normalized_email=invite_email)<>2 then raise exception 'replacement invite failed'; end if;
 -- An invalid affiliation rolls back its otherwise valid invitation.
 caught:=false;
 begin perform create_invite_with_affiliation(actor,'zz-test-rollback-'||d::text||'@client.test',client,'member',repeat('c',64),null,d,'seller',0,'client_advisor',null);
 exception when raise_exception then if sqlerrm <> 'invalid_affiliation' then raise; end if; caught:=true; end;
 if not caught or exists(select 1 from invites where email='zz-test-rollback-'||d::text||'@client.test') then raise exception 'wrapper did not roll back invite'; end if;
 insert into deals(id,tenant_id,bank_id,code,codename,status) values(other_deal,t,bank,'ZZ-TEST-'||other_deal::text,'ZZ TEST '||other_deal::text,'active');
 insert into deal_parties(deal_id,company_id,party_role) values(other_deal,client,'target');
 caught:=false;
 begin perform set_recipient_affiliation(actor,other_deal,invite_email,client,'client',null,null,invite_id,null);
 exception when raise_exception then if sqlerrm <> 'invalid_invite' then raise; end if; caught:=true; end;
 if not caught then raise exception 'cross-deal invitation accepted'; end if;
 raise notice 'PASS: authority, revisions, isolation, audit rollback, replacement invite and regrant';
end $$;
rollback;
